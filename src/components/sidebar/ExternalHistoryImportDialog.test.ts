import { describe, expect, it } from "vitest";
import type { ImportExternalSessionsResult } from "../../types/externalHistory";
import { summarizeImportResult } from "./ExternalHistoryImportDialog";

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
