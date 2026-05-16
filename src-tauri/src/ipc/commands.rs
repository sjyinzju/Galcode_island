use crate::agent::claude::{self as claude_agent, ClaudeModelsResult, CliRuntimeStatus};
use crate::agent::codex::{self as codex_agent, CodexModelsResult, CodexStatus, CodexVerifyResult};
use crate::agent::manager::{self, LaunchResult};
use crate::agent::opencode::{self as opencode_agent, OpencodeStatus};
use crate::agent::runtime::{RuntimeState, DEFAULT_RUN_ID};
use crate::AppState;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResponse {
    pub ok: bool,
}

/// 多 tab UI 启动 / reattach 时枚举所有活跃会话。
/// 前端拿这个 list 跟自己持久化的 tab 列表对比，决定哪些 tab 还能继续显示进度。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub run_id: String,
    pub agent_type: String,
    pub status: crate::session::state::AgentStatus,
    pub cwd: Option<String>,
    pub stream_id: String,
    pub last_user_prompt: Option<String>,
    pub created_at_ms: u128,
}

/// 返回当前 manager 里所有 session 的摘要快照。
/// 不带状态过滤——已完成 / 出错的也会列出来，让前端决定是否清理。
#[tauri::command]
pub fn list_sessions(state: State<Arc<AppState>>) -> Result<Vec<SessionSummary>, String> {
    let mgr = state.manager.lock().map_err(|e| e.to_string())?;
    let mut summaries: Vec<SessionSummary> = mgr
        .sessions
        .iter()
        .map(|(sid, sess)| {
            let snap = sess.snapshot.lock().ok();
            SessionSummary {
                session_id: sid.clone(),
                run_id: sess.run_id.clone(),
                agent_type: snap
                    .as_ref()
                    .map(|s| s.agent_type.clone())
                    .unwrap_or_default(),
                status: snap
                    .as_ref()
                    .map(|s| s.status)
                    .unwrap_or(crate::session::state::AgentStatus::Idle),
                cwd: snap.as_ref().and_then(|s| s.cwd.clone()),
                stream_id: sess.stream_id.clone(),
                last_user_prompt: snap.as_ref().and_then(|s| s.last_user_prompt.clone()),
                created_at_ms: sess.created_at.elapsed().as_millis(),
            }
        })
        .collect();
    // 按最近创建（elapsed 越小越新）排在前面
    summaries.sort_by_key(|s| s.created_at_ms);
    Ok(summaries)
}

