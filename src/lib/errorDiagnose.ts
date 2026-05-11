// 错误归因：把后端 / Agent CLI 抛出的原始错误字符串翻译成"用户能看懂的友好诊断 +
// 推荐的修复动作列表"。
//
// 输入：一段错误文本（可能来自 agent://error 事件、stderr block.message、
//      或 IPC 命令 throw 的字符串），以及当前 tab 的 agent 类型（决定登录命令走哪个 backend）
// 输出：ErrorDiagnosis —— 包含友好标题、详细解释、推荐的 actions（按钮）
//
// 这是个纯函数模块——不依赖 React / store / Tauri 任何 runtime，方便单元测试 + 任意
// 错误展示组件复用（当前只用在 BlockStream 的 ErrorLine，未来 ResultCard 也可接）。

import type { AgentType } from "../types/agent";

export type ErrorActionKind =
  | "open-settings"        // 打开全局设置弹窗
  | "open-backend-login"   // 调 claude_login_open / codex_login_open / opencode_login_open
  | "verify-backend"       // 调 *_verify 命令测连通
  | "resend-prompt"        // 把 lastUserPrompt 回填到输入框 + focus
  | "reset-tab"            // resetTabSession + clearCliBlocks
  | "open-link"            // 用 tauri-plugin-opener 打开外部 URL
  | "copy-error"           // 仅复制错误文本
  | "copy-with-context";   // 复制错误 + tab 上下文（agent/projectPath/time）

export interface ErrorAction {
  /// 按钮文字（短句中文）
  label: string;
  kind: ErrorActionKind;
  /// 对于 open-link 是 URL；对于 open-settings 可指定 section（'backends' / 'llm' / 'pet'）
  target?: string;
  /// 给视觉提示：primary 用品牌蓝按钮，其余 zinc 边框；最多一个 primary
  primary?: boolean;
}

export interface ErrorDiagnosis {
  /// 归因后的简短友好标题；不含技术黑话
  title: string;
  /// 一段说明，告诉用户大概是什么情况 / 建议怎么处理；2-3 句
  detail: string;
  /// 推荐的修复动作，按"用户最该先点的"排序；最多 3 个避免按钮行挤
  actions: ErrorAction[];
  /// 用于 UI 区分严重度：'error' 红色 / 'warning' 琥珀色（仅"看似 error 但其实是
  /// 状态冲突"的情况用 warning）
  severity: "error" | "warning";
  /// 给开发者看的归因标签（便于排查、埋点）；不展示给用户
  kind: string;
}

interface PatternEntry {
  /// 归因匹配模式（多个时按"任一命中"算 hit）
  test: (msg: string) => boolean;
  /// 命中后产出 diagnosis；可能根据 agent 类型 / 错误细节动态生成
  build: (msg: string, agent: AgentType) => ErrorDiagnosis;
}

/// 把 agent 类型转成展示用的友好名（用户看到的不是 "claude-code" 而是 "Claude Code"）
function agentLabel(agent: AgentType): string {
  switch (agent) {
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "opencode":
      return "OpenCode";
    default:
      return agent;
  }
}

/// CLI 未找到 / 命令未安装
const PATTERN_CLI_MISSING: PatternEntry = {
  test: (m) =>
    /未检测到\s*(claude|codex|opencode)/i.test(m) ||
    /command not found/i.test(m) ||
    // 启动子进程时的典型 ENOENT：实际错误里 "Claude Code" 可能在 "No such file" 前面，
    // 也可能在后面（如"Failed to start Claude Code stream session: No such file..."），
    // 所以放宽到只要 message 里含"no such file"或 Rust ENOENT 数字码即视为 CLI 缺失。
    /no such file or directory/i.test(m) ||
    /\(os error (2|3)\)/i.test(m) ||
    /找不到.*CLI/i.test(m),
  build: (_msg, agent) => ({
    title: `没找到 ${agentLabel(agent)} CLI`,
    detail:
      `应用需要在系统 PATH 上找到 ${agentLabel(agent)} 的命令行工具。可能是还没装、` +
      "或者打包时 runtime 跳过了导致缺二进制。装好后回到这里点重试。",
    actions: [
      { label: "打开 Backend 设置", kind: "open-settings", target: "backends", primary: true },
      { label: "复制错误信息", kind: "copy-with-context" },
    ],
    severity: "error",
    kind: "cli-missing",
  }),
};

