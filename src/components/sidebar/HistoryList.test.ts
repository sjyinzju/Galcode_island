import { describe, expect, it } from "vitest";
import type { ArchivedSession } from "../../stores/useTabsStore";
import type { ImportedConversationSummary } from "../../types/externalHistory";
import { mergeHistoryEntries } from "./HistoryList";

function importedConversation(id: string, updatedAt: number): ImportedConversationSummary {
  return {
    id,
    source: "codex",
    nativeSessionId: `native-${id}`,
    title: id,
    projectPath: null,
    createdAt: updatedAt - 1,
    updatedAt,
    importedAt: updatedAt + 1,
    messageCount: 1,
  };
}

function archivedSession(id: string, closedAt: number): ArchivedSession {
  return {
    id,
    closedAt,
    createdAt: closedAt - 1,
    agent: "codex",
    projectPath: null,
    summary: id,
    sessionId: null,
    agentNativeSessionId: null,
    importedConversationId: null,
    deletedImportedBlockIds: [],
    importedHistoryError: null,
    summaryTranslation: "",
    emotionText: "",
    resultZh: "",
    suggestionOptions: [],
  };
}

describe("mergeHistoryEntries", () => {
  it("interleaves imported and archived conversations by their activity time", () => {
    const olderImport = importedConversation("import-old", 100);
    const newerImport = importedConversation("import-new", 300);
    const olderArchive = archivedSession("archive-old", 200);
    const newerArchive = archivedSession("archive-new", 400);

    const entries = mergeHistoryEntries(
      [newerImport, olderImport],
      [newerArchive, olderArchive],
    );

    expect(entries.map((entry) => `${entry.kind}:${entry.item.id}`)).toEqual([
      "archived:archive-new",
      "imported:import-new",
      "archived:archive-old",
      "imported:import-old",
    ]);
  });
});
