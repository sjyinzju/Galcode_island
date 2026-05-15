export type AgentType =
  | "claude-code"
  | "opencode"
  | "codex"
  | "gemini"
  | "cursor";

export type AgentStatus =
  | "idle"
  | "starting"
  | "running"
  | "thinking"
  | "processing"
  | "waitingApproval"
  | "completed"
  | "error";

export type AgentTab = "claude-code" | "opencode";

export type UiState =
  | "idle"
  | "running"
  | "done"
  | "error"
  | "suggesting";

export type LastStage =
  | "default"
  | "init"
  | "thinking"
  | "working"
  | "done"
  | "error"
  | "suggest";

/// Claude Code 的权限模式。直接对应 Claude CLI `--permission-mode` 的 5 个值：
/// - default: 工具调用走 permission-prompt-tool 弹审批卡
/// - acceptEdits: 自动放行编辑类（Edit/Write/Patch、mkdir/touch/mv/cp 等），其它工具仍审批
/// - plan: 先研究 + 写计划，不动源码；ExitPlanMode 时退出
/// - auto: 不弹审批，但独立 classifier 模型逐 action 做安全审查；被 block 3 次/20 次累计后
///   回退到 prompt-tool。需要 v2.1.83+ CLI 与 Max/Team/Enterprise/API 计划。
/// - bypassPermissions: 完全跳过审批 + 关闭 prompt-tool 桥接；仅限隔离环境
export type PermissionMode =
  | "default"
  | "auto"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "error";
}

export interface LogEntry {
  timestamp: number;
  level: "info" | "warn" | "error";
  message: string;
  toolName?: string;
}
