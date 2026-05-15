// 斜杠命令注册表 + 类型定义。
//
// 来源：
//   1. **builtin**：App 层处理（/clear /help /mode /model /login /agents …），handler = "local"
//   2. **plugin**：来自 ~/.claude/plugins/.../commands/*.md，handler = "passthrough"
//   3. **project**：来自 `<cwd>/.claude/commands/*.md`，handler = "passthrough"
//   4. **user**：来自 `~/.claude/commands/*.md`，handler = "passthrough"
//
// `passthrough` 意思是把原始文本（含 `/`）原封不动塞给 `start_agent`，让 Claude CLI
// 解释执行（Claude CLI 本身支持 markdown 形式的 user/plugin/project 命令）。
//
// **重要**：Claude CLI 的内置交互命令（/model /login /logout /cost /init /doctor 等）
// 只在 **TTY 交互模式** 才有效；本应用走 `--input-format stream-json` 非交互模式，
// 这些 slash 字符串直接写到 stdin 会被当成普通用户提示，CLI 不会拦截执行。
// 所以这些"内置"命令必须在 **App 层桥接**：
//   - A 类：跑 `claude <子命令>` 在新终端窗口（/login /logout /doctor /upgrade /init 等）
//   - B 类：打开 App 内对应面板（/config /agents /status /permissions）
//   - C 类：改前端状态（/clear /mode /model /exit /quit）
//   - D 类：打开外部 URL / 文件（/bug /release-notes /memory /hooks /mcp）
//   - E 类：明确不支持的场景给说明（/compact /rewind /undo 等，需 TTY session 状态）

import { invoke } from "./bridge";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useTabsStore } from "../stores/useTabsStore";
import type { PermissionMode } from "../types/agent";

export type SlashCommandSource = "builtin" | "project" | "user" | "plugin";

export interface SlashCommandRecord {
  /// 命令名（不含开头 `/`）；可能带命名空间 `<ns>:<cmd>`
  name: string;
  /// 来源
  source: SlashCommandSource;
  /// 一行描述，下拉面板里显示
  description: string;
  /// frontmatter `argument-hint`，例如 "<commit-hash>"；builtin 命令也可以填
  argumentHint?: string;
  /// 处理器：local = InputBubble 本地处理；passthrough = 原样透传 Claude CLI
  handler: "local" | "passthrough";
  /// 插件命令的所属插件名（仅 plugin 来源有）
  plugin?: string;
}

/// builtin 命令处理器需要的上下文。
/// 由 InputBubble 在调用 handler 之前组装；handler 可以读这里的任何字段，
/// 或调用 stores 直接改状态（zustand 的 getState 调用是 OK 的）。
export interface BuiltinCommandContext {
  /// 原始输入文本（含开头 `/` 和参数），如 "/mode plan"
  rawText: string;
  /// 已解析出的命令名（不含 `/`）
  commandName: string;
  /// 参数字符串（命令名后的部分，trim 过），可能为空
  args: string;
  /// 当前 active tab id；null 表示没活动 tab
  activeTabId: string | null;
  /// 当前 active tab 的工作目录；用于 /init / cwd-sensitive 命令
  projectPath: string | null;
  /// 一些便捷动作。
  actions: {
    clearActiveTabBlocks: () => void;
    openSettings: () => void;
    setPermissionMode: (value: PermissionMode) => void;
    addLog: (level: "info" | "warn" | "error", message: string) => void;
  };
}

export interface BuiltinCommandResult {
  /// "handled" = 已本地执行；不再发给 backend
  /// "passthrough" = 命令需要透传到 backend（极少用，保留扩展能力）
  status: "handled" | "passthrough";
  /// 给用户的提示文案；非空时 InputBubble 会以日志条目方式显示
  notice?: string;
}

