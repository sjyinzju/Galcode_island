import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DeferredTranscriptContent,
  TranscriptPart,
  claimTranscriptRenderBatch,
  nextTranscriptRenderCount,
  taskNotificationSummary,
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

  it("does not turn local markdown files into empty navigating links", () => {
    const html = renderToStaticMarkup(
      <TranscriptPart
        part={{ type: "text", text: "[Open PDF](C:/Users/test/report.pdf)" }}
      />,
    );

    expect(html).toContain("Open PDF");
    expect(html).toContain("仅桌面端可打开");
    expect(html).not.toContain('href=""');
    expect(html).not.toContain("<a ");
  });

  it("does not navigate the webview for a local attachment URL", () => {
    const html = renderToStaticMarkup(
      <TranscriptPart
        part={{
          type: "attachment",
          name: "report.pdf",
          mediaType: "application/pdf",
          dataUrl: null,
          url: String.raw`C:\Users\test\report.pdf`,
        }}
      />,
    );

    expect(html).toContain("仅桌面端可打开");
    expect(html).not.toContain('href=""');
    expect(html).not.toContain("<a ");
  });

  it("downloads inline PDF data without opening a new webview", () => {
    const html = renderToStaticMarkup(
      <TranscriptPart
        part={{
          type: "attachment",
          name: "report.pdf",
          mediaType: "application/pdf",
          dataUrl: "data:application/pdf;base64,JVBERi0=",
          url: null,
        }}
      />,
    );

    expect(html).toContain('download="report.pdf"');
    expect(html).not.toContain('target="_blank"');
  });

  it("does not mount imported internal context before expansion", () => {
    const html = renderToStaticMarkup(
      <DeferredTranscriptContent label="内部上下文">
        <span>secret system prompt</span>
      </DeferredTranscriptContent>,
    );

    expect(html).toContain("内部上下文");
    expect(html).not.toContain("secret system prompt");
  });

  it("summarizes a legacy task notification despite its stale user flag", () => {
    expect(taskNotificationSummary({
      id: "legacy-task-notification",
      role: "user",
      isUserPrompt: true,
      sourceTurnId: "incorrect-legacy-turn",
      content: [
        "<task-notification>",
        "<status>completed</status>",
        "<summary>Background command completed</summary>",
        "</task-notification>",
      ].join("\n"),
      timestamp: 100,
    })).toBe("Background command completed");
  });
});