#[tauri::command]
pub fn select_project_folder(app: AppHandle) -> Result<Option<String>, String> {
    Ok(app.dialog().file().blocking_pick_folder().and_then(|fp| {
        fp.into_path()
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    /// 当前列出的目录的绝对路径
    pub path: String,
    /// 父目录的绝对路径；根目录时为 None
    pub parent: Option<String>,
    /// 子目录列表（不含文件，按名称排序，跳过点开头的隐藏项）
    pub entries: Vec<DirectoryEntry>,
}

/// 列目录子项（仅目录），给移动端 / LAN 客户端做项目目录选择用。
/// `path` 为 None / 空时返回用户家目录。Tauri 桌面端通常用原生 dialog，
/// 不会调用本命令，但保留以备 web 调试。
#[tauri::command]
pub fn list_directory(path: Option<String>) -> Result<DirectoryListing, String> {
    let target = match path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => std::path::PathBuf::from(p),
        None => std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(std::path::PathBuf::from)
            .ok_or_else(|| "无法确定家目录（HOME / USERPROFILE 都没设置）".to_string())?,
    };

    if !target.exists() {
        return Err(format!("目录不存在: {}", target.display()));
    }
    if !target.is_dir() {
        return Err(format!("不是目录: {}", target.display()));
    }

    let read = std::fs::read_dir(&target)
        .map_err(|e| format!("读目录失败 {}: {e}", target.display()))?;

    let mut entries: Vec<DirectoryEntry> = Vec::new();
    for item in read {
        let Ok(entry) = item else { continue };
        let Ok(file_type) = entry.file_type() else { continue };
        // 跟随 symlink 目录，但仅列目录
        if !file_type.is_dir()
            && !(file_type.is_symlink() && entry.path().is_dir())
        {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        // 跳过点开头隐藏项（避免 .git / .DS_Store / .config 等噪音）
        if name.starts_with('.') {
            continue;
        }
        entries.push(DirectoryEntry {
            name,
            path: entry.path().to_string_lossy().into_owned(),
        });
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    let parent = target
        .parent()
        .filter(|p| p.as_os_str() != target.as_os_str())
        .map(|p| p.to_string_lossy().into_owned());

    Ok(DirectoryListing {
        path: target.to_string_lossy().into_owned(),
        parent,
        entries,
    })
}

/// 项目 / 用户 / 插件级斜杠命令元数据。
///
/// 来源：
/// - `project`：`{cwd}/.claude/commands/**/*.md`
/// - `user`：`~/.claude/commands/**/*.md`
/// - `plugin`：`~/.claude/plugins/cache/<marketplace>/<plugin>/<ver>/commands/**/*.md`
///
/// 命名：子目录会进入命令名前缀，分隔符 `:`。例如
/// `~/.claude/commands/ecc/plan.md` → `ecc:plan`；插件 `ecc` 下的
/// `commands/agent-sort.md` → `ecc:agent-sort`。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommandMeta {
    /// 命令名，不含开头 `/`；子目录用 `:` 当命名空间分隔符；插件命令带 `<plugin>:` 前缀
    pub name: String,
    /// 来源：project / user / plugin / builtin（builtin 由前端注入，本结构只产出前三种）
    pub source: &'static str,
    /// frontmatter 里的 description；解析失败 / 不存在时为空串
    pub description: String,
    /// frontmatter 里的 argument-hint（提示该命令需要哪些参数）
    pub argument_hint: Option<String>,
    /// 命令定义文件绝对路径，便于前端打开编辑
    pub file_path: String,
    /// 插件名（仅 `plugin` 来源有；其它为 None）。前端可用来分组显示。
    pub plugin: Option<String>,
}

/// 从 .md 文件头部抽 YAML frontmatter 的 `description` / `argument-hint`。
///
/// Claude Code 的命令文件格式是：
/// ```text
/// ---
/// description: ...
/// argument-hint: ...
/// ---
/// <body>
/// ```
/// 这里只挑两个字段，不引 serde_yaml；语法非常稳定（一行一个 key: value）。
fn parse_command_frontmatter(content: &str) -> (String, Option<String>) {
    let mut description = String::new();
    let mut argument_hint: Option<String> = None;

    let trimmed = content.trim_start_matches('\u{feff}');
    let rest = match trimmed.strip_prefix("---") {
        Some(r) => r.trim_start_matches(['\r', '\n']),
        None => return (description, argument_hint),
    };
    // 找闭合的 ---
    let end_idx = rest.find("\n---").or_else(|| rest.find("\r\n---"));
    let block = match end_idx {
        Some(idx) => &rest[..idx],
        None => return (description, argument_hint),
    };

    for line in block.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim().trim_matches('"').trim_matches('\'').to_string();
        match key.as_str() {
            "description" => description = value,
            "argument-hint" => argument_hint = Some(value).filter(|v| !v.is_empty()),
            _ => {}
        }
    }

    (description, argument_hint)
}

/// 递归扫一个 commands 目录。子目录被当作命名空间，最终命令名拼成
/// `<dir1>:<dir2>:<stem>` 形式（点开头的隐藏目录/文件直接跳过）。
fn scan_commands_dir_recursive(
    root: &std::path::Path,
    subdir: &std::path::Path,
    namespace: Vec<String>,
    source: &'static str,
    plugin: Option<&str>,
    out: &mut Vec<SlashCommandMeta>,
) {
    let scan_path = root.join(subdir);
    let Ok(read) = std::fs::read_dir(&scan_path) else { return };
    for entry in read.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else { continue };
        let file_name = entry.file_name();
        let name_str = file_name.to_string_lossy();
        if name_str.starts_with('.') {
            continue;
        }

        if file_type.is_dir() {
            // 限制递归深度避免病态目录结构爆栈：命名空间嵌套不应超过 4 层
            if namespace.len() >= 4 {
                continue;
            }
            let mut next_ns = namespace.clone();
            next_ns.push(name_str.into_owned());
            scan_commands_dir_recursive(
                root,
                &subdir.join(&file_name),
                next_ns,
                source,
                plugin,
                out,
            );
            continue;
        }

        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        if stem.is_empty() {
            continue;
        }
        let full_name = if namespace.is_empty() {
            // 顶层命令：插件来源默认套上 `<plugin>:` 前缀，模仿 Claude Code CLI 行为
            if let Some(p) = plugin {
                if stem == p {
                    // 插件目录里同名文件（feature-dev.md 在 feature-dev 插件下）就是
                    // "默认命令"，名字直接用插件名，不重复
                    p.to_string()
                } else {
                    format!("{p}:{stem}")
                }
            } else {
                stem.to_string()
            }
        } else {
            let prefix = namespace.join(":");
            if let Some(p) = plugin {
                format!("{p}:{prefix}:{stem}")
            } else {
                format!("{prefix}:{stem}")
            }
        };

        let content = std::fs::read_to_string(&path).unwrap_or_default();
        let (description, argument_hint) = parse_command_frontmatter(&content);
        out.push(SlashCommandMeta {
            name: full_name,
            source,
            description,
            argument_hint,
            file_path: path.to_string_lossy().into_owned(),
            plugin: plugin.map(ToOwned::to_owned),
        });
    }
}

fn scan_commands_dir(dir: &std::path::Path, source: &'static str, out: &mut Vec<SlashCommandMeta>) {
    scan_commands_dir_recursive(dir, std::path::Path::new(""), Vec::new(), source, None, out);
}

/// 扫 `~/.claude/plugins/installed_plugins.json` 列出的所有插件，读它们的
/// `<installPath>/commands/**/*.md`。每个命令命名 `<plugin>:<file-stem>`
/// （子目录嵌入到 `:` 分隔的中间段）。
fn scan_installed_plugin_commands(out: &mut Vec<SlashCommandMeta>) {
    let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) else {
        return;
    };
    let manifest_path = std::path::PathBuf::from(&home)
        .join(".claude")
        .join("plugins")
        .join("installed_plugins.json");
    let Ok(text) = std::fs::read_to_string(&manifest_path) else { return };
    let Ok(json) = serde_json::from_str::<Value>(&text) else { return };

    let Some(map) = json.get("plugins").and_then(Value::as_object) else { return };
    for (key, entries) in map {
        // key 形如 "ecc@everything-claude-code"；插件名取 `@` 之前
        let plugin_name = key.split('@').next().unwrap_or(key).trim();
        if plugin_name.is_empty() {
            continue;
        }
        let Some(array) = entries.as_array() else { continue };
        // 一份 installed_plugins.json 里同插件可能多实例（user / project scope）；都扫
        for entry in array {
            let Some(install_path) = entry.get("installPath").and_then(Value::as_str) else {
                continue;
            };
            let commands_dir = std::path::PathBuf::from(install_path).join("commands");
            if commands_dir.is_dir() {
                scan_commands_dir_recursive(
                    &commands_dir,
                    std::path::Path::new(""),
                    Vec::new(),
                    "plugin",
                    Some(plugin_name),
                    out,
                );
            }
        }
    }
}

/// 列出当前项目 + 用户家目录 + 已安装插件下定义的斜杠命令。
///
/// 前端在 chat 输入框敲 `/` 时把结果合并进下拉。同名时优先级
/// `project` > `user` > `plugin`，保持与 Claude Code CLI 的覆盖语义一致。
#[tauri::command]
pub fn list_project_slash_commands(cwd: Option<String>) -> Result<Vec<SlashCommandMeta>, String> {
    let mut commands: Vec<SlashCommandMeta> = Vec::new();

    // 插件级（最低优先级，先扫）
    scan_installed_plugin_commands(&mut commands);

    // 用户级（覆盖同名 plugin）
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let user_dir = std::path::PathBuf::from(home).join(".claude").join("commands");
        if user_dir.is_dir() {
            let mut user_cmds = Vec::new();
            scan_commands_dir(&user_dir, "user", &mut user_cmds);
            let user_names: std::collections::HashSet<String> =
                user_cmds.iter().map(|c| c.name.clone()).collect();
            commands.retain(|c| !user_names.contains(&c.name));
            commands.extend(user_cmds);
        }
    }

    // 项目级（覆盖同名 user / plugin）
    if let Some(cwd) = cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let project_dir = std::path::PathBuf::from(cwd).join(".claude").join("commands");
        if project_dir.is_dir() {
            let mut project_cmds = Vec::new();
            scan_commands_dir(&project_dir, "project", &mut project_cmds);
            let project_names: std::collections::HashSet<String> =
                project_cmds.iter().map(|c| c.name.clone()).collect();
            commands.retain(|c| !project_names.contains(&c.name));
            commands.extend(project_cmds);
        }
    }

    commands.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(commands)
}

