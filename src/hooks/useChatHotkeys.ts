// 聊天界面快捷键：
//
// - Shift+Tab：在当前 tab 内循环切换 Claude Code permission mode
//   (default → acceptEdits → plan → bypassPermissions → default)
//
// 设计选择：
//   - **拦截 textarea 内的 Shift+Tab**：用户在聊天框敲字时也想能切，
//     不拦截就会触发浏览器原生"反向 Tab 切焦点"，跳到上一个可聚焦元素。
//   - 只在 claude-code backend 下激活：其它 backend 不支持 permission mode。
//   - 仅在确实存在 activeTabId 时响应；空 tab 列表期间忽略。

import { useEffect } from "react";
import { useTabsStore } from "../stores/useTabsStore";
import type { PermissionMode } from "../types/agent";

// Shift+Tab 循环顺序：对齐 Claude Code CLI 文档（default → acceptEdits → plan →
// auto → bypassPermissions）。auto 是 v2.1.83+ 的独立 mode，按"递增放权"
// 放在 plan 之后；全部模式都进循环，让 Shift+Tab 不会跳档。
const PERMISSION_MODE_CYCLE: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "bypassPermissions",
];

function nextPermissionMode(current: PermissionMode): PermissionMode {
  const idx = PERMISSION_MODE_CYCLE.indexOf(current);
  if (idx < 0) return "default";
  return PERMISSION_MODE_CYCLE[(idx + 1) % PERMISSION_MODE_CYCLE.length];
}

export function useChatHotkeys(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Shift+Tab，且没按 Ctrl/Meta/Alt（避免和系统 / 浏览器组合键打架）
      if (event.key !== "Tab" || !event.shiftKey) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      // IME 候选词期间不响应
      if (event.isComposing) return;

      const state = useTabsStore.getState();
      const activeTabId = state.activeTabId;
      if (!activeTabId) return;

      const tab = state.tabs[activeTabId];
      if (!tab || tab.agent !== "claude-code") return;

      event.preventDefault();
      event.stopPropagation();
      state.updateTab(activeTabId, {
        permissionMode: nextPermissionMode(tab.permissionMode ?? "default"),
      });
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
