// Agent 运行时状态：多 tab、各 backend 的客户端结构、端口池。
// 关键设计（踩坑后的成熟方案）：
//   - 多 tab：HashMap<run_id, State> 按 run_id 路由
//   - OpenCode：per-tab 独立子进程，端口从 OPENCODE_BASE_PORT 起线性分配
//   - Codex：全局共享单实例（CODEX_SHARED_KEY），多 tab 用 thread_id 隔离
//   - Claude：per-tab 独立 stream client，按 (cwd, model, effort, proxy, session) 复用

use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::process::{Child, ChildStdin};
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};

use super::sysutils::DEFAULT_OPENCODE_BINARY;

// ---------------------------------------------------------------------------
// 多 tab 路由
// ---------------------------------------------------------------------------

/// 当前阶段前端只暴露单会话 UI；老调用路径无 run_id 时统一落到这个槽。
/// 未来扩多 tab 时直接换 run_id，后端不用改。
pub const DEFAULT_RUN_ID: &str = "default";

/// OpenCode 端口分配池：每个 tab 启动 OpenCode 子进程需占用独立端口；
/// 从 OPENCODE_BASE_PORT 起线性分配，关闭 tab 时释放回池。
pub const OPENCODE_BASE_PORT: u16 = 4096;

// Codex app-server 在设计上就是「单进程多 thread_id 并发」模型：
// 多个 tab 共享同一个 app-server 子进程，靠各自的 thread_id 做会话隔离，
// turn/start 跨 thread 并发不互相干扰（stdout 事件按 turn_id 路由到每个
// tab 自己的 mpsc channel）。
//
// 早期把 Codex 做成 per-tab 子进程会引发：
//   1) 多个 codex app-server 同时抢占 ~/.codex/auth.json，OAuth 刷新冲突；
//   2) 某个 tab 重新登录后，其它 tab 的旧子进程仍然用过期 token；
//   3) `codex exec --ephemeral`（verify 路径）也会因 auth 文件并发而失败。
// 因此 Codex 强制使用共享实例，通过 CODEX_SHARED_KEY 固定存放。
pub const CODEX_SHARED_KEY: &str = "__codex_shared__";

pub struct RuntimeState {
    pub opencode: Mutex<HashMap<String, OpencodeState>>,
    pub codex: Mutex<HashMap<String, CodexAppServerState>>,
    pub claude: Mutex<HashMap<String, ClaudeStreamState>>,
    pub port_pool: Mutex<HashSet<u16>>,
    /// 启动阶段"前端已把首批 backend 偏好推过来"的门闩。
    ///
    /// boot 时依赖 prefs 的延后任务（当前只有 opencode 自动启动）`.notified().await`
    /// 这个 Notify，等前端 App.tsx 跑 `update_backend_preferences` 把用户存的
    /// `binary` / `proxy` / `provider` 等同步进 Rust 内存后再开始动作。
    ///
    /// 用 tokio Notify 而不是 oneshot 有两个原因：
    ///   1. 触发顺序鲁棒——先 `notify_one` 再 `notified()` 也能立即 ready（permit
    ///      会被 buffer 一份），oneshot 必须先创建 receiver 才能 send
    ///   2. 前端会连续推 3 个 backend，多次 `notify_one` 是幂等的（多余 permit 丢弃）
    pub boot_prefs_ready: Arc<tokio::sync::Notify>,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            opencode: Mutex::new(HashMap::new()),
            codex: Mutex::new(HashMap::new()),
            claude: Mutex::new(HashMap::new()),
            port_pool: Mutex::new(HashSet::new()),
            boot_prefs_ready: Arc::new(tokio::sync::Notify::new()),
        }
    }
}

// ---------------------------------------------------------------------------
// OpenCode 状态
// ---------------------------------------------------------------------------

pub struct OpencodeState {
    pub child: Option<Child>,
    pub port: u16,
    pub binary: String,
    pub session_id: Option<String>,
    pub managed: bool,
}

