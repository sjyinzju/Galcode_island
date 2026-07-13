// Claude Code stream 子系统。
// 通过 --input-format stream-json 与 claude 进程持续交互，
// 管理会话复用、消息收发、登录检测、模型目录。
//
// 关键设计（踩坑后的成熟方案）：
//   - per (cwd, model, effort, proxy, session) 复用一个长期 child 进程
//     避免每次 turn 都付 ~1.5s 的 claude CLI 冷启动
//   - 三个后台线程：stdout 行读取 + stderr 行读取 + child wait
//   - mpsc waiter 同步 turn：stdout 见到 type=result 时触发
//   - --resume 续接：session_id 在 stream 中自动捕获，下次 turn 复用
//   - 退出处理：fatal_error / exit_detail 兜底，避免 waiter 永久阻塞

use crate::agent::runtime::*;
use crate::agent::sysutils::*;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, LazyLock, Mutex};
use tauri::AppHandle;

// ---------------------------------------------------------------------------
// tool_use_id → 块前缀的映射表
// ---------------------------------------------------------------------------
//
// 流式 stream-json 里 tool_use 先到，tool_result 后到。tool_use 时根据工具
// 类型把块发到 claude-cmd-/claude-file-/claude-tool-/claude-diff- 其中一种
// id 上；tool_result 到达时我们只该更新对应那一种，而不是给三种前缀都发
// 一遍（之前为了"反正前端按 id 去重"的偷懒写法，结果在前端 upsert 路径上
// 创建出空 command/file 幻影块，截图里"$ (command) User has answered..."
// 就是这么来的）。
//
// 全局 HashMap 够用：tool_use_id 是 Claude 端 UUID，唯一；同一 App 寿命里
// 不会膨胀到危险量级（万级以内）。多个 session 共用一份也无冲突。
static TOOL_USE_PREFIX: LazyLock<Mutex<HashMap<String, &'static str>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 同步记录每个 tool_use_id 对应的工具名，以便 tool_result 阶段对特定工具
/// （AskUserQuestion 等）做特殊后处理。
static TOOL_USE_NAME: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn remember_tool_use_prefix(tool_use_id: &str, prefix: &'static str) {
    if tool_use_id.is_empty() {
        return;
    }
    if let Ok(mut map) = TOOL_USE_PREFIX.lock() {
        map.insert(tool_use_id.to_string(), prefix);
    }
}

fn remember_tool_use_name(tool_use_id: &str, name: &str) {
    if tool_use_id.is_empty() {
        return;
    }
    if let Ok(mut map) = TOOL_USE_NAME.lock() {
        map.insert(tool_use_id.to_string(), name.to_string());
    }
}

fn lookup_tool_use_prefix(tool_use_id: &str) -> Option<&'static str> {
    if tool_use_id.is_empty() {
        return None;
    }
    TOOL_USE_PREFIX
        .lock()
        .ok()
        .and_then(|map| map.get(tool_use_id).copied())
}

fn lookup_tool_use_name(tool_use_id: &str) -> Option<String> {
    if tool_use_id.is_empty() {
        return None;
    }
    TOOL_USE_NAME
        .lock()
        .ok()
        .and_then(|map| map.get(tool_use_id).cloned())
}

/// tool_result 处理完后调用：释放该 tool_use_id 在两个全局 map 上的条目。
/// 长跑 session（几千次工具调用）下避免 map 持续增长。
fn forget_tool_use(tool_use_id: &str) {
    if tool_use_id.is_empty() {
        return;
    }
    if let Ok(mut map) = TOOL_USE_PREFIX.lock() {
        map.remove(tool_use_id);
    }
    if let Ok(mut map) = TOOL_USE_NAME.lock() {
        map.remove(tool_use_id);
    }
}

// ---------------------------------------------------------------------------
// 模块内 API 响应类型 (供未来 UI 命令使用)
// ---------------------------------------------------------------------------

#[allow(dead_code)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliRuntimeStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub binary: String,
    pub logged_in: bool,
    pub login_status: String,
    pub auth_method: Option<String>,
    pub default_model: Option<String>,
    pub default_effort: Option<String>,
}

#[allow(dead_code)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeModel {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
}

#[allow(dead_code)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeModelsResult {
    pub available_models: Vec<ClaudeModel>,
    pub available_efforts: Vec<String>,
    pub current_model_id: Option<String>,
    pub current_effort: Option<String>,
}

// ---------------------------------------------------------------------------
// 登录/状态
// ---------------------------------------------------------------------------

#[allow(dead_code)]
pub fn claude_login_status(
    binary: &Path,
    cwd: &Path,
) -> Result<(bool, String, Option<String>), String> {
    // Windows 上 claude auth status 若遇代理/网络异常会阻塞数十秒，原先用
    // .output() 没超时，整条 refreshDesktopIntegration 会卡死。改为带 5s 超时。
    let mut command = Command::new(binary);
    configure_background_command(&mut command);
    let child = command
        .args(["auth", "status"])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to inspect Claude Code auth status: {error}"))?;
    let output = wait_child_output_with_timeout(child, CLI_VERIFY_TIMEOUT)
        .map_err(|error| format!("Failed to inspect Claude Code auth status: {error}"))?;

    let stdout = strip_cli_warning_lines(&trim_output(&output.stdout));
    let stderr = strip_cli_warning_lines(&trim_output(&output.stderr));
    let text = if !stdout.is_empty() { stdout } else { stderr };

    if text.is_empty() {
        return Ok((false, "未检测到 Claude Code 登录状态。".to_string(), None));
    }

    if let Ok(value) = serde_json::from_str::<Value>(&text) {
        let logged_in = value
            .get("loggedIn")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let auth_method = value
            .get("authMethod")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .filter(|value| !value.is_empty() && value != "none");
        let provider = value
            .get("apiProvider")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .filter(|value| !value.is_empty());
        let status = if logged_in {
            match (auth_method.as_deref(), provider.as_deref()) {
                (Some(method), Some(api_provider)) => {
                    format!("Logged in via {method} · {api_provider}")
                }
                (Some(method), None) => format!("Logged in via {method}"),
                _ => "Logged in".to_string(),
            }
        } else {
            "未登录 Claude Code。".to_string()
        };

        return Ok((logged_in, status, auth_method));
    }

    Ok((output.status.success(), text, None))
}

