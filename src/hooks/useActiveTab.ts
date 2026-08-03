// 当前活动 tab 的便捷选择器。
//
// 大多数 UI 组件不关心多 tab 路由，只想读"现在用户看到的这个 tab"的状态。
// 这个 hook 封装常见的 selector：
//   const tab = useActiveTab();          ← 整份 slice（兜底空 tab，不会 null）
//   const task = useActiveTabField('task'); ← 单字段订阅，最小重渲染
//   const id   = useActiveTabId();           ← 仅订阅 id
//
// 没有任何 tab 时（应用刚启动 / 全部关闭后）返回一个常量空 tab，
// 这样消费方不用到处加 null check。如果业务上需要"没有 tab 时
// 不显示某些 UI"，应该判断 useActiveTabId() 是否为 null。

import { useTabsStore, type TabState } from "../stores/useTabsStore";

const EMPTY_TAB: TabState = Object.freeze({
  id: "",
  title: "",
  agent: "claude-code",
  projectPath: null,
  task: "",
  agentStatus: "idle",
  uiState: "idle",
  mode: "idle",
  bubble: "",
  percent: 0,
  sessionId: null,
  agentNativeSessionId: null,
  importedConversationId: null,
  hasFullImportedHistory: false,
  deletedImportedBlockIds: [],
  importedHistoryError: null,
  importedHistoryRevision: 0,
  resultZh: "",
  summaryTranslation: "",
  emotionText: "",
  suggestionOptions: [],
  lastStage: "default",
  cliBlocks: [],
  hasUnread: false,
  pendingResultRaw: null,
  pendingUserZh: null,
  createdAt: 0,
  lastActiveAt: 0,
  lastUserPrompt: null,
  permissionMode: "acceptEdits",
  autoApprovedTools: [],
}) as TabState;

export function useActiveTabId(): string | null {
  return useTabsStore((s) => s.activeTabId);
}

export function useActiveTab(): TabState {
  return useTabsStore((s) => {
    if (!s.activeTabId) return EMPTY_TAB;
    return s.tabs[s.activeTabId] ?? EMPTY_TAB;
  });
}

/// 选订阅活动 tab 的某个字段，重渲染只跟该字段相关。
export function useActiveTabField<K extends keyof TabState>(field: K): TabState[K] {
  return useTabsStore((s) => {
    const tab = s.activeTabId ? s.tabs[s.activeTabId] : null;
    return (tab ?? EMPTY_TAB)[field];
  });
}

/// 拿到一组 actions（绑定到当前 active tab）；没有 active tab 时所有
/// 函数都是 no-op，UI 调用安全。
export function useActiveTabActions() {
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const updateTab = useTabsStore((s) => s.updateTab);
  const resetTabSession = useTabsStore((s) => s.resetTabSession);
  const appendCliBlock = useTabsStore((s) => s.appendCliBlock);
  const upsertCliBlock = useTabsStore((s) => s.upsertCliBlock);
  const clearCliBlocks = useTabsStore((s) => s.clearCliBlocks);

  return {
    activeTabId,
    update: (patch: Partial<TabState>) => {
      if (activeTabId) updateTab(activeTabId, patch);
    },
    reset: () => {
      if (activeTabId) resetTabSession(activeTabId);
    },
    appendBlock: (block: Parameters<typeof appendCliBlock>[1]) => {
      if (activeTabId) appendCliBlock(activeTabId, block);
    },
    upsertBlock: (block: Parameters<typeof upsertCliBlock>[1]) => {
      if (activeTabId) upsertCliBlock(activeTabId, block);
    },
    clearBlocks: () => {
      if (activeTabId) clearCliBlocks(activeTabId);
    },
  };
}
