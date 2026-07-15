import { describe, expect, it } from "vitest";
import type { ImportExternalSessionsResult } from "../../types/externalHistory";
import { dialogFocusTarget, summarizeImportResult } from "./ExternalHistoryImportDialog";

describe("summarizeImportResult", () => {
  it("keeps warning details visible after import", () => {
    const result: ImportExternalSessionsResult = {
      imported: [],
      skipped: ["missing-session"],
      warnings: ["line 3 is invalid JSON", "attachment is too large"],
    };

    expect(summarizeImportResult(result)).toEqual({
      message: "已导入 0 个完整对话，跳过 1 条，2 条记录需要注意",
      warnings: result.warnings,
    });
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
