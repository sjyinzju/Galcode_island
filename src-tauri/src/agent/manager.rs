// Agent 会话管理器：start/stop/总结/翻译/IPC 事件聚合层。
//
// 设计：
//   - 三个 backend (Claude / OpenCode / Codex) 都通过对应 agent::xxx 模块完成 CLI 通信
//   - 本模块负责把每个 turn 套到 LLM 翻译/总结管线里：
//       中文 prompt → translate_zh_to_en → backend turn → 拿到英文输出
//       英文输出 → translate_en_to_zh → 中文 → generate_agent_summary → mode/emotion/options
//   - SessionSnapshot 状态由 IPC events 透传给前端宠物气泡
//   - 会话续接：每个 backend 自动捕获 session_id 存到 RuntimeState 里供下次 turn 复用

use crate::agent::runtime::{
    with_claude_state, with_codex_state, ClaudeStreamClient, RuntimeState, CODEX_SHARED_KEY,
};
use crate::agent::{claude as claude_agent, codex as codex_agent, opencode as opencode_agent};
use crate::ipc::events::{self, SessionCompletePayload};
use crate::llm::{
    generate_agent_summary, load_llm_config, translate_en_to_zh, translate_zh_to_en, LlmConfig,
};
use crate::session::snapshot::SessionSnapshot;
use crate::session::state::AgentStatus;
use crate::AppState;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};

// ---------------------------------------------------------------------------
// 会话与管理器
// ---------------------------------------------------------------------------

pub struct AgentSession {
    pub snapshot: Arc<Mutex<SessionSnapshot>>,
    /// 用 get_session_logs 命令读出（暂未由 backend 主动写入，预留作未来调试面板）。
    pub logs: Arc<Mutex<Vec<String>>>,
    pub created_at: Instant,
    /// 用于 cli-output 事件路由（前端按 stream_id 把流式日志分发到对应会话面板）。
    pub stream_id: String,
    /// tab 标识：多 tab UI 下每个 tab 独占一个 run_id，所有 emit / runtime
    /// HashMap 都按它路由。前端按 IPC payload.runId 找到对应 tab slice 写入。
    pub run_id: String,
}

impl AgentSession {
    pub fn new(
        session_id: String,
        agent_type: String,
        cwd: Option<String>,
        run_id: String,
    ) -> Self {
        let stream_id = format!("stream-{}", session_id);
        Self {
            snapshot: Arc::new(Mutex::new(SessionSnapshot::new(
                session_id,
                agent_type,
                cwd,
                None,
            ))),
            logs: Arc::new(Mutex::new(Vec::new())),
            created_at: Instant::now(),
            stream_id,
            run_id,
        }
    }
}

pub struct AgentManager {
    pub sessions: HashMap<String, AgentSession>,
    pending_permission: HashMap<(String, String), ()>,
    /// 当前活动会话（兼容老的无参 stop_agent）。命名沿用 demo 时代，但承载所有 backend。
    pub active_session: Option<String>,
    /// 会话续接缓存：(agent_type, cwd) → 上次的 session_id / thread_id。
    /// 下次同 agent_type+cwd 提交时自动 resume，让对话有上下文延续。
    pub last_session_per_context: HashMap<(String, String), String>,
}

impl AgentManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            pending_permission: HashMap::new(),
            active_session: None,
            last_session_per_context: HashMap::new(),
        }
    }

    pub fn clear_active_session_if(&mut self, session_id: &str) {
        if self.active_session.as_deref() == Some(session_id) {
            self.active_session = None;
        }
    }

    pub fn cleanup_completed_sessions(&mut self, max_age: std::time::Duration) -> Vec<String> {
        let now = Instant::now();
        let ids: Vec<String> = self
            .sessions
            .iter()
            .filter(|(_, s)| {
                let st = s
                    .snapshot
                    .lock()
                    .map(|g| g.status)
                    .unwrap_or(AgentStatus::Idle);
                matches!(st, AgentStatus::Completed | AgentStatus::Error)
                    && now.duration_since(s.created_at) > max_age
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in &ids {
            self.clear_active_session_if(id);
            self.sessions.remove(id);
            log::info!("cleanup removed stale session {}", id);
        }
        ids
    }

    pub fn respond_permission_stub(
        &mut self,
        session_id: &str,
        tool_use_id: &str,
        _decision: &str,
    ) -> Result<(), String> {
        self.pending_permission
            .remove(&(session_id.to_string(), tool_use_id.to_string()));
        log::info!(
            "respond_permission (stub): session={} tool_use_id={}",
            session_id,
            tool_use_id
        );
        Ok(())
    }

    /// 记下"某 tab 的某 backend 上一轮拿到的 session_id"，下次同 tab 启动新
    /// turn 时用它 resume conversation。索引 key 是 `(agent_type, run_id)` —
    /// **不再按 cwd 索引** —— 每个 tab 独立一份，避免同目录多 tab 串台。
    fn remember_session(&mut self, agent_type: &str, run_id: &str, session_id: &str) {
        if session_id.trim().is_empty() {
            return;
        }
        self.last_session_per_context.insert(
            (agent_type.to_string(), run_id.to_string()),
            session_id.to_string(),
        );
    }

    fn last_session_for(&self, agent_type: &str, run_id: &str) -> Option<String> {
        self.last_session_per_context
            .get(&(agent_type.to_string(), run_id.to_string()))
            .cloned()
    }
}

// ---------------------------------------------------------------------------
// 公共结果类型
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    pub session_id: String,
    pub status: AgentStatus,
}

