// HTTP /api/cmd/<name> 的后端 dispatch：把 JSON 包装的 args 解析后调用 commands.rs
// 里既有的 #[tauri::command] 函数（这些函数本身就是普通 Rust 函数，宏只是注册
// invoke_handler，外部代码可以照常调用）。
//
// 这样我们不用为移动端再写一遍命令逻辑：所有桌面端跑得通的命令在浏览器端也直接复用。
// 安全：调到这里的请求已经过 LAN token 鉴权（api.rs 的 verify_and_touch_token），
// 用户即"已知道密码的局域网客户端"——理论上等同于桌面端用户，所以全命令开放。

use crate::agent::runtime::RuntimeState;
use crate::ipc::commands;
use crate::lan::state::LanRuntimeState;
use crate::AppState;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

/// 把 args JSON 反序列化成对应类型；缺字段给默认。命令字段名前端用 camelCase。
fn parse<T: for<'de> Deserialize<'de> + Default>(v: Value) -> Result<T, String> {
    if v.is_null() {
        return Ok(T::default());
    }
    serde_json::from_value(v).map_err(|e| format!("args 反序列化失败: {e}"))
}

fn to_value<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| format!("响应序列化失败: {e}"))
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ListDirectoryArgs {
    path: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ImportedConversationArgs {
    id: String,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ImportedAssetArgs {
    asset_id: String,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct StartAgentArgs {
    user_input_zh: String,
    cwd: Option<String>,
    agent: Option<String>,
    run_id: Option<String>,
    session_id: Option<String>,
    imported_fallback_context: Option<String>,
    permission_mode: Option<String>,
    prompt_override: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct StopAgentArgs {
    session_id: Option<String>,
    run_id: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct GetSessionLogsArgs {
    session_id: String,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct FinalizePendingArgs {
    run_id: String,
    session_id: String,
    user_zh: String,
    result_raw: String,
    agent_native_session_id: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct TranslateOnlyArgs {
    text_zh: String,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct UpdateLlmSettingsArgs {
    base_url: String,
    api_key: String,
    nickname: String,
    system_prompt: String,
    provider: Option<String>,
    model: Option<String>,
    thinking: Option<bool>,
    translate_input: Option<bool>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ListLlmModelsArgs {
    base_url: String,
    api_key: String,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct UpdateBackendPreferencesArgs {
    backend: String,
    model: Option<String>,
    effort: Option<String>,
    proxy: Option<String>,
    binary: Option<String>,
    provider: Option<String>,
    api_key: Option<String>,
    auth_mode: Option<String>,
    default_permission_mode: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ClickThroughArgs {
    enabled: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ClaudeStatusArgs {
    binary: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ClaudeVerifyArgs {
    model: Option<String>,
    effort: Option<String>,
    binary: Option<String>,
    proxy: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ClaudeLoginOpenArgs {
    binary: Option<String>,
    proxy: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ClaudeRunInTerminalArgs {
    args: Vec<String>,
    binary: Option<String>,
    proxy: Option<String>,
    success_message: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ClaudeSendPromptArgs {
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
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct CodexStatusArgs {
    binary: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct CodexVerifyArgs {
    model: Option<String>,
    reasoning_effort: Option<String>,
    binary: Option<String>,
    proxy: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct CodexLoginOpenArgs {
    binary: Option<String>,
    device_auth: Option<bool>,
    proxy: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct CodexSendPromptArgs {
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
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct OpencodeRunArgs {
    run_id: Option<String>,
    binary: Option<String>,
    proxy: Option<String>,
    port: Option<u16>,
    cwd: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct OpencodeRunIdOnlyArgs {
    run_id: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct OpencodeCreateSessionArgs {
    run_id: Option<String>,
    title: Option<String>,
    directory: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct OpencodeSetAuthArgs {
    provider: String,
    mode: String,
    api_key: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct OpencodeLoginOpenArgs {
    binary: Option<String>,
    provider: Option<String>,
    proxy: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct OpencodeSendPromptArgs {
    run_id: Option<String>,
    session_id: String,
    text: String,
    system: Option<String>,
    directory: Option<String>,
    stream_id: Option<String>,
    provider: Option<String>,
    model: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct LanSetPasswordArgs {
    password: String,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct LanSetPortArgs {
    port: u16,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct LanSetEnabledArgs {
    enabled: bool,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct LanSyncProjectsArgs {
    items: Vec<crate::lan::state::ProjectSnapshotItem>,
    active_tab_id: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct PermissionResponseArgs {
    session_id: String,
    tool_use_id: String,
    decision: String,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct PermissionDecisionArgs {
    request_id: String,
    decision: String,
    message: Option<String>,
    updated_input: Option<Value>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct StorageGetArgs {
    key: String,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct StorageSetArgs {
    key: String,
    value: String,
    source: Option<String>,
    notify_webview: Option<bool>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct StorageRemoveArgs {
    key: String,
    source: Option<String>,
    notify_webview: Option<bool>,
}

/// 主分发函数。HTTP server 的 /api/cmd/<cmd> handler 调它。
/// 命令名沿用桌面端 invoke 名（snake_case）；返回 serde_json::Value（前端再按类型用）。
pub async fn dispatch(app: AppHandle, cmd: &str, args: Value) -> Result<Value, String> {
    let app_state = app.state::<Arc<AppState>>();
    let runtime_state = app.state::<Arc<RuntimeState>>();
    let lan_state = app.state::<Arc<LanRuntimeState>>();

    match cmd {
        // 通用
        "select_project_folder" => {
            let v = commands::select_project_folder(app.clone())?;
            to_value(v)
        }
        "list_directory" => {
            let p: ListDirectoryArgs = parse(args)?;
            to_value(commands::list_directory(p.path)?)
        }
        "validate_directory" => {
            let p: ListDirectoryArgs = parse(args)?;
            commands::validate_directory(p.path.unwrap_or_default())?;
            Ok(Value::Null)
        }
        "list_imported_conversations" => {
            to_value(commands::list_imported_conversations(app.clone()).await?)
        }
        "load_imported_conversation" => {
            let p: ImportedConversationArgs = parse(args)?;
            to_value(commands::load_imported_conversation(app.clone(), p.id).await?)
        }
        "load_imported_asset" => {
            let p: ImportedAssetArgs = parse(args)?;
            to_value(commands::load_imported_asset(app.clone(), p.asset_id).await?)
        }
        "remove_imported_conversation" => {
            let p: ImportedConversationArgs = parse(args)?;
            commands::remove_imported_conversation(app.clone(), p.id).await?;
            Ok(Value::Null)
        }
        "list_sessions" => to_value(commands::list_sessions(app_state)?),
        "start_agent" => {
            let p: StartAgentArgs = parse(args)?;
            to_value(
                commands::start_agent(
                    app.clone(),
                    app_state,
                    runtime_state,
                    p.user_input_zh,
                    p.cwd,
                    p.agent,
                    p.run_id,
                    p.session_id,
                    p.imported_fallback_context,
                    p.permission_mode,
                    p.prompt_override,
                )
                .await?,
            )
        }
        "stop_agent" => {
            let p: StopAgentArgs = parse(args)?;
            commands::stop_agent(app.clone(), app_state, runtime_state, p.session_id, p.run_id)
                .await?;
            Ok(Value::Null)
        }
        "respond_permission" => {
            let p: PermissionResponseArgs = parse(args)?;
            to_value(commands::respond_permission(
                app_state,
                p.session_id,
                p.tool_use_id,
                p.decision,
            )?)
        }
        "respond_permission_decision" => {
            let p: PermissionDecisionArgs = parse(args)?;
            to_value(commands::respond_permission_decision(
                p.request_id,
                p.decision,
                p.message,
                p.updated_input,
            )?)
        }
        "get_session_logs" => {
            let p: GetSessionLogsArgs = parse(args)?;
            to_value(commands::get_session_logs(app_state, p.session_id)?)
        }
        "finalize_pending" => {
            let p: FinalizePendingArgs = parse(args)?;
            commands::finalize_pending(
                app.clone(),
                p.run_id,
                p.session_id,
                p.user_zh,
                p.result_raw,
                p.agent_native_session_id,
            )
            .await?;
            Ok(Value::Null)
        }
        "translate_only" => {
            let p: TranslateOnlyArgs = parse(args)?;
            to_value(commands::translate_only(p.text_zh)?)
        }
        "update_llm_settings" => {
            let p: UpdateLlmSettingsArgs = parse(args)?;
            commands::update_llm_settings(
                p.base_url,
                p.api_key,
                p.nickname,
                p.system_prompt,
                p.provider,
                p.model,
                p.thinking,
                p.translate_input,
            )?;
            Ok(Value::Null)
        }
        "list_llm_models" => {
            let p: ListLlmModelsArgs = parse(args)?;
            to_value(commands::list_llm_models(p.base_url, p.api_key).await?)
        }
        "update_backend_preferences" => {
            let p: UpdateBackendPreferencesArgs = parse(args)?;
            commands::update_backend_preferences(
                runtime_state,
                p.backend,
                p.model,
                p.effort,
                p.proxy,
                p.binary,
                p.provider,
                p.api_key,
                p.auth_mode,
                p.default_permission_mode,
            )?;
            Ok(Value::Null)
        }
        "set_click_through" => {
            let p: ClickThroughArgs = parse(args)?;
            commands::set_click_through(app.clone(), p.enabled)?;
            Ok(Value::Null)
        }

        // Claude
        "claude_status" => {
            let p: ClaudeStatusArgs = parse(args)?;
            to_value(commands::claude_status(app.clone(), p.binary).await?)
        }
        "claude_models" => {
            let p: ClaudeStatusArgs = parse(args)?;
            to_value(commands::claude_models(app.clone(), p.binary).await?)
        }
        "claude_verify" => {
            let p: ClaudeVerifyArgs = parse(args)?;
            to_value(
                commands::claude_verify(app.clone(), p.model, p.effort, p.binary, p.proxy).await?,
            )
        }
        "claude_login_open" => {
            let p: ClaudeLoginOpenArgs = parse(args)?;
            to_value(commands::claude_login_open(app.clone(), p.binary, p.proxy).await?)
        }
        "claude_run_in_terminal" => {
            let p: ClaudeRunInTerminalArgs = parse(args)?;
            to_value(
                commands::claude_run_in_terminal(
                    app.clone(),
                    p.args,
                    p.binary,
                    p.proxy,
                    p.success_message,
                )
                .await?,
            )
        }
        "claude_send_prompt" => {
            let p: ClaudeSendPromptArgs = parse(args)?;
            to_value(
                commands::claude_send_prompt(
                    app.clone(),
                    runtime_state,
                    p.run_id,
                    p.text,
                    p.cwd,
                    p.session_id,
                    p.model,
                    p.effort,
                    p.binary,
                    p.proxy,
                    p.permission_mode,
                    p.stream_id,
                )
                .await?,
            )
        }

        // Codex
        "codex_status" => {
            let p: CodexStatusArgs = parse(args)?;
            to_value(commands::codex_status(app.clone(), p.binary).await?)
        }
        "codex_verify" => {
            let p: CodexVerifyArgs = parse(args)?;
            to_value(
                commands::codex_verify(
                    app.clone(),
                    p.model,
                    p.reasoning_effort,
                    p.binary,
                    p.proxy,
                )
                .await?,
            )
        }
        "codex_login_open" => {
            let p: CodexLoginOpenArgs = parse(args)?;
            to_value(commands::codex_login_open(app.clone(), p.binary, p.device_auth, p.proxy).await?)
        }
        "codex_send_prompt" => {
            let p: CodexSendPromptArgs = parse(args)?;
            to_value(
                commands::codex_send_prompt(
                    app.clone(),
                    runtime_state,
                    p.run_id,
                    p.thread_id,
                    p.text,
                    p.system,
                    p.cwd,
                    p.model,
                    p.reasoning_effort,
                    p.binary,
                    p.proxy,
                    p.stream_id,
                )
                .await?,
            )
        }

        // OpenCode
        "opencode_status" => {
            let p: OpencodeRunIdOnlyArgs = parse(args)?;
            to_value(commands::opencode_status(app.clone(), runtime_state, p.run_id).await?)
        }
        "opencode_start" => {
            let p: OpencodeRunArgs = parse(args)?;
            to_value(
                commands::opencode_start(
                    app.clone(),
                    runtime_state,
                    p.run_id,
                    p.binary,
                    p.proxy,
                    p.port,
                    p.cwd,
                )
                .await?,
            )
        }
        "opencode_stop" => {
            let p: OpencodeRunIdOnlyArgs = parse(args)?;
            to_value(commands::opencode_stop(runtime_state, p.run_id).await?)
        }
        "opencode_create_session" => {
            let p: OpencodeCreateSessionArgs = parse(args)?;
            to_value(
                commands::opencode_create_session(
                    app.clone(),
                    runtime_state,
                    p.run_id,
                    p.title,
                    p.directory,
                )
                .await?,
            )
        }
        "opencode_set_auth" => {
            let p: OpencodeSetAuthArgs = parse(args)?;
            commands::opencode_set_auth(p.provider, p.mode, p.api_key).await?;
            Ok(Value::Null)
        }
        "opencode_login_open" => {
            let p: OpencodeLoginOpenArgs = parse(args)?;
            to_value(
                commands::opencode_login_open(app.clone(), p.binary, p.provider, p.proxy).await?,
            )
        }
        "opencode_list_providers" => {
            let p: OpencodeRunIdOnlyArgs = parse(args)?;
            to_value(
                commands::opencode_list_providers(app.clone(), runtime_state, p.run_id).await?,
            )
        }
        "opencode_send_prompt" => {
            let p: OpencodeSendPromptArgs = parse(args)?;
            to_value(
                commands::opencode_send_prompt(
                    app.clone(),
                    runtime_state,
                    p.run_id,
                    p.session_id,
                    p.text,
                    p.system,
                    p.directory,
                    p.stream_id,
                    p.provider,
                    p.model,
                )
                .await?,
            )
        }

        // LAN
        "lan_get_state" => to_value(commands::lan_get_state(app.clone(), lan_state)?),
        "lan_set_password" => {
            let p: LanSetPasswordArgs = parse(args)?;
            to_value(commands::lan_set_password(app.clone(), lan_state, p.password)?)
        }
        "lan_clear_password" => to_value(commands::lan_clear_password(app.clone(), lan_state)?),
        "lan_set_port" => {
            let p: LanSetPortArgs = parse(args)?;
            to_value(commands::lan_set_port(app.clone(), lan_state, p.port)?)
        }
        "lan_set_enabled" => {
            let p: LanSetEnabledArgs = parse(args)?;
            to_value(commands::lan_set_enabled(app.clone(), lan_state, p.enabled)?)
        }
        "lan_revoke_all_devices" => {
            to_value(commands::lan_revoke_all_devices(app.clone(), lan_state)?)
        }
        "lan_sync_projects" => {
            let p: LanSyncProjectsArgs = parse(args)?;
            commands::lan_sync_projects(lan_state, p.items, p.active_tab_id)?;
            Ok(Value::Null)
        }
        "lan_list_storage" => to_value(commands::lan_list_storage(lan_state)?),
        "lan_get_storage" => {
            let p: StorageGetArgs = parse(args)?;
            to_value(commands::lan_get_storage(lan_state, p.key)?)
        }
        "lan_set_storage" => {
            let p: StorageSetArgs = parse(args)?;
            commands::lan_set_storage(
                app.clone(),
                lan_state,
                p.key,
                p.value,
                p.source,
                p.notify_webview,
            )?;
            Ok(Value::Null)
        }
        "lan_remove_storage" => {
            let p: StorageRemoveArgs = parse(args)?;
            commands::lan_remove_storage(
                app.clone(),
                lan_state,
                p.key,
                p.source,
                p.notify_webview,
            )?;
            Ok(Value::Null)
        }

        _ => Err(format!("不支持的命令: {cmd}")),
    }
    .map(|v| json!({ "value": v }))
}
