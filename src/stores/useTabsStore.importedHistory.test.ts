import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliBlock } from "../types/blocks";

const bridgeMocks = vi.hoisted(() => ({
  invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  listen: vi.fn(async () => () => {}),
}));

vi.mock("../lib/bridge", () => ({
  invoke: bridgeMocks.invoke,
  isTauri: true,
  listen: bridgeMocks.listen,
}));

const storedValues = new Map<string, string>();
const memoryStorage: Storage = {
  get length() {
    return storedValues.size;
  },
  clear: () => storedValues.clear(),
  getItem: (key) => storedValues.get(key) ?? null,
  key: (index) => Array.from(storedValues.keys())[index] ?? null,
  removeItem: (key) => void storedValues.delete(key),
  setItem: (key, value) => void storedValues.set(key, value),
};

let useTabsStore: typeof import("./useTabsStore").useTabsStore;
let useImportedConversationsStore:
  typeof import("./useImportedConversationsStore").useImportedConversationsStore;

beforeAll(async () => {
  vi.stubGlobal("localStorage", memoryStorage);
  bridgeMocks.invoke.mockResolvedValue(undefined);
  ({ useTabsStore } = await import("./useTabsStore"));
  ({ useImportedConversationsStore } = await import("./useImportedConversationsStore"));
});