// ---------------------------------------------------------------------------
// Claude Code Agent
// ---------------------------------------------------------------------------

pub fn launch_claude_agent(
    app: AppHandle,
    state: Arc<AppState>,
    runtime_state: Arc<RuntimeState>,
    run_id: String,
    cwd: String,
    task_zh: String,
    // 前端持久化的 tab.sessionId hint：用作 resume 候选。重启 app 后内存
    // last_session_per_context 空了，前端持久化的 sessionId 能续上下文。
    resume_hint: Option<String>,
    // Claude Code permission mode：default / acceptEdits / plan / bypassPermissions。
    // None 时由 claude.rs 内部 fallback 到 acceptEdits（保留老行为）。
    permission_mode: Option<String>,
) -> Result<LaunchResult, String> {
    let trimmed = task_zh.trim().to_string();
    if trimmed.is_empty() {
        return Err("任务内容不能为空".into());
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    let sess = AgentSession::new(
        session_id.clone(),
        "claude-code".into(),
        Some(cwd.clone()),
        run_id.clone(),
    );
    let stream_id = sess.stream_id.clone();
    {
        let mut sn = sess.snapshot.lock().map_err(|e| e.to_string())?;
        sn.last_user_prompt = Some(trimmed.clone());
        sn.status = AgentStatus::Running;
    }

    // resume 优先级：内存 last_session_per_context（同 app 会话连续轮次）→
    // 前端 resume_hint（持久化恢复用，覆盖空的内存值）。两者非空时取内存里的
    // —— 内存版本是同 app 会话最新一轮的真相，比磁盘旧值更准。
    let resume_session_id = {
        let mgr = state.manager.lock().map_err(|e| e.to_string())?;
        mgr.last_session_for("claude-code", &run_id)
            .or_else(|| resume_hint.clone().filter(|s| !s.trim().is_empty()))
    };

    {
        let mut mgr = state.manager.lock().map_err(|e| e.to_string())?;
        mgr.active_session = Some(session_id.clone());
        mgr.sessions.insert(session_id.clone(), sess);
    }

    emit_status_running(&app, Some(&run_id), &session_id, "Claude Code starting");

    let app_handle = app.clone();
    let state_clone = Arc::clone(&state);
    let runtime_clone = Arc::clone(&runtime_state);
    let sid = session_id.clone();
    let user_zh = trimmed.clone();
    let cwd_owned = cwd.clone();
    let permission_mode_owned = permission_mode.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let t0 = std::time::Instant::now();
        eprintln!("[claude] >>> turn start sid={}", sid);
        let llm = load_llm_config();
        eprintln!(
            "[claude] llm config: {}",
            if llm.is_some() { "ok" } else { "MISSING (无 API Key, 跳过翻译)" }
        );
        if llm.is_some() {
            emit_progress(&app_handle, Some(&run_id), &sid, AgentStatus::Processing, "翻译输入到英文…", 10.0);
        }
        let t_tr_in_start = std::time::Instant::now();
        let prompt_for_agent = translate_input(&llm, &user_zh);
        let dur_tr_in = t_tr_in_start.elapsed();
        eprintln!(
            "[claude] timing: translate_in={}ms (prompt_len={})",
            dur_tr_in.as_millis(),
            prompt_for_agent.len()
        );

        emit_progress(&app_handle, Some(&run_id), &sid, AgentStatus::Starting, "启动 Claude Code…", 30.0);
        let prefs = crate::agent::preferences::load_backend_preferences("claude-code");

        emit_progress(&app_handle, Some(&run_id), &sid, AgentStatus::Processing, "Agent 工作中…", 50.0);
        let t_turn_start = std::time::Instant::now();
        let turn_result = claude_agent::run_claude_stream_turn(
            &app_handle,
            runtime_clone.as_ref(),
            &run_id,
            &prompt_for_agent,
            &cwd_owned,
            resume_session_id.as_deref(),
            prefs.model.as_deref(),
            prefs.effort.as_deref(),
            prefs.binary.as_deref(),
            prefs.proxy.as_deref(),
            permission_mode_owned.as_deref(),
            Some(&stream_id),
        );

        let dur_turn = t_turn_start.elapsed();
        match turn_result {
            Ok((next_session_id, output_en)) => {
                eprintln!(
                    "[claude] timing: agent_turn={}ms (output_len={})",
                    dur_turn.as_millis(),
                    output_en.len()
                );
                if let Some(ref next_sid) = next_session_id {
                    if let Ok(mut mgr) = state_clone.manager.lock() {
                        mgr.remember_session("claude-code", &run_id, next_sid);
                    }
                }
                // 在跑 finalize 之前 emit agent turn 的英文原文，让前端持久化
                // 备用：用户在翻译/总结过程中退出 app，重启时 reattach 会拿这个
                // result_raw 调 finalize_pending 自动接续翻译+总结。
                let _ = app_handle.emit(
                    "agent://result-raw",
                    serde_json::json!({
                        "sessionId": sid,
                        "runId": run_id,
                        "resultRaw": output_en,
                        "userZh": user_zh,
                    }),
                );
                emit_progress(&app_handle, Some(&run_id), &sid, AgentStatus::Processing, "翻译输出 + 总结…", 80.0);
                let t_post_start = std::time::Instant::now();
                finalize_session(
                    &app_handle,
                    &state_clone,
                    &sid,
                    &user_zh,
                    output_en,
                    llm.as_ref(),
                    next_session_id.clone(),
                );
                let dur_post = t_post_start.elapsed();
                let dur_total = t0.elapsed();
                eprintln!(
                    "[claude] === SUMMARY: total={}ms = translate_in={}ms + agent_turn={}ms + post={}ms (translate_out + summary) ===",
                    dur_total.as_millis(),
                    dur_tr_in.as_millis(),
                    dur_turn.as_millis(),
                    dur_post.as_millis()
                );
            }
            Err(error) => {
                eprintln!(
                    "[claude] <<< turn FAILED after {}ms: {}",
                    dur_turn.as_millis(),
                    error
                );
                fail_session(&app_handle, &state_clone, &sid, &error, "CLAUDE_TURN_FAILED");
            }
        }
    });

    Ok(LaunchResult {
        session_id,
        status: AgentStatus::Running,
    })
}

