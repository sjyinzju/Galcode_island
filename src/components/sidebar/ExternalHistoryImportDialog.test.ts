import { describe, expect, it } from "vitest";
import type {
  ExternalSessionPreview,
  ImportExternalSessionsResult,
  ImportedConversationSummary,
} from "../../types/externalHistory";
import {
  IMPORT_HARD_LIMIT_BYTES,
  aggregateImportResults,
  dialogFocusTarget,
  notifyImportedSafely,
  planImportBatches,
  remainingSelectedSessionKeys,
  sessionImportBlockReason,
  summarizeImportResult,
  validateImportResult,
} from "./ExternalHistoryImportDialog";

function preview(
  source: ExternalSessionPreview["source"],
  nativeSessionId: string,
  sourceBytes: number,
): ExternalSessionPreview {
  return {
    source,
    nativeSessionId,
    title: nativeSessionId,
    projectPath: null,
    createdAt: 1,
    updatedAt: 2,
    messageCount: 1,
    sourceBytes,
  };
}

function imported(
  source: ExternalSessionPreview["source"],
  nativeSessionId: string,
): ImportedConversationSummary {
  return {
    id: `external:${source}:${nativeSessionId}`,
    source,
    nativeSessionId,
    title: nativeSessionId,
    projectPath: null,
    createdAt: 1,
    updatedAt: 2,
    importedAt: 3,
    messageCount: 1,
  };
}

describe("planImportBatches", () => {
  it("groups complete sessions by source without exceeding the target", () => {
    const sessions = [
      preview("codex", "a", 60),
      preview("claude-code", "d", 70),
      preview("codex", "b", 50),
      preview("codex", "c", 40),
      preview("claude-code", "e", 20),
    ];
    const selected = new Set(sessions.map((session) => `${session.source}:${session.nativeSessionId}`));

    expect(planImportBatches(sessions, selected, 100)).toEqual([
      {
        source: "codex",
        sourceBytes: 60,
        selections: [{ source: "codex", nativeSessionId: "a" }],
      },
      {
        source: "codex",
        sourceBytes: 90,
        selections: [
          { source: "codex", nativeSessionId: "b" },
          { source: "codex", nativeSessionId: "c" },
        ],
      },
      {
        source: "claude-code",
        sourceBytes: 90,
        selections: [
          { source: "claude-code", nativeSessionId: "d" },
          { source: "claude-code", nativeSessionId: "e" },
        ],
      },
    ]);
  });

  it("keeps an individually oversized session whole and excludes unselected sessions", () => {
    const sessions = [
      preview("codex", "large", 120),
      preview("codex", "ignored", 10),
    ];

    expect(planImportBatches(sessions, new Set(["codex:large"]), 100)).toEqual([
      {
        source: "codex",
        sourceBytes: 120,
        selections: [{ source: "codex", nativeSessionId: "large" }],
      },
    ]);
  });

  it("keeps unknown-size sessions in separate defensive batches", () => {
    const sessions = [
      preview("codex", "zero", 0),
      preview("codex", "invalid", Number.NaN),
      preview("codex", "known", 20),
    ];
    const selected = new Set(sessions.map((session) => `codex:${session.nativeSessionId}`));

    expect(planImportBatches(sessions, selected, 100).map((batch) =>
      batch.selections.map((selection) => selection.nativeSessionId)
    )).toEqual([["zero"], ["invalid"], ["known"]]);
  });

  it("blocks a session that exceeds the backend hard limit", () => {
    const session = preview("codex", "too-large", IMPORT_HARD_LIMIT_BYTES + 1);

    expect(sessionImportBlockReason(session)).toBe("超过 512 MiB 上限，无法导入");
    expect(planImportBatches([session], new Set(["codex:too-large"]))).toEqual([]);
  });
});

describe("validateImportResult", () => {
  it("rejects a resolved but malformed backend result", () => {
    expect(() => validateImportResult({ imported: null, skipped: [], warnings: [] }))
      .toThrow("导入服务返回了无效结果");
  });
});

describe("notifyImportedSafely", () => {
  it("turns a parent refresh failure into a recoverable message", () => {
    const result: ImportExternalSessionsResult = {
      imported: [imported("codex", "a")],
      skipped: [],
      warnings: [],
    };

    expect(notifyImportedSafely(() => {
      throw new Error("refresh failed");
    }, result)).toContain("refresh failed");
  });
});