beforeEach(() => {
  vi.useFakeTimers();
  storedValues.clear();
  useTabsStore.setState({ tabs: {}, order: [], activeTabId: null, history: [] });
  useImportedConversationsStore.setState({ conversations: [], loaded: false });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.clearAllTimers();
  vi.useRealTimers();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("useTabsStore full imported history", () => {
  it("keeps 305+ imported blocks through create, append, and upsert", () => {
    const importedBlocks: CliBlock[] = Array.from({ length: 305 }, (_, index) => ({
      id: `imported-${index}`,
      type: index % 50 === 0 ? "user-prompt" : "text",
      content: `Block ${index}`,
    }));
    const continuedPrompt: CliBlock = {
      id: "continued-prompt",
      type: "user-prompt",
      content: "Continue the imported conversation",
    };
    const continuedAnswer: CliBlock = {
      id: "continued-answer",
      type: "text",
      content: "Continued response",
    };

    const tabId = useTabsStore.getState().createTab({
      id: "full-imported-history",
      importedConversationId: "external:claude-code:test-session",
      hasFullImportedHistory: true,
      cliBlocks: importedBlocks,
    });

    expect(useTabsStore.getState().tabs[tabId]?.cliBlocks).toEqual(importedBlocks);

    useTabsStore.getState().appendCliBlock(tabId, continuedPrompt);
    expect(useTabsStore.getState().tabs[tabId]?.cliBlocks).toEqual([
      ...importedBlocks,
      continuedPrompt,
    ]);

    useTabsStore.getState().upsertCliBlock(tabId, continuedAnswer);
    const tab = useTabsStore.getState().tabs[tabId];
    expect(tab?.cliBlocks).toEqual([
      ...importedBlocks,
      continuedPrompt,
      continuedAnswer,
    ]);
    expect(tab?.hasFullImportedHistory).toBe(true);
  });

  it("records a tombstone when an imported block is deleted", () => {
    const importedBlock: CliBlock = {
      id: "imported-external:codex:test-message-0",
      type: "text",
      content: "Delete me",
      importedConversationId: "external:codex:test",
    };
    const tabId = useTabsStore.getState().createTab({
      importedConversationId: "external:codex:test",
      hasFullImportedHistory: true,
      cliBlocks: [importedBlock],
    });

    useTabsStore.getState().removeCliBlock(tabId, importedBlock.id);

    const tab = useTabsStore.getState().tabs[tabId];
    expect(tab?.cliBlocks).toEqual([]);
    expect(tab?.deletedImportedBlockIds).toEqual([importedBlock.id]);
  });

  it("preserves imported session state when a closed tab is restored", () => {
    const conversationId = "external:codex:archived-thread";
    const deletedBlockId = `imported-${conversationId}-message-1`;
    const tabId = useTabsStore.getState().createTab({
      id: "archived-imported-tab",
      title: "Imported session",
      agent: "codex",
      projectPath: "C:\\work",
      importedConversationId: conversationId,
      hasFullImportedHistory: true,
      deletedImportedBlockIds: [deletedBlockId],
      importedHistoryError: "Previous import error",
      lastUserPrompt: "Continue this session",
      cliBlocks: [{
        id: `imported-${conversationId}-message-0`,
        type: "user-prompt",
        content: "Continue this session",
        importedConversationId: conversationId,
      }],
    });

    useTabsStore.getState().removeTab(tabId);

    const archived = useTabsStore.getState().history.find((item) => item.id === tabId);
    expect(archived?.importedConversationId).toBe(conversationId);
    expect(archived?.deletedImportedBlockIds).toEqual([deletedBlockId]);
    expect(archived?.importedHistoryError).toBe("Previous import error");

    const restoredId = useTabsStore.getState().restoreFromHistory(tabId);
    expect(restoredId).not.toBeNull();

    const restored = useTabsStore.getState().tabs[restoredId!];
    expect(restored?.importedConversationId).toBe(conversationId);
    expect(restored?.deletedImportedBlockIds).toEqual([deletedBlockId]);
    expect(restored?.importedHistoryError).toBe("Previous import error");
    expect(restored?.hasFullImportedHistory).toBe(false);
    expect(restored?.cliBlocks).toEqual([]);
  });

  it("does not copy a large imported block array for an unchanged upsert", () => {
    const importedBlocks: CliBlock[] = Array.from({ length: 6_000 }, (_, index) => ({
      id: `imported-large-${index}`,
      type: "text",
      content: `Block ${index}`,
    }));
    const tabId = useTabsStore.getState().createTab({
      importedConversationId: "external:codex:large",
      hasFullImportedHistory: true,
      cliBlocks: importedBlocks,
    });
    const before = useTabsStore.getState().tabs[tabId]!.cliBlocks;

    useTabsStore.getState().upsertCliBlock(tabId, { ...before[100]! });

    expect(useTabsStore.getState().tabs[tabId]!.cliBlocks).toBe(before);
  });

  it("updates an early block in a large imported timeline without duplicating it", () => {
    const importedBlocks: CliBlock[] = Array.from({ length: 6_000 }, (_, index) => ({
      id: `imported-large-${index}`,
      type: "text",
      content: `Block ${index}`,
    }));
    const tabId = useTabsStore.getState().createTab({
      importedConversationId: "external:codex:large",
      hasFullImportedHistory: true,
      cliBlocks: importedBlocks,
    });

    useTabsStore.getState().upsertCliBlock(tabId, {
      id: "imported-large-100",
      type: "text",
      content: "Updated",
    });

    const blocks = useTabsStore.getState().tabs[tabId]!.cliBlocks;
    expect(blocks).toHaveLength(6_000);
    expect(blocks[100]?.content).toBe("Updated");
    expect(blocks.filter((block) => block.id === "imported-large-100")).toHaveLength(1);
  });

  it("persists a local attachment as a local path instead of a remote URL", async () => {
    const tabId = useTabsStore.getState().createTab({
      cliBlocks: [{
        id: "local-attachment-message",
        type: "user-prompt",
        content: "",
        attachments: [{
          name: "report.pdf",
          mediaType: "application/pdf",
          localPath: "C:\\work\\report.pdf",
        }],
      }],
    });

    await vi.advanceTimersByTimeAsync(250);

    const raw = storedValues.get("galcode_tabs");
    expect(raw).toContain("report.pdf");
    const persisted = JSON.parse(raw ?? "{}") as {
      state?: { tabs?: Record<string, { cliBlocks?: CliBlock[] }> };
    };
    const attachment = persisted.state?.tabs?.[tabId]?.cliBlocks?.[0]?.attachments?.[0];
    expect(attachment?.localPath).toBe("C:\\work\\report.pdf");
    expect(attachment?.url).toBeUndefined();
  });

  it("marks an already open tab for refresh when the same session is reimported", () => {
    const tabId = useTabsStore.getState().createTab({
      agent: "codex",
      agentNativeSessionId: "thread-123",
      importedConversationId: "external:codex:thread-123",
      hasFullImportedHistory: true,
    });

    useImportedConversationsStore.getState().merge([{
      id: "external:codex:thread-123",
      source: "codex",
      nativeSessionId: "thread-123",
      title: "Updated import",
      projectPath: "C:\\work",
      createdAt: 1,
      updatedAt: 2,
      importedAt: 3,
      messageCount: 4,
    }]);

    expect(useTabsStore.getState().tabs[tabId]?.hasFullImportedHistory).toBe(false);
    expect(useTabsStore.getState().tabs[tabId]?.importedHistoryRevision).toBe(1);
  });

  it("does not persist recoverable imported tool payloads", () => {
    const conversationId = "external:codex:large-tool";
    const tabId = useTabsStore.getState().createTab({
      importedConversationId: conversationId,
      hasFullImportedHistory: true,
      cliBlocks: [{
        id: `imported-${conversationId}-tool-1`,
        type: "tool",
        tool: "Tool result",
        detail: "bounded preview",
        detailValue: { output: "x".repeat(1_000_000) },
        images: [{
          dataUrl: "data:image/png;base64,AA==",
          assetId: "a".repeat(64),
          alt: "stored image",
        }],
        attachments: [{
          name: "report.pdf",
          mediaType: "application/pdf",
          dataUrl: "data:application/pdf;base64,AA==",
          assetId: "b".repeat(64),
        }],
      }],
    });

    const partialize = useTabsStore.persist.getOptions().partialize!;
    const persisted = partialize(useTabsStore.getState()) as unknown as {
      tabs: Record<string, { cliBlocks: CliBlock[]; hasFullImportedHistory: boolean }>;
    };

    expect(persisted.tabs[tabId]?.cliBlocks[0]?.detail).toBe("bounded preview");
    expect(persisted.tabs[tabId]?.cliBlocks[0]?.detailValue).toBeUndefined();
    expect(persisted.tabs[tabId]?.cliBlocks[0]?.images).toEqual([{
      assetId: "a".repeat(64),
      alt: "stored image",
    }]);
    expect(persisted.tabs[tabId]?.cliBlocks[0]?.attachments).toEqual([{
      name: "report.pdf",
      mediaType: "application/pdf",
      assetId: "b".repeat(64),
    }]);
    expect(persisted.tabs[tabId]?.hasFullImportedHistory).toBe(false);
  });

  it("shows a recoverable error on open tabs when imported storage is deleted", async () => {
    const conversationId = "external:codex:thread-123";
    const tabId = useTabsStore.getState().createTab({
      importedConversationId: conversationId,
      hasFullImportedHistory: true,
    });
    useImportedConversationsStore.setState({
      loaded: true,
      conversations: [{
        id: conversationId,
        source: "codex",
        nativeSessionId: "thread-123",
        title: "Imported",
        projectPath: "C:\\work",
        createdAt: 1,
        updatedAt: 2,
        importedAt: 3,
        messageCount: 4,
      }],
    });

    await useImportedConversationsStore.getState().remove(conversationId);

    const tab = useTabsStore.getState().tabs[tabId];
    expect(tab?.importedHistoryError).toContain("重新导入");
    expect(tab?.cliBlocks.some((block) => block.id === `imported-history-error-${conversationId}`))
      .toBe(true);
  });
});