// ---------------------------------------------------------------------------
// Codex Agent
// ---------------------------------------------------------------------------

pub fn launch_codex_agent(
    app: AppHandle,
    state: Arc<AppState>,
    runtime_state: Arc<RuntimeState>,
    run_id: String,
    cwd: String,
    task_zh: String,
    // 前端持久化的 tab.sessionId（codex 这里其实是 thread_id）hint：作 resume 候选。
    resume_hint: Option<String>,
) -> Result<LaunchResult, String> {
    let trimmed = task_zh.trim().to_string();
    if trimmed.is_empty() {
        return Err("任务内容不能为空".into());
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    let sess = AgentSession::new(
        session_id.clone(),
        "codex".into(),
        Some(cwd.clone()),
        run_id.clone(),
    );
    let stream_id = sess.stream_id.clone();
    {
        let mut sn = sess.snapshot.lock().map_err(|e| e.to_string())?;
        sn.last_user_prompt = Some(trimmed.clone());
        sn.status = AgentStatus::Running;
    }

    let resume_thread_id = {
        let mgr = state.manager.lock().map_err(|e| e.to_string())?;
        mgr.last_session_for("codex", &run_id)
            .or_else(|| resume_hint.clone().filter(|s| !s.trim().is_empty()))
    };

    {
        let mut mgr = state.manager.lock().map_err(|e| e.to_string())?;
        mgr.active_session = Some(session_id.clone());
        mgr.sessions.insert(session_id.clone(), sess);
    }

    emit_status_running(&app, Some(&run_id), &session_id, "Codex App Server starting");

    let app_handle = app.clone();
    let state_clone = Arc::clone(&state);
    let runtime_clone = Arc::clone(&runtime_state);
    let sid = session_id.clone();
    let user_zh = trimmed.clone();
    let cwd_owned = cwd.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let t0 = std::time::Instant::now();
        eprintln!("[codex] >>> turn start sid={}", sid);
        let llm = load_llm_config();
        eprintln!(
            "[codex] llm config: {}",
            if llm.is_some() { "ok" } else { "MISSING" }
        );
        if llm.is_some() {
            emit_progress(&app_handle, Some(&run_id), &sid, AgentStatus::Processing, "翻译输入到英文…", 10.0);
        }
        let t_tr_in_start = std::time::Instant::now();
        let prompt_for_agent = translate_input(&llm, &user_zh);
        let dur_tr_in = t_tr_in_start.elapsed();
        eprintln!(
            "[codex] timing: translate_in={}ms (prompt_len={})",
            dur_tr_in.as_millis(),
            prompt_for_agent.len()
        );

        emit_progress(&app_handle, Some(&run_id), &sid, AgentStatus::Starting, "启动 Codex App Server…", 30.0);
        let prefs = crate::agent::preferences::load_backend_preferences("codex");

        emit_progress(&app_handle, Some(&run_id), &sid, AgentStatus::Processing, "Agent 工作中…", 50.0);
        let t_turn_start = std::time::Instant::now();
        let turn_result = codex_agent::run_codex_app_server_turn(
            &app_handle,
            runtime_clone.as_ref(),
            &run_id,
            &cwd_owned,
            resume_thread_id.as_deref(),
            None,
            &prompt_for_agent,
            prefs.model.as_deref(),
            prefs.effort.as_deref(),
            prefs.binary.as_deref(),
            prefs.proxy.as_deref(),
            Some(&stream_id),
        );

        let dur_turn = t_turn_start.elapsed();
        match turn_result {
            Ok((thread_id, output_en)) => {
                eprintln!(
                    "[codex] timing: agent_turn={}ms (output_len={})",
                    dur_turn.as_millis(),
                    output_en.len()
                );
                if let Ok(mut mgr) = state_clone.manager.lock() {
                    mgr.remember_session("codex", &run_id, &thread_id);
                }
                // 在跑 finalize 之前 emit agent turn 的英文原文，让前端持久化
                // 备用：用户在翻译/总结过程中退出 app，重启时 reattach 会拿这个
                // result_raw 调 finalize_pending 自动接续翻译+总结。
                let _ = app_handle.emit(
                    "agent://result-raw",
                    serde_json::json!({
                        "sessionId": sid,
                        "runId": run_id,
                        "resultRaw": output_en,
                        "userZh": user_zh,
                    }),
                );
                emit_progress(&app_handle, Some(&run_id), &sid, AgentStatus::Processing, "翻译输出 + 总结…", 80.0);
                let t_post_start = std::time::Instant::now();
                finalize_session(
                    &app_handle,
                    &state_clone,
                    &sid,
                    &user_zh,
                    output_en,
                    llm.as_ref(),
                    Some(thread_id.clone()),
                );
                let dur_post = t_post_start.elapsed();
                let dur_total = t0.elapsed();
                eprintln!(
                    "[codex] === SUMMARY: total={}ms = translate_in={}ms + agent_turn={}ms + post={}ms ===",
                    dur_total.as_millis(),
                    dur_tr_in.as_millis(),
                    dur_turn.as_millis(),
                    dur_post.as_millis()
                );
            }
            Err(error) => {
                eprintln!(
                    "[codex] <<< turn FAILED after {}ms: {}",
                    dur_turn.as_millis(),
                    error
                );
                fail_session(&app_handle, &state_clone, &sid, &error, "CODEX_TURN_FAILED");
            }
        }
    });

    Ok(LaunchResult {
        session_id,
        status: AgentStatus::Running,
    })
}

