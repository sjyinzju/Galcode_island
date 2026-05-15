// Claude Code permission-prompt-tool 桥接：本地 HTTP MCP server。
//
// 工作流：
//   1. App 启动时绑定 127.0.0.1:<随机端口>，run_loop 收 HTTP POST。
//   2. Claude CLI 用 `--mcp-config <path> --permission-prompt-tool mcp__galcode_permission__approve`
//      启动；MCP config 把 server URL 指过来，URL 里带 ?run_id=... 标记调用方 tab。
//   3. Claude 想跑工具时 POST `tools/call name=approve` 到这里。
//   4. server 把请求 emit 到前端事件 `permission://request`，把 oneshot sender 存到全局 map。
//   5. 前端 PermissionCard 显示 Allow/Deny，用户点击后 invoke `respond_permission_decision`。
//   6. 该命令在 map 里取出 sender，发回决策。server 解除阻塞，组装 MCP 响应回给 Claude。
//
// 协议：JSON-RPC 2.0 over HTTP（Streamable HTTP 简化版，不做 SSE）。
// 实测足够：Claude CLI 走 initialize → tools/list → tools/call 三步，每步都是同步 POST。
//
// 单一服务实例（OnceLock）；多个 Claude session 共用，靠 run_id 查询参数路由。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::net::SocketAddr;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tiny_http::{Header, Method, Request, Response, Server};

/// 前端在 PermissionCard 决策完成后，通过 Tauri command 回传的决策。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecision {
    /// "allow" | "deny"
    pub decision: String,
    /// 用户在 deny 时附的原因（可选）
    #[serde(default)]
    pub message: Option<String>,
    /// allow 时可选地改写 Claude 提议的 input；None 表示用原样
    #[serde(default)]
    pub updated_input: Option<Value>,
}

/// emit 给前端的 permission 请求负载。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestEvent {
    /// 唯一请求 id，前端回 respond_permission_decision 时带回
    pub request_id: String,
    /// 关联到哪个 tab（== Claude spawn 时的 run_id）。前端按它路由。
    pub run_id: String,
    /// Claude 提议要调的工具名（如 "Bash" / "Edit"）
    pub tool_name: String,
    /// Claude 提议的工具入参（JSON 原文）
    pub input: Value,
    /// Claude 给的 tool_use_id；同 turn 多个 tool 用不同 id
    pub tool_use_id: Option<String>,
    /// CLI 提供的"建议方案"完整列表：每条形如
    ///   { behavior: "allow"|"deny", type: "always"|"once"|..., name: "...", ... }
    /// 前端按这个渲染"Always allow this tool"之类的额外按钮。原样转发，
    /// 不做强类型化避免 CLI 字段演进时这层成为瓶颈。
    pub permission_suggestions: Option<Value>,
}

/// 待响应的请求池：request_id → 阻塞中的 MCP handler 线程的 oneshot sender
static PENDING: OnceLock<Mutex<HashMap<String, Sender<PermissionDecision>>>> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<String, Sender<PermissionDecision>>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone)]
pub struct PermissionMcpHandle {
    pub addr: SocketAddr,
}

impl PermissionMcpHandle {
    /// MCP config 里要写的 URL。run_id 走 query 参数。
    pub fn url_for(&self, run_id: &str) -> String {
        format!("http://{}/mcp?run_id={}", self.addr, urlencode(run_id))
    }
}

static HANDLE: OnceLock<PermissionMcpHandle> = OnceLock::new();

pub fn handle() -> Option<&'static PermissionMcpHandle> {
    HANDLE.get()
}

/// 启动 server。失败仅 log，App 仍能跑（permission 桥接降级到老 stub 行为）。
pub fn spawn(app: AppHandle) -> Result<PermissionMcpHandle, String> {
    // 0 = 让 OS 分一个未占用端口；只监听本地回环避免局域网误连
    let server = Server::http("127.0.0.1:0")
        .map_err(|e| format!("permission-mcp bind 失败: {e}"))?;
    let addr = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| "permission-mcp 取不到本地地址".to_string())?;
    let handle = PermissionMcpHandle { addr };

    std::thread::Builder::new()
        .name("galcode-permission-mcp".into())
        .spawn(move || run_loop(server, app))
        .map_err(|e| format!("permission-mcp 线程起不来: {e}"))?;

    let _ = HANDLE.set(handle.clone());
    log::info!("[permission-mcp] listening on http://{}", handle.addr);
    Ok(handle)
}

fn run_loop(server: Server, app: AppHandle) {
    for req in server.incoming_requests() {
        let app = app.clone();
        std::thread::spawn(move || handle_one(req, app));
    }
}

