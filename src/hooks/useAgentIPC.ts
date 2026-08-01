// 订阅后端 agent://* 事件，按 runId 路由到对应 tab slice。
//
// 路由策略（按优先级）：
//   1. 事件 payload 带 runId 且 store 里有这个 tab → 直接写
//   2. 事件 payload 没有 runId 但带 sessionId →
//      a. 通过 sessionId 反查 tab（findTabBySessionId）
//      b. 反查不到说明这是该 tab 第一条事件（后端先 emit status-changed，
//         然后 launch_*_agent 才返回 sessionId 给前端写回）—— 此时
//         如果只有一个 tab，写到那个；多个 tab 则丢弃 + warn
//   3. 都没有 → 丢弃 + warn
//
// 为什么 fallback 到"只有一个 tab 时直接写"：避免阶段 B 单 tab 模式下
// 后端兜底用 DEFAULT_RUN_ID 而前端 tab id 是 UUID 时事件全部丢失。这只在
// 没有 sessionId / runId 的极早期事件触发。

import { useEffect } from "react";
import { listen, type UnlistenFn } from "../lib/bridge";
import { useAppStore } from "../stores/useAppStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useTabsStore, type TabState } from "../stores/useTabsStore";
import type { AgentStatus, UiState } from "../types/agent";
import type {
  ErrorPayload,
  ResumeFallbackPayload,
  SessionCompletePayload,
  StatusChangedPayload,
} from "../types/ipc";

/// 启发式判断文本是否中文：CJK 汉字占非空白字符 > 30% 即视为中文。
/// 用于 cmd+f 翻译模式下，agent 实际输出已经是中文（仓库中文 / 直接 quote 中文）
/// 时跳过覆写 —— 既避免把中文用 result_zh 覆盖（result_zh 此时跟原文相同但拼接版
/// 略有差异，多块写到单块会引入冗余），也避免视觉抖动。
function looksChinese(text: string): boolean {
  if (!text) return false;
  let cjk = 0;
  let total = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    total += 1;
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjk += 1;
    }
  }
  if (total < 8) return false;
  return cjk * 10 > total * 3;
}

function mapAgentStatusToStage(
  st: string,
): TabState["lastStage"] {
  const s = st.toLowerCase();
  if (s === "thinking") return "thinking";
  if (s === "processing") return "working";
  if (s === "completed") return "done";
  if (s === "starting" || s === "running") return "init";
  if (s === "waitingapproval") return "thinking";
  if (s === "error") return "error";
  return "default";
}

const AGENT_STATUSES: ReadonlySet<AgentStatus> = new Set([
  "idle",
  "starting",
  "running",
  "thinking",
  "processing",
  "waitingApproval",
  "completed",
  "error",
]);

function parseAgentStatus(value: unknown): AgentStatus | null {
  return typeof value === "string" && AGENT_STATUSES.has(value as AgentStatus)
    ? (value as AgentStatus)
    : null;
}

function uiStateForAgentStatus(status: AgentStatus): UiState {
  if (status === "completed") return "done";
  if (status === "error") return "error";
  if (status === "idle") return "idle";
  return "running";
}

/// 路由事件到对应 tab。返回 tab id（命中），或 null（未命中）。
function resolveTabId(
  runId: string | undefined,
  sessionId: string | undefined,
): string | null {
  const store = useTabsStore.getState();
  if (runId && store.tabs[runId]) return runId;
  if (sessionId) {
    const byId = store.findTabBySessionId(sessionId);
    if (byId) return byId;
  }
  // 单 tab 兜底：只有一个 tab + 该 tab 还没有 sessionId 时，假定事件就是它的
  const ids = store.order;
  if (ids.length === 1) {
    const onlyId = ids[0];
    const onlyTab = store.tabs[onlyId];
    if (onlyTab && onlyTab.sessionId === null) return onlyId;
  }
  return null;
}

/// 把后端 sessionId 写回 tab.sessionId（首次匹配上时），方便后续事件路由。
function ensureSessionLinked(tabId: string, sessionId: string | undefined): void {
  if (!sessionId) return;
  const tab = useTabsStore.getState().tabs[tabId];
  if (!tab || tab.sessionId === sessionId) return;
  useTabsStore.getState().updateTab(tabId, { sessionId });
}

