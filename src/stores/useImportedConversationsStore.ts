import { create } from "zustand";
import { invoke, isTauri } from "../lib/bridge";
import { importedHistoryErrorBlock } from "../lib/importedConversation";
import type { ImportedConversationSummary } from "../types/externalHistory";
import { useTabsStore } from "./useTabsStore";

interface ImportedConversationsState {
  conversations: ImportedConversationSummary[];
  loaded: boolean;
  refresh: () => Promise<void>;
  merge: (conversations: ImportedConversationSummary[]) => void;
  remove: (id: string) => Promise<void>;
}

let refreshPromise: Promise<void> | null = null;

export const useImportedConversationsStore = create<ImportedConversationsState>((set) => ({
  conversations: [],
  loaded: false,

  refresh: () => {
    if (!isTauri) return Promise.resolve();
    if (!refreshPromise) {
      refreshPromise = invoke<ImportedConversationSummary[]>("list_imported_conversations")
        .then((conversations) => set({ conversations, loaded: true }))
        .catch((error) => {
          console.error("Failed to list imported conversations", error);
          set({ loaded: true });
        })
        .finally(() => {
          refreshPromise = null;
        });
    }
    return refreshPromise;
  },

  merge: (incoming) => {
    if (incoming.length === 0) return;
    set((state) => {
      const nextById = new Map(
        state.conversations.map((conversation) => [conversation.id, conversation]),
      );
      for (const conversation of incoming) nextById.set(conversation.id, conversation);
      const conversations = Array.from(nextById.values()).sort(
        (first, second) => second.updatedAt - first.updatedAt || first.title.localeCompare(second.title),
      );
      return { conversations, loaded: true };
    });
    const tabs = useTabsStore.getState();
    for (const conversation of incoming) {
      for (const tab of Object.values(tabs.tabs)) {
        if (
          tab.importedConversationId !== conversation.id &&
          !(tab.agent === conversation.source &&
            tab.agentNativeSessionId === conversation.nativeSessionId)
        ) continue;
        tabs.updateTab(tab.id, {
          importedConversationId: conversation.id,
          hasFullImportedHistory: false,
          importedHistoryError: null,
          importedHistoryRevision: (tab.importedHistoryRevision ?? 0) + 1,
        });
      }
    }
  },

  remove: async (id) => {
    if (!isTauri) return;
    await invoke("remove_imported_conversation", { id });
    set((state) => ({
      conversations: state.conversations.filter((conversation) => conversation.id !== id),
    }));
    const message = "导入历史已被删除，重新导入同一会话即可恢复完整内容。";
    const tabs = useTabsStore.getState();
    for (const tab of Object.values(tabs.tabs)) {
      if (tab.importedConversationId !== id) continue;
      tabs.upsertCliBlock(tab.id, importedHistoryErrorBlock(id, message));
      tabs.updateTab(tab.id, {
        hasFullImportedHistory: false,
        importedHistoryError: message,
        importedHistoryRevision: (tab.importedHistoryRevision ?? 0) + 1,
      });
    }
  },
}));