#[allow(dead_code)]
pub fn claude_status_snapshot(
    app: &AppHandle,
    requested_binary: Option<&str>,
) -> Result<CliRuntimeStatus, String> {
    let root = resolve_project_root(app)?;
    let binary = resolve_claude_binary(app, requested_binary);
    let version = command_version(&binary, "--version", &root);
    let installed = version.is_some();
    let (logged_in, login_status, auth_method) = if installed {
        claude_login_status(&binary, &root)?
    } else {
        (false, "未检测到 Claude Code CLI。".to_string(), None)
    };

    Ok(CliRuntimeStatus {
        installed,
        version,
        binary: binary.display().to_string(),
        logged_in,
        login_status,
        auth_method,
        default_model: read_claude_default_model(),
        default_effort: read_claude_default_effort(),
    })
}

// ---------------------------------------------------------------------------
// 配置/模型
// ---------------------------------------------------------------------------

pub fn claude_config_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| user_home_dir().map(|home| home.join(".claude")))
}

pub fn read_claude_settings() -> Option<Value> {
    let path = claude_config_dir()?.join("settings.json");
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn read_claude_default_model() -> Option<String> {
    read_claude_settings()
        .and_then(|settings| {
            settings
                .get("model")
                .and_then(Value::as_str)
                .map(str::trim)
                .map(ToOwned::to_owned)
        })
        .filter(|value| !value.is_empty())
        .or_else(|| {
            std::env::var("ANTHROPIC_MODEL")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
}

pub fn read_claude_default_effort() -> Option<String> {
    read_claude_settings()
        .and_then(|settings| {
            settings
                .get("effortLevel")
                .and_then(Value::as_str)
                .map(str::trim)
                .map(ToOwned::to_owned)
        })
        .and_then(|value| normalize_claude_effort(&value))
}

pub fn normalize_claude_effort(value: &str) -> Option<String> {
    let normalized = value.trim().to_lowercase();
    match normalized.as_str() {
        "" | "default" | "auto" => None,
        // `claude --help` 在 1.x 里列了 low/medium/high/xhigh/max 五档，
        // 老版本只有 low/medium/high/max。拿不到 xhigh 的版本由 help 解析自动剔除。
        "low" | "medium" | "high" | "xhigh" | "max" => Some(normalized),
        _ => None,
    }
}

#[allow(dead_code)]
pub fn read_claude_help_text(binary: &Path, cwd: &Path) -> Option<String> {
    let mut command = Command::new(binary);
    configure_background_command(&mut command);
    let child = command
        .current_dir(cwd)
        .arg("--help")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let output = wait_child_output_with_timeout(child, CLI_VERSION_TIMEOUT).ok()?;
    let stdout = trim_output(&output.stdout);
    if !stdout.is_empty() {
        return Some(stdout);
    }
    let stderr = trim_output(&output.stderr);
    if stderr.is_empty() {
        None
    } else {
        Some(stderr)
    }
}

#[allow(dead_code)]
pub fn parse_claude_effort_levels(help_text: &str) -> Vec<String> {
    let mut levels = Vec::new();
    for line in help_text.lines() {
        if !line.contains("--effort") {
            continue;
        }
        if let (Some(start), Some(end)) = (line.rfind('('), line.rfind(')')) {
            let choices = &line[start + 1..end];
            for value in choices.split(',') {
                if let Some(level) = normalize_claude_effort(value) {
                    if !levels.iter().any(|entry| entry == &level) {
                        levels.push(level);
                    }
                }
            }
        }
    }
    if levels.is_empty() {
        levels = vec![
            "low".to_string(),
            "medium".to_string(),
            "high".to_string(),
            "max".to_string(),
        ];
    }
    levels
}

#[allow(dead_code)]
pub fn build_claude_model_catalog(
    app: &AppHandle,
    requested_binary: Option<&str>,
) -> Result<ClaudeModelsResult, String> {
    let root = resolve_project_root(app)?;
    let binary = resolve_claude_binary(app, requested_binary);
    let help_text = read_claude_help_text(&binary, &root).unwrap_or_default();
    let mut model_ids = BTreeSet::from([
        "sonnet".to_string(),
        "opus".to_string(),
        "haiku".to_string(),
        "sonnet[1m]".to_string(),
        "opusplan".to_string(),
    ]);

    let settings = read_claude_settings();
    if let Some(model) = settings
        .as_ref()
        .and_then(|value| value.get("model"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        model_ids.insert(model.to_string());
    }
    if let Some(overrides) = settings
        .as_ref()
        .and_then(|value| value.get("modelOverrides"))
        .and_then(Value::as_object)
    {
        for (key, value) in overrides {
            let key = key.trim();
            if !key.is_empty() {
                model_ids.insert(key.to_string());
            }
            if let Some(value) = value
                .as_str()
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
            {
                model_ids.insert(value.to_string());
            }
        }
    }
    if let Ok(model) = std::env::var("ANTHROPIC_MODEL") {
        let model = model.trim();
        if !model.is_empty() {
            model_ids.insert(model.to_string());
        }
    }
    for key in [
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    ] {
        if let Ok(model) = std::env::var(key) {
            let model = model.trim();
            if !model.is_empty() {
                model_ids.insert(model.to_string());
            }
        }
    }

    let preferred_order = ["sonnet", "opus", "opusplan", "haiku", "sonnet[1m]"];
    let mut available_models = model_ids
        .into_iter()
        .map(|id| ClaudeModel {
            name: id.clone(),
            id,
            description: None,
        })
        .collect::<Vec<_>>();
    available_models.sort_by_key(|model| {
        (
            preferred_order
                .iter()
                .position(|entry| entry == &model.id.as_str())
                .unwrap_or(preferred_order.len()),
            model.id.clone(),
        )
    });

    Ok(ClaudeModelsResult {
        available_models,
        available_efforts: parse_claude_effort_levels(&help_text),
        current_model_id: read_claude_default_model(),
        current_effort: read_claude_default_effort(),
    })
}

// ---------------------------------------------------------------------------
// 登录终端
// ---------------------------------------------------------------------------

#[allow(dead_code)]
pub fn open_claude_login_terminal(
    app: &AppHandle,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
) -> Result<String, String> {
    let binary = resolve_claude_binary(app, requested_binary);
    let command_text = format!(
        "{}{}",
        proxy_env_prefix(proxy),
        shell_command_text(&binary, &[], &["auth".to_string(), "login".to_string()])
    );
    open_terminal_command(
        &command_text,
        "已在系统终端中打开 `claude auth login`。完成登录后回到软件点\u{201c}刷新状态\u{201d}或\u{201c}验证连接\u{201d}。",
    )
}

/// 通用：在系统终端新开窗口跑 `claude <args>`。
///
/// 用于桥接 Claude Code 的 CLI 内置交互命令（/login /logout /doctor /upgrade
/// /init …）—— 这些命令本身只在 TTY 交互模式有效，我们的应用走 stream-json
/// 非交互模式，所以只能新开终端让 CLI 自己跑。前端面板调用 `claude_run_in_terminal`
/// 时通过 `args` 指定子命令。
#[allow(dead_code)]
pub fn open_claude_terminal_with_args(
    app: &AppHandle,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
    args: &[String],
    success_message: &str,
) -> Result<String, String> {
    let binary = resolve_claude_binary(app, requested_binary);
    let command_text = format!(
        "{}{}",
        proxy_env_prefix(proxy),
        shell_command_text(&binary, &[], args)
    );
    open_terminal_command(&command_text, success_message)
}

// ---------------------------------------------------------------------------
// Stream 事件解析（通用 stream-json 提取，跨 backend 复用）
// ---------------------------------------------------------------------------

pub fn extract_cli_session_id(event: &Value) -> Option<String> {
    event
        .get("session_id")
        .and_then(Value::as_str)
        .or_else(|| event.get("sessionId").and_then(Value::as_str))
        .or_else(|| event.get("thread_id").and_then(Value::as_str))
        .or_else(|| event.get("threadId").and_then(Value::as_str))
        .or_else(|| event.get("conversation_id").and_then(Value::as_str))
        .or_else(|| event.get("conversationId").and_then(Value::as_str))
        .or_else(|| event.get("checkpoint_id").and_then(Value::as_str))
        .or_else(|| event.get("checkpointId").and_then(Value::as_str))
        .or_else(|| {
            event
                .get("session")
                .and_then(|value| value.get("id"))
                .and_then(Value::as_str)
        })
        .map(ToOwned::to_owned)
}

pub fn extract_claude_last_message(events: &[Value]) -> String {
    for event in events.iter().rev() {
        if event.get("type").and_then(Value::as_str) == Some("result") {
            if let Some(text) = event
                .get("result")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return text.to_string();
            }
        }

        if event.get("type").and_then(Value::as_str) == Some("assistant") {
            if let Some(content) = event
                .get("message")
                .and_then(|value| value.get("content"))
                .and_then(Value::as_array)
            {
                let text = content
                    .iter()
                    .filter_map(|item| item.get("text").and_then(Value::as_str))
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                if !text.is_empty() {
                    return text;
                }
            }
        }
    }

    String::new()
}

pub fn extract_claude_event_message(event: &Value) -> Option<String> {
    if let Some(text) = event
        .get("result")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(text.to_string());
    }

    if let Some(content) = event
        .get("message")
        .and_then(|value| value.get("content"))
        .and_then(Value::as_array)
    {
        let text = content
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if !text.is_empty() {
            return Some(text);
        }
    }

    None
}

pub fn claude_stream_error_message(event: &Value) -> Option<String> {
    if event.get("type").and_then(Value::as_str) == Some("result")
        && event
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        if let Some(result) = event
            .get("result")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(result.to_string());
        }
    }

    event
        .get("error")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

// ---------------------------------------------------------------------------
// 文件编辑 diff 提取
// ---------------------------------------------------------------------------

/// 从 Claude stream-json 行解析所有有意义的 content 项，转成 galcode.block 列表。
/// 覆盖：
///   - assistant.text → text block（Agent 中间消息）
///   - assistant.thinking → thought block（推理过程）
///   - assistant.tool_use Edit/MultiEdit/Write → diff block（带 +/- 染色）
///   - assistant.tool_use Bash → command block（终端样式）
///   - assistant.tool_use Read/Write/Grep/Glob 等 → file block 或 tool block
///   - user.tool_result → 关联 tool_use_id，覆盖之前的 tool/command block status+output
pub fn extract_claude_blocks(event: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
    let Some(content) = event
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return out;
    };

    for item in content {
        let item_type = item.get("type").and_then(Value::as_str).unwrap_or("");
        match item_type {
            "text" if event_type == "assistant" => {
                let text = item.get("text").and_then(Value::as_str).unwrap_or("").trim();
                if text.is_empty() {
                    continue;
                }
                let id = item
                    .get("id")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| format!("text-{}", chrono::Utc::now().timestamp_millis()));
                out.push(json!({
                    "type": "galcode.block",
                    "block": {
                        "id": format!("claude-text-{id}"),
                        "type": "text",
                        "content": text,
                        "backend": "claude",
                        "suppressLogLine": false
                    }
                }));
            }
            "thinking" if event_type == "assistant" => {
                let text = item
                    .get("thinking")
                    .or_else(|| item.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                if text.is_empty() {
                    continue;
                }
                let id = item
                    .get("id")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| {
                        format!("thought-{}", chrono::Utc::now().timestamp_millis())
                    });
                out.push(json!({
                    "type": "galcode.block",
                    "block": {
                        "id": format!("claude-thought-{id}"),
                        "type": "thought",
                        "content": text,
                        "backend": "claude",
                        "suppressLogLine": true
                    }
                }));
            }
            "tool_use" if event_type == "assistant" => {
                let name = item.get("name").and_then(Value::as_str).unwrap_or("Tool");
                let id = item
                    .get("id")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| format!("tool-{}", chrono::Utc::now().timestamp_millis()));
                let input = item.get("input").cloned().unwrap_or(Value::Null);
                // 默认前缀按下面 match 实际走哪一支决定；用 mut 占位等 match 内部赋。
                let mut effective_prefix: &'static str = "claude-tool";

                let block = match name {
                    "Edit" => {
                        let path = input.get("file_path").and_then(Value::as_str).unwrap_or("");
                        let old = input.get("old_string").and_then(Value::as_str).unwrap_or("");
                        let new = input.get("new_string").and_then(Value::as_str).unwrap_or("");
                        if path.is_empty() && old.is_empty() && new.is_empty() {
                            continue;
                        }
                        effective_prefix = "claude-diff";
                        build_diff_block(&id, "Edit", path, &simple_diff(old, new))
                    }
                    "MultiEdit" => {
                        let path = input.get("file_path").and_then(Value::as_str).unwrap_or("");
                        let edits = input
                            .get("edits")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default();
                        let mut diff_text = String::new();
                        for (i, edit) in edits.iter().enumerate() {
                            let old = edit.get("old_string").and_then(Value::as_str).unwrap_or("");
                            let new = edit.get("new_string").and_then(Value::as_str).unwrap_or("");
                            if i > 0 {
                                diff_text.push_str("\n@@\n");
                            }
                            diff_text.push_str(&simple_diff(old, new));
                        }
                        effective_prefix = "claude-diff";
                        build_diff_block(&id, "MultiEdit", path, &diff_text)
                    }
                    "Write" => {
                        let path = input.get("file_path").and_then(Value::as_str).unwrap_or("");
                        let content = input.get("content").and_then(Value::as_str).unwrap_or("");
                        let diff_text = content
                            .lines()
                            .map(|l| format!("+{l}"))
                            .collect::<Vec<_>>()
                            .join("\n");
                        effective_prefix = "claude-diff";
                        build_diff_block(&id, "Write", path, &diff_text)
                    }
                    "Bash" => {
                        let cmd = input
                            .get("command")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        effective_prefix = "claude-cmd";
                        json!({
                            "id": format!("claude-cmd-{id}"),
                            "type": "command",
                            "command": cmd,
                            "output": "",
                            "status": "running",
                            "backend": "claude",
                            "suppressLogLine": false
                        })
                    }
                    "TodoWrite" => {
                        // 把 input.todos 解析成前端 todo 块的 items 数组。
                        // 老路径走 file/tool 块只会显示 "[object Object]"，
                        // 用专用 todo 块 + TodoBlock 渲染才有打勾视觉。
                        let items: Vec<Value> = input
                            .get("todos")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default()
                            .into_iter()
                            .enumerate()
                            .filter_map(|(i, raw)| {
                                let obj = raw.as_object()?;
                                let label = obj
                                    .get("content")
                                    .or_else(|| obj.get("activeForm"))
                                    .or_else(|| obj.get("task"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string();
                                if label.is_empty() {
                                    return None;
                                }
                                let status = obj
                                    .get("status")
                                    .and_then(Value::as_str)
                                    .unwrap_or("pending")
                                    .to_string();
                                Some(json!({
                                    "id": obj.get("id")
                                        .and_then(Value::as_str)
                                        .map(ToOwned::to_owned)
                                        .unwrap_or_else(|| format!("todo-{i}")),
                                    "label": label,
                                    "status": status,
                                }))
                            })
                            .collect();
                        effective_prefix = "claude-todo";
                        json!({
                            "id": format!("claude-todo-{id}"),
                            "type": "todo",
                            "title": "TodoWrite",
                            "items": items,
                            "status": "running",
                            "backend": "claude",
                            "suppressLogLine": false
                        })
                    }
                    "Task" => {
                        // 子 agent 调用：把 subagent_type + description / prompt 漂亮地显示
                        let subagent = input
                            .get("subagent_type")
                            .and_then(Value::as_str)
                            .unwrap_or("agent");
                        let desc = input
                            .get("description")
                            .and_then(Value::as_str)
                            .or_else(|| input.get("prompt").and_then(Value::as_str))
                            .map(|s| {
                                // 截到 200 字符避免一坨 prompt 把 UI 撑爆
                                s.chars().take(200).collect::<String>()
                            });
                        effective_prefix = "claude-tool";
                        json!({
                            "id": format!("claude-tool-{id}"),
                            "type": "tool",
                            "tool": format!("Task · {subagent}"),
                            "detail": desc,
                            "status": "running",
                            "startedAt": chrono::Utc::now().timestamp_millis(),
                            "backend": "claude",
                            "suppressLogLine": false
                        })
                    }
                    "Skill" => {
                        // 安装的技能调用：surface skill_name 让用户知道在跑哪个 skill
                        let skill = input
                            .get("skill_name")
                            .or_else(|| input.get("name"))
                            .or_else(|| input.get("skill"))
                            .and_then(Value::as_str)
                            .unwrap_or("(unknown skill)");
                        let desc = input
                            .get("description")
                            .or_else(|| input.get("command"))
                            .or_else(|| input.get("prompt"))
                            .and_then(Value::as_str)
                            .map(|s| s.chars().take(200).collect::<String>());
                        effective_prefix = "claude-tool";
                        json!({
                            "id": format!("claude-tool-{id}"),
                            "type": "tool",
                            "tool": format!("Skill · {skill}"),
                            "detail": desc,
                            "status": "running",
                            "startedAt": chrono::Utc::now().timestamp_millis(),
                            "backend": "claude",
                            "suppressLogLine": false
                        })
                    }
                    "Read" | "Grep" | "Glob" | "WebFetch" | "WebSearch" => {
                        let path = input
                            .get("file_path")
                            .or_else(|| input.get("path"))
                            .and_then(Value::as_str);
                        let detail = input
                            .get("pattern")
                            .or_else(|| input.get("query"))
                            .or_else(|| input.get("url"))
                            .or_else(|| input.get("prompt"))
                            .and_then(Value::as_str);
                        if let Some(path) = path {
                            effective_prefix = "claude-file";
                            json!({
                                "id": format!("claude-file-{id}"),
                                "type": "file",
                                "tool": name,
                                "path": path,
                                "status": "running",
                                "backend": "claude",
                                "suppressLogLine": false
                            })
                        } else {
                            effective_prefix = "claude-tool";
                            json!({
                                "id": format!("claude-tool-{id}"),
                                "type": "tool",
                                "tool": name,
                                "detail": detail,
                                "status": "running",
                                "backend": "claude",
                                "suppressLogLine": false
                            })
                        }
                    }
                    _ => {
                        // 通用：未知工具显示工具名 + input 字段摘要
                        let detail = serde_json::to_string(&input)
                            .ok()
                            .map(|s| s.chars().take(80).collect::<String>());
                        effective_prefix = "claude-tool";
                        json!({
                            "id": format!("claude-tool-{id}"),
                            "type": "tool",
                            "tool": name,
                            "detail": detail,
                            "status": "running",
                            "backend": "claude",
                            "suppressLogLine": false
                        })
                    }
                };
                // 记下这次 tool_use 实际落到哪种前缀块上，方便 tool_result 精准回更新
                remember_tool_use_prefix(&id, effective_prefix);
                // 同步记下工具名，给 tool_result 阶段特殊后处理用（如
                // AskUserQuestion 把 deny 当成功显示）
                remember_tool_use_name(&id, name);
                out.push(json!({ "type": "galcode.block", "block": block }));
            }
            "tool_result" if event_type == "user" => {
                // 关联到对应的 tool_use_id：前端按 block.id 去重，这里覆盖之前的
                // running 状态为 success/error + 把 output 填上
                let tool_use_id = item
                    .get("tool_use_id")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let is_error = item
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let output = item
                    .get("content")
                    .and_then(|c| {
                        // content 可能是 string，也可能是 [{type:text, text:...}] 数组
                        c.as_str().map(ToOwned::to_owned).or_else(|| {
                            c.as_array().map(|arr| {
                                arr.iter()
                                    .filter_map(|x| x.get("text").and_then(Value::as_str))
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            })
                        })
                    })
                    .unwrap_or_default();
                // AskUserQuestion 特化：走 deny + message 通路时 CLI 把 message
                // 标 is_error=true（甚至 <error> 包装），但其实是用户提交的答案。
                // 在前端展示上强制 success 状态 + 把消息当成 output 显示，避免
                // 渲染成红色错误块；Claude 那边仍然原样收到带 is_error 标记的
                // tool_result，能从内容里读到 "User has answered..." 用户答案。
                let resolved_tool_name = lookup_tool_use_name(tool_use_id);
                let is_ask_user_question = resolved_tool_name.as_deref() == Some("AskUserQuestion");
                let status: &'static str = if is_ask_user_question {
                    "success"
                } else if is_error {
                    "error"
                } else {
                    "success"
                };
                // 查 tool_use 那一步登记过的前缀，只更新它。查不到（极少见，比如
                // tool_use 比 tool_result 晚到达或代码升级前的旧 id）则回退到老的
                // 三前缀广播以保住"至少有一条更新到"的兜底。
                let target_prefix = lookup_tool_use_prefix(tool_use_id);
                let prefixes: Vec<&'static str> = match target_prefix {
                    Some(p) => vec![p],
                    None => vec![
                        "claude-cmd",
                        "claude-file",
                        "claude-tool",
                        "claude-todo",
                        "claude-diff",
                    ],
                };
                for prefix in prefixes {
                    let block_type = match prefix {
                        "claude-cmd" => "command",
                        "claude-file" => "file",
                        "claude-todo" => "todo",
                        "claude-diff" => "diff",
                        _ => "tool",
                    };
                    // command 块要把 output 灌进去（终端样式渲染要展示）；
                    // 其它块用 message 字段承载错误文本，正常完成时无需附内容；
                    // AskUserQuestion 特例：把答案同时灌到 output（command 备用）
                    // 和 detail（tool/file 块的展示字段）让任何前缀的块都显出来
                    let output_for_block = if prefix == "claude-cmd" || is_ask_user_question {
                        Some(output.clone())
                    } else {
                        None
                    };
                    // 错误消息只在真正错误（且不是 AskUserQuestion 走 deny）时填
                    let message_for_block = if is_error && !is_ask_user_question {
                        Some(output.clone())
                    } else {
                        None
                    };
                    // ToolBlock / FileBlock 渲染 detail 字段，给 AskUserQuestion
                    // 把答案塞进去；其它工具的 detail 在 tool_use 阶段就有，
                    // 这里 *不要* 设 detail（含 null）覆盖掉它，故用 Map 构造
                    let mut block_map = serde_json::Map::new();
                    block_map.insert("id".into(), json!(format!("{prefix}-{tool_use_id}")));
                    block_map.insert("type".into(), json!(block_type));
                    block_map.insert("status".into(), json!(status));
                    block_map.insert("output".into(), json!(output_for_block));
                    block_map.insert("message".into(), json!(message_for_block));
                    block_map.insert("backend".into(), json!("claude"));
                    block_map.insert("suppressLogLine".into(), json!(true));
                    if is_ask_user_question {
                        block_map.insert("detail".into(), json!(output.clone()));
                    }
                    out.push(json!({
                        "type": "galcode.block",
                        "block": Value::Object(block_map)
                    }));
                }
                // tool_use_id 这次 turn 不会再用到，释放两个 map 上的条目避免长期累积
                forget_tool_use(tool_use_id);
            }
            _ => {}
        }
    }
    out
}