describe("aggregateImportResults", () => {
  it("keeps first-seen batch results while removing repeated entries", () => {
    expect(aggregateImportResults([
      {
        imported: [imported("codex", "a")],
        skipped: [],
        warnings: ["first warning"],
      },
      {
        imported: [imported("codex", "a"), imported("claude-code", "b")],
        skipped: ["missing", "missing"],
        warnings: ["first warning", "second warning"],
      },
    ])).toEqual({
      imported: [imported("codex", "a"), imported("claude-code", "b")],
      skipped: ["missing"],
      warnings: ["first warning", "second warning"],
    });
  });
});

describe("remainingSelectedSessionKeys", () => {
  it("removes only sessions confirmed as imported", () => {
    const selected = new Set(["codex:a", "codex:b", "claude-code:c"]);
    const result: ImportExternalSessionsResult = {
      imported: [imported("codex", "a")],
      skipped: ["codex:b was not found"],
      warnings: [],
    };

    expect([...remainingSelectedSessionKeys(selected, result)]).toEqual([
      "codex:b",
      "claude-code:c",
    ]);
    expect([...selected]).toEqual(["codex:a", "codex:b", "claude-code:c"]);
  });
});

describe("summarizeImportResult", () => {
  it("reports complete success as done", () => {
    const result: ImportExternalSessionsResult = {
      imported: [imported("codex", "a")],
      skipped: [],
      warnings: [],
    };

    expect(summarizeImportResult(result, 0)).toEqual({
      kind: "done",
      message: "已导入 1 个完整对话",
      warnings: [],
    });
  });

  it("treats a zero-import result as a retryable failure", () => {
    const result: ImportExternalSessionsResult = {
      imported: [],
      skipped: ["missing-session"],
      warnings: ["line 3 is invalid JSON", "attachment is too large"],
    };

    expect(summarizeImportResult(result)).toEqual({
      kind: "error",
      message: "未导入任何对话，1 个对话已保留，可重试",
      warnings: result.warnings,
    });
  });

  it("reports persisted partial success as a retryable failure", () => {
    const result = aggregateImportResults([
      {
        imported: [imported("codex", "a")],
        skipped: [],
        warnings: [],
      },
    ], ["Claude Code 第 2/2 批导入失败：network error"]);
    const selected = new Set(["codex:a", "claude-code:b"]);

    expect(summarizeImportResult(result, 1)).toEqual({
      kind: "error",
      message: "已导入 1 个完整对话，1 个未完成，已保留可重试，1 条记录需要注意",
      warnings: result.warnings,
    });
    expect([...remainingSelectedSessionKeys(selected, result)]).toEqual(["claude-code:b"]);
  });

  it("asks for a rescan when history grew beyond the backend limit", () => {
    const result: ImportExternalSessionsResult = {
      imported: [],
      skipped: ["session was not found"],
      warnings: [
        "Selected history exceeds the 536870912 byte complete import limit; no partial conversations were imported",
      ],
    };

    expect(summarizeImportResult(result, 1).message)
      .toBe("未导入任何对话，历史记录体积已变化，请重新打开导入窗口后重试");
  });

  it("asks for a rescan after partial success when history grew beyond the backend limit", () => {
    const result: ImportExternalSessionsResult = {
      imported: [imported("codex", "a")],
      skipped: ["session was not found"],
      warnings: [
        "Selected history exceeds the 536870912 byte complete import limit; no partial conversations were imported",
      ],
    };

    expect(summarizeImportResult(result, 1).message)
      .toBe("已导入 1 个完整对话，剩余记录体积已变化，请重新打开导入窗口后重试，1 条记录需要注意");
  });
});

describe("dialogFocusTarget", () => {
  it("wraps focus at both ends and recovers focus that escaped the dialog", () => {
    const first = { id: "first" };
    const middle = { id: "middle" };
    const last = { id: "last" };
    const focusable = [first, middle, last];

    expect(dialogFocusTarget(focusable, last, false)).toBe(first);
    expect(dialogFocusTarget(focusable, first, true)).toBe(last);
    expect(dialogFocusTarget(focusable, middle, false)).toBeNull();
    expect(dialogFocusTarget(focusable, { id: "outside" }, false)).toBe(first);
  });
});