fn handle_one(mut req: Request, app: AppHandle) {
    // 只处理 POST /mcp；其它路径 404
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("");
    if req.method() != &Method::Post || path != "/mcp" {
        let _ = req.respond(Response::empty(404));
        return;
    }

    // 取 run_id 查询参数
    let run_id = parse_query_param(&url, "run_id").unwrap_or_default();

    // 读 body
    let mut body = String::new();
    if let Err(e) = req.as_reader().read_to_string(&mut body) {
        let _ = req.respond(json_response(400, &error_object(0, -32700, &format!("body 读取失败: {e}"))));
        return;
    }
    let payload: Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(e) => {
            let _ = req.respond(json_response(400, &error_object(0, -32700, &format!("JSON 解析失败: {e}"))));
            return;
        }
    };

    // 区分单条 vs 批量请求；我们只见过单条
    let id = payload.get("id").cloned().unwrap_or(Value::Null);
    let method = payload.get("method").and_then(Value::as_str).unwrap_or("");

    let response = match method {
        "initialize" => handle_initialize(&id),
        "notifications/initialized" => {
            // 通知没有 id；返回 202 No Content（按 JSON-RPC 通知约定不回 body）
            let _ = req.respond(Response::empty(202));
            return;
        }
        "tools/list" => handle_tools_list(&id),
        "tools/call" => handle_tools_call(&id, &payload, &run_id, &app),
        "ping" => json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
        _ => error_object(
            json_id_as_num(&id),
            -32601,
            &format!("Method 不支持: {method}"),
        ),
    };

    let body = serde_json::to_string(&response).unwrap_or_else(|_| "{}".into());
    let _ = req.respond(
        Response::from_string(body)
            .with_status_code(200)
            .with_header(
                "Content-Type: application/json"
                    .parse::<Header>()
                    .unwrap(),
            ),
    );
}

fn handle_initialize(id: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "serverInfo": {
                "name": "galcode-permission",
                "version": "1.0.0"
            }
        }
    })
}

fn handle_tools_list(id: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "tools": [{
                "name": "approve",
                "description": "Galcode Island permission approval tool. Forwards Claude's tool-use proposals to the desktop UI for user approval.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "tool_name": { "type": "string" },
                        "input":     { "type": "object" },
                        "tool_use_id": { "type": "string" }
                    },
                    "required": ["tool_name", "input"]
                }
            }]
        }
    })
}