/// 中文任务 → 翻译 → 启动 Agent（claude-code / opencode / codex / demo）。
/// 工作目录默认 `.`，可通过 `cwd` 指定。
///
/// `run_id` 是 tab 标识：多 tab UI 下每个 tab 独占一个 run_id，所有
/// IPC 事件按 run_id 分发到对应 tab slice。前端不传时兜底 DEFAULT_RUN_ID
/// （单 tab 模式下兼容老调用路径）。
///
/// 多 tab 模式下，**不再**强行 stop 上一个 active_session：
/// 每个 tab 独立运行，互不干扰；只有传入相同 run_id 时才会替换原有任务。
#[tauri::command]
pub async fn start_agent(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    runtime_state: State<'_, Arc<RuntimeState>>,
    user_input_zh: String,
    cwd: Option<String>,
    agent: Option<String>,
    run_id: Option<String>,
    // 可选：前端持久化的 tab.sessionId（重启 app 后内存 last_session_per_context
    // 是空的，前端 localStorage 留着 sessionId，传过来当 resume hint）。
    session_id: Option<String>,
    // 仅 claude-code 使用：Claude CLI 的 --permission-mode 参数值，
    // 来自 tab.permissionMode（Shift+Tab 切换 / 全局默认）。其它 backend 忽略此参数。
    permission_mode: Option<String>,
    // 可选：当前桌宠图自带的"团长文案风格 prompt"。非空 → finalize 时整段替换
    // 凉宫春日人设；空 → 走默认凉宫风。前端从当前 visualState 对应的 community
    // 桌宠图元数据里取（不是社区图 / 无 prompt 则不传）。
    prompt_override: Option<String>,
) -> Result<LaunchResult, String> {
    let cwd = cwd.unwrap_or_else(|| ".".to_string());
    let agent_type = agent
        .clone()
        .unwrap_or_else(|| "claude-code".to_string());
    let run_id = run_id.unwrap_or_else(|| DEFAULT_RUN_ID.to_string());

    eprintln!(
        "[galcode] start_agent: run_id={run_id} agent={agent_type} cwd={cwd} input_len={}",
        user_input_zh.len()
    );

    // 如果同 run_id 还有未完成的会话，先停掉再重启（同 tab 内只能跑一个 turn）。
    // 不同 run_id 的并发会话互不影响。
    let prev = {
        let mgr = state.manager.lock().map_err(|e| e.to_string())?;
        mgr.sessions
            .iter()
            .find(|(_, sess)| sess.run_id == run_id)
            .map(|(sid, _)| sid.clone())
    };
    if let Some(sid) = prev {
        let _ = manager::stop_session(
            app.clone(),
            Arc::clone(state.inner()),
            Arc::clone(runtime_state.inner()),
            sid,
        )
        .await;
    }

    let result = match agent_type.as_str() {
        "claude-code" => manager::launch_claude_agent(
            app,
            Arc::clone(state.inner()),
            Arc::clone(runtime_state.inner()),
            run_id,
            cwd,
            user_input_zh,
            session_id,
            permission_mode,
            prompt_override,
        ),
        "opencode" => manager::launch_opencode_agent(
            app,
            Arc::clone(state.inner()),
            Arc::clone(runtime_state.inner()),
            run_id,
            cwd,
            user_input_zh,
            session_id,
            prompt_override,
        ),
        "codex" => manager::launch_codex_agent(
            app,
            Arc::clone(state.inner()),
            Arc::clone(runtime_state.inner()),
            run_id,
            cwd,
            user_input_zh,
            session_id,
            prompt_override,
        ),
        _ => Err(format!("暂不支持的 agent 类型: {}", agent_type)),
    };
    match &result {
        Ok(r) => eprintln!("[galcode] start_agent ok, sid={}", r.session_id),
        Err(e) => eprintln!("[galcode] start_agent FAILED: {}", e),
    }
    result
}

/// 停止指定会话。
///
/// 优先级：`session_id` > `run_id` 反查会话 > active_session 兜底。
/// 多 tab 模式下推荐传 `run_id`：从该 tab 的 sessions 里找当前 active 的会话停掉。
#[tauri::command]
pub async fn stop_agent(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    runtime_state: State<'_, Arc<RuntimeState>>,
    session_id: Option<String>,
    run_id: Option<String>,
) -> Result<(), String> {
    let sid = session_id
        .or_else(|| {
            run_id.as_ref().and_then(|rid| {
                state.manager.lock().ok().and_then(|mgr| {
                    mgr.sessions
                        .iter()
                        .find(|(_, sess)| sess.run_id == *rid)
                        .map(|(sid, _)| sid.clone())
                })
            })
        })
        .or_else(|| {
            state
                .manager
                .lock()
                .ok()
                .and_then(|m| m.active_session.clone())
        })
        .ok_or_else(|| "没有可停止的会话".to_string())?;
    manager::stop_session(
        app,
        Arc::clone(state.inner()),
        Arc::clone(runtime_state.inner()),
        sid,
    )
    .await
}

/// 老接口，沿用 session_id + tool_use_id 形式；现已无用（permission_mcp 用独立的
/// request_id 路由），但保留 export 让 LAN dispatch 不破。新调用走
/// [`respond_permission_decision`]。
#[tauri::command]
pub fn respond_permission(
    state: State<Arc<AppState>>,
    session_id: String,
    tool_use_id: String,
    decision: String,
) -> Result<PermissionResponse, String> {
    let mut mgr = state.manager.lock().map_err(|e| e.to_string())?;
    mgr.respond_permission_stub(&session_id, &tool_use_id, &decision)?;
    Ok(PermissionResponse { ok: true })
}

/// 实战版：给 permission-prompt-tool MCP 桥接用。前端 PermissionCard
/// 用户点 Allow / Deny 后调本命令，按 request_id 解出阻塞中的 MCP handler
/// 线程并把决策传回去，Claude CLI 收到决策继续 / 终止该工具调用。
#[tauri::command]
pub fn respond_permission_decision(
    request_id: String,
    decision: String,
    message: Option<String>,
    updated_input: Option<Value>,
) -> Result<PermissionResponse, String> {
    let normalized = match decision.as_str() {
        "allow" | "approve" | "yes" => "allow".to_string(),
        _ => "deny".to_string(),
    };
    let resolved = crate::permission_mcp::resolve(
        &request_id,
        crate::permission_mcp::PermissionDecision {
            decision: normalized,
            message,
            updated_input,
        },
    );
    if !resolved {
        return Err(format!(
            "找不到对应的审批请求（已超时或被重复响应？request_id={request_id}）"
        ));
    }
    Ok(PermissionResponse { ok: true })
}