// ---------------------------------------------------------------------------
// OpenCode Agent
// ---------------------------------------------------------------------------

pub fn launch_opencode_agent(
    app: AppHandle,
    state: Arc<AppState>,
    runtime_state: Arc<RuntimeState>,
    run_id: String,
    cwd: String,
    task_zh: String,
    // 前端持久化的 tab.sessionId（OpenCode 的 session id）hint：作 resume 候选。
    resume_hint: Option<String>,
) -> Result<LaunchResult, String> {
    let trimmed = task_zh.trim().to_string();
    if trimmed.is_empty() {
        return Err("任务内容不能为空".into());
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    let sess = AgentSession::new(
        session_id.clone(),
        "opencode".into(),
        Some(cwd.clone()),
        run_id.clone(),
    );
    let stream_id = sess.stream_id.clone();
    {
        let mut sn = sess.snapshot.lock().map_err(|e| e.to_string())?;
        sn.last_user_prompt = Some(trimmed.clone());
        sn.status = AgentStatus::Running;
    }

    let resume_session_id = {
        let mgr = state.manager.lock().map_err(|e| e.to_string())?;
        mgr.last_session_for("opencode", &run_id)
            .or_else(|| resume_hint.clone().filter(|s| !s.trim().is_empty()))
    };

    {
        let mut mgr = state.manager.lock().map_err(|e| e.to_string())?;
        mgr.active_session = Some(session_id.clone());
        mgr.sessions.insert(session_id.clone(), sess);
    }

    emit_status_running(&app, Some(&run_id), &session_id, "OpenCode server starting");

    let app_handle = app.clone();
    let state_clone = Arc::clone(&state);
    let runtime_clone = Arc::clone(&runtime_state);
    let sid = session_id.clone();
    let user_zh = trimmed.clone();
    let cwd_owned = cwd.clone();

    tauri::async_runtime::spawn(async move {
        let t0 = std::time::Instant::now();
        eprintln!("[opencode] >>> turn start sid={}", sid);
        let llm = load_llm_config();
        eprintln!(
            "[opencode] llm config: {}",
            if llm.is_some() { "ok" } else { "MISSING" }
        );
        if llm.is_some() {
            emit_progress(&app_handle, Some(&run_id), &sid, AgentStatus::Processing, "翻译输入到英文…", 10.0);
        }
        let llm_for_blocking = llm.clone();
        let user_zh_for_blocking = user_zh.clone();
        let t_tr_in_start = std::time::Instant::now();
        let prompt_for_agent = tauri::async_runtime::spawn_blocking(move || {
            translate_input(&llm_for_blocking, &user_zh_for_blocking)
        })
        .await
        .unwrap_or_else(|_| user_zh.clone());
        let dur_tr_in = t_tr_in_start.elapsed();
        eprintln!(
            "[opencode] timing: translate_in={}ms (prompt_len={})",
            dur_tr_in.as_millis(),
            prompt_for_agent.len()
        );

        emit_progress(&app_handle, Some(&run_id), &sid, AgentStatus::Starting, "启动 OpenCode serve…", 25.0);
        let prefs = crate::agent::preferences::load_backend_preferences("opencode");

        // 用户在设置里把 authMode 选成 "key" 并填了 API Key 时，启动 serve 之前先把
        // 凭据写到 auth.json。OpenCode serve 启动后会从那里读认证，没有这步即便填
        // 了 key 也走不通；oauth 模式则依赖用户已经跑过 `opencode auth login`。
        if let (Some(mode), Some(provider)) = (prefs.auth_mode.as_deref(), prefs.provider.as_deref())
        {
            if mode == "key" {
                if let Err(error) = crate::agent::opencode::upsert_opencode_auth_entry(
                    provider,
                    "key",
                    prefs.api_key.as_deref(),
                ) {
                    eprintln!("[opencode] auth.json write failed: {}", error);
                    // 不直接 fail：让 serve 启起来后用户能看到清晰报错（可能只是 key 字段空）
                }
            }
        }

        let t_serve_start = std::time::Instant::now();

        if let Err(error) = opencode_agent::opencode_start(
            &app_handle,
            runtime_clone.as_ref(),
            &run_id,
            prefs.binary.as_deref(),
            prefs.proxy.as_deref(),
            None,
            Some(&cwd_owned),
        )
        .await
        {
            eprintln!("[opencode] <<< opencode_start FAILED: {}", error);
            fail_session(
                &app_handle,
                &state_clone,
                &sid,
                &error,
                "OPENCODE_START_FAILED",
            );
            return;
        }
        let dur_serve = t_serve_start.elapsed();
        eprintln!("[opencode] timing: serve_ready={}ms", dur_serve.as_millis());

        emit_progress(&app_handle, Some(&run_id), &sid, AgentStatus::Processing, "创建会话…", 40.0);
        let t_session_start = std::time::Instant::now();
        let session_for_turn = match resume_session_id {
            Some(existing) => existing,
            None => match opencode_agent::opencode_create_session(
                &app_handle,
                runtime_clone.as_ref(),
                &run_id,
                None,
                Some(&cwd_owned),
            )
            .await
            {
                Ok(id) => id,
                Err(error) => {
                    eprintln!("[opencode] <<< create_session FAILED: {}", error);
                    fail_session(
                        &app_handle,
                        &state_clone,
                        &sid,
                        &error,
                        "OPENCODE_SESSION_FAILED",
                    );
                    return;
                }
            },
        };

        let dur_session = t_session_start.elapsed();
        eprintln!("[opencode] timing: create_session={}ms", dur_session.as_millis());

        emit_progress(&app_handle, Some(&run_id), &sid, AgentStatus::Processing, "Agent 工作中…", 55.0);
        let t_turn_start = std::time::Instant::now();
        let turn_result = opencode_agent::run_opencode_turn(
            &app_handle,
            runtime_clone.as_ref(),
            &run_id,
            &session_for_turn,
            &prompt_for_agent,
            None,
            Some(&cwd_owned),
            Some(&stream_id),
            prefs.provider.as_deref(),
            prefs.model.as_deref(),
        )
        .await;

        let dur_turn = t_turn_start.elapsed();
        match turn_result {
            Ok((output_en, _raw)) => {
                eprintln!(
                    "[opencode] timing: agent_turn={}ms (output_len={})",
                    dur_turn.as_millis(),
                    output_en.len()
                );
                if let Ok(mut mgr) = state_clone.manager.lock() {
                    mgr.remember_session("opencode", &run_id, &session_for_turn);
                }
                // emit agent 英文原文给前端持久化（参见 claude/codex 同处注释）
                let _ = app_handle.emit(
                    "agent://result-raw",
                    serde_json::json!({
                        "sessionId": sid,
                        "runId": run_id,
                        "resultRaw": output_en,
                        "userZh": user_zh,
                    }),
                );
                emit_progress(&app_handle, Some(&run_id), &sid, AgentStatus::Processing, "翻译输出 + 总结…", 80.0);
                let t_post_start = std::time::Instant::now();
                let app_for_finalize = app_handle.clone();
                let state_for_finalize = Arc::clone(&state_clone);
                let sid_for_finalize = sid.clone();
                let user_zh_for_finalize = user_zh.clone();
                let native_for_finalize = Some(session_for_turn.clone());
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    finalize_session(
                        &app_for_finalize,
                        &state_for_finalize,
                        &sid_for_finalize,
                        &user_zh_for_finalize,
                        output_en,
                        llm.as_ref(),
                        native_for_finalize,
                    );
                })
                .await;
                let dur_post = t_post_start.elapsed();
                let dur_total = t0.elapsed();
                eprintln!(
                    "[opencode] === SUMMARY: total={}ms = translate_in={}ms + serve={}ms + create_session={}ms + agent_turn={}ms + post={}ms ===",
                    dur_total.as_millis(),
                    dur_tr_in.as_millis(),
                    dur_serve.as_millis(),
                    dur_session.as_millis(),
                    dur_turn.as_millis(),
                    dur_post.as_millis()
                );
            }
            Err(error) => {
                eprintln!(
                    "[opencode] <<< turn FAILED after {}ms: {}",
                    dur_turn.as_millis(),
                    error
                );
                fail_session(
                    &app_handle,
                    &state_clone,
                    &sid,
                    &error,
                    "OPENCODE_TURN_FAILED",
                );
            }
        }
    });

    Ok(LaunchResult {
        session_id,
        status: AgentStatus::Running,
    })
}