fn handle_tools_call(id: &Value, payload: &Value, run_id: &str, app: &AppHandle) -> Value {
    let params = payload.get("params").cloned().unwrap_or(Value::Null);
    let tool = params.get("name").and_then(Value::as_str).unwrap_or("");
    if tool != "approve" {
        return error_object(
            json_id_as_num(id),
            -32602,
            &format!("Unknown tool: {tool}"),
        );
    }

    let arguments = params.get("arguments").cloned().unwrap_or(Value::Null);
    let tool_name = arguments
        .get("tool_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let tool_input = arguments
        .get("input")
        .cloned()
        .unwrap_or(Value::Object(Default::default()));
    let tool_use_id = arguments
        .get("tool_use_id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    // 把 CLI 给的整个 permission_suggestions 数组原样透传给前端，
    // 让 PermissionCard 渲染额外按钮（Always allow this tool 之类）。
    let permission_suggestions = arguments
        .get("permission_suggestions")
        .filter(|v| !v.is_null())
        .cloned();

    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = channel::<PermissionDecision>();

    log::info!(
        "[permission-mcp] tools/call approve received: run_id={run_id} tool={tool_name} request_id={request_id} tool_use_id={tool_use_id:?}"
    );

    // 二进制 / 大文件守卫：Read 类工具读 .pcap / .zip / .exe 等二进制文件
    // 会把一堆乱码 token 塞进 Claude 上下文，浪费 token 还容易让 Claude 误判。
    // 这里在权限层先短路 deny 并给出明确说明，让 Claude 知道为什么被拒。
    if let Some(deny_reason) = binary_or_oversized_guard(&tool_name, &tool_input) {
        log::info!("[permission-mcp] auto-deny {tool_name}: {deny_reason}");
        return tool_call_payload_response(
            id,
            json!({
                "behavior": "deny",
                "message": format!("自动拒绝：{deny_reason}。请改用结构化方式（hexdump / ffprobe / grep 等命令行工具）查看，不要直接 Read 二进制文件。")
            }),
        );
    }

    {
        let mut map = pending().lock().unwrap();
        map.insert(request_id.clone(), tx);
    }

    let event = PermissionRequestEvent {
        request_id: request_id.clone(),
        run_id: run_id.to_string(),
        tool_name: tool_name.clone(),
        input: tool_input.clone(),
        tool_use_id,
        permission_suggestions,
    };
    if let Err(e) = app.emit("permission://request", &event) {
        log::error!("[permission-mcp] emit failed: {e}");
        // 还是要清掉 pending，避免泄漏
        pending().lock().unwrap().remove(&request_id);
        return tool_call_error_response(id, "无法转发审批请求到前端");
    }

    // 阻塞等用户决策；10 分钟超时 → 自动 deny
    let decision = match rx.recv_timeout(Duration::from_secs(600)) {
        Ok(d) => d,
        Err(_) => {
            log::warn!("[permission-mcp] request {request_id} 超时，自动 deny");
            pending().lock().unwrap().remove(&request_id);
            return tool_call_payload_response(
                id,
                json!({
                    "behavior": "deny",
                    "message": "审批超时（10 分钟内未响应），已自动拒绝。"
                }),
            );
        }
    };

    // 用户回传的决策 → Claude 期望的 JSON 字串
    let payload_json = match decision.decision.as_str() {
        "allow" => {
            let mut obj = serde_json::Map::new();
            obj.insert("behavior".into(), Value::String("allow".into()));
            obj.insert(
                "updatedInput".into(),
                decision.updated_input.unwrap_or(tool_input),
            );
            Value::Object(obj)
        }
        _ => json!({
            "behavior": "deny",
            "message": decision.message.unwrap_or_else(|| "用户拒绝".to_string())
        }),
    };

    tool_call_payload_response(id, payload_json)
}

/// 已知会让 Claude 上下文进垃圾的二进制扩展名。命中即拒。
/// 排除常见图片（.png/.jpg/.gif/.webp）— 注意 Claude 多模态能直接看图片，
/// 但我们走 stream-json + Read tool 时图片会被当字节流读，效果一样烂，仍拒。
const BINARY_EXTENSIONS: &[&str] = &[
    // 抓包 / 网络
    "pcap", "pcapng", "cap",
    // 压缩 / 归档
    "zip", "tar", "tgz", "gz", "bz2", "xz", "7z", "rar",
    // 可执行 / 二进制制品
    "exe", "dll", "so", "dylib", "bin", "pdb", "wasm", "obj", "o", "a", "lib",
    // 图像
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "heic", "heif", "tiff", "tif",
    // 音视频
    "mp3", "mp4", "wav", "ogg", "flac", "avi", "mkv", "mov", "webm", "m4a",
    // 字体 / 文档二进制
    "ttf", "otf", "woff", "woff2", "pdf",
    // ML / 数据二进制
    "npz", "npy", "safetensors", "pt", "pth", "ckpt", "bin",
    // 数据库
    "sqlite", "sqlite3", "db", "mdb", "accdb",
    // Office / 老格式
    "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    // 其它
    "iso", "img", "dmg", "msi", "deb", "rpm", "apk", "ipa",
];

/// 大文件阈值：Read 同步加载大文件会让 Claude 上下文炸；让 Claude 自己分页 / 用 grep。
/// 注意 Claude 的 Read 工具自带 limit 参数能分页读，所以这里只拒"无 limit + 大文件"组合。
const READ_SIZE_LIMIT_BYTES: u64 = 2 * 1024 * 1024; // 2 MiB

/// 检查 Read 类工具的入参，命中二进制扩展名或大文件 → 返回 deny 原因，
/// 否则返回 None 让正常流程继续。仅对 Read 工具生效（其它工具不读字节，跳过）。
fn binary_or_oversized_guard(tool_name: &str, input: &Value) -> Option<String> {
    if tool_name != "Read" && tool_name != "NotebookRead" {
        return None;
    }
    let file_path = input
        .get("file_path")
        .or_else(|| input.get("path"))
        .or_else(|| input.get("notebook_path"))
        .and_then(Value::as_str)?;
    let path = std::path::Path::new(file_path);

    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        let ext_lower = ext.to_ascii_lowercase();
        if BINARY_EXTENSIONS.iter().any(|b| *b == ext_lower) {
            return Some(format!("`{file_path}` 是已知二进制扩展名 .{ext_lower}"));
        }
    }

    // 仅当用户没显式给 limit / offset 时检查大小（有 limit 表明 Claude 知道分页）
    let has_pagination = input.get("limit").and_then(Value::as_u64).is_some()
        || input.get("offset").and_then(Value::as_u64).is_some();
    if !has_pagination {
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.len() > READ_SIZE_LIMIT_BYTES {
                return Some(format!(
                    "`{file_path}` 大小 {} 字节，超过 {} 字节阈值且未设 limit。建议带 limit 参数分页读",
                    meta.len(),
                    READ_SIZE_LIMIT_BYTES
                ));
            }
        }
    }

    None
}