#[tauri::command]
pub fn get_session_logs(
    state: State<Arc<AppState>>,
    session_id: String,
) -> Result<Vec<String>, String> {
    manager::get_logs(Arc::clone(state.inner()), session_id)
}

/// 重启后接续翻译+总结：用户在 finalize_session 跑到一半（agent 已完成
/// 但 LLM 翻译/总结还在跑）退出 app，重启时前端 reattach 检测到 tab.pending*
/// 字段 → 调这个命令把英文 result_raw + 中文 user_zh 重新喂给 LLM 管线，
/// 跑完后 emit `agent://session-complete` 让 ResultCard 显示。
///
/// 跟 finalize_session 共用 compute_finalize_outcome 核心逻辑，但**不依赖**
/// mgr.sessions（重启后那是空的）—— 直接用入参 sessionId/runId emit。
#[tauri::command]
pub async fn finalize_pending(
    app: AppHandle,
    run_id: String,
    session_id: String,
    user_zh: String,
    result_raw: String,
    // 上轮的 backend native session id（前端持久化的 tab.agentNativeSessionId），
    // emit 给前端做 round-trip 持久化 —— 退出再次重启后还能续上
    agent_native_session_id: Option<String>,
) -> Result<(), String> {
    use crate::ipc::events::SessionCompletePayload;
    use tauri::Emitter;

    let handle = app.clone();
    let join = tokio::task::spawn_blocking(move || {
        let llm = crate::llm::load_llm_config();
        // finalize_pending 是"上次 turn 已经拿到 raw result 但 LLM 总结被打断"的兜底重试
        // —— 此时 AgentSession 不一定还存在，没有 prompt_override 来源，按默认凉宫风走。
        let outcome = crate::agent::manager::compute_finalize_outcome(
            &user_zh,
            &result_raw,
            llm.as_ref(),
            None,
        );

        let _ = handle.emit(
            "agent://session-complete",
            SessionCompletePayload {
                session_id: session_id.clone(),
                run_id: Some(run_id),
                agent_native_session_id,
                mode: outcome.mode,
                emotion: outcome.emotion,
                summary_translation: outcome.summary_translation,
                result_raw: Some(result_raw),
                result_zh: Some(outcome.result_zh),
                suggestion_options: outcome.suggestion_options,
            },
        );
    });
    join.await
        .map_err(|e| format!("finalize_pending task failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn translate_only(text_zh: String) -> Result<String, String> {
    let cfg = crate::llm::load_llm_config().ok_or_else(|| "未配置 LLM_API_KEY".to_string())?;
    crate::llm::translate_zh_to_en(&cfg, &text_zh)
}

/// 用 LLM 实时生成"进入软件时的欢迎语"。
/// 前端在 welcome 状态时检查当前 welcome 类图是否带 prompt，有则调本命令生成。
/// 未配 LLM_API_KEY / 任何错误：返回 Err 让前端回退到内置 GREETINGS。
///
/// **关键**：标 async + 用 spawn_blocking 把同步 reqwest::blocking 分流到工作线程，
/// 不会阻塞 Tauri 主线程（否则 webview 会冻 3-4s）。
#[tauri::command]
pub async fn generate_welcome_speech(
    persona: Option<String>,
    nickname: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = crate::llm::load_llm_config()
            .ok_or_else(|| "未配置 LLM_API_KEY".to_string())?;
        crate::llm::generate_welcome_speech(&cfg, persona.as_deref(), nickname.as_deref())
    })
    .await
    .map_err(|e| format!("spawn_blocking err: {e}"))?
}

/// 用户点击桌宠时生成"被戳/触摸"互动台词。
/// 前端在 PetCharacter handleClick 触发，自带 5s 冷却（连点不重复 fire）。
///
/// 同 welcome_speech：async + spawn_blocking，避免 reqwest::blocking 占主线程导致
/// 点桌宠时 UI 卡 3-4s。
#[tauri::command]
pub async fn generate_poke_speech(
    persona: Option<String>,
    nickname: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = crate::llm::load_llm_config()
            .ok_or_else(|| "未配置 LLM_API_KEY".to_string())?;
        crate::llm::generate_poke_speech(&cfg, persona.as_deref(), nickname.as_deref())
    })
    .await
    .map_err(|e| format!("spawn_blocking err: {e}"))?
}

#[tauri::command]
pub fn update_llm_settings(
    base_url: String,
    api_key: String,
    nickname: String,
    system_prompt: String,
    provider: Option<String>,
    model: Option<String>,
    thinking: Option<bool>,
    translate_input: Option<bool>,
) -> Result<(), String> {
    crate::llm::client::update_global_settings(
        base_url,
        api_key,
        nickname,
        system_prompt,
        provider.unwrap_or_default(),
        model.unwrap_or_default(),
        thinking.unwrap_or(false),
        translate_input.unwrap_or(false),
    );
    Ok(())
}

/// 拉取 OpenAI 兼容服务商的模型列表（DeepSeek / OpenAI / Moonshot / 通义 / 智谱 等）。
/// `base_url` 和 `apiKey` 由前端传入，因为用户可能在保存前就想试探。
#[tauri::command]
pub async fn list_llm_models(
    base_url: String,
    api_key: String,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || crate::llm::client::list_models(&base_url, &api_key))
        .await
        .map_err(|error| format!("list_llm_models task failed: {error}"))?
}

/// 写入某个 backend 的运行时偏好。
/// 通用字段 model/effort/proxy/binary，加 OpenCode 专属的 provider/apiKey/authMode。
/// 后端的 launch_*_agent 在每次 turn 启动时都会读这份偏好。
/// `backend` 取值：`"claude-code" | "codex" | "opencode"`。
///
/// 副作用：每次调用都顺手 `notify_one` 一下 `boot_prefs_ready` 门闩，让 boot
/// 阶段等"前端 prefs 就绪"的延后任务（opencode auto-start）能开始动作。
/// Notify 自带幂等性，多调几次没事；非 boot 阶段（用户改 settings）的调用也只
/// 是消耗一个永远没人等的 permit，无副作用。
#[tauri::command]
pub fn update_backend_preferences(
    runtime_state: State<'_, Arc<RuntimeState>>,
    backend: String,
    model: Option<String>,
    effort: Option<String>,
    proxy: Option<String>,
    binary: Option<String>,
    provider: Option<String>,
    api_key: Option<String>,
    auth_mode: Option<String>,
    default_permission_mode: Option<String>,
) -> Result<(), String> {
    crate::agent::preferences::update_backend_preferences(
        &backend,
        model,
        effort,
        proxy,
        binary,
        provider,
        api_key,
        auth_mode,
        default_permission_mode,
    )?;
    runtime_state.boot_prefs_ready.notify_one();
    Ok(())
}