/// 鉴权 / 未登录 / 401
const PATTERN_AUTH: PatternEntry = {
  test: (m) =>
    /未登录|not logged in|unauthor/i.test(m) ||
    /\b401\b/.test(m) ||
    /(invalid|missing).*(api[\s_-]?key|token|credential)/i.test(m) ||
    /authentication\s+(fail|error)/i.test(m),
  build: (_msg, agent) => ({
    title: `${agentLabel(agent)} 没登录 / 鉴权失败`,
    detail:
      `${agentLabel(agent)} CLI 还没登录，或者 token / API key 过期 / 无效。` +
      `点「登录 ${agentLabel(agent)}」会打开它官方的登录终端；` +
      `OpenCode 也可以在设置里改用 API Key。`,
    actions: [
      { label: `登录 ${agentLabel(agent)}`, kind: "open-backend-login", primary: true },
      { label: "打开 Backend 设置", kind: "open-settings", target: "backends" },
      { label: "验证连接", kind: "verify-backend" },
    ],
    severity: "error",
    kind: "auth",
  }),
};

/// 余额 / 配额耗尽
const PATTERN_QUOTA: PatternEntry = {
  test: (m) =>
    /insufficient[_\s]?quota/i.test(m) ||
    /payment[_\s]?required/i.test(m) ||
    /\b402\b/.test(m) ||
    /balance|余额|额度不足|quota.*exceed/i.test(m) ||
    /billing/i.test(m),
  build: (_msg, agent) => ({
    title: "余额或配额不足",
    detail:
      `${agentLabel(agent)} 调用 LLM 时被服务商以余额 / 配额耗尽拒绝。去服务商控制台充值，` +
      "或者切到设置里把 backend 换成额度还充足的另一家。",
    actions: [
      { label: "打开 LLM 设置", kind: "open-settings", target: "llm", primary: true },
      { label: "复制错误信息", kind: "copy-with-context" },
    ],
    severity: "error",
    kind: "quota",
  }),
};

/// 网络 / 超时 / 连不上
const PATTERN_NETWORK: PatternEntry = {
  test: (m) =>
    /timeout|timed?\s*out|超时/i.test(m) ||
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(m) ||
    /network\s+(error|fail)|fetch\s+failed/i.test(m) ||
    /无法连接|connection refused/i.test(m),
  build: (_msg, _agent) => ({
    title: "网络连不通或超时",
    detail:
      "可能是本地网络问题、代理没配 / 配错了、或者目标服务（LLM API / Codex app-server）正巧抽风。" +
      "先点验证连接看看；如果走代理，去设置里检查 backend 的 proxy 字段。",
    actions: [
      { label: "验证连接", kind: "verify-backend", primary: true },
      { label: "打开 Backend 设置", kind: "open-settings", target: "backends" },
      { label: "重新发送", kind: "resend-prompt" },
    ],
    severity: "error",
    kind: "network",
  }),
};

/// 并发冲突：同 backend 上一轮还在跑
const PATTERN_CONCURRENT: PatternEntry = {
  test: (m) =>
    /仍在处理上一条请求|already\s+(running|in\s*progress|busy)/i.test(m) ||
    /concurrent.*request/i.test(m),
  build: (_msg, agent) => ({
    title: `${agentLabel(agent)} 还在处理上一条请求`,
    detail:
      "上一轮 turn 还没结束就又发了新的。等它跑完，或者点重置本 tab 强制清理状态后重发。",
    actions: [
      { label: "重置本 tab", kind: "reset-tab", primary: true },
      { label: "重新发送", kind: "resend-prompt" },
    ],
    severity: "warning",
    kind: "concurrent",
  }),
};

