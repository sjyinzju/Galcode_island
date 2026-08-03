// CLI 流事件的 block 类型 —— 后端 emit `galcode://cli-output` 的 line 字段是
// JSON 字符串，反序列化后有两种顶层格式：
//   1. { type: "galcode.block", block: {...} }   ← Claude/Codex/OpenCode 通用块
//   2. { type: "opencode.tool|file|status|error", ... }  ← OpenCode 专属
//
// 前端 useCliStream 把两种格式归一成下面的 CliBlock 统一类型，按 id 去重（同一
// id 的后续事件是 update：text 增量、command output delta、todo 状态变化等）。

export interface CliStreamEvent {
  streamId: string;
  backend: string;        // "claude" | "codex" | "opencode"
  channel: string;        // "stdout" | "stderr"
  line: string;            // JSONL / block JSON / 纯文本
  runId: string;
}

export type CliBlockType =
  | "text"
  | "thought"
  | "command"
  | "todo"
  | "confirm"
  | "tool"
  | "file"
  | "diff"
  | "status"
  | "error"
  | "stderr"
  | "image"
  /// 用户原始 prompt：前端启动 turn 时自己 append 进去（不来自 backend），
  /// 流式区右对齐渲染成蓝色气泡。多轮会话能看清"用户 / agent"交替顺序。
  | "user-prompt"
  /// permission-prompt-tool 桥过来的工具审批请求；PermissionCard 渲染 Allow/Deny。
  /// 用户决策完成后 status 改 "approved"/"denied"，按钮收起。
  | "permission-request";

export interface CliTodoItem {
  id: string;
  label: string;
  status: string;         // "pending" | "running" | "success" | ...
}

export interface CliBlockImage {
  dataUrl?: string;
  assetId?: string;
  alt: string | null;
}

export interface CliBlockAttachment {
  name: string;
  mediaType: string;
  dataUrl?: string;
  assetId?: string;
  url?: string;
  localPath?: string;
}

export interface CliBlock {
  id: string;
  type: CliBlockType;
  backend?: string;
  suppressLogLine?: boolean;

  // text / thought / status / error
  content?: string;
  message?: string;
  tone?: string;          // text (file 标记)
  collapsedLabel?: string; // 长内部上下文 / 导入事件默认折叠时显示的短标签
  isApiError?: boolean; // 导入源明确标记的 API 失败，不应注入续聊上下文
  images?: CliBlockImage[];
  attachments?: CliBlockAttachment[];

  // 导入记录的稳定来源信息，用于重导入去重、导航筛选和分轮展示。
  sourceMessageId?: string;
  sourceTimestamp?: number;
  sourceRole?: string;
  sourceTurnId?: string;
  importedConversationId?: string;

  // command
  command?: string;
  output?: string;
  status?: string;        // running / success / error / completed

  // todo
  title?: string;
  items?: CliTodoItem[];

  // confirm (审批)
  interactive?: boolean;
  note?: string;
  approvalId?: string;

  // tool / file / diff
  tool?: string;
  path?: string;
  detail?: string;
  /// Imported tool payload kept in its original shape and formatted only after expansion.
  detailValue?: unknown;

  // diff (Claude Edit/MultiEdit/Write)
  diff?: string;          // unified-ish: 行首 +/-/空格

  // stderr (raw)
  channel?: string;       // "stderr"

  // 当用户切换会话时丢弃旧 block 用
  streamId?: string;

  // permission-request 专属
  /// MCP 桥发来的 request_id；用户决策时回传给后端解阻塞
  permissionRequestId?: string;
  /// Claude 提议要调的工具名
  permissionToolName?: string;
  /// Claude 提议的工具入参（JSON 原文）
  permissionInput?: unknown;
  /// 关联到的 tool_use_id（同 turn 多个 tool 用不同 id）
  permissionToolUseId?: string;
  /// 用户决策结果："approved" | "denied" | undefined（未决）
  permissionDecision?: string;

  /// 块开始时间（ms epoch）。Task / 长跑工具用来算"已运行 X 秒"。
  startedAt?: number;
}