/// Backwards-compat 别名：原来的 extract_claude_diff_blocks 是 extract_claude_blocks 子集。
#[allow(dead_code)]
pub fn extract_claude_diff_blocks(event: &Value) -> Vec<Value> {
    extract_claude_blocks(event)
}

fn simple_diff(old: &str, new: &str) -> String {
    let mut lines = Vec::new();
    for line in old.lines() {
        lines.push(format!("-{line}"));
    }
    for line in new.lines() {
        lines.push(format!("+{line}"));
    }
    lines.join("\n")
}

fn build_diff_block(id: &str, tool: &str, path: &str, diff: &str) -> Value {
    json!({
        "id": format!("claude-diff-{id}"),
        "type": "diff",
        "tool": tool,
        "path": path,
        "diff": diff,
        "backend": "claude",
        "suppressLogLine": false
    })
}

// ---------------------------------------------------------------------------
// Stream 客户端辅助
// ---------------------------------------------------------------------------

pub fn set_claude_client_fatal_error(client: &ClaudeStreamClient, message: String) {
    if let Ok(mut fatal_error) = client.fatal_error.lock() {
        *fatal_error = Some(message);
    }
}

pub fn take_claude_pending_turn(
    pending_turn: &Arc<Mutex<Option<ClaudePendingTurn>>>,
) -> Option<ClaudePendingTurn> {
    pending_turn.lock().ok().and_then(|mut turn| turn.take())
}