// ---------------------------------------------------------------------------
// LLM 翻译/总结管线（输入翻译 + 输出翻译 + summary 生成）
// ---------------------------------------------------------------------------

/// 输入翻译：用户中文 prompt → 英文（仅当 LLM 已配置 + translate_input 开关开启）。
/// 关闭时直接返回原中文，让 agent 自己用中文跟用户对话。
fn translate_input(llm: &Option<LlmConfig>, zh: &str) -> String {
    match llm {
        Some(cfg) if cfg.translate_input => {
            translate_zh_to_en(cfg, zh).unwrap_or_else(|_| zh.to_string())
        }
        _ => zh.to_string(),
    }
}

/// 启发式判断：文本里 CJK 汉字占非空白字符的比例 > 30% 即视为中文。
/// 用在 translate_input=true 但仓库内容是中文、agent 实际输出中文的场景：
/// 跳过 translate_en_to_zh 节省一次 LLM 调用 + 避免把中文再翻一遍引入失真。
pub(crate) fn is_likely_chinese(text: &str) -> bool {
    let mut cjk = 0usize;
    let mut total = 0usize;
    for ch in text.chars() {
        if ch.is_whitespace() {
            continue;
        }
        total += 1;
        // CJK Unified Ideographs + Extension A + Compatibility Ideographs
        if matches!(ch as u32, 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF) {
            cjk += 1;
        }
    }
    if total < 8 {
        return false;
    }
    cjk * 10 > total * 3
}

