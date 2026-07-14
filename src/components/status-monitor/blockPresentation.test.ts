import { describe, expect, it } from "vitest";
import type { CliBlock } from "../../types/blocks";
import {
  getPromptCopyMode,
  getTurnSpacing,
  requiresAttachmentEditWarning,
} from "./blockPresentation";

describe("block presentation semantics", () => {
  it("copies an image-only prompt as an image instead of empty text", () => {
    const block: CliBlock = {
      id: "image-prompt",
      type: "user-prompt",
      images: [{ dataUrl: "data:image/png;base64,AA==", alt: null }],
    };

    expect(getPromptCopyMode(block)).toBe("image");
    expect(requiresAttachmentEditWarning(block)).toBe(true);
  });

  it("recognizes generic attachments and separates source turns", () => {
    const block: CliBlock = {
      id: "attachment-prompt",
      type: "user-prompt",
      attachments: [{ name: "report.pdf", mediaType: "application/pdf", localPath: "C:\\report.pdf" }],
      sourceTurnId: "turn-2",
    };

    expect(getPromptCopyMode(block)).toBe("none");
    expect(requiresAttachmentEditWarning(block)).toBe(true);
    expect(getTurnSpacing({ ...block, sourceTurnId: "turn-1" }, block)).toBe(16);
    expect(getTurnSpacing(block, { ...block, id: "next" })).toBe(4);
  });
});
