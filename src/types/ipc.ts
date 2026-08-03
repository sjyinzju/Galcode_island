// 后端 emit 的 agent 事件 payload。
//
// 多 tab 路由：每个事件都带 runId（后端 events.rs StatusChangedPayload 等
// 加了 #[serde(skip_serializing_if = "Option::is_none")]，所以前端可能
// 拿不到 — 兜底走 sessionId 反查 tab）。

export interface StatusChangedPayload {
  sessionId: string;
  runId?: string;
  status: string;
  percent?: number;
  toolName?: string;
  toolDescription?: string;
}

export interface SessionCompletePayload {
  sessionId: string;
  runId?: string;
  /// backend native session id（Claude CLI session / Codex thread / OpenCode session）
  /// —— 前端持久化它做下次重启的 resume hint
  agentNativeSessionId?: string;
  mode?: string;
  emotion?: string;
  summaryTranslation?: string;
  resultRaw?: string;
  resultZh?: string;
  suggestionOptions?: string[];
}

export interface ErrorPayload {
  sessionId?: string;
  runId?: string;
  message: string;
  code?: string;
}

export interface ResumeFallbackPayload {
  sessionId?: string;
  runId?: string;
}

/// 后端 list_sessions 命令返回的会话摘要。
/// 重启 / 多窗口共存 / 调试面板用来"对账"前端 tab 跟后端实际活跃会话。
export interface SessionSummary {
  sessionId: string;
  runId: string;
  agentType: string;
  status: string;
  cwd?: string | null;
  streamId: string;
  lastUserPrompt?: string | null;
  /// 后端 elapsed millisecond from creation to query 时刻（越小越新）
  createdAtMs: number;
}
