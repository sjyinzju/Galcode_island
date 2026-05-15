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

/// Claude Code 的权限模式。
///
/// 直接对应 Claude CLI `--permission-mode` 的 4 个原生值：
/// - default: 默认行为，工具调用需要审批
/// - acceptEdits: 自动接受所有编辑（写文件 / Edit / Patch 等），其它工具仍要审批
/// - plan: Plan Mode，agent 先列计划再执行，需 ExitPlanMode 才真正动手
/// - bypassPermissions: 完全跳过审批；危险，仅给可信脚本用
///
/// 额外提供一个 UI 别名：
/// - auto: 对应 Claude Code 桌面版的"Auto"按钮；当前 CLI 没有独立值，
///   Rust 端 normalize_permission_mode 把它映射到 `acceptEdits` 实际生效。
///   单独列出是为了让 UI 跟桌面版 Shift+Tab 循环保持一致（用户预期里有这一档）。
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
