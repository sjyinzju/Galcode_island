// 任务流：单一干净的滚动文本区，没有外层装饰、状态条、进度条、日志框这些
// 重复 / 抢空间的子组件。流式过程 + 最终总结 + 建议按钮 都在 BlockStream 里。
// AgentStatusBadge / TodoProgress / LogStream 已下线（前两个跟 PetCharacter 状态
// 重复，LogStream 在事件管线收敛后没人 push 了）。

import { useEffect } from "react";
import { useActiveTabId } from "../../hooks/useActiveTab";
import { invoke } from "../../lib/bridge";
import {
  importedHistoryErrorBlock,
  mergeImportedConversationTimeline,
} from "../../lib/importedConversation";
import { useTabsStore } from "../../stores/useTabsStore";
import type { ImportedConversation } from "../../types/externalHistory";
import { BlockStream } from "./BlockStream";

const importedTabLoads = new Map<string, Promise<void>>();

function restoreImportedTimeline(
  tabId: string,
  conversationId: string,
  revision: number,
): Promise<void> {
  const key = `${tabId}:${conversationId}:${revision}`;
  const existingLoad = importedTabLoads.get(key);
  if (existingLoad) return existingLoad;

  const load = (async () => {
    const conversation = await invoke<ImportedConversation>("load_imported_conversation", {
      id: conversationId,
    });
    const state = useTabsStore.getState();
    const tab = state.tabs[tabId];
    if (
      !tab ||
      tab.importedConversationId !== conversationId ||
      tab.importedHistoryRevision !== revision ||
      tab.hasFullImportedHistory
    ) return;

    const importedTab = mergeImportedConversationTimeline(
      conversation,
      tab.cliBlocks,
      {
        deletedImportedBlockIds: tab.deletedImportedBlockIds,
        projectPath: tab.projectPath,
      },
    );
    state.updateTab(tabId, {
      cliBlocks: importedTab.cliBlocks,
      hasFullImportedHistory: true,
      importedHistoryError: null,
      lastUserPrompt: importedTab.lastUserPrompt,
    });
  })()
    .catch((error) => {
      console.error("Failed to restore imported conversation", error);
      const message = "导入历史文件不可用，请重新导入该会话后重试。";
      const state = useTabsStore.getState();
      const tab = state.tabs[tabId];
      if (
        !tab ||
        tab.importedConversationId !== conversationId ||
        tab.importedHistoryRevision !== revision
      ) return;
      state.upsertCliBlock(tabId, importedHistoryErrorBlock(conversationId, message));
      state.updateTab(tabId, { importedHistoryError: message });
    })
    .finally(() => {
      importedTabLoads.delete(key);
    });
  importedTabLoads.set(key, load);
  return load;
}

export function StatusMonitor(): JSX.Element {
  const activeTabId = useActiveTabId();
  const inferredImportedConversationId = useTabsStore((state) => {
    const tab = activeTabId ? state.tabs[activeTabId] : null;
    if (!tab || tab.importedConversationId || !tab.agentNativeSessionId) return null;
    const candidate = `external:${tab.agent}:${tab.agentNativeSessionId}`;
    const prefix = `imported-${candidate}-`;
    return tab.cliBlocks.some((block) => block.id.startsWith(prefix)) ? candidate : null;
  });
  const importedConversationId = useTabsStore((state) =>
    activeTabId ? state.tabs[activeTabId]?.importedConversationId ?? null : null
  );
  const hasFullImportedHistory = useTabsStore((state) =>
    activeTabId ? state.tabs[activeTabId]?.hasFullImportedHistory ?? false : false
  );
  const importedHistoryRevision = useTabsStore((state) =>
    activeTabId ? state.tabs[activeTabId]?.importedHistoryRevision ?? 0 : 0
  );

  useEffect(() => {
    if (!activeTabId || !inferredImportedConversationId) return;
    useTabsStore.getState().updateTab(activeTabId, {
      importedConversationId: inferredImportedConversationId,
      hasFullImportedHistory: false,
    });
  }, [activeTabId, inferredImportedConversationId]);

  useEffect(() => {
    if (!activeTabId || !importedConversationId || hasFullImportedHistory) return;
    void restoreImportedTimeline(activeTabId, importedConversationId, importedHistoryRevision);
  }, [activeTabId, hasFullImportedHistory, importedConversationId, importedHistoryRevision]);

  return (
    <div className="h-full min-h-0">
      <BlockStream key={activeTabId ?? "no-tab"} />
    </div>
  );
}