#[tauri::command]
pub fn set_click_through(app: AppHandle, enabled: bool) -> Result<(), String> {
    let w = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到 main 窗口".to_string())?;
    crate::window_utils::set_click_through(&w, enabled)
}

// ===========================================================================
// 细粒度 backend 命令（与 designcode 风格对齐）
//
// 这些命令是"原始接口"——不走 LLM 翻译/总结管线，直接 spawn / send / 等响应。
// 当前 ChatBubble UI 仍然用 `start_agent`（套了 LLM + 凉宫春日总结），新命令
// 给 Settings / 调试面板 / 未来多 tab 直连场景使用。
// ===========================================================================

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

// status / models 内部会 spawn `claude --version` / `claude auth status` /
// `claude --help` 三个子进程顺序 wait（首次还要 stage bundled binary 复制 ~220MB）
// 整体 4-8s 是常态。改成 async + spawn_blocking 把阻塞挪到 tokio blocking pool，
// 主线程不卡，前端 SettingsModal 能立即弹出再异步刷新状态条。

#[tauri::command]
pub async fn claude_status(
    app: AppHandle,
    binary: Option<String>,
) -> Result<CliRuntimeStatus, String> {
    let handle = app.clone();
    tokio::task::spawn_blocking(move || claude_agent::claude_status_snapshot(&handle, binary.as_deref()))
        .await
        .map_err(|error| format!("claude_status task failed: {error}"))?
}

#[tauri::command]
pub async fn claude_models(
    app: AppHandle,
    binary: Option<String>,
) -> Result<ClaudeModelsResult, String> {
    let handle = app.clone();
    tokio::task::spawn_blocking(move || claude_agent::build_claude_model_catalog(&handle, binary.as_deref()))
        .await
        .map_err(|error| format!("claude_models task failed: {error}"))?
}

#[tauri::command]
pub async fn claude_verify(
    app: AppHandle,
    model: Option<String>,
    effort: Option<String>,
    binary: Option<String>,
    proxy: Option<String>,
) -> Result<CodexVerifyResult, String> {
    let handle = app.clone();
    let join = tokio::task::spawn_blocking(move || {
        claude_agent::run_claude_probe(
            &handle,
            model.as_deref(),
            effort.as_deref(),
            binary.as_deref(),
            proxy.as_deref(),
        )
    });
    let message = join
        .await
        .map_err(|error| format!("Claude verification task failed to join: {error}"))??;
    Ok(CodexVerifyResult { ok: true, message })
}

#[tauri::command]
pub async fn claude_login_open(
    app: AppHandle,
    binary: Option<String>,
    proxy: Option<String>,
) -> Result<String, String> {
    let handle = app.clone();
    tokio::task::spawn_blocking(move || {
        claude_agent::open_claude_login_terminal(&handle, binary.as_deref(), proxy.as_deref())
    })
    .await
    .map_err(|error| format!("claude_login_open task failed: {error}"))?
}

/// 通用：在系统终端新开窗口跑 `claude <args>`。用来桥接 Claude CLI 的内置交互命令
/// （/logout /doctor /upgrade /init /migrate-installer 等），这些只在 TTY 模式才有效。
#[tauri::command]
pub async fn claude_run_in_terminal(
    app: AppHandle,
    args: Vec<String>,
    binary: Option<String>,
    proxy: Option<String>,
    success_message: Option<String>,
) -> Result<String, String> {
    let handle = app.clone();
    let cmd_text = args.join(" ");
    let msg = success_message
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("已在系统终端运行 `claude {cmd_text}`。"));
    tokio::task::spawn_blocking(move || {
        claude_agent::open_claude_terminal_with_args(
            &handle,
            binary.as_deref(),
            proxy.as_deref(),
            &args,
            &msg,
        )
    })
    .await
    .map_err(|error| format!("claude_run_in_terminal task failed: {error}"))?
}