/// 会话未就绪 / stream client 没起来
const PATTERN_SESSION_NOT_READY: PatternEntry = {
  test: (m) =>
    /会话尚未就绪|session\s+not\s+ready|stream.*not\s+initialized/i.test(m),
  build: (_msg, agent) => ({
    title: `${agentLabel(agent)} 会话还没准备好`,
    detail:
      "可能是 backend 进程刚启动还没就位，或者上一轮异常退出留下了卡住的状态。重置本 tab 通常能恢复。",
    actions: [
      { label: "重置本 tab", kind: "reset-tab", primary: true },
      { label: "重新发送", kind: "resend-prompt" },
      { label: "复制错误", kind: "copy-with-context" },
    ],
    severity: "warning",
    kind: "session-not-ready",
  }),
};

/// 子进程异常退出 / 崩溃
const PATTERN_PROCESS_DIED: PatternEntry = {
  test: (m) =>
    /(异常退出|process\s+(exited|died|crashed)|exit\s+code\s+(?!0))/i.test(m) ||
    /panic|fatal\s+error|signal\s+(SIGKILL|SIGTERM|SIGSEGV)/i.test(m),
  build: (_msg, agent) => ({
    title: `${agentLabel(agent)} 子进程意外退出`,
    detail:
      "Agent CLI 进程崩溃了。常见原因：版本不兼容、内存压力大、或者输入触发了 CLI 的 bug。" +
      "重置本 tab 后重发；若反复出现，把错误复制贴给维护者帮忙看。",
    actions: [
      { label: "重置本 tab", kind: "reset-tab", primary: true },
      { label: "重新发送", kind: "resend-prompt" },
      { label: "复制错误 + 上下文", kind: "copy-with-context" },
    ],
    severity: "error",
    kind: "process-died",
  }),
};

/// 模式表 —— 按"匹配优先级"排序：越具体的越靠前，避免被泛模式抢先匹配
const PATTERNS: PatternEntry[] = [
  PATTERN_CLI_MISSING,
  PATTERN_AUTH,
  PATTERN_QUOTA,
  PATTERN_CONCURRENT,
  PATTERN_SESSION_NOT_READY,
  PATTERN_PROCESS_DIED,
  PATTERN_NETWORK, // network 放最后避免抢前面更具体的（比如"timeout"也可能伴随 auth 错误）
];

/// 未命中任何具体模式时的通用兜底
function buildGenericDiagnosis(_msg: string, _agent: AgentType): ErrorDiagnosis {
  return {
    title: "Agent 出错了",
    detail:
      "没识别出常见错误模式。下面是原始错误文本，可以点详情展开。如果反复出现，" +
      "建议复制错误 + 上下文反馈给团长。",
    actions: [
      { label: "重新发送", kind: "resend-prompt", primary: true },
      { label: "重置本 tab", kind: "reset-tab" },
      { label: "复制错误 + 上下文", kind: "copy-with-context" },
    ],
    severity: "error",
    kind: "unknown",
  };
}

/// 主入口：对一条错误消息做归因。
/// 永远返回一个 diagnosis（哪怕是兜底），调用方不用判 null。
export function diagnoseError(message: string, agent: AgentType): ErrorDiagnosis {
  const msg = (message ?? "").trim();
  if (!msg) {
    return {
      title: "未知错误",
      detail: "Agent 抛出了一个空错误消息——这通常意味着内部状态异常。重置本 tab 后再试。",
      actions: [
        { label: "重置本 tab", kind: "reset-tab", primary: true },
        { label: "重新发送", kind: "resend-prompt" },
      ],
      severity: "error",
      kind: "empty",
    };
  }
  for (const p of PATTERNS) {
    if (p.test(msg)) return p.build(msg, agent);
  }
  return buildGenericDiagnosis(msg, agent);
}