/// 在新终端跑 `claude <args>`。复用 Rust 的 claude_run_in_terminal。
async function runClaudeInTerminal(
  args: string[],
  notice: string
): Promise<BuiltinCommandResult> {
  try {
    const current = useSettingsStore.getState().backends["claude-code"];
    const msg = await invoke<string>("claude_run_in_terminal", {
      args,
      binary: current.binary || null,
      proxy: current.proxy || null,
      successMessage: notice,
    });
    return { status: "handled", notice: msg || notice };
  } catch (err) {
    return {
      status: "handled",
      notice: `运行失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/// 用系统默认应用打开 URL。
async function openExternalUrl(url: string, notice: string): Promise<BuiltinCommandResult> {
  try {
    const mod = await import("@tauri-apps/plugin-opener");
    await mod.openUrl(url);
    return { status: "handled", notice };
  } catch (err) {
    return {
      status: "handled",
      notice: `打开链接失败：${err instanceof Error ? err.message : String(err)}（URL：${url}）`,
    };
  }
}

/// 用系统默认应用打开本地文件路径。
async function openLocalPath(path: string, notice: string): Promise<BuiltinCommandResult> {
  try {
    const mod = await import("@tauri-apps/plugin-opener");
    await mod.openPath(path);
    return { status: "handled", notice };
  } catch (err) {
    return {
      status: "handled",
      notice: `打开文件失败：${err instanceof Error ? err.message : String(err)}（路径：${path}）`,
    };
  }
}

/// 解析 ~/.claude/<rel> 形式的路径（Tauri path API）。
async function resolveClaudeConfigPath(rel: string): Promise<string> {
  const { homeDir, join } = await import("@tauri-apps/api/path");
  const home = await homeDir();
  return join(home, ".claude", rel);
}

/// 内置命令执行表。
/// handler 允许同步或异步（async）；调用方 await 后处理 notice。
///
/// 经过实测裁剪，只保留**在本应用上下文下真有效**的命令；CLI 交互模式专属、
/// stream-json 模式无法实现的（/compact /resume /rewind /export /add-dir /vim /ide
/// /terminal-setup）和过冷门的（/migrate-installer /install-github-app /feedback
/// /statusline /output-style /plugin /permissions /quit）已删除。
export const BUILTIN_COMMAND_HANDLERS: Record<
  string,
  (ctx: BuiltinCommandContext) => BuiltinCommandResult | Promise<BuiltinCommandResult>
> = {
  // ---------- 会话控制 ----------
  clear(ctx) {
    ctx.actions.clearActiveTabBlocks();
    return { status: "handled", notice: "已清空当前 tab 的对话历史。" };
  },
  exit(ctx) {
    if (!ctx.activeTabId) {
      return { status: "handled", notice: "当前没有活动 tab。" };
    }
    useTabsStore.getState().removeTab(ctx.activeTabId);
    return { status: "handled", notice: "已关闭当前 tab。" };
  },
  help() {
    return {
      status: "handled",
      notice:
        "命令：/clear /exit /help ｜ /mode /model /config /agents /status ｜ /login /logout /doctor /upgrade /init /cost ｜ /memory /hooks /mcp ｜ /bug /release-notes /about" +
        " ｜ 快捷键 Shift+Tab 切 permission mode · Cmd/Ctrl+F 页内搜索 · Cmd/Ctrl+Shift+L 切主题",
    };
  },

  // ---------- 设置 / 状态 ----------
  agents(ctx) {
    ctx.actions.openSettings();
    return { status: "handled", notice: "已打开 Agent backend 设置面板。" };
  },
  config(ctx) {
    ctx.actions.openSettings();
    return { status: "handled", notice: "已打开设置。" };
  },
  status(ctx) {
    ctx.actions.openSettings();
    return {
      status: "handled",
      notice: "已打开设置 → Agent backend 区，可查看 Claude Code 连接状态。",
    };
  },
  mode(ctx) {
    const arg = ctx.args.trim().toLowerCase();
    const map: Record<string, PermissionMode> = {
      default: "default",
      auto: "auto",
      acceptedits: "acceptEdits",
      "accept-edits": "acceptEdits",
      plan: "plan",
      bypasspermissions: "bypassPermissions",
      "bypass-permissions": "bypassPermissions",
      bypass: "bypassPermissions",
    };
    if (!arg) {
      return {
        status: "handled",
        notice:
          "用法：/mode default | auto | acceptEdits | plan | bypassPermissions（也可以 Shift+Tab 循环切换）",
      };
    }
    const next = map[arg];
    if (!next) {
      return {
        status: "handled",
        notice: `未识别的模式 \"${ctx.args}\"。可选：default / auto / acceptEdits / plan / bypassPermissions。`,
      };
    }
    ctx.actions.setPermissionMode(next);
    return { status: "handled", notice: `已切到 ${next} 模式。` };
  },
  async model(ctx) {
    const arg = ctx.args.trim();
    if (!arg) {
      ctx.actions.openSettings();
      return {
        status: "handled",
        notice:
          "用法：/model <id>（直接切换）或 /model 不带参数会打开设置面板。",
      };
    }
    // 读 active tab 的 agent，决定写到哪个 backend 偏好里。tab 上若是
    // gemini/cursor 这类暂未持久化偏好的 backend 则只给提示，不动 storage。
    const tab = ctx.activeTabId ? useTabsStore.getState().tabs[ctx.activeTabId] : null;
    const agent = tab?.agent;
    if (agent !== "claude-code" && agent !== "codex" && agent !== "opencode") {
      return {
        status: "handled",
        notice: agent
          ? `当前 backend \"${agent}\" 暂不支持通过 /model 切换，请在设置面板修改。`
          : "当前没有活动 tab，无法确定要切换哪个 backend 的模型。",
      };
    }
    useSettingsStore.getState().setBackendPref(agent, "model", arg);
    const current = useSettingsStore.getState().backends[agent];
    try {
      await invoke("update_backend_preferences", {
        backend: agent,
        model: current.model || null,
        effort: current.effort || null,
        proxy: current.proxy || null,
        binary: current.binary || null,
        provider: null,
        apiKey: null,
        authMode: null,
        defaultPermissionMode: current.defaultPermissionMode || null,
      });
    } catch (err) {
      return {
        status: "handled",
        notice: `已记录但同步给后端失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const agentDisplay =
      agent === "claude-code" ? "Claude Code" : agent === "codex" ? "Codex" : "OpenCode";
    return {
      status: "handled",
      notice: `已切到模型 \"${arg}\"（下次启动 ${agentDisplay} 生效）。`,
    };
  },

  // ---------- 账号 / 跑 claude 子命令 ----------
  async login() {
    try {
      const current = useSettingsStore.getState().backends["claude-code"];
      const msg = await invoke<string>("claude_login_open", {
        binary: current.binary || null,
        proxy: current.proxy || null,
      });
      return { status: "handled", notice: msg || "已打开 Claude Code 登录终端。" };
    } catch (err) {
      return {
        status: "handled",
        notice: `打开登录终端失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
  logout() {
    return runClaudeInTerminal(["logout"], "已在系统终端运行 `claude logout`。");
  },
  doctor() {
    return runClaudeInTerminal(["doctor"], "已在系统终端运行 `claude doctor`。");
  },
  upgrade() {
    return runClaudeInTerminal(["upgrade"], "已在系统终端运行 `claude upgrade`。");
  },
  init() {
    return runClaudeInTerminal(["init"], "已在系统终端运行 `claude init`。");
  },
  cost() {
    return runClaudeInTerminal(["cost"], "已在系统终端运行 `claude cost` 查用量。");
  },

  // ---------- 配置文件 ----------
  async memory() {
    const path = await resolveClaudeConfigPath("CLAUDE.md");
    return openLocalPath(path, `已用系统默认编辑器打开 ${path}`);
  },
  async hooks() {
    const path = await resolveClaudeConfigPath("settings.json");
    return openLocalPath(
      path,
      `已打开 ${path}（hooks 在 settings.json 的 \"hooks\" 字段下）`
    );
  },
  async mcp() {
    const path = await resolveClaudeConfigPath(".mcp.json");
    return openLocalPath(path, `已打开 ${path}（如不存在请手动创建）`);
  },

  // ---------- 信息 / 外链 ----------
  bug() {
    return openExternalUrl(
      "https://github.com/anthropics/claude-code/issues",
      "已在浏览器打开 Claude Code GitHub Issues。"
    );
  },
  "release-notes"() {
    return openExternalUrl(
      "https://docs.claude.com/en/docs/claude-code/release-notes",
      "已在浏览器打开 Claude Code 发布日志。"
    );
  },
  about() {
    const appVersion =
      typeof (globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ === "string"
        ? (globalThis as { __APP_VERSION__?: string }).__APP_VERSION__
        : "?";
    return {
      status: "handled",
      notice: `Galcode Island v${appVersion} ｜ Claude Code 版本可在『设置 → Agent backend』查看。`,
    };
  },
};

/// 内置命令列表。精简到本应用上下文真正能用的一组。
export const BUILTIN_COMMANDS: readonly SlashCommandRecord[] = [
  // 会话控制
  { name: "clear", source: "builtin", description: "清空当前 tab 的对话历史", handler: "local" },
  { name: "exit", source: "builtin", description: "关闭当前 tab", handler: "local" },
  { name: "help", source: "builtin", description: "显示命令和快捷键列表", handler: "local" },

  // 设置 / 状态
  {
    name: "mode",
    source: "builtin",
    description: "切换 Claude Code permission mode",
    argumentHint: "<default|auto|acceptEdits|plan|bypassPermissions>",
    handler: "local",
  },
  {
    name: "model",
    source: "builtin",
    description: "切换当前 agent 的默认模型（无参数打开设置）",
    argumentHint: "<model-id>",
    handler: "local",
  },
  { name: "config", source: "builtin", description: "打开全局设置", handler: "local" },
  { name: "status", source: "builtin", description: "查看 Claude Code 连接状态", handler: "local" },
  { name: "agents", source: "builtin", description: "打开 Agent backend 设置面板", handler: "local" },

  // 账号 / 跑 claude 子命令
  { name: "login", source: "builtin", description: "在系统终端跑 `claude /login`", handler: "local" },
  { name: "logout", source: "builtin", description: "在系统终端跑 `claude logout`", handler: "local" },
  { name: "doctor", source: "builtin", description: "在系统终端跑 `claude doctor`", handler: "local" },
  { name: "upgrade", source: "builtin", description: "在系统终端跑 `claude upgrade`", handler: "local" },
  { name: "init", source: "builtin", description: "在系统终端跑 `claude init`（生成 CLAUDE.md）", handler: "local" },
  { name: "cost", source: "builtin", description: "在系统终端跑 `claude cost` 查用量", handler: "local" },

  // 配置文件
  { name: "memory", source: "builtin", description: "打开 ~/.claude/CLAUDE.md", handler: "local" },
  { name: "hooks", source: "builtin", description: "打开 ~/.claude/settings.json（hooks 配置）", handler: "local" },
  { name: "mcp", source: "builtin", description: "打开 ~/.claude/.mcp.json（MCP 服务器）", handler: "local" },

  // 信息 / 外链
  { name: "about", source: "builtin", description: "显示版本信息", handler: "local" },
  { name: "bug", source: "builtin", description: "在浏览器打开 GitHub Issues", handler: "local" },
  { name: "release-notes", source: "builtin", description: "在浏览器打开 Claude Code 发布日志", handler: "local" },
];

/// 从输入文本里解析"/命令 args"。
/// 必须以 `/` 开头；命令名允许字母 / 数字 / `_` / `-` / `:`（命名空间分隔符），
/// 例如 `/ecc:plan` 或 `/feature-dev:code-explorer`。
///
/// 特殊情形：裸 `/` 返回 `{ name: "", args: "" }`，让前端能据此弹出"显示全部命令"
/// 的下拉面板，配合 startsWith 过滤天然成立。
export function parseSlashInput(value: string): { name: string; args: string } | null {
  const trimmed = value.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  if (body.length === 0) return { name: "", args: "" };
  const match = body.match(/^([A-Za-z0-9_:\-]+)(.*)$/);
  if (!match) return null;
  return { name: match[1], args: match[2].trim() };
}

/// 把后端 list_project_slash_commands 返回的 meta 转成 SlashCommandRecord（透传）。
export interface ProjectSlashCommandMeta {
  name: string;
  source: "project" | "user" | "plugin";
  description: string;
  argumentHint?: string | null;
  filePath: string;
  plugin?: string | null;
}

export function projectMetaToRecord(meta: ProjectSlashCommandMeta): SlashCommandRecord {
  const fallbackDesc =
    meta.source === "plugin"
      ? `(插件 ${meta.plugin ?? "?"} 提供)`
      : meta.source === "project"
        ? "(项目命令)"
        : "(用户命令)";
  return {
    name: meta.name,
    source: meta.source,
    description: meta.description || fallbackDesc,
    argumentHint: meta.argumentHint ?? undefined,
    handler: "passthrough",
    plugin: meta.plugin ?? undefined,
  };
}

/// 合并 builtin + plugin + user + project 命令。
/// 同名时优先级 project > user > plugin > builtin（与 Claude Code CLI 一致）。
export function mergeCommands(
  external: readonly SlashCommandRecord[]
): SlashCommandRecord[] {
  const map = new Map<string, SlashCommandRecord>();
  for (const cmd of BUILTIN_COMMANDS) map.set(cmd.name, cmd);
  const plugins = external.filter((c) => c.source === "plugin");
  const users = external.filter((c) => c.source === "user");
  const projects = external.filter((c) => c.source === "project");
  for (const cmd of plugins) map.set(cmd.name, cmd);
  for (const cmd of users) map.set(cmd.name, cmd);
  for (const cmd of projects) map.set(cmd.name, cmd);
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}