pub fn current_claude_stream_id(client: &ClaudeStreamClient) -> Option<String> {
    client
        .pending_turn
        .lock()
        .ok()
        .and_then(|turn| turn.as_ref().and_then(|turn| turn.stream_id.clone()))
}

// ---------------------------------------------------------------------------
// Stream 客户端生命周期
// ---------------------------------------------------------------------------

/// Claude CLI 支持的 permission mode。前端用同名 PermissionMode TS 类型。
///
/// `auto` 是 Claude Code v2.1.83+ 引入的独立 mode：CLI 不弹审批，但有独立 classifier
/// 模型逐 action 做安全审查，被 block 3 次连续 / 20 次累计后才回退到 prompt-tool。
/// 这里**原样透传** `auto`，让 CLI 自己处理 — 之前误把它映射到 acceptEdits 是错的。
///
/// 注意：auto 有最低 CLI 版本 + 计划 + 模型 + provider 要求（详见
/// <https://code.claude.com/docs/en/permission-modes>）。若用户当前账号不满足，
/// CLI 会自己报错，本应用不预先判断。
///
/// 任何不在白名单里的字符串会被 fall back 到 "acceptEdits"（保持向后兼容老行为）。
fn normalize_permission_mode(mode: Option<&str>) -> &'static str {
    match mode.map(str::trim).unwrap_or("") {
        "default" => "default",
        "auto" => "auto",
        "acceptEdits" => "acceptEdits",
        "plan" => "plan",
        "bypassPermissions" => "bypassPermissions",
        _ => "acceptEdits",
    }
}

