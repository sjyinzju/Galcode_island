import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ArchivedSession } from "../../stores/useTabsStore";
import type { ImportedConversationSummary } from "../../types/externalHistory";
import {
  ImportedHistoryRow,
  mergeHistoryEntries,
} from "./HistoryList";

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

describe("ImportedHistoryRow", () => {
  it("uses sibling native buttons for primary, view, and delete actions", () => {
    const html = renderToStaticMarkup(createElement(ImportedHistoryRow, {
      item: importedConversation("imported-keyboard", 100),
      now: 200,
      onOpen: vi.fn(),
      onView: vi.fn(),
      onDelete: vi.fn(),
    }));

    const buttonStarts = Array.from(html.matchAll(/<button/g), (match) => match.index);
    const buttonEnds = Array.from(html.matchAll(/<\/button>/g), (match) => match.index);

    expect(buttonStarts).toHaveLength(3);
    expect(buttonEnds).toHaveLength(3);
    expect(buttonEnds[0]).toBeLessThan(buttonStarts[1]!);
    expect(buttonEnds[1]).toBeLessThan(buttonStarts[2]!);
    expect(html).not.toContain('role="button"');
    expect(html).not.toContain('tabindex="0"');
    expect(html).toContain('aria-label="查看完整导入记录"');
    expect(html).toContain('aria-label="删除已导入对话"');
  });
});