/// 翻译 + 总结的核心计算（纯函数，不动 state / 不 emit）。
/// 拿英文原文 + 用户中文 prompt + LLM 配置，跑并发翻译 + 总结，输出
/// session-complete payload 所需的全部字段。
///
/// 设计上不依赖 mgr.sessions —— 这样 `finalize_pending` IPC 命令在重启
/// 后（mgr.sessions 是空的）也能用同一份逻辑跑"接续翻译+总结"。
pub(crate) struct FinalizeOutcome {
    pub mode: Option<String>,
    pub emotion: Option<String>,
    pub summary_translation: Option<String>,
    pub result_zh: String,
    pub suggestion_options: Option<Vec<String>>,
}

pub(crate) fn compute_finalize_outcome(
    user_zh: &str,
    result_en: &str,
    llm: Option<&LlmConfig>,
) -> FinalizeOutcome {
    // 翻译输出 + 生成 summary 并发——summary 不需要等翻译完成的中文，直接吃英文
    // 也能正确理解（DeepSeek 跨语言无压力）。串行约 5-15s 改并发后取 max(两者)。
    //
    // translate_input=false 时跳过 translate_en_to_zh：用户输入是中文，agent
    // 输出大概率也是中文（agent 跟用户语言走），不需要再翻译；result_zh 直接用
    // result_en（其实就是中文原文）。summary 始终跑。
    let (result_zh, summary_result) = match llm {
        Some(cfg) => {
            let cfg_summary = cfg.clone();
            let result_for_summary = result_en.to_string();
            let user_zh_owned = user_zh.to_string();
            let t_parallel = std::time::Instant::now();
            let h_summary = std::thread::spawn(move || {
                generate_agent_summary(&cfg_summary, &user_zh_owned, &result_for_summary)
            });

            // translate_input=true 且 agent 实际输出不是中文时才翻译。
            // 仓库内容是中文 / agent 直接 quote 中文文件 → 输出可能是中文，
            // 这种情况跳过翻译省一次 LLM 调用，且避免把中文再翻一遍引入失真。
            let need_out_translate = cfg.translate_input && !is_likely_chinese(result_en);
            let translated = if need_out_translate {
                let cfg_translate = cfg.clone();
                let result_for_translate = result_en.to_string();
                let result_en_fallback = result_en.to_string();
                let h_translate = std::thread::spawn(move || {
                    translate_en_to_zh(&cfg_translate, &result_for_translate)
                });
                h_translate
                    .join()
                    .ok()
                    .and_then(|r| r.ok())
                    .unwrap_or(result_en_fallback)
            } else {
                // 没启用输入翻译 / agent 输出已经是中文：直接用，不再翻译
                result_en.to_string()
            };
            let summary = h_summary.join().ok().and_then(|r| match r {
                Ok(s) => Some(Ok(s)),
                Err(e) => Some(Err(e)),
            });
            eprintln!(
                "[finalize] parallel translate_out + summary done in {}ms (translate_input={}, did_translate_out={})",
                t_parallel.elapsed().as_millis(),
                cfg.translate_input,
                need_out_translate,
            );
            (translated, summary)
        }
        None => (result_en.to_string(), None),
    };

    let (mode, emotion, summary, suggestion_options) = match summary_result {
        Some(Ok(s)) => (
            Some(s.mode),
            Some(s.emotion_speech),
            Some(s.summary_translation),
            Some(s.next_options),
        ),
        Some(Err(e)) => (
            Some("error".into()),
            Some(format!("LLM 总结生成失败: {}", e)),
            Some(format!(
                "Agent 原始输出:\n{}",
                result_zh.chars().take(500).collect::<String>()
            )),
            Some(vec!["重试".into()]),
        ),
        None => {
            let no_llm_hint = "未配置 LLM API Key（在设置中配置后，将自动总结 Agent 输出）";
            (
                Some("complete".into()),
                Some(no_llm_hint.into()),
                Some(result_zh.chars().take(500).collect::<String>()),
                Some(vec!["配置 API Key".into(), "重试".into()]),
            )
        }
    };

    FinalizeOutcome {
        mode,
        emotion,
        summary_translation: summary,
        result_zh,
        suggestion_options,
    }
}

/// 处理 backend turn 的成功结果：英→中翻译 + LLM summary + emit complete + 状态归位。
fn finalize_session(
    app: &AppHandle,
    state: &Arc<AppState>,
    session_id: &str,
    user_zh: &str,
    result_en: String,
    llm: Option<&LlmConfig>,
    // backend native session/thread id（Claude CLI session / Codex thread / OpenCode session）
    // —— emit 给前端持久化，重启后做 resume hint 才能真正续 conversation
    native_session_id: Option<String>,
) {
    let (snapshot, run_id) = match state.manager.lock() {
        Ok(mgr) => mgr
            .sessions
            .get(session_id)
            .map(|s| (Some(Arc::clone(&s.snapshot)), Some(s.run_id.clone())))
            .unwrap_or((None, None)),
        Err(_) => (None, None),
    };

    let outcome = compute_finalize_outcome(user_zh, &result_en, llm);
    let FinalizeOutcome {
        mode,
        emotion,
        summary_translation,
        result_zh,
        suggestion_options,
    } = outcome;

    if let Some(snap) = snapshot {
        if let Ok(mut s) = snap.lock() {
            s.status = match mode.as_deref() {
                Some("error") => AgentStatus::Error,
                _ => AgentStatus::Completed,
            };
            s.last_assistant_message = Some(result_zh.clone());
        }
    }

    let _ = app.emit(
        "agent://session-complete",
        SessionCompletePayload {
            session_id: session_id.to_string(),
            run_id: run_id.clone(),
            agent_native_session_id: native_session_id,
            mode: mode.clone(),
            emotion: emotion.clone(),
            summary_translation: summary_translation.clone(),
            result_raw: Some(result_en.clone()),
            result_zh: Some(result_zh.clone()),
            suggestion_options: suggestion_options.clone(),
        },
    );

    let _ = (result_en, result_zh, suggestion_options);
    clear_active_session(state, session_id);
}