pub fn spawn_claude_stream_client(
    app: &AppHandle,
    run_id: &str,
    directory: &str,
    session_id: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
    permission_mode: Option<&str>,
) -> Result<Arc<ClaudeStreamClient>, String> {
    let binary = resolve_claude_binary(app, requested_binary);
    let binary_display = binary.display().to_string();
    let model_text = model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let effort_text = effort
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let proxy_text = proxy
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let resume_session = session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let permission_mode_text = normalize_permission_mode(permission_mode);

    let mut command = Command::new(&binary);
    configure_background_command(&mut command);
    command
        .current_dir(directory)
        .arg("-p")
        .arg("--input-format")
        .arg("stream-json")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--replay-user-messages")
        .arg("--include-partial-messages")
        .arg("--permission-mode")
        .arg(permission_mode_text);

    // 接入 permission-prompt-tool：让 Claude 在工具调用前 RPC 到本地 MCP 桥接
    // 服务，桥接转 Tauri 事件 → 前端 PermissionCard，让用户在 App 内 Allow/Deny。
    // 失败时（MCP 没起来 / 写 config 出错）忽略，行为退化到纯 --permission-mode。
    //
    // bypassPermissions 例外：用户明确选了"零审批"，不该再起任何审批往返。
    // Claude CLI 在 bypass 下其实也不会调 prompt-tool（CLI 行为兜底），但
    // 我们这边显式不挂，连 MCP config 文件都不写、HTTP 也不被访问，语义更干净。
    let mut prompt_tool_attached = false;
    if permission_mode_text == "bypassPermissions" {
        log::info!(
            "[claude] bypassPermissions 模式：跳过 permission-prompt-tool 接入"
        );
    } else {
        match crate::permission_mcp::write_session_mcp_config(app, run_id) {
            Ok(cfg_path) => {
                command
                    .arg("--mcp-config")
                    .arg(&cfg_path)
                    .arg("--permission-prompt-tool")
                    .arg(crate::permission_mcp::PERMISSION_TOOL_NAME);
                prompt_tool_attached = true;
                log::info!(
                    "[claude] permission-prompt-tool 接入 OK: run_id={run_id} cfg={} tool={}",
                    cfg_path.display(),
                    crate::permission_mcp::PERMISSION_TOOL_NAME
                );
            }
            Err(e) => {
                log::warn!(
                    "[claude] 跳过 permission-prompt-tool 接入: {e}（将走 --permission-mode 原生行为）"
                );
            }
        }
    }
    log::info!(
        "[claude] spawn args: run_id={run_id} mode={permission_mode_text} prompt_tool={} model={:?} effort={:?} proxy_set={}",
        if prompt_tool_attached { "on" } else { "off" },
        model_text,
        effort_text,
        proxy_text.is_some()
    );

    // 直接把 spawn 配置作为 status 块推给前端，让用户在对话流里立刻看到 Claude
    // 实际启动的 mode + 是否挂了 permission-prompt-tool。这对诊断"default 模式
    // Edit 不弹窗"这种问题极有用——一眼就能确认 CLI 拿到的参数是否符合预期。
    let prompt_tool_label = if prompt_tool_attached {
        "✓ permission-prompt-tool 已挂"
    } else if permission_mode_text == "bypassPermissions" {
        "（bypassPermissions：所有工具直接放行）"
    } else {
        "⚠ permission-prompt-tool 未挂（CLI 走 --permission-mode 原生行为）"
    };
    let mode_warn = if permission_mode_text == "default" && !prompt_tool_attached {
        "（default 模式下没有 prompt-tool，工具调用大概率被 CLI 直接拒）"
    } else {
        ""
    };
    let status_text = format!(
        "Claude CLI started · mode={permission_mode_text} · {prompt_tool_label}{mode_warn}"
    );
    emit_cli_stream_json_event(
        app,
        "claude",
        run_id,
        &format!("spawn-{run_id}"),
        &json!({
            "type": "galcode.block",
            "block": {
                // id 用 run_id 保证同 tab 内 respawn（参数变更触发 kill + respawn）
                // 时新的 spawn-info 块 upsert 覆盖旧的，而不是堆出多条历史 status。
                "id": format!("claude-spawn-info-{run_id}"),
                "type": "status",
                "content": status_text,
                "backend": "claude",
                "suppressLogLine": true
            }
        }),
    );

    if let Some(existing_session) = resume_session.as_deref() {
        command.arg("--resume").arg(existing_session);
    }
    if let Some(model) = model_text.as_deref() {
        command.arg("--model").arg(model);
    }
    if let Some(effort) = effort_text.as_deref() {
        command.arg("--effort").arg(effort);
    }

    apply_proxy_env(&mut command, proxy_text.as_deref());

    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start Claude Code stream session: {error}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Claude Code stream stdin is not available.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Claude Code stream stdout is not available.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Claude Code stream stderr is not available.".to_string())?;
    let pid = child.id();

    let client = Arc::new(ClaudeStreamClient {
        stdin: Mutex::new(stdin),
        pid,
        session_id: Arc::new(Mutex::new(resume_session.clone())),
        last_message: Arc::new(Mutex::new(String::new())),
        fatal_error: Arc::new(Mutex::new(None)),
        pending_turn: Arc::new(Mutex::new(None)),
        exited: Arc::new(AtomicBool::new(false)),
        exit_detail: Arc::new(Mutex::new(None)),
        directory: directory.to_string(),
        binary: binary_display,
        proxy: proxy_text,
        model: model_text,
        effort: effort_text,
        permission_mode: permission_mode_text.to_string(),
        resume_session,
        run_id: run_id.to_string(),
    });

    {
        let app = app.clone();
        let client = client.clone();
        let run_id_for_stdout = run_id.to_string();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let stream_id = current_claude_stream_id(&client);
                if let Some(stream_id) = stream_id.as_deref() {
                    emit_cli_stream_line(
                        &app,
                        "claude",
                        &run_id_for_stdout,
                        stream_id,
                        "stdout",
                        &line,
                    );
                }

                let Ok(event) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };

                if let Some(next_session_id) = extract_cli_session_id(&event) {
                    if let Ok(mut session) = client.session_id.lock() {
                        *session = Some(next_session_id);
                    }
                }

                // 把 stream-json 的 assistant text/thinking/tool_use + user tool_result
                // 翻译成 galcode.block，前端 BlockStream 才能渲染中间过程。
                let blocks = extract_claude_blocks(&event);
                if !blocks.is_empty() {
                    let stream_id_dbg = stream_id.as_deref().unwrap_or("(none)");
                    let types: Vec<String> = blocks
                        .iter()
                        .filter_map(|b| {
                            b.get("block")
                                .and_then(|x| x.get("type"))
                                .and_then(|x| x.as_str())
                                .map(ToOwned::to_owned)
                        })
                        .collect();
                    eprintln!(
                        "[claude] emit {} block(s): {} (stream_id={})",
                        blocks.len(),
                        types.join(","),
                        stream_id_dbg
                    );
                }
                for block_event in blocks {
                    if let Some(stream_id) = stream_id.as_deref() {
                        emit_cli_stream_json_event(
                            &app,
                            "claude",
                            &run_id_for_stdout,
                            stream_id,
                            &block_event,
                        );
                    } else {
                        eprintln!("[claude] WARN: block dropped — no active stream_id");
                    }
                }

                if let Some(message) = extract_claude_event_message(&event) {
                    if let Ok(mut last_message) = client.last_message.lock() {
                        *last_message = message;
                    }
                }

                if let Some(error_message) = claude_stream_error_message(&event) {
                    set_claude_client_fatal_error(&client, error_message);
                }

                if event.get("type").and_then(Value::as_str) == Some("result") {
                    if let Some(turn) = take_claude_pending_turn(&client.pending_turn) {
                        let session_id = client
                            .session_id
                            .lock()
                            .ok()
                            .and_then(|value| value.clone());
                        let error = client
                            .fatal_error
                            .lock()
                            .ok()
                            .and_then(|value| value.clone());
                        let output = client
                            .last_message
                            .lock()
                            .map(|value| value.clone())
                            .unwrap_or_default();

                        let _ = turn.waiter.send(if let Some(error) = error {
                            Err(error)
                        } else {
                            Ok((session_id, output))
                        });
                    }
                }
            }
        });
    }

    {
        let app = app.clone();
        let client = client.clone();
        let run_id_for_stderr = run_id.to_string();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                let stream_id = current_claude_stream_id(&client);
                if let Some(stream_id) = stream_id.as_deref() {
                    emit_cli_stream_line(
                        &app,
                        "claude",
                        &run_id_for_stderr,
                        stream_id,
                        "stderr",
                        trimmed,
                    );
                }
            }
        });
    }

    {
        let client = client.clone();
        std::thread::spawn(move || {
            let status = child.wait();
            client.exited.store(true, Ordering::SeqCst);
            let detail = match status {
                Ok(status) if status.success() => None,
                Ok(status) => Some(format!("Claude Code 会话已结束（exit code: {}）。", status)),
                Err(error) => Some(format!("Claude Code 会话异常退出：{error}")),
            };

            if let Some(message) = detail.clone() {
                if let Ok(mut exit_detail) = client.exit_detail.lock() {
                    *exit_detail = Some(message.clone());
                }
                set_claude_client_fatal_error(&client, message.clone());
            }

            if let Some(turn) = take_claude_pending_turn(&client.pending_turn) {
                let error = client
                    .fatal_error
                    .lock()
                    .ok()
                    .and_then(|value| value.clone())
                    .or_else(|| detail.clone())
                    .unwrap_or_else(|| "Claude Code 会话已意外结束。".to_string());
                let _ = turn.waiter.send(Err(error));
            }
        });
    }

    Ok(client)
}