/// Claude 原始 turn —— 不翻译、不套总结，直接走 stream-json。
/// 返回 { sessionId, output }（output 是 CLI 英文原文）。
#[tauri::command]
pub async fn claude_send_prompt(
    app: AppHandle,
    runtime_state: State<'_, Arc<RuntimeState>>,
    run_id: Option<String>,
    text: String,
    cwd: String,
    session_id: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    binary: Option<String>,
    proxy: Option<String>,
    permission_mode: Option<String>,
    stream_id: Option<String>,
) -> Result<Value, String> {
    let runtime = Arc::clone(runtime_state.inner());
    let run = run_id.unwrap_or_else(|| DEFAULT_RUN_ID.to_string());
    let handle = app.clone();
    let join = tokio::task::spawn_blocking(move || {
        claude_agent::run_claude_stream_turn(
            &handle,
            runtime.as_ref(),
            &run,
            &text,
            &cwd,
            session_id.as_deref(),
            model.as_deref(),
            effort.as_deref(),
            binary.as_deref(),
            proxy.as_deref(),
            permission_mode.as_deref(),
            stream_id.as_deref(),
        )
    });
    let (next_session_id, output) = join
        .await
        .map_err(|error| format!("Claude prompt task failed to join: {error}"))??;
    Ok(json!({
        "sessionId": next_session_id,
        "output": output,
    }))
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn codex_status(app: AppHandle, binary: Option<String>) -> Result<CodexStatus, String> {
    let handle = app.clone();
    tokio::task::spawn_blocking(move || codex_agent::codex_status_snapshot(&handle, binary.as_deref()))
        .await
        .map_err(|error| format!("codex_status task failed: {error}"))?
}

/// 拉 Codex 官方模型目录（走 `codex debug models` 的 JSON dump）。
/// 跟 claude_models 平行；前端在 ProjectOverview / SettingsModal 里都靠它拉下拉数据。
#[tauri::command]
pub async fn codex_models(
    app: AppHandle,
    binary: Option<String>,
) -> Result<CodexModelsResult, String> {
    let handle = app.clone();
    tokio::task::spawn_blocking(move || codex_agent::build_codex_model_catalog(&handle, binary.as_deref()))
        .await
        .map_err(|error| format!("codex_models task failed: {error}"))?
}

#[tauri::command]
pub async fn codex_verify(
    app: AppHandle,
    model: Option<String>,
    reasoning_effort: Option<String>,
    binary: Option<String>,
    proxy: Option<String>,
) -> Result<CodexVerifyResult, String> {
    let handle = app.clone();
    let join = tokio::task::spawn_blocking(move || {
        codex_agent::run_codex_probe(
            &handle,
            model.as_deref(),
            reasoning_effort.as_deref(),
            binary.as_deref(),
            proxy.as_deref(),
        )
    });
    let message = join
        .await
        .map_err(|error| format!("Codex verification task failed to join: {error}"))??;
    Ok(CodexVerifyResult { ok: true, message })
}

#[tauri::command]
pub async fn codex_login_open(
    app: AppHandle,
    binary: Option<String>,
    device_auth: Option<bool>,
    proxy: Option<String>,
) -> Result<String, String> {
    let handle = app.clone();
    tokio::task::spawn_blocking(move || {
        codex_agent::open_codex_login_terminal(
            &handle,
            binary.as_deref(),
            device_auth.unwrap_or(false),
            proxy.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("codex_login_open task failed: {error}"))?
}

/// Codex 原始 turn —— 通过 app-server JSON-RPC，不翻译、不套总结。
/// 返回 { threadId, output }。
#[tauri::command]
pub async fn codex_send_prompt(
    app: AppHandle,
    runtime_state: State<'_, Arc<RuntimeState>>,
    run_id: Option<String>,
    thread_id: Option<String>,
    text: String,
    system: Option<String>,
    cwd: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    binary: Option<String>,
    proxy: Option<String>,
    stream_id: Option<String>,
) -> Result<Value, String> {
    let runtime = Arc::clone(runtime_state.inner());
    let run = run_id.unwrap_or_else(|| DEFAULT_RUN_ID.to_string());
    let handle = app.clone();
    let join = tokio::task::spawn_blocking(move || {
        codex_agent::run_codex_app_server_turn(
            &handle,
            runtime.as_ref(),
            &run,
            &cwd,
            thread_id.as_deref(),
            system.as_deref(),
            &text,
            model.as_deref(),
            reasoning_effort.as_deref(),
            binary.as_deref(),
            proxy.as_deref(),
            stream_id.as_deref(),
        )
    });
    let (next_thread_id, output) = join
        .await
        .map_err(|error| format!("Codex prompt task failed to join: {error}"))??;
    Ok(json!({
        "threadId": next_thread_id,
        "output": output,
    }))
}

// ---------------------------------------------------------------------------
// OpenCode（生命周期 + send_prompt）
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn opencode_status(
    app: AppHandle,
    runtime_state: State<'_, Arc<RuntimeState>>,
    run_id: Option<String>,
) -> Result<OpencodeStatus, String> {
    let run = run_id.unwrap_or_else(|| DEFAULT_RUN_ID.to_string());
    opencode_agent::snapshot_opencode(&app, runtime_state.inner().as_ref(), &run).await
}

#[tauri::command]
pub async fn opencode_start(
    app: AppHandle,
    runtime_state: State<'_, Arc<RuntimeState>>,
    run_id: Option<String>,
    binary: Option<String>,
    proxy: Option<String>,
    port: Option<u16>,
    cwd: Option<String>,
) -> Result<OpencodeStatus, String> {
    let run = run_id.unwrap_or_else(|| DEFAULT_RUN_ID.to_string());
    opencode_agent::opencode_start(
        &app,
        runtime_state.inner().as_ref(),
        &run,
        binary.as_deref(),
        proxy.as_deref(),
        port,
        cwd.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn opencode_stop(
    runtime_state: State<'_, Arc<RuntimeState>>,
    run_id: Option<String>,
) -> Result<OpencodeStatus, String> {
    let run = run_id.unwrap_or_else(|| DEFAULT_RUN_ID.to_string());
    opencode_agent::opencode_stop(runtime_state.inner().as_ref(), &run).await
}

#[tauri::command]
pub async fn opencode_create_session(
    app: AppHandle,
    runtime_state: State<'_, Arc<RuntimeState>>,
    run_id: Option<String>,
    title: Option<String>,
    directory: Option<String>,
) -> Result<String, String> {
    let run = run_id.unwrap_or_else(|| DEFAULT_RUN_ID.to_string());
    opencode_agent::opencode_create_session(
        &app,
        runtime_state.inner().as_ref(),
        &run,
        title.as_deref(),
        directory.as_deref(),
    )
    .await
}

/// 把用户填的 API Key 写到 OpenCode 的 auth.json（合并写入，不覆盖其它 provider）。
/// `mode == "key"` 写 `{type:"api", key}`；`mode == "oauth"` 把已有的 api 类型条目清掉
/// （让用户随后跑 opencode_login_open 走 OAuth 流程重新写入）；空串删除条目。
#[tauri::command]
pub async fn opencode_set_auth(
    provider: String,
    mode: String,
    api_key: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        opencode_agent::upsert_opencode_auth_entry(&provider, &mode, api_key.as_deref())
    })
    .await
    .map_err(|error| format!("opencode_set_auth task failed: {error}"))?
}

/// 在系统终端打开 `opencode auth login [provider]` 让用户走 OAuth/CLI 交互式登录。
#[tauri::command]
pub async fn opencode_login_open(
    app: AppHandle,
    binary: Option<String>,
    provider: Option<String>,
    proxy: Option<String>,
) -> Result<String, String> {
    let handle = app.clone();
    tokio::task::spawn_blocking(move || {
        opencode_agent::open_opencode_login_terminal(
            &handle,
            binary.as_deref(),
            provider.as_deref(),
            proxy.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("opencode_login_open task failed: {error}"))?
}

/// 拉服务商 + 模型清单。需要 OpenCode serve 已经启动，没启动时回落到 auth.json 里
/// 已有 provider 的最小集合（model 列表为空）。前端可通过 `cwd` 让 serve 用对应工程目录。
#[tauri::command]
pub async fn opencode_list_providers(
    app: AppHandle,
    runtime_state: State<'_, Arc<RuntimeState>>,
    run_id: Option<String>,
) -> Result<Vec<opencode_agent::OpencodeProviderInfo>, String> {
    let run = run_id.unwrap_or_else(|| DEFAULT_RUN_ID.to_string());
    let status = opencode_agent::snapshot_opencode(&app, runtime_state.inner().as_ref(), &run).await?;
    opencode_agent::list_opencode_providers(status.port).await
}

/// OpenCode 原始 turn —— HTTP POST + SSE，session_id 必须先 create。
/// 返回 { text, raw }（text 是从 message list 提取的纯文本）。
#[tauri::command]
pub async fn opencode_send_prompt(
    app: AppHandle,
    runtime_state: State<'_, Arc<RuntimeState>>,
    run_id: Option<String>,
    session_id: String,
    text: String,
    system: Option<String>,
    directory: Option<String>,
    stream_id: Option<String>,
    provider: Option<String>,
    model: Option<String>,
) -> Result<Value, String> {
    let run = run_id.unwrap_or_else(|| DEFAULT_RUN_ID.to_string());
    let (final_text, raw) = opencode_agent::run_opencode_turn(
        &app,
        runtime_state.inner().as_ref(),
        &run,
        &session_id,
        &text,
        system.as_deref(),
        directory.as_deref(),
        stream_id.as_deref(),
        provider.as_deref(),
        model.as_deref(),
    )
    .await?;
    Ok(json!({ "text": final_text, "raw": raw }))
}

// ---------------------------------------------------------------------------
// 局域网移动端访问（lan_*）
//
// 让用户在桌面端开一个内置 HTTP 服务（绑 0.0.0.0:port），手机扫 URL 即可登录管理项目。
// 设计要点：
//   - 必须先设置密码才能启用：lan_set_password 写哈希；启用时若密码空 → 拒绝
//   - 改密码自动撤销所有现有 token：避免老设备无声续用
//   - 启停是同步的：spawn_server 在 Rust 主进程开线程，立刻返回端口；前端马上能取 URL
//   - 前端定期 invoke lan_sync_projects 把 tabs/history 推过来，HTTP 服务端拿到镜像直发
//     给移动端 —— 避免在 Rust 端再造一套项目数据模型
// ---------------------------------------------------------------------------

use crate::lan::config::{self as lan_config, LanConfig};
use crate::lan::network as lan_network;
use crate::lan::state::{LanRuntimeState, ProjectsSnapshot, ProjectSnapshotItem};
use crate::lan::{auth as lan_auth, server as lan_server};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanDeviceInfo {
    pub label: String,
    pub created_at: u64,
    pub expires_at: u64,
    /// 出于隐私，前端只展示 token 前 6 字（足够区分多个设备）
    pub token_preview: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanStateInfo {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub running_port: Option<u16>,
    pub has_password: bool,
    /// 局域网可访问的完整 URL（取局域网 IPv4 + port 拼出来）
    pub urls: Vec<String>,
    /// 主机所有探测到的 IPv4 地址（含 LAN 与可能的公网/VPN 地址）
    pub interfaces: Vec<String>,
    pub devices: Vec<LanDeviceInfo>,
}

fn build_state_info(app: &AppHandle, cfg: &LanConfig, lan: &LanRuntimeState) -> LanStateInfo {
    let server = lan.server.lock().ok();
    let running = server.as_ref().map(|s| s.thread.is_some()).unwrap_or(false);
    let running_port = server.as_ref().and_then(|s| s.running_port);
    let port = running_port.unwrap_or(cfg.port);
    let _ = app; // 预留：未来加 OS 名称、平台 hint
    let interfaces = lan_network::detect_lan_ipv4();
    let urls = if running {
        interfaces
            .iter()
            .filter(|ip| lan_network::is_lan_ipv4(ip))
            .map(|ip| format!("http://{ip}:{port}/"))
            .collect()
    } else {
        Vec::new()
    };
    let devices = cfg
        .tokens
        .iter()
        .map(|t| LanDeviceInfo {
            label: t.label.clone(),
            created_at: t.created_at,
            expires_at: t.expires_at,
            token_preview: t.token.chars().take(6).collect(),
        })
        .collect();
    LanStateInfo {
        enabled: cfg.enabled,
        running,
        port: cfg.port,
        running_port,
        has_password: cfg.has_password(),
        urls,
        interfaces,
        devices,
    }
}

#[tauri::command]
pub fn lan_get_state(
    app: AppHandle,
    lan: State<Arc<LanRuntimeState>>,
) -> Result<LanStateInfo, String> {
    let cfg = lan_config::load(&app);
    Ok(build_state_info(&app, &cfg, lan.inner()))
}

#[tauri::command]
pub fn lan_set_password(
    app: AppHandle,
    lan: State<Arc<LanRuntimeState>>,
    password: String,
) -> Result<LanStateInfo, String> {
    let trimmed = password.trim();
    if trimmed.len() < 4 {
        return Err("密码至少 4 位".to_string());
    }
    let mut cfg = lan_config::load(&app);
    let salt = lan_auth::generate_salt();
    let hash = lan_auth::hash_password(&salt, trimmed);
    cfg.password_salt = salt;
    cfg.password_hash = hash;
    // 改密 → 强制所有移动端重新登录（防止老 token 无声续用）
    cfg.tokens.clear();
    lan_config::save(&app, &cfg)?;
    Ok(build_state_info(&app, &cfg, lan.inner()))
}

#[tauri::command]
pub fn lan_clear_password(
    app: AppHandle,
    lan: State<Arc<LanRuntimeState>>,
) -> Result<LanStateInfo, String> {
    let mut cfg = lan_config::load(&app);
    cfg.password_hash.clear();
    cfg.password_salt.clear();
    cfg.tokens.clear();
    cfg.enabled = false;
    lan_config::save(&app, &cfg)?;
    // 同步停服
    let mut server = lan.server.lock().map_err(|e| e.to_string())?;
    let thread = server.thread.take();
    let stop_flag = server.stop_flag.take();
    server.running_port = None;
    drop(server);
    lan_server::stop_server(thread, stop_flag);
    Ok(build_state_info(&app, &cfg, lan.inner()))
}

#[tauri::command]
pub fn lan_set_port(
    app: AppHandle,
    lan: State<Arc<LanRuntimeState>>,
    port: u16,
) -> Result<LanStateInfo, String> {
    if port < 1024 {
        return Err("端口必须 ≥ 1024".to_string());
    }
    let mut cfg = lan_config::load(&app);
    cfg.port = port;
    lan_config::save(&app, &cfg)?;
    // 如果当前服务在跑且端口变了，需要重启（用户手动启停最安全；这里只更新配置）
    Ok(build_state_info(&app, &cfg, lan.inner()))
}

#[tauri::command]
pub fn lan_set_enabled(
    app: AppHandle,
    lan: State<Arc<LanRuntimeState>>,
    enabled: bool,
) -> Result<LanStateInfo, String> {
    let mut cfg = lan_config::load(&app);

    if enabled {
        if !cfg.has_password() {
            return Err("启用前请先设置密码".to_string());
        }
        // 已经在跑就直接返回
        let already_running = lan.server.lock().map(|s| s.thread.is_some()).unwrap_or(false);
        if !already_running {
            let (running_port, handle, stop) = lan_server::spawn_server(&app, cfg.port)?;
            let mut server = lan.server.lock().map_err(|e| e.to_string())?;
            server.thread = Some(handle);
            server.stop_flag = Some(stop);
            server.running_port = Some(running_port);
        }
        cfg.enabled = true;
    } else {
        let mut server = lan.server.lock().map_err(|e| e.to_string())?;
        let thread = server.thread.take();
        let stop_flag = server.stop_flag.take();
        server.running_port = None;
        drop(server);
        lan_server::stop_server(thread, stop_flag);
        cfg.enabled = false;
    }
    lan_config::save(&app, &cfg)?;
    Ok(build_state_info(&app, &cfg, lan.inner()))
}

#[tauri::command]
pub fn lan_revoke_all_devices(
    app: AppHandle,
    lan: State<Arc<LanRuntimeState>>,
) -> Result<LanStateInfo, String> {
    let mut cfg = lan_config::load(&app);
    cfg.tokens.clear();
    lan_config::save(&app, &cfg)?;
    Ok(build_state_info(&app, &cfg, lan.inner()))
}

/// 前端调用：把当前 tabs / history 的精简快照推到后端，HTTP 接口直接读它。
/// 设计权衡：项目数据真相在前端 zustand+localStorage，后端要么 IPC 反查要么复制一份。
/// 复制一份内存最简单，30s 一次 push 就够移动端用。
#[tauri::command]
pub fn lan_sync_projects(
    lan: State<Arc<LanRuntimeState>>,
    items: Vec<ProjectSnapshotItem>,
    active_tab_id: Option<String>,
) -> Result<(), String> {
    let mut p = lan.projects.lock().map_err(|e| e.to_string())?;
    *p = ProjectsSnapshot {
        items,
        active_tab_id,
        updated_at: lan_config::unix_now(),
    };
    Ok(())
}

// ===========================================================================
// 共享 zustand storage（桌面端 ↔ 移动端跨设备数据同步）
//
// 设计：
//   - 桌面端的 zustand persist 通过 createSharedStorage adapter 把每次 setItem
//     的 key/value 推到 Rust 侧的内存镜像（同时保留 localStorage 作为本地缓存）
//   - 移动端没有真正的桌面端 localStorage（手机本地是空的），它的 zustand persist
//     storage 直接走 IPC 读这份镜像
//   - 任一端 set/remove 后会 emit `storage://changed` / `storage://removed`，
//     带 source clientId 让其它客户端 rehydrate 自己的 store —— 写入方自己跳过
//     避免双向回环
//   - 镜像同步落盘到 <app_config_dir>/lan-storage.json：服务重启 / 桌面端关
//     webview 后再开移动端不会拿到空数据
//
// 注意：这只镜像 zustand persist 层的 JSON 字符串；不解析、不感知 store 内部结构。
// 这样不管 tabs / settings / profile 哪个 store schema 怎么演进都不需要改 Rust 端。
// ===========================================================================

/// 列出当前所有镜像里的 key/value 对。客户端启动时调一次拿全量做 hydration。
#[tauri::command]
pub fn lan_list_storage(
    lan: State<Arc<LanRuntimeState>>,
) -> Result<Vec<(String, String)>, String> {
    let map = lan.shared_storage.lock().map_err(|e| e.to_string())?;
    Ok(map.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
}

#[tauri::command]
pub fn lan_get_storage(
    lan: State<Arc<LanRuntimeState>>,
    key: String,
) -> Result<Option<String>, String> {
    let map = lan.shared_storage.lock().map_err(|e| e.to_string())?;
    Ok(map.get(&key).cloned())
}

/// 写入并广播。`source` 是写入方的 clientId（前端 sharedStorage.ts 生成的随机值），
/// 其它客户端收到广播时会比对 source 跳过自己的回声。
///
/// `notify_webview` 控制是否再用 `app.emit` 通知 Tauri webview：
///   - 桌面 webview 自己发起的 setItem（已经在自己端设过 state）→ 设 false，
///     避免"自己 emit 自己又收到"一次无意义 IPC 来回
///   - 移动端通过 HTTP 发起的 setItem → 设 true（默认），让桌面 webview 也能 rehydrate
///   - 不论哪种情况都直接 push 到 EventBus，移动端长轮询路径不依赖 app.emit
///
/// 性能：高频 set（agent 流式 ~10Hz）只更新内存 HashMap + 入 EventBus + 必要时 emit，
/// 写盘走 800ms debounce —— 多次 set 在窗口内合并为一次 IO。
#[tauri::command]
pub fn lan_set_storage(
    app: AppHandle,
    lan: State<Arc<LanRuntimeState>>,
    key: String,
    value: String,
    source: Option<String>,
    notify_webview: Option<bool>,
) -> Result<(), String> {
    use tauri::Emitter;
    {
        let mut map = lan.shared_storage.lock().map_err(|e| e.to_string())?;
        // 短路：值没变就不广播 / 不调度落盘，避免桌面端 zustand 里"看起来等价但 JSON
        // 序列化字节序略有差异"的 setState 反复造成无意义事件
        if map.get(&key).map(|v| v == &value).unwrap_or(false) {
            return Ok(());
        }
        map.insert(key.clone(), value.clone());
    }
    let payload = json!({
        "key": key,
        "value": value,
        "source": source.unwrap_or_default(),
    });
    // 移动端 / 其它 LAN 客户端走长轮询拿事件 —— 直接 append（不经过 Tauri 事件总线）
    lan.event_bus
        .append("storage://changed".to_string(), payload.clone());
    // 仅当调用方不是桌面 webview 自己时才 emit 给 webview（避免回声）
    if notify_webview.unwrap_or(true) {
        let _ = app.emit("storage://changed", payload);
    }
    crate::lan::shared_storage::schedule_save(&app, lan.inner());
    Ok(())
}

#[tauri::command]
pub fn lan_remove_storage(
    app: AppHandle,
    lan: State<Arc<LanRuntimeState>>,
    key: String,
    source: Option<String>,
    notify_webview: Option<bool>,
) -> Result<(), String> {
    use tauri::Emitter;
    {
        let mut map = lan.shared_storage.lock().map_err(|e| e.to_string())?;
        if !map.contains_key(&key) {
            return Ok(());
        }
        map.remove(&key);
    }
    let payload = json!({
        "key": key,
        "source": source.unwrap_or_default(),
    });
    lan.event_bus
        .append("storage://removed".to_string(), payload.clone());
    if notify_webview.unwrap_or(true) {
        let _ = app.emit("storage://removed", payload);
    }
    crate::lan::shared_storage::schedule_save(&app, lan.inner());
    Ok(())
}
