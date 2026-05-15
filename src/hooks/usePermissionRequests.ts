// 订阅 Rust 端 permission_mcp 服务 emit 的 permission://request 事件。
//
// 每次 Claude 通过 permission-prompt-tool 调过来时，Rust 阻塞中等用户决策，
// 同时 emit 该事件给前端。前端追加一个 permission-request 块到对应 tab，
// 用户点 Allow/Deny 后通过 respond_permission_decision 命令解阻塞。
//
// 自动放行：若工具名在 tab.autoApprovedTools 里（"Always allow this tool" 设过），
// 跳过 UI 卡片直接 invoke allow + 在流式区记一条 info 块，让用户能追溯。

import { useEffect } from "react";
import { invoke, listen, type UnlistenFn } from "../lib/bridge";
import { useAppStore } from "../stores/useAppStore";
import { useTabsStore } from "../stores/useTabsStore";

interface PermissionRequestPayload {
  requestId: string;
  runId: string;
  toolName: string;
  input: unknown;
  toolUseId?: string;
  permissionSuggestions?: unknown;
}

export function usePermissionRequests(): void {
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    (async () => {
      try {
        const fn = await listen<PermissionRequestPayload>(
          "permission://request",
          (event) => {
            const p = event.payload;
            if (!p?.requestId) return;
            const tabsState = useTabsStore.getState();
            // 路由：用 runId 找到对应 tab。找不到时退到 activeTabId。
            const tabId =
              p.runId && tabsState.tabs[p.runId]
                ? p.runId
                : tabsState.activeTabId;
            if (!tabId) {
              console.warn("[permission] 找不到匹配 tab，丢弃请求", p);
              return;
            }

            // 工具在 auto-approve 白名单 → 直接放行，不显示卡。
            // 但 AskUserQuestion 例外：它的目的就是问用户问题，自动放行 = 跳过用户答案，
            // 让 Claude 拿默认值，体验跟没适配一样烂。所以这条工具不进自动白名单。
            const tab = tabsState.tabs[tabId];
            const whitelist = tab?.autoApprovedTools ?? [];
            if (whitelist.includes(p.toolName) && p.toolName !== "AskUserQuestion") {
              void invoke("respond_permission_decision", {
                requestId: p.requestId,
                decision: "allow",
                message: null,
                updatedInput: null,
              }).catch((err) => {
                console.error("[permission] auto-allow failed", err);
              });
              useAppStore.getState().addLogEntry({
                timestamp: Date.now(),
                level: "info",
                message: `已自动放行工具 \`${p.toolName}\`（之前点过 Always allow this tool）`,
              });
              return;
            }

            tabsState.appendCliBlock(tabId, {
              id: `permission-${p.requestId}`,
              type: "permission-request",
              backend: "claude",
              permissionRequestId: p.requestId,
              permissionToolName: p.toolName,
              permissionInput: p.input,
              permissionToolUseId: p.toolUseId,
            });
          }
        );
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      } catch (err) {
        console.error("[permission] listen permission://request 失败", err);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