fn fail_session(
    app: &AppHandle,
    state: &Arc<AppState>,
    session_id: &str,
    message: &str,
    code: &str,
) {
    let run_id = state
        .manager
        .lock()
        .ok()
        .and_then(|mgr| mgr.sessions.get(session_id).map(|s| s.run_id.clone()));
    if let Ok(mgr) = state.manager.lock() {
        if let Some(s) = mgr.sessions.get(session_id) {
            if let Ok(mut snap) = s.snapshot.lock() {
                snap.status = AgentStatus::Error;
                snap.last_assistant_message = Some(message.to_string());
            }
        }
    }
    emit_err(app, run_id.as_deref(), session_id, message, code);
    let _ = app.emit(
        "agent://session-complete",
        SessionCompletePayload {
            session_id: session_id.to_string(),
            run_id: run_id.clone(),
            agent_native_session_id: None,
            mode: Some("error".into()),
            emotion: Some(format!("Agent 出错了: {}", message)),
            summary_translation: Some(message.to_string()),
            result_raw: None,
            result_zh: None,
            suggestion_options: Some(vec![]),
        },
    );
    clear_active_session(state, session_id);
}

fn emit_status_running(
    app: &AppHandle,
    run_id: Option<&str>,
    session_id: &str,
    description: &str,
) {
    let _ = app.emit(
        "agent://status-changed",
        events::StatusChangedPayload {
            session_id: session_id.to_string(),
            run_id: run_id.map(ToOwned::to_owned),
            status: AgentStatus::Running,
            tool_name: None,
            tool_description: Some(description.to_string()),
            percent: Some(0.0),
        },
    );
}

fn emit_progress(
    app: &AppHandle,
    run_id: Option<&str>,
    session_id: &str,
    status: AgentStatus,
    description: &str,
    percent: f64,
) {
    let _ = app.emit(
        "agent://status-changed",
        events::StatusChangedPayload {
            session_id: session_id.to_string(),
            run_id: run_id.map(ToOwned::to_owned),
            status,
            tool_name: None,
            tool_description: Some(description.to_string()),
            percent: Some(percent),
        },
    );
}

fn clear_active_session(state: &Arc<AppState>, session_id: &str) {
    if let Ok(mut mgr) = state.manager.lock() {
        mgr.clear_active_session_if(session_id);
    }
}

fn emit_err(
    app: &AppHandle,
    run_id: Option<&str>,
    session_id: &str,
    message: &str,
    code: &str,
) {
    let _ = app.emit(
        "agent://error",
        events::ErrorPayload {
            session_id: session_id.to_string(),
            run_id: run_id.map(ToOwned::to_owned),
            message: message.to_string(),
            code: code.to_string(),
        },
    );
}

// ---------------------------------------------------------------------------
// 停止会话
// ---------------------------------------------------------------------------

