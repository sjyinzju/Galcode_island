import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportedConversationSummary } from "../types/externalHistory";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  tabsState: {
    tabs: {},
    updateTab: vi.fn(),
    upsertCliBlock: vi.fn(),
  },
}));

vi.mock("../lib/bridge", () => ({
  invoke: mocks.invoke,
  isTauri: false,
}));

vi.mock("./useTabsStore", () => ({
  useTabsStore: {
    getState: () => mocks.tabsState,
  },
}));

import { useImportedConversationsStore } from "./useImportedConversationsStore";

const conversation: ImportedConversationSummary = {
  id: "external:codex:lan-session",
  source: "codex",
  nativeSessionId: "lan-session",
  title: "LAN session",
  projectPath: null,
  createdAt: 1,
  updatedAt: 2,
  importedAt: 3,
  messageCount: 4,
};

beforeEach(() => {
  mocks.invoke.mockReset();
  useImportedConversationsStore.setState({ conversations: [], loaded: false });
});

describe("useImportedConversationsStore in browser LAN mode", () => {
  it("loads imported conversations through the bridge", async () => {
    mocks.invoke.mockResolvedValueOnce([conversation]);

    await useImportedConversationsStore.getState().refresh();

    expect(mocks.invoke).toHaveBeenCalledWith("list_imported_conversations");
    expect(useImportedConversationsStore.getState()).toMatchObject({
      conversations: [conversation],
      loaded: true,
    });
  });

  it("deletes imported conversations through the bridge", async () => {
    useImportedConversationsStore.setState({ conversations: [conversation], loaded: true });
    mocks.invoke.mockResolvedValueOnce(undefined);

    await useImportedConversationsStore.getState().remove(conversation.id);

    expect(mocks.invoke).toHaveBeenCalledWith("remove_imported_conversation", {
      id: conversation.id,
    });
    expect(useImportedConversationsStore.getState().conversations).toEqual([]);
  });
});