pub fn kill_claude_stream_client(client: &ClaudeStreamClient) {
    if client.exited.load(Ordering::SeqCst) {
        return;
    }

    // 解开所有阻塞中的 permission-prompt-tool handler 线程：Claude 进程一旦
    // 被杀，前端 PermissionCard 也会随 tab 销毁，永远不会有人调
    // respond_permission_decision，handler 会在 rx.recv_timeout 上空等
    // 10 分钟。这里主动 deny 一下释放掉。
    let denied = crate::permission_mcp::deny_pending_for_run(
        &client.run_id,
        "Claude session 已停止",
    );
    if denied > 0 {
        log::info!(
            "[claude] kill run_id={}: denied {} pending permission request(s)",
            client.run_id,
            denied
        );
    }

    // 先递归清理子进程树（含 SIGTERM→SIGKILL 回退），再强杀主进程
    kill_child_descendants(client.pid);

    #[cfg(unix)]
    {
        // 子进程树已由 kill_child_descendants 处理，主进程直接 SIGKILL 确保退出
        let _ = Command::new("kill")
            .arg("-KILL")
            .arg(client.pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        configure_background_command(&mut command);
        let _ = command
            .arg("/PID")
            .arg(client.pid.to_string())
            .arg("/T")
            .arg("/F")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// cc-switch 等外部工具改写 `~/.claude/settings.json` 后调用：杀掉所有**空闲**
/// （无进行中 turn）的 per-tab stream client。下一轮 turn 在
/// ensure_claude_stream_client 里带新 settings.json 重启，从而用上新服务商；
/// `resume_session` 字段随重启保留，`--resume` 会续上原对话上下文。
///
/// 正忙的 tab 跳过不杀，返回 `false` 让调用方稍后重试，避免打断进行中的对话。
pub fn reset_idle_claude_clients(state: &RuntimeState) -> bool {
    let (idle, all_idle) = drain_idle_claude_clients(state);
    for client in &idle {
        kill_claude_stream_client(client);
    }
    if !idle.is_empty() {
        log::info!(
            "[config-watch] Claude 重置了 {} 个空闲 stream client（settings.json 变更），下一轮以新配置重启",
            idle.len()
        );
    }
    all_idle
}

pub fn claude_stream_client_matches(
    client: &ClaudeStreamClient,
    directory: &str,
    session_id: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
    permission_mode: Option<&str>,
    app: &AppHandle,
) -> bool {
    if client.exited.load(Ordering::SeqCst) || client.directory != directory {
        return false;
    }

    let desired_binary = resolve_claude_binary(app, requested_binary)
        .display()
        .to_string();
    let desired_proxy = proxy
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let desired_model = model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let desired_effort = effort
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let desired_session = session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned);
    let desired_permission_mode = normalize_permission_mode(permission_mode);

    if client.binary != desired_binary
        || client.proxy != desired_proxy
        || client.model != desired_model
        || client.effort != desired_effort
        || client.permission_mode != desired_permission_mode
    {
        return false;
    }

    let current_session = client
        .session_id
        .lock()
        .ok()
        .and_then(|value| value.clone())
        .or_else(|| client.resume_session.clone());

    match (current_session.as_deref(), desired_session.as_deref()) {
        (_, None) => true,
        (Some(current), Some(expected)) => current == expected,
        (None, Some(_)) => false,
    }
}

pub fn ensure_claude_stream_client(
    app: &AppHandle,
    state: &RuntimeState,
    run_id: &str,
    directory: &str,
    session_id: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
    permission_mode: Option<&str>,
) -> Result<Arc<ClaudeStreamClient>, String> {
    let existing = with_claude_state(state, run_id, |claude| claude.client.clone())?;

    if let Some(client) = existing {
        if claude_stream_client_matches(
            &client,
            directory,
            session_id,
            model,
            effort,
            requested_binary,
            proxy,
            permission_mode,
            app,
        ) {
            return Ok(client);
        }

        kill_claude_stream_client(&client);
    }

    let client = spawn_claude_stream_client(
        app,
        run_id,
        directory,
        session_id,
        model,
        effort,
        requested_binary,
        proxy,
        permission_mode,
    )?;

    with_claude_state(state, run_id, |claude| {
        claude.client = Some(client.clone());
    })?;
    Ok(client)
}

pub fn run_claude_stream_turn(
    app: &AppHandle,
    state: &RuntimeState,
    run_id: &str,
    prompt: &str,
    directory: &str,
    session_id: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
    permission_mode: Option<&str>,
    stream_id: Option<&str>,
) -> Result<(Option<String>, String), String> {
    let client = ensure_claude_stream_client(
        app,
        state,
        run_id,
        directory,
        session_id,
        model,
        effort,
        requested_binary,
        proxy,
        permission_mode,
    )?;

    if client.exited.load(Ordering::SeqCst) {
        let detail = client
            .exit_detail
            .lock()
            .ok()
            .and_then(|value| value.clone())
            .unwrap_or_else(|| "Claude Code 会话尚未就绪。".to_string());
        return Err(detail);
    }

    let (tx, rx) = mpsc::channel();
    {
        let mut pending_turn = client
            .pending_turn
            .lock()
            .map_err(|_| "Failed to lock Claude pending turn state.".to_string())?;
        if pending_turn.is_some() {
            return Err("Claude Code 当前仍在处理上一条请求。".to_string());
        }
        *pending_turn = Some(ClaudePendingTurn {
            stream_id: stream_id.map(ToOwned::to_owned),
            waiter: tx,
        });
    }

    if let Ok(mut fatal_error) = client.fatal_error.lock() {
        *fatal_error = None;
    }
    if let Ok(mut last_message) = client.last_message.lock() {
        last_message.clear();
    }

    let payload = json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": prompt,
        }
    })
    .to_string();

    {
        let mut stdin = client
            .stdin
            .lock()
            .map_err(|_| "Failed to lock Claude Code stdin.".to_string())?;
        stdin
            .write_all(payload.as_bytes())
            .map_err(|error| format!("Failed to write prompt to Claude Code stream: {error}"))?;
        stdin
            .write_all(b"\n")
            .map_err(|error| format!("Failed to finalize Claude Code stream prompt: {error}"))?;
        stdin
            .flush()
            .map_err(|error| format!("Failed to flush Claude Code stream prompt: {error}"))?;
    }

    match rx.recv_timeout(CODEX_TURN_TIMEOUT) {
        Ok(result) => result,
        Err(_) => {
            let _ = take_claude_pending_turn(&client.pending_turn);
            Err("Claude Code 响应超时。".to_string())
        }
    }
}

