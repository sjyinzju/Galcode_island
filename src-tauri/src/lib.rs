// 这些 lint 在 backend 模块里"看着像问题但其实合理"，统一在 crate 级别抑制：
//   - needless_return: cfg(target_os) 平台分支里 return 是必须的（编译期只激活一个分支，
//     单分支视角下 return 后面"无代码"看似冗余，但少了 return 类型不匹配）
//   - too_many_arguments: backend launch/turn 函数固有参数多 (cwd/model/effort/proxy/binary/...)
//   - type_complexity: Arc<Mutex<HashMap<...>>> 等并发数据结构的复杂签名是设计本身
#![allow(
    clippy::needless_return,
    clippy::too_many_arguments,
    clippy::type_complexity
)]

mod agent;
mod external_history;
mod ipc;
mod lan;
mod llm;
mod permission_mcp;
mod session;
mod window_utils;

use tauri::Manager;

use ipc::commands::{
    claude_login_open, claude_models, claude_run_in_terminal, claude_send_prompt, claude_status,
    claude_verify, codex_login_open, codex_models, codex_send_prompt, codex_status, codex_verify,
    finalize_pending, generate_poke_speech, generate_welcome_speech, get_session_logs,
    import_external_sessions, lan_clear_password, lan_get_state, lan_get_storage, lan_list_storage,
    lan_remove_storage, lan_revoke_all_devices, lan_set_enabled, lan_set_password, lan_set_port,
    lan_set_storage, lan_sync_projects, list_directory, list_imported_conversations,
    list_llm_models, list_project_slash_commands, list_sessions, load_imported_asset,
    load_imported_conversation, opencode_create_session, opencode_list_providers,
    opencode_login_open, opencode_send_prompt, opencode_set_auth, opencode_start, opencode_status,
    opencode_stop, remove_imported_conversation, respond_permission, respond_permission_decision,
    scan_external_sessions, select_project_folder, set_click_through, start_agent, stop_agent,
    translate_only, update_backend_preferences, update_llm_settings, validate_directory,
};
use ipc::git::{
    git_checkout_branch, git_commit, git_diff, git_discard, git_generate_commit_message,
    git_list_branches, git_log, git_pull, git_push, git_pushed_commits, git_remote_url,
    git_show_commit_files, git_show_file_diff, git_stage, git_status, git_unstage,
};
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub manager: Arc<std::sync::Mutex<agent::manager::AgentManager>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            manager: Arc::new(std::sync::Mutex::new(agent::manager::AgentManager::new())),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 默认开 INFO 级别，dev 不需要 RUST_LOG=info 也能看到诊断日志。
    // 用户可以通过 RUST_LOG=debug 进一步加详细。
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // 自动更新：endpoints / pubkey 在 tauri.conf.json plugins.updater 配置
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 安装完成后用 process.relaunch() 重启 webview
        .plugin(tauri_plugin_process::init())
        // 系统级通知：任务结束时弹原生通知（前端调 sendNotification）
        .plugin(tauri_plugin_notification::init())
        // HTTP plugin：让前端 fetch 走 Rust reqwest，绕开 macOS WKWebView 对
        // tauri:// 跨域 fetch 的"Load failed"限制。仅桌面端使用；浏览器 LAN 走 window.fetch
        .plugin(tauri_plugin_http::init())
        .manage(Arc::new(AppState::new()))
        .manage(Arc::new(agent::runtime::RuntimeState::default()))
        .manage(Arc::new(lan::LanRuntimeState::default()))
        .setup(|app| {
            let handle = app.handle().clone();
            let state = app.state::<Arc<AppState>>();
            session::cleanup::spawn_idle_cleanup_loop(handle.clone(), Arc::clone(&state));

            // 启动时清理上一轮崩溃 / 强退留下的 opencode/codex/claude 孤儿子进程，
            // 避免端口被占用或重复消耗 token。
            agent::sysutils::cleanup_stale_runtime_orphans(&handle);

            // 启动本地 HTTP MCP 服务用于桥接 Claude Code 的 permission-prompt-tool。
            // 失败不阻塞主流程：MCP 起不来时 Claude CLI 启动会自动跳过桥接、退化到
            // 纯 --permission-mode 行为（与本特性出现前一致）。
            if let Err(e) = permission_mcp::spawn(handle.clone()) {
                log::warn!("[permission-mcp] 启动失败: {e}");
            }

            // 把 Tauri emit 的核心事件 forward 到 LAN 事件总线（浏览器端 listen 用）
            lan::event_bus::register_forwarders(&handle);

            // 共享 storage 启动时从盘上加载到内存（重启后镜像不丢，移动端拉到非空数据）
            {
                let entries = lan::shared_storage::load(&handle);
                if !entries.is_empty() {
                    let storage_arc = handle
                        .state::<Arc<lan::LanRuntimeState>>()
                        .shared_storage
                        .clone();
                    let count = entries.len();
                    let lock_result = storage_arc.lock();
                    if let Ok(mut map) = lock_result {
                        *map = entries;
                        log::info!("[lan] loaded {count} shared-storage entries from disk");
                    }
                }
            }

            // 局域网 HTTP 服务：上次启用过且密码还在 → 启动恢复
            // 失败不阻塞主流程，仅日志告警；用户可在设置里手动重新开启
            {
                let cfg = lan::config::load(&handle);
                if cfg.enabled && cfg.has_password() {
                    let lan_state = handle.state::<Arc<lan::LanRuntimeState>>();
                    match lan::server::spawn_server(&handle, cfg.port) {
                        Ok((running_port, thread, stop_flag)) => {
                            if let Ok(mut s) = lan_state.server.lock() {
                                s.thread = Some(thread);
                                s.stop_flag = Some(stop_flag);
                                s.running_port = Some(running_port);
                            }
                            log::info!("[lan] auto-resume HTTP server at :{running_port}");
                        }
                        Err(e) => {
                            log::warn!("[lan] auto-resume failed: {e}");
                        }
                    }
                }
            }

            // macOS 原生顶栏（左上红绿灯）：tauri.conf.json 主配置 decorations=false
            // 让 Windows/Linux 保持完全 borderless（用我们自画的 GlobalTopBar）；
            // macOS 单独打开 decorations 才会显示 traffic lights。配合 conf.json
            // 里 macOS-only 的 titleBarStyle=Overlay + hiddenTitle，红绿灯浮在
            // 透明窗口左上角，不占用一整行原生 title bar 高度，圆角/磨砂玻璃保留。
            #[cfg(target_os = "macos")]
            {
                if let Some(win) = app.get_webview_window("main") {
                    if let Err(e) = win.set_decorations(true) {
                        log::warn!("macOS set_decorations(true) failed: {e}");
                    }
                }
            }

            ipc::tray::setup_tray(app).map_err(|e| {
                log::warn!("tray setup skipped: {}", e);
                e
            }).ok();

            // OpenCode 后台静默自启 —— 装了 CLI 就在 boot 阶段顺手把
            // `opencode serve` 拉起来（占 DEFAULT_RUN_ID 槽位 + 默认端口 4096），
            // 让 SettingsModal 一打开就看到"运行中"，给 OpenCode 选服务商/模型
            // 不再需要用户先点"启动服务"。失败仅 warn，不阻塞 app 启动。
            //
            // 时机：先 await `boot_prefs_ready` —— 前端 App.tsx 跑完 useEffect
            // 把用户存的 binary / proxy / provider 推进 Rust 内存（命中
            // update_backend_preferences）后才动手，免得 auto-start 拿 None
            // 默认 binary 起服务、用户在 tab 里又拿自定义 binary 起一份。
            // 8s 超时兜底是为了"前端不推 prefs 的场景"（比如 LAN 浏览器客户端
            // 是唯一连接、桌面 webview 一直没启动 useEffect），到点也得起服务，
            // 不能让 OpenCode 永远等不到。
            {
                let handle_for_opencode = handle.clone();
                let runtime_state = handle
                    .state::<Arc<agent::runtime::RuntimeState>>()
                    .inner()
                    .clone();
                tauri::async_runtime::spawn(async move {
                    let notify = runtime_state.boot_prefs_ready.clone();
                    match tokio::time::timeout(
                        std::time::Duration::from_secs(8),
                        notify.notified(),
                    )
                    .await
                    {
                        Ok(_) => log::debug!("[opencode] boot prefs ready, proceeding with auto-start"),
                        Err(_) => log::info!(
                            "[opencode] boot prefs ready timeout (8s), auto-starting with defaults"
                        ),
                    }
                    agent::opencode::opencode_auto_start_silent(
                        &handle_for_opencode,
                        runtime_state.as_ref(),
                    )
                    .await;
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            // 通用
            select_project_folder,
            list_directory,
            validate_directory,
            list_project_slash_commands,
            start_agent,
            stop_agent,
            respond_permission,
            respond_permission_decision,
            get_session_logs,
            list_sessions,
            scan_external_sessions,
            import_external_sessions,
            list_imported_conversations,
            load_imported_conversation,
            load_imported_asset,
            remove_imported_conversation,
            finalize_pending,
            translate_only,
            generate_welcome_speech,
            generate_poke_speech,
            set_click_through,
            update_llm_settings,
            update_backend_preferences,
            list_llm_models,
            // Claude Code
            claude_status,
            claude_models,
            claude_verify,
            claude_login_open,
            claude_run_in_terminal,
            claude_send_prompt,
            // Codex
            codex_status,
            codex_models,
            codex_verify,
            codex_login_open,
            codex_send_prompt,
            // OpenCode
            opencode_status,
            opencode_start,
            opencode_stop,
            opencode_create_session,
            opencode_send_prompt,
            opencode_set_auth,
            opencode_login_open,
            opencode_list_providers,
            // 局域网移动端访问
            lan_get_state,
            lan_set_password,
            lan_clear_password,
            lan_set_port,
            lan_set_enabled,
            lan_revoke_all_devices,
            lan_sync_projects,
            lan_list_storage,
            lan_get_storage,
            lan_set_storage,
            lan_remove_storage,
            // Git 面板
            git_status,
            git_diff,
            git_stage,
            git_unstage,
            git_commit,
            git_push,
            git_pull,
            git_discard,
            git_log,
            git_show_commit_files,
            git_show_file_diff,
            git_generate_commit_message,
            git_list_branches,
            git_checkout_branch,
            git_remote_url,
            git_pushed_commits,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            // 用户从 tray 选"退出"时 Tauri 触发 ExitRequested，先清子进程再放过 api。
            // 桌面宠物的关窗 = 隐藏（on_window_event 已 prevent_close），不会走到这里；
            // 真退出只可能由 tray 菜单的 app.exit(0) 或 ⌘Q 触发。
            tauri::RunEvent::ExitRequested { api: _, .. } => {
                agent::manager::shutdown_runtime_clients(app_handle);
            }
            // RunEvent::Exit 在退出最后一刻再触发一次，作兜底（清理函数幂等）。
            tauri::RunEvent::Exit => {
                agent::manager::shutdown_runtime_clients(app_handle);
            }
            _ => {}
        });
}
