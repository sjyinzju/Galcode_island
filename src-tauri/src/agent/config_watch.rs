// cc-switch 兼容：监听外部工具对 CLI 标准配置文件的改动，改动后就近重启对应
// 的长驻子进程，让下一轮对话用上新服务商——且不打断进行中的 turn。
//
// 背景
//   cc-switch（及同类工具）「切换服务商」= 改写各 CLI 的标准配置文件：
//     - Claude Code: ~/.claude/settings.json  （env 里的 ANTHROPIC_BASE_URL / TOKEN）
//     - Codex:       ~/.codex/config.toml      （model_provider / base_url / bearer）
//   Galcode spawn 的 CLI 子进程天然读这些文件，所以**新开**的进程已经会用上
//   新服务商。唯一的缝隙是长驻进程只在**启动那一刻**读一次配置：
//     - Codex 是全局共享单个 app-server（整个 App 生命周期复用）；
//     - Claude 是每个 tab 一个常驻 stream client（跨轮次复用）。
//   本模块补上这条缝：检测到配置文件变化，就把对应的空闲长驻进程重置掉，
//   下一轮 turn 自动带新配置重启。
//
// 为什么只看 config.toml / settings.json，不看 auth.json / .credentials.json
//   Codex app-server 在 OAuth 刷新 token 时会**重写 auth.json**；若监听它会
//   触发「刷新→重启→刷新」的自我死循环。而 cc-switch 切换服务商一定重写
//   config.toml（其登录缓存才落在 auth.json，切换刻意不动），所以只看
//   config.toml 既能捕获每次切换、又躲开 token 刷新。Claude 侧同理：
//   provider 配置在 settings.json，登录 token 在 .credentials.json。
//
// 为什么用轮询而非文件事件（notify）
//   跨平台、零新依赖、天然吃下原子写 / rename（只比对最终文件的 mtime）。
//   ~1.5s 延迟对「人手动点一下切换、再回来打字」这个场景完全够快。

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use super::runtime::RuntimeState;

/// 轮询间隔。对「切换后立即生效」的人机节奏来说 1.5s 足够快，又不至于空转烧 CPU。
const POLL_INTERVAL: Duration = Duration::from_millis(1500);

/// 读取文件的最后修改时间；文件不存在 / 读不到元数据时返回 None。
/// 用 Option 直接参与相等比较：None→Some（文件被创建）或 mtime 变化都算「变更」。
fn file_mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
}

/// 启动后台轮询线程，监听 Claude / Codex 配置文件变更并就近重启空闲长驻进程。
///
/// 幂等性由各 reset 函数保证：空闲则重启、正忙则跳过并稍后重试；无长驻进程
/// 时是 no-op。因此即便用户根本没装 cc-switch，本循环也只是偶尔空跑一次比对。
pub fn spawn_config_watch_loop(runtime: Arc<RuntimeState>) {
    let claude_settings = super::claude::claude_config_dir().map(|dir| dir.join("settings.json"));
    let codex_config = super::binary::codex_config_file();

    if claude_settings.is_none() && codex_config.is_none() {
        log::warn!("[config-watch] 无法定位 ~/.claude 或 ~/.codex，跳过配置监听");
        return;
    }

    std::thread::spawn(move || {
        // 先记下启动时的基线 mtime，之后每轮与基线比对，避免首轮误判为「变更」。
        let mut last_claude = claude_settings.as_deref().and_then(file_mtime);
        let mut last_codex = codex_config.as_deref().and_then(file_mtime);

        // dirty = 检测到变更但尚未成功应用（长驻进程正忙时会延后到下一轮重试）。
        let mut claude_dirty = false;
        let mut codex_dirty = false;

        log::info!(
            "[config-watch] 已启动：claude={:?} codex={:?}",
            claude_settings,
            codex_config
        );

        loop {
            std::thread::sleep(POLL_INTERVAL);

            if let Some(path) = claude_settings.as_ref() {
                let current = file_mtime(path);
                if current != last_claude {
                    last_claude = current;
                    claude_dirty = true;
                    log::info!("[config-watch] 检测到 ~/.claude/settings.json 变更");
                }
            }
            if let Some(path) = codex_config.as_ref() {
                let current = file_mtime(path);
                if current != last_codex {
                    last_codex = current;
                    codex_dirty = true;
                    log::info!("[config-watch] 检测到 ~/.codex/config.toml 变更");
                }
            }

            // 应用变更：成功（含无进程可重置）则清 dirty；被延后（正忙）则保留
            // dirty，下一轮再试。
            if claude_dirty && super::claude::reset_idle_claude_clients(&runtime) {
                claude_dirty = false;
            }
            if codex_dirty && super::codex::reset_shared_codex_client_if_idle(&runtime) {
                codex_dirty = false;
            }
        }
    });
}
