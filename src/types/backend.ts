// 三个 CLI backend 的状态/审核结果类型，与 Rust 端 codex_status / claude_status /
// opencode_status / codex_verify / claude_verify 命令的返回值对齐。

export interface ClaudeStatus {
  installed: boolean;
  version?: string;
  binary: string;
  loggedIn: boolean;
  loginStatus: string;
  authMethod?: string;
  defaultModel?: string;
  defaultEffort?: string;
}

export interface CodexStatus {
  installed: boolean;
  version?: string;
  binary: string;
  loggedIn: boolean;
  loginStatus: string;
  authMethod?: string;
  defaultModel?: string;
  defaultReasoningEffort?: string;
}

export interface OpencodeStatus {
  installed: boolean;
  version?: string;
  running: boolean;
  managed: boolean;
  binary: string;
  port: number;
  projectDir: string;
  sessionId?: string;
}

export interface VerifyResult {
  ok: boolean;
  message: string;
}

// Claude / Codex 模型目录 —— 跟 Rust 端 ClaudeModelsResult / CodexModelsResult 对齐。
// 两个 backend 现在都把"模型"+"该模型支持的 reasoning effort"摞到一起返回，
// 前端用这份数据驱动 ProjectOverview 的下拉。
export interface ClaudeModel {
  id: string;
  name: string;
  description?: string;
}

export interface ClaudeModelsResult {
  availableModels: ClaudeModel[];
  availableEfforts: string[];
  currentModelId?: string;
  currentEffort?: string;
}

export interface CodexModel {
  id: string;
  name: string;
  description?: string;
  /// 该模型在 Codex 注册表里建议的 reasoning level（取自 default_reasoning_level）
  defaultEffort?: string;
  /// 该模型支持的全部 reasoning level（low/medium/high/xhigh 等，原样透传）
  supportedEfforts: string[];
}

export interface CodexModelsResult {
  availableModels: CodexModel[];
  currentModelId?: string;
  currentEffort?: string;
}
