// 错误归因卡片：把 `diagnoseError` 翻译后的 friendly 信息 + 一键修复按钮渲染成卡片。
// 两个位置复用同一个组件：
//   - 'inline' variant：BlockStream 里 type=error 的 cliBlock（紧凑 11px）
//   - 'card' variant：ResultCard 的错误模式（更大字体、更显眼，整张卡片占据 result 区一段）
//
// 复用的原因：handler（open-settings / login / verify / resend / reset / open-link /
// copy / copy-with-context）跟两个位置无关，抽出来一份维护就够。视觉上两种 variant 仅是
// 字号 / padding 不同；归因结构、按钮、详情折叠都共享。
//
// 跨平台：clipboard / window.confirm / plugin-opener / *_login_open IPC 命令都已确认
// 在 macOS 和 Windows 上 work。

import { useEffect, useState } from "react";
import { invoke } from "../../lib/bridge";
import { useActiveTabActions, useActiveTabField, useActiveTabId } from "../../hooks/useActiveTab";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useTabsStore } from "../../stores/useTabsStore";
import { useUiStore } from "../../stores/useUiStore";
import { diagnoseError, type ErrorAction } from "../../lib/errorDiagnose";
import type { AgentType } from "../../types/agent";

/// 按 agent 类型路由到对应 IPC：登录命令 / 验证命令。
/// OpenCode 没有独立 verify 命令，走 status 当连通性探针即可。
function loginCommandFor(agent: AgentType): string | null {
  if (agent === "claude-code") return "claude_login_open";
  if (agent === "codex") return "codex_login_open";
  if (agent === "opencode") return "opencode_login_open";
  return null;
}
function verifyCommandFor(agent: AgentType): string | null {
  if (agent === "claude-code") return "claude_verify";
  if (agent === "codex") return "codex_verify";
  if (agent === "opencode") return "opencode_status";
  return null;
}

interface ErrorActionButtonProps {
  action: ErrorAction;
  onAction: (a: ErrorAction) => void;
  disabled?: boolean;
  /// inline 比 card 字号更小；只影响 padding / font-size
  size: "inline" | "card";
}

function ErrorActionButton({ action, onAction, disabled, size }: ErrorActionButtonProps): JSX.Element {
  const sizeCls =
    size === "inline" ? "px-2 py-0.5 text-[10px]" : "px-3 py-1 text-[11px]";
  const cls = action.primary
    ? "bg-sky-500/85 text-white hover:bg-sky-500 disabled:bg-zinc-300 disabled:text-zinc-500 dark:disabled:bg-zinc-700"
    : "border border-zinc-300/70 text-zinc-700 hover:bg-black/5 hover:border-zinc-400 dark:border-zinc-600/70 dark:text-zinc-300 dark:hover:bg-white/5";
  return (
    <button
      type="button"
      onClick={() => onAction(action)}
      disabled={disabled}
      className={`shrink-0 rounded font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${sizeCls} ${cls}`}
    >
      {action.label}
    </button>
  );
}

export interface ErrorDiagnosisCardProps {
  /// 错误文本：归因输入
  message: string;
  /// 大块卡片（ResultCard）vs 紧凑 inline（BlockStream 内）
  variant: "inline" | "card";
  /// 可选：调用方自己渲染 raw message（比如 BlockStream 用 highlightText 做 cmd+f 高亮）。
  /// 不传时组件内部用 <span>{msg}</span> 直接展示。
  renderRawMessage?: (msg: string) => React.ReactNode;
}

