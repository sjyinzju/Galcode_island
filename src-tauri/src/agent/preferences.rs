// 三个 backend 的运行时偏好（model / effort / proxy / binary）。
// 单例存内存里，前端在 Settings 修改后通过 update_backend_preferences 命令同步。
//
// 持久化：当前**前端**走 zustand persist 写 localStorage，启动时重新 invoke
// 一次同步过来。后端不写文件——避免 JSON 格式漂移以及多窗口写冲突的麻烦。
// 真要做后端持久化（比如 CLI 用户希望在没有前端时也能跑），未来再加 fs IO。

use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Default)]
pub struct BackendSettings {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub proxy: Option<String>,
    pub binary: Option<String>,
    /// 仅 OpenCode 用：服务商 id（"anthropic"/"openai"/...）。其它 backend 全为 None。
    pub provider: Option<String>,
    /// 仅 OpenCode 用：API Key（authMode == "key" 时生效）。Rust 端不主动用，
    /// 但 launch_opencode_agent 在启动 serve 之前会拿它去调 opencode_set_auth 写
    /// auth.json，用完丢；持久化以前端 zustand 为准。
    pub api_key: Option<String>,
    /// 仅 OpenCode 用："oauth" / "key" / None。决定启动前是否要 set_auth。
    pub auth_mode: Option<String>,
    /// 仅 Claude Code 用：新开 tab 的默认 permission mode
    /// （"default" / "acceptEdits" / "plan" / "bypassPermissions"）。None 表示用前端 fallback。
    /// 实际每次 start_agent 的 mode 由前端传入；这里仅用作"全局 Settings 设过默认值"的 cache，
    /// 给将来 CLI / LAN 客户端读取用。
    #[allow(dead_code)]
    pub default_permission_mode: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct AllBackendPreferences {
    pub claude: BackendSettings,
    pub codex: BackendSettings,
    pub opencode: BackendSettings,
}

static GLOBAL_BACKEND_PREFS: OnceLock<Mutex<AllBackendPreferences>> = OnceLock::new();

fn get_global_prefs() -> &'static Mutex<AllBackendPreferences> {
    GLOBAL_BACKEND_PREFS.get_or_init(|| Mutex::new(AllBackendPreferences::default()))
}

/// 把空字符串归一为 None —— 前端 Settings 表单里的空 input 不应当作"显式空值"。
fn normalize(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn update_backend_preferences(
    backend: &str,
    model: Option<String>,
    effort: Option<String>,
    proxy: Option<String>,
    binary: Option<String>,
    provider: Option<String>,
    api_key: Option<String>,
    auth_mode: Option<String>,
    default_permission_mode: Option<String>,
) -> Result<(), String> {
    let settings = BackendSettings {
        model: normalize(model),
        effort: normalize(effort),
        proxy: normalize(proxy),
        binary: normalize(binary),
        provider: normalize(provider),
        // api_key 不 trim：用户密钥可能包含前后无意义空白被误删的风险，但通常不会有；
        // 走 normalize 保持空串归 None 行为一致。
        api_key: normalize(api_key),
        auth_mode: normalize(auth_mode),
        default_permission_mode: normalize(default_permission_mode),
    };

    let mut prefs = get_global_prefs()
        .lock()
        .map_err(|_| "Failed to lock backend preferences.".to_string())?;
    match backend {
        "claude" | "claude-code" => prefs.claude = settings,
        "codex" => prefs.codex = settings,
        "opencode" => prefs.opencode = settings,
        other => return Err(format!("Unknown backend: {other}")),
    }
    Ok(())
}

pub fn load_backend_preferences(backend: &str) -> BackendSettings {
    let prefs = match get_global_prefs().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    match backend {
        "claude" | "claude-code" => prefs.claude.clone(),
        "codex" => prefs.codex.clone(),
        "opencode" => prefs.opencode.clone(),
        _ => BackendSettings::default(),
    }
}