/// 真正中断指定 session 的当前 turn。按 backend 类型分别处理：
///
/// - **claude-code**: per-tab 独立 stream client，take 走 client + kill 整个
///   child process。后续 turn 在 ensure_claude_stream_client 里重启；
///   resume_session 字段保留，下次会用 --resume 续上对话。
/// - **codex**: 共享 app-server 不能杀（多 tab 共用），通过 active_turns
///   找该 run_id 的 turn → take waiter 发 Err，让 turn 函数提前返回。
/// - **opencode**: per-tab HTTP server child，复用 opencode_stop 杀掉整个
///   server。后续 turn 在 launch_opencode_agent / opencode_start 里重启。
///
/// 中断后 emit `agent://session-complete` mode=error 让前端从 running
/// 状态退出，避免界面卡在"运行中"。
pub async fn stop_session(
    app: AppHandle,
    state: Arc<AppState>,
    runtime_state: Arc<RuntimeState>,
    session_id: String,
) -> Result<(), String> {
    let (snapshot, run_id, agent_type, prior_status) = {
        let mut mgr = state.manager.lock().map_err(|e| e.to_string())?;
        mgr.clear_active_session_if(&session_id);
        let Some(sess) = mgr.sessions.get_mut(&session_id) else {
            return Err("会话不存在".into());
        };
        let (agent_type, prior_status) = sess
            .snapshot
            .lock()
            .map(|s| (s.agent_type.clone(), s.status))
            .unwrap_or_else(|_| (String::new(), AgentStatus::Idle));
        (
            Arc::clone(&sess.snapshot),
            sess.run_id.clone(),
            agent_type,
            prior_status,
        )
    };

    // 关键判断：上一轮 session 已经 Completed / Error / Idle 了 —— 这是
    // start_agent 内部 "清理上一轮 session 再启动新 turn" 路径的常见情况。
    // 这种情形不应该再 abort backend 也不应该 emit "已停止" 事件
    // （否则会污染刚启动的新 turn 的 ResultCard 显示，并把已经被新 turn
    // 复用的 stream client 杀掉），只是从 manager.sessions 里清理掉旧条目即可。
    let already_finished = matches!(
        prior_status,
        AgentStatus::Completed | AgentStatus::Error | AgentStatus::Idle
    );
    if already_finished {
        eprintln!(
            "[stop] skip abort: session={session_id} already in terminal status {prior_status:?}"
        );
        let _ = runtime_state;
        let _ = app;
        let _ = snapshot;
        let _ = run_id;
        let _ = agent_type;
        return Ok(());
    }

    if let Ok(mut s) = snapshot.lock() {
        s.interrupted = true;
        s.status = AgentStatus::Idle;
    }

    match agent_type.as_str() {
        "claude-code" => {
            // 取出该 tab 的 claude client 并 kill 进程；下次 turn 自动重 spawn
            let client = with_claude_state(&runtime_state, &run_id, |st| st.client.take())
                .ok()
                .flatten();
            if let Some(client) = client {
                kill_claude_client(&client);
                eprintln!("[stop] claude killed for run_id={run_id}");
            }
        }
        "codex" => {
            // 共享 app-server：只中断该 run_id 的 turn，不杀进程
            let client = with_codex_state(&runtime_state, CODEX_SHARED_KEY, |st| st.client.clone())
                .ok()
                .flatten();
            if let Some(client) = client {
                let aborted = client.abort_turns_for_run(&run_id);
                eprintln!("[stop] codex aborted {aborted} turn(s) for run_id={run_id}");
            }
        }
        "opencode" => {
            if let Err(e) =
                crate::agent::opencode::opencode_stop(&runtime_state, &run_id).await
            {
                eprintln!("[stop] opencode_stop failed for run_id={run_id}: {e}");
            }
        }
        other => {
            eprintln!("[stop] unknown agent_type={other}, only emit idle event");
        }
    }

    // 让前端的 ResultCard 出现"已停止"提示；TabBar 状态点回归 idle
    let _ = app.emit(
        "agent://status-changed",
        events::StatusChangedPayload {
            session_id: session_id.clone(),
            run_id: Some(run_id.clone()),
            status: AgentStatus::Idle,
            tool_name: None,
            tool_description: Some("stopped".into()),
            percent: None,
        },
    );
    let _ = app.emit(
        "agent://session-complete",
        SessionCompletePayload {
            session_id: session_id.clone(),
            run_id: Some(run_id),
            agent_native_session_id: None,
            mode: Some("error".into()),
            emotion: Some("任务已停止".into()),
            summary_translation: Some("用户中断了任务。".into()),
            result_raw: None,
            result_zh: None,
            suggestion_options: Some(vec!["重试".into()]),
        },
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// 杂项
// ---------------------------------------------------------------------------

pub fn get_logs(state: Arc<AppState>, session_id: String) -> Result<Vec<String>, String> {
    let mgr = state
        .manager
        .lock()
        .map_err(|_| "lock poisoned".to_string())?;
    let Some(s) = mgr.sessions.get(&session_id) else {
        return Err("会话不存在".into());
    };
    let g = s.logs.lock().map_err(|e| e.to_string())?;
    Ok(g.clone())
}

/// App 退出时清理所有 backend 子进程。
///
/// 退出阶段必须**阻塞拿锁**完成清理，try_lock 拿不到就跳过是漏杀子进程的主因。
/// 顺序：
///   1. drain 三个 backend 各自的 client/state，逐个 kill 子进程树
///   2. kill_opencode_listeners 兜底（防止 drain 漏掉的端口仍被占）
///   3. kill_all_direct_children 杀掉所有未注册到 state 的直系子进程
///   4. cleanup_stale_runtime_orphans 再扫一次 ppid==1 孤儿
pub fn shutdown_runtime_clients(app: &AppHandle) {
    use crate::agent::proc::{
        cleanup_stale_runtime_orphans, kill_all_direct_children, kill_child_descendants,
        kill_opencode_listeners,
    };
    use crate::agent::runtime::{drain_claude_clients, drain_codex_clients, drain_opencode_states};

    let runtime: tauri::State<Arc<RuntimeState>> = app.state();
    let runtime_state: &RuntimeState = runtime.inner().as_ref();

    // 多 tab 模式下遍历每个 run_id 各自的 OpencodeState，逐一杀掉子进程并收集端口。
    let mut opencode_ports: Vec<u16> = Vec::new();
    drain_opencode_states(runtime_state, |_run_id, opencode| {
        if let Some(child) = opencode.child.as_mut() {
            // 先递归杀 opencode 派生的子孙（node MCP servers、shell 工具等），
            // 再杀主进程。缺了这一步 grandchildren 会被 launchd 收养变残留。
            kill_child_descendants(child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
        opencode_ports.push(opencode.port);
        opencode.child = None;
        opencode.session_id = None;
        opencode.managed = false;
    });
    // OpenCode OAuth 回调用 1455 也加进来一起清
    opencode_ports.push(1455);
    let _ = kill_opencode_listeners(&opencode_ports);

    for client in drain_codex_clients(runtime_state) {
        client.stop();
    }

    for client in drain_claude_clients(runtime_state) {
        kill_claude_client(&client);
    }

    // 兜底：杀掉本进程的所有直系子进程（包括未进 state 的 warmup / probe 残留），
    // 退出前杀掉，否则它们会被 launchd 收养成 ppid==1 孤儿，那时已没人能扫它们。
    kill_all_direct_children();

    // 再扫一次 ppid==1 孤儿（上轮崩溃 / 强退留下的可能还在）
    cleanup_stale_runtime_orphans(app);
}

fn kill_claude_client(client: &ClaudeStreamClient) {
    crate::agent::claude::kill_claude_stream_client(client);
}
