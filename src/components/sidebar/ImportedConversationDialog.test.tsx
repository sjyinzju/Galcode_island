import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  TranscriptPart,
  claimTranscriptRenderBatch,
  nextTranscriptRenderCount,
  transcriptVirtualItemCount,
  transcriptVirtualItemKey,
} from "./ImportedConversationDialog";

describe("ImportedConversationDialog", () => {
  it("progressively renders large transcripts in bounded batches", () => {
    expect(nextTranscriptRenderCount(0, 4_174)).toBeLessThan(4_174);
    expect(nextTranscriptRenderCount(80, 4_174)).toBeGreaterThan(80);
    expect(nextTranscriptRenderCount(4_160, 4_174)).toBe(4_174);
  });

  it("claims only one batch before the expanded DOM commits", () => {
    const pending = { current: false };
    const claims = Array.from({ length: 20 }, () =>
      claimTranscriptRenderBatch(80, 4_174, pending)
    );

    expect(claims[0]).toBe(180);
    expect(claims.slice(1).every((claim) => claim === null)).toBe(true);
    pending.current = false;
    expect(claimTranscriptRenderBatch(180, 4_174, pending)).toBe(280);
  });

  it("keeps the virtual list bounded to rendered messages plus one loader row", () => {
    const messages = [
      { id: "message-1" },
      { id: "message-2" },
    ];

    expect(transcriptVirtualItemCount(messages.length, 4_174)).toBe(3);
    expect(transcriptVirtualItemKey(messages, 0)).toBe("message-1");
    expect(transcriptVirtualItemKey(messages, 2)).toBe("load-more");
    expect(transcriptVirtualItemCount(4_174, 4_174)).toBe(4_174);
  });

  it("uses the safe lazy image renderer in transcript parts", () => {
    const html = renderToStaticMarkup(
      <TranscriptPart
        part={{ type: "image", dataUrl: "https://example.com/private.png", alt: "附件" }}
      />,
    );

    expect(html).toContain("加载远程图片");
    expect(html).not.toContain('<img src="https://example.com/private.png"');
  });

  it("does not auto-load remote images embedded in markdown text", () => {
    const html = renderToStaticMarkup(
      <TranscriptPart
        part={{ type: "text", text: "![private](https://tracker.example/pixel.png)" }}
      />,
    );

    expect(html).toContain("加载远程图片");
    expect(html).not.toContain('<img src="https://tracker.example/pixel.png"');
  });
});