fn tool_call_payload_response(id: &Value, payload: Value) -> Value {
    let text = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".into());
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "content": [{ "type": "text", "text": text }],
            "isError": false
        }
    })
}

fn tool_call_error_response(id: &Value, msg: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "content": [{ "type": "text", "text": msg }],
            "isError": true
        }
    })
}

fn error_object(id: i64, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}

fn json_id_as_num(id: &Value) -> i64 {
    id.as_i64().unwrap_or(0)
}

fn json_response(status: u16, value: &Value) -> Response<std::io::Cursor<Vec<u8>>> {
    let body = serde_json::to_string(value).unwrap_or_else(|_| "{}".into());
    Response::from_string(body)
        .with_status_code(status)
        .with_header("Content-Type: application/json".parse::<Header>().unwrap())
}

fn parse_query_param(url: &str, key: &str) -> Option<String> {
    let qs = url.split_once('?')?.1;
    for pair in qs.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if k == key {
            return Some(urldecode(v));
        }
    }
    None
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'+' {
            out.push(b' ');
            i += 1;
        } else if b == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
            } else {
                out.push(b);
                i += 1;
            }
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 由 ipc::commands::respond_permission_decision 调用。返回是否找到了对应请求。
pub fn resolve(request_id: &str, decision: PermissionDecision) -> bool {
    let tx = {
        let mut map = pending().lock().unwrap();
        map.remove(request_id)
    };
    match tx {
        Some(sender) => {
            if let Err(e) = sender.send(decision) {
                log::warn!("[permission-mcp] resolve send failed: {e}");
                false
            } else {
                true
            }
        }
        None => {
            log::warn!("[permission-mcp] resolve: 找不到 request {request_id}（已超时或重复响应？）");
            false
        }
    }
}

/// 给指定 run_id 写一份 per-session MCP config 文件，返回路径。
/// 文件放在 app_local_data_dir/permission-mcp/<run_id>.json。
pub fn write_session_mcp_config(
    app: &AppHandle,
    run_id: &str,
) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let handle = self::handle().ok_or_else(|| "permission-mcp 未启动".to_string())?;
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("拿不到 app data dir: {e}"))?
        .join("permission-mcp");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("创建 permission-mcp 目录失败: {e}"))?;
    let path = dir.join(format!("{run_id}.json"));
    let cfg = json!({
        "mcpServers": {
            "galcode_permission": {
                "type": "http",
                "url": handle.url_for(run_id)
            }
        }
    });
    let content =
        serde_json::to_string_pretty(&cfg).map_err(|e| format!("MCP config 序列化失败: {e}"))?;
    std::fs::write(&path, content).map_err(|e| format!("MCP config 写入失败: {e}"))?;
    Ok(path)
}

/// Claude 启动时给 --permission-prompt-tool 用的 tool 全名。
pub const PERMISSION_TOOL_NAME: &str = "mcp__galcode_permission__approve";

/// Session 结束时清理 MCP config 文件（best-effort）。
pub fn cleanup_session_mcp_config(app: &AppHandle, run_id: &str) {
    use tauri::Manager;
    if let Ok(dir) = app.path().app_local_data_dir() {
        let path = dir.join("permission-mcp").join(format!("{run_id}.json"));
        let _ = std::fs::remove_file(path);
    }
}

/// 测试桩用；释放所有 pending（让 Claude 拿到 deny），上下游异常时调一下避免泄漏。
#[allow(dead_code)]
pub fn deny_all_pending(reason: &str) {
    let entries: Vec<(String, Sender<PermissionDecision>)> = {
        let mut map = pending().lock().unwrap();
        map.drain().collect()
    };
    for (_id, tx) in entries {
        let _ = tx.send(PermissionDecision {
            decision: "deny".into(),
            message: Some(reason.to_string()),
            updated_input: None,
        });
    }
}

#[allow(dead_code)]
pub fn pending_count() -> usize {
    pending().lock().map(|m| m.len()).unwrap_or(0)
}

// 让 unused-Arc 不警告（保留 Arc 形态以便将来加 stop_flag）
#[allow(dead_code)]
fn _arc_anchor() -> Arc<()> {
    Arc::new(())
}