export function useAgentIPC(): void {
  useEffect(() => {
    const unsubs: UnlistenFn[] = [];

    const run = async () => {
      unsubs.push(
        await listen<StatusChangedPayload>("agent://status-changed", (e) => {
          const p = e.payload;
          const tabId = resolveTabId(p?.runId, p?.sessionId);
          if (!tabId) {
            console.warn("[ipc] status-changed dropped, no tab match", p);
            return;
          }
          ensureSessionLinked(tabId, p?.sessionId);

          const status = parseAgentStatus(p.status);
          if (!status) {
            console.warn("[ipc] status-changed dropped, invalid status", p.status);
            return;
          }

          const update = useTabsStore.getState().updateTab;
          const patch: Partial<TabState> = {
            uiState: uiStateForAgentStatus(status),
            agentStatus: status,
            lastStage: mapAgentStatusToStage(status),
            lastActiveAt: Date.now(),
          };
          if (typeof p.percent === "number") {
            patch.percent = Math.max(0, Math.min(100, p.percent));
          }
          const hint = p.toolDescription ?? p.toolName;
          if (hint) patch.bubble = String(hint);
          update(tabId, patch);
        }),
      );

      // agent turn 完成、finalize 开始前后端 emit 这个；前端持久化中间结果，
      // 防止 finalize 跑到一半用户退出 app 后丢数据。session-complete 收到时
      // 会清掉 pending 字段表示"已经走完 finalize 了"。
      unsubs.push(
        await listen<{
          sessionId?: string;
          runId?: string;
          resultRaw?: string;
          userZh?: string;
        }>("agent://result-raw", (e) => {
          const p = e.payload;
          const tabId = resolveTabId(p?.runId, p?.sessionId);
          if (!tabId) {
            console.warn("[ipc] result-raw dropped, no tab match", p);
            return;
          }
          ensureSessionLinked(tabId, p?.sessionId);
          useTabsStore.getState().updateTab(tabId, {
            pendingResultRaw: p?.resultRaw ?? null,
            pendingUserZh: p?.userZh ?? null,
          });
        }),
      );

      unsubs.push(
        await listen<ResumeFallbackPayload>("agent://resume-fallback", (e) => {
          const p = e.payload;
          const tabId = resolveTabId(p?.runId, p?.sessionId);
          if (!tabId) return;
          ensureSessionLinked(tabId, p?.sessionId);
          useTabsStore.getState().updateTab(tabId, {
            agentNativeSessionId: null,
            uiState: "running",
            agentStatus: "running",
            bubble: "原生会话不可用，正在从导入历史创建新会话。",
            lastActiveAt: Date.now(),
          });
        }),
      );

      unsubs.push(
        await listen<SessionCompletePayload>("agent://session-complete", (e) => {
          const p = e.payload;
          const tabId = resolveTabId(p?.runId, p?.sessionId);
          if (!tabId) {
            console.warn("[ipc] session-complete dropped, no tab match", p);
            return;
          }
          ensureSessionLinked(tabId, p?.sessionId);

          // 启用了"转换为英文输入"时，agent 流式输出的最后一个 text 块（agent 的
          // 最终回复）通常是英文，需要用 finalize 翻译后的中文 resultZh 覆写它，
          // 否则用户在 BlockStream 里看到的还是英文。
          // 但要做启发式判断：仓库内容是中文 / agent 直接 quote 中文文件时，
          // 输出本身已经是中文 —— 这种情况跳过覆写避免视觉抖动 + 单块膨胀。
          const translateInputOn = useSettingsStore.getState().translateInput;
          if (translateInputOn && p.resultZh) {
            const store = useTabsStore.getState();
            const tab = store.tabs[tabId];
            if (tab) {
              for (let i = tab.cliBlocks.length - 1; i >= 0; i -= 1) {
                const b = tab.cliBlocks[i];
                if (b.type !== "text") continue;
                if (looksChinese(b.content ?? "")) {
                  // 最后一个 text 块本来就是中文，无需覆写
                  break;
                }
                store.upsertCliBlock(tabId, { ...b, content: p.resultZh });
                break;
              }
            }
          }

          const update = useTabsStore.getState().updateTab;
          const completedWithError = p.mode === "error";
          const patch: Partial<TabState> = {
            uiState: completedWithError ? "error" : "done",
            percent: 100,
            lastStage: completedWithError ? "error" : "done",
            mode: p.mode ?? "complete",
            resultZh: p.resultZh ?? "",
            summaryTranslation: p.summaryTranslation ?? "",
            emotionText: p.emotion ?? "",
            suggestionOptions: p.suggestionOptions ?? [],
            bubble: p.emotion || "任务完成！",
            agentStatus: completedWithError ? "error" : "completed",
            lastActiveAt: Date.now(),
            // finalize 已经走完，清掉中间结果防止下次启动重复触发 finalize_pending
            pendingResultRaw: null,
            pendingUserZh: null,
          };
          // 后端 native session id 仅在成功完成时存在；错误 / 用户中断的
          // session-complete 不带这个字段，保留之前的 hint 不动
          if (p.agentNativeSessionId) {
            patch.agentNativeSessionId = p.agentNativeSessionId;
          }
          update(tabId, patch);

          // 非活动 tab 完成时打未读小红点（D 阶段 TabBar 会显示）
          const activeId = useTabsStore.getState().activeTabId;
          if (activeId !== tabId) {
            update(tabId, { hasUnread: true });
          }
        }),
      );

      unsubs.push(
        await listen<ErrorPayload>("agent://error", (e) => {
          const p = e.payload;
          const tabId = resolveTabId(p?.runId, p?.sessionId);
          const msg = p?.message ?? String(e.payload ?? "未知错误");
          useAppStore.getState().addLogEntry({
            timestamp: Date.now(),
            level: "error",
            message: `[agent://error]${tabId ? ` tab=${tabId}` : ""} ${msg}`,
          });
          if (!tabId) return;
          useTabsStore.getState().updateTab(tabId, {
            uiState: "error",
            agentStatus: "error",
            lastStage: "error",
            bubble: msg,
            lastActiveAt: Date.now(),
          });
        }),
      );
    };

    void run();

    return () => {
      unsubs.forEach((u) => {
        try {
          u();
        } catch {
          /* noop */
        }
      });
    };
  }, []);
}