export function ErrorDiagnosisCard({
  message,
  variant,
  renderRawMessage,
}: ErrorDiagnosisCardProps): JSX.Element | null {
  const msg = message?.trim();
  const agent = useActiveTabField("agent");
  const projectPath = useActiveTabField("projectPath");
  const activeTabId = useActiveTabId();
  const { update } = useActiveTabActions();
  const bumpInputFocus = useUiStore((s) => s.bumpInputFocus);
  const openSettingsModal = useSettingsStore((s) => s.openSettingsModal);
  const [expanded, setExpanded] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!feedback) return;
    const id = window.setTimeout(() => setFeedback(null), 3000);
    return () => window.clearTimeout(id);
  }, [feedback]);

  if (!msg) return null;

  const diag = diagnoseError(msg, agent);

  // 严重度配色：error 用 rose 红，warning 用 amber 琥珀
  const palette =
    diag.severity === "warning"
      ? {
          border: "border-amber-400/40 dark:border-amber-300/30",
          bg: "bg-amber-50/60 dark:bg-amber-400/10",
          title: "text-amber-800 dark:text-amber-200",
          body: "text-amber-700 dark:text-amber-300",
          divider: "border-amber-300/40 dark:border-amber-300/20",
          dot: "bg-amber-500",
        }
      : {
          border: "border-rose-400/40 dark:border-rose-300/30",
          bg: "bg-rose-50/60 dark:bg-rose-400/10",
          title: "text-rose-800 dark:text-rose-200",
          body: "text-rose-700 dark:text-rose-300",
          divider: "border-rose-300/40 dark:border-rose-300/20",
          dot: "bg-rose-500",
        };

  /// 各 action 的实际执行；busy 期间禁用所有按钮防止并发；feedback 3s 自动消失
  const handleAction = async (a: ErrorAction): Promise<void> => {
    if (busy) return;
    try {
      switch (a.kind) {
        case "open-settings": {
          // target='backends' / 'llm' 仅作意图标签；当前设置弹窗没"跳转 section"机制，
          // 整体打开即可——用户从 backend 区找入口
          openSettingsModal();
          break;
        }
        case "open-backend-login": {
          const cmd = loginCommandFor(agent);
          if (!cmd) {
            setFeedback({ kind: "err", text: `当前 backend 不支持登录命令: ${agent}` });
            return;
          }
          setBusy(true);
          try {
            await invoke(cmd);
            setFeedback({ kind: "ok", text: "已打开登录终端，登录完成后回来重试" });
          } finally {
            setBusy(false);
          }
          break;
        }
        case "verify-backend": {
          const cmd = verifyCommandFor(agent);
          if (!cmd) {
            setFeedback({ kind: "err", text: `当前 backend 不支持验证命令: ${agent}` });
            return;
          }
          setBusy(true);
          try {
            await invoke(cmd);
            setFeedback({ kind: "ok", text: "✓ Backend 连接正常" });
          } catch (err) {
            setFeedback({ kind: "err", text: `✗ 验证失败：${String(err).slice(0, 120)}` });
          } finally {
            setBusy(false);
          }
          break;
        }
        case "resend-prompt": {
          const tabs = useTabsStore.getState().tabs;
          const tab = activeTabId ? tabs[activeTabId] : null;
          const fallback =
            tab?.lastUserPrompt?.trim() || tab?.task?.trim() || "";
          if (!fallback) {
            setFeedback({ kind: "err", text: "找不到上次的 prompt——请手动输入" });
            return;
          }
          update({
            task: fallback,
            uiState: "idle",
            mode: "idle",
            agentStatus: "idle",
          });
          bumpInputFocus();
          break;
        }
        case "reset-tab": {
          if (!activeTabId) return;
          if (!window.confirm("重置本 tab 会清空所有流式记录和会话状态，确定吗？\n（不会影响其它 tab）")) {
            return;
          }
          useTabsStore.getState().resetTabSession(activeTabId);
          setFeedback({ kind: "ok", text: "已重置本 tab，可重新发起任务" });
          break;
        }
        case "open-link": {
          if (!a.target) {
            setFeedback({ kind: "err", text: "未提供链接" });
            return;
          }
          try {
            const { openUrl } = await import("@tauri-apps/plugin-opener");
            await openUrl(a.target);
          } catch (err) {
            setFeedback({ kind: "err", text: `无法打开链接：${String(err)}` });
          }
          break;
        }
        case "copy-error": {
          try {
            await navigator.clipboard.writeText(msg);
            setFeedback({ kind: "ok", text: "✓ 错误已复制" });
          } catch {
            setFeedback({ kind: "err", text: "复制失败——浏览器可能拒绝了 clipboard 权限" });
          }
          break;
        }
        case "copy-with-context": {
          const tabs = useTabsStore.getState().tabs;
          const tab = activeTabId ? tabs[activeTabId] : null;
          const lines = [
            "[galcode_island error report]",
            `time: ${new Date().toISOString()}`,
            `agent: ${agent}`,
            `project: ${projectPath ?? "(unset)"}`,
            `diagnosis: ${diag.title} (${diag.kind})`,
            "---",
            msg,
          ];
          if (tab?.lastUserPrompt) {
            lines.push("---", `last prompt: ${tab.lastUserPrompt}`);
          }
          try {
            await navigator.clipboard.writeText(lines.join("\n"));
            setFeedback({ kind: "ok", text: "✓ 错误 + 上下文已复制" });
          } catch {
            setFeedback({ kind: "err", text: "复制失败——浏览器可能拒绝了 clipboard 权限" });
          }
          break;
        }
      }
    } catch (err) {
      // 防御性兜底：handler 自身抛出（极少见）也别让组件挂掉
      setFeedback({ kind: "err", text: `操作失败：${String(err).slice(0, 120)}` });
    }
  };

  // variant 仅影响外层 padding / 字号；内部结构（标题 / 详情 / 按钮 / 反馈）相同
  const sizeCls =
    variant === "inline"
      ? {
          wrap: "px-2.5 py-1.5",
          title: "text-[11px]",
          body: "text-[11px] leading-relaxed",
          raw: "text-[10px]",
          feedback: "text-[10px]",
        }
      : {
          wrap: "px-4 py-3 sm:px-5 sm:py-4",
          title: "text-[14px] sm:text-[15px]",
          body: "text-[13px] leading-relaxed sm:text-sm",
          raw: "text-[11px]",
          feedback: "text-[12px]",
        };

  return (
    <div className={`rounded-md border ${palette.border} ${palette.bg} ${sizeCls.wrap}`}>
      {/* 标题行：状态点 + 友好标题 + 详情切换 */}
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${palette.dot}`} />
        <span className={`min-w-0 flex-1 font-semibold ${palette.title} ${palette.title}`}>
          {diag.title}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={`shrink-0 text-[10px] underline-offset-2 transition-colors hover:underline ${palette.body}`}
        >
          {expanded ? "收起" : "详情"}
        </button>
      </div>

      {/* 友好说明：恒久显示 */}
      <div className={`mt-1 ${palette.body}`}>{diag.detail}</div>

      {/* 折叠的原始错误：展开时显示；调用方提供 renderRawMessage 时用其渲染（用于 cmd+f 高亮） */}
      {expanded ? (
        <div className={`mt-1.5 border-t pt-1.5 ${palette.divider}`}>
          <div className={`whitespace-pre-wrap break-all font-mono ${sizeCls.raw} ${palette.body}`}>
            {renderRawMessage ? renderRawMessage(msg) : msg}
          </div>
        </div>
      ) : null}

      {/* 动作按钮行 */}
      {diag.actions.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {diag.actions.map((a, i) => (
            <ErrorActionButton
              key={`${a.kind}:${i}`}
              action={a}
              onAction={(act) => void handleAction(act)}
              disabled={busy}
              size={variant}
            />
          ))}
        </div>
      ) : null}

      {/* inline feedback：3 秒自动消失 */}
      {feedback ? (
        <div
          className={`mt-1.5 ${sizeCls.feedback} ${
            feedback.kind === "ok"
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-rose-600 dark:text-rose-400"
          }`}
        >
          {feedback.text}
        </div>
      ) : null}
    </div>
  );
}