// ---------------------------------------------------------------------------
// Probe (验证连接)
// ---------------------------------------------------------------------------

#[allow(dead_code)]
pub fn run_claude_probe(
    app: &AppHandle,
    model: Option<&str>,
    effort: Option<&str>,
    requested_binary: Option<&str>,
    proxy: Option<&str>,
) -> Result<String, String> {
    let root = resolve_project_root(app)?;
    let binary = resolve_claude_binary(app, requested_binary);
    let mut command = Command::new(&binary);
    configure_background_command(&mut command);
    command
        .current_dir(&root)
        .arg("-p")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--permission-mode")
        .arg("default")
        .arg("--no-session-persistence");

    if let Some(model) = model.filter(|value| !value.trim().is_empty()) {
        command.arg("--model").arg(model);
    }
    if let Some(effort) = effort.filter(|value| !value.trim().is_empty()) {
        command.arg("--effort").arg(effort);
    }

    apply_proxy_env(&mut command, proxy);

    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start Claude Code probe: {error}"))?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(b"Reply with exactly OK.")
            .map_err(|error| format!("Failed to write probe prompt to Claude Code CLI: {error}"))?;
    }
    drop(child.stdin.take());

    let output = wait_child_output_with_timeout(child, CLI_VERIFY_TIMEOUT)?;
    let stdout = trim_output(&output.stdout);
    let stderr = strip_cli_warning_lines(&trim_output(&output.stderr));

    let mut events = Vec::new();
    for line in stdout.lines().filter(|line| !line.trim().is_empty()) {
        if let Ok(event) = serde_json::from_str::<Value>(line) {
            events.push(event);
        }
    }
    let message = extract_claude_last_message(&events);

    if !output.status.success() {
        return Err(if !message.trim().is_empty() {
            message
        } else if !stderr.is_empty() {
            stderr
        } else {
            stdout
        });
    }

    Ok(if message.trim().is_empty() {
        "Claude Code 请求已完成，但没有返回最终消息。".to_string()
    } else {
        message
    })
}