impl Default for OpencodeState {
    fn default() -> Self {
        Self {
            child: None,
            port: OPENCODE_BASE_PORT,
            binary: DEFAULT_OPENCODE_BINARY.to_string(),
            session_id: None,
            managed: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Codex 状态
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct CodexAppServerState {
    pub client: Option<Arc<CodexAppServerClient>>,
    pub binary: String,
    pub proxy: Option<String>,
}

pub struct CodexAppServerClient {
    pub child: Mutex<Child>,
    pub stdin: Mutex<ChildStdin>,
    pub next_request_id: AtomicU64,
    pub pending_responses: Arc<Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>>,
    pub pending_approvals: Arc<Mutex<HashMap<String, CodexPendingApproval>>>,
    pub active_turns: Arc<Mutex<HashMap<String, CodexActiveTurn>>>,
    pub thread_streams: Arc<Mutex<HashMap<String, String>>>,
    /// 多 tab 路由：thread_id → run_id。
    /// Codex 是单进程多 thread 模型，多个 tab 共享 CODEX_SHARED_KEY 一个 client；
    /// stdout 事件分发到各自 tab 时，需要按 thread_id 反查 run_id 填进 emit。
    /// 与 thread_streams 并列维护，turn 结束 / 超时清理时一起 remove。
    pub thread_run_ids: Arc<Mutex<HashMap<String, String>>>,
}

#[derive(Clone)]
pub struct CodexPendingApproval {
    pub approval_id: String,
    pub request_id: Value,
    pub request_id_key: String,
    pub method: String,
    pub params: Value,
    pub block: Value,
}

pub struct CodexActiveTurn {
    pub thread_id: String,
    pub working_dir: String,
    pub stream_id: Option<String>,
    /// 多 tab 路由：当前 turn 所属的 tab；emit 时跟 stream_id 一起带上。
    pub run_id: String,
    pub last_message: String,
    pub command_labels: HashMap<String, String>,
    pub command_outputs: HashMap<String, String>,
    pub todo_text: HashMap<String, String>,
    pub thought_text: HashMap<String, String>,
    pub message_text: HashMap<String, String>,
    pub waiter: Option<mpsc::Sender<Result<String, String>>>,
}

// ---------------------------------------------------------------------------
// Claude 状态
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct ClaudeStreamState {
    pub client: Option<Arc<ClaudeStreamClient>>,
}

pub struct ClaudeStreamClient {
    pub stdin: Mutex<ChildStdin>,
    pub pid: u32,
    pub session_id: Arc<Mutex<Option<String>>>,
    pub last_message: Arc<Mutex<String>>,
    pub fatal_error: Arc<Mutex<Option<String>>>,
    pub pending_turn: Arc<Mutex<Option<ClaudePendingTurn>>>,
    pub exited: Arc<AtomicBool>,
    pub exit_detail: Arc<Mutex<Option<String>>>,
    pub directory: String,
    pub binary: String,
    pub proxy: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub resume_session: Option<String>,
    /// 多 tab 路由：spawn 时由 ensure_claude_stream_client 注入。
    /// stdout/stderr 后台线程 emit 流事件时填到 CliStreamEvent.run_id，
    /// 前端按 run_id 把流块写到对应 tab 的 cliBlocks。
    /// （字段当前在 spawn 闭包里通过同名局部变量捕获，结构里保留是为了
    /// 日志诊断 / 之后 ensure_*_matches 跨 tab 复用判断时可用。）
    #[allow(dead_code)]
    pub run_id: String,
}

pub struct ClaudePendingTurn {
    pub stream_id: Option<String>,
    pub waiter: mpsc::Sender<Result<(Option<String>, String), String>>,
}

// ---------------------------------------------------------------------------
// CLI 流事件（用于把 stdout/stderr 行实时透传给前端日志面板）
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStreamEvent {
    pub stream_id: String,
    pub backend: String,
    pub channel: String,
    pub line: String,
    /// 多 tab 路由：前端按 run_id 把事件分发到对应 tab store。
    /// 早期发射点尚未填充时为空字符串，前端按 stream_id 兜底匹配。
    #[serde(default)]
    pub run_id: String,
}

// ---------------------------------------------------------------------------
// per-tab 运行时访问器：HashMap 路由 + 默认条目自动插入
// ---------------------------------------------------------------------------

fn lock_map<'a, T>(
    mutex: &'a Mutex<HashMap<String, T>>,
    label: &str,
) -> Result<MutexGuard<'a, HashMap<String, T>>, String> {
    mutex
        .lock()
        .map_err(|_| format!("Failed to lock {label} state map."))
}

/// 在指定 run_id 的 OpencodeState 上执行闭包；条目不存在时按 Default 插入。
pub fn with_opencode_state<F, R>(state: &RuntimeState, run_id: &str, f: F) -> Result<R, String>
where
    F: FnOnce(&mut OpencodeState) -> R,
{
    let mut map = lock_map(&state.opencode, "OpenCode")?;
    let entry = map.entry(run_id.to_string()).or_insert_with(OpencodeState::default);
    Ok(f(entry))
}

/// 在指定 run_id 的 CodexAppServerState 上执行闭包；条目不存在时按 Default 插入。
pub fn with_codex_state<F, R>(state: &RuntimeState, run_id: &str, f: F) -> Result<R, String>
where
    F: FnOnce(&mut CodexAppServerState) -> R,
{
    let mut map = lock_map(&state.codex, "Codex App Server")?;
    let entry = map.entry(run_id.to_string()).or_insert_with(CodexAppServerState::default);
    Ok(f(entry))
}

/// 在指定 run_id 的 ClaudeStreamState 上执行闭包；条目不存在时按 Default 插入。
pub fn with_claude_state<F, R>(state: &RuntimeState, run_id: &str, f: F) -> Result<R, String>
where
    F: FnOnce(&mut ClaudeStreamState) -> R,
{
    let mut map = lock_map(&state.claude, "Claude Stream")?;
    let entry = map.entry(run_id.to_string()).or_insert_with(ClaudeStreamState::default);
    Ok(f(entry))
}

/// 退出阶段使用：遍历 OpenCode HashMap，对每个条目执行回收闭包。
/// 会阻塞等待 mutex —— 退出时必须拿到锁完成清理，否则会漏杀子进程；
/// mutex 被 poison 照样拿内层继续清理。
pub fn drain_opencode_states<F>(state: &RuntimeState, mut f: F)
where
    F: FnMut(&str, &mut OpencodeState),
{
    let mut map = match state.opencode.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    for (run_id, run) in map.iter_mut() {
        f(run_id.as_str(), run);
    }
}

pub fn drain_codex_clients(state: &RuntimeState) -> Vec<Arc<CodexAppServerClient>> {
    let mut out = Vec::new();
    let mut map = match state.codex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    for (_, codex) in map.iter_mut() {
        if let Some(client) = codex.client.take() {
            out.push(client);
        }
    }
    out
}

pub fn drain_claude_clients(state: &RuntimeState) -> Vec<Arc<ClaudeStreamClient>> {
    let mut out = Vec::new();
    let mut map = match state.claude.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    for (_, claude) in map.iter_mut() {
        if let Some(client) = claude.client.take() {
            out.push(client);
        }
    }
    out
}

/// 为指定 run_id 分配一个 OpenCode 端口。如指定 requested 端口直接使用并占位；
/// 否则从 OPENCODE_BASE_PORT 起线性扫描首个未占用端口。
pub fn allocate_opencode_port(state: &RuntimeState, requested: Option<u16>) -> u16 {
    let mut pool = match state.port_pool.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(port) = requested {
        pool.insert(port);
        return port;
    }
    let mut candidate = OPENCODE_BASE_PORT;
    while pool.contains(&candidate) {
        candidate = candidate.checked_add(1).unwrap_or(OPENCODE_BASE_PORT);
    }
    pool.insert(candidate);
    candidate
}

pub fn release_opencode_port(state: &RuntimeState, port: u16) {
    if let Ok(mut pool) = state.port_pool.lock() {
        pool.remove(&port);
    }
}
