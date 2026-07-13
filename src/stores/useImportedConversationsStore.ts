import { create } from "zustand";
import { invoke, isTauri } from "../lib/bridge";
import type { ImportedConversationSummary } from "../types/externalHistory";

interface ImportedConversationsState {
  conversations: ImportedConversationSummary[];
  loading: boolean;
  loaded: boolean;
  refreshPending: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useImportedConversationsStore = create<ImportedConversationsState>((set, get) => ({
  conversations: [],
  loading: false,
  loaded: false,
  refreshPending: false,
  error: null,

  refresh: async () => {
    if (!isTauri) return;
    if (get().loading) {
      set({ refreshPending: true });
      return;
    }
    set({ loading: true, error: null });
    try {
      const conversations = await invoke<ImportedConversationSummary[]>("list_imported_conversations");
      set({ conversations, loading: false, loaded: true });
    } catch (error) {
      set({ loading: false, loaded: true, error: String(error) });
    }
    if (get().refreshPending) {
      set({ refreshPending: false });
      await get().refresh();
    }
  },

  remove: async (id) => {
    if (!isTauri) return;
    await invoke("remove_imported_conversation", { id });
    set((state) => ({
      conversations: state.conversations.filter((conversation) => conversation.id !== id),
    }));
  },
}));
