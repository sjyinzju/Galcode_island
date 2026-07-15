import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AttachmentRow, MarkdownText } from "./BlockStream";

describe("BlockStream markdown images", () => {
  it("requires consent before loading a remote markdown image", () => {
    const html = renderToStaticMarkup(
      <MarkdownText content="![private](https://tracker.example/pixel.png)" />,
    );

    expect(html).toContain("加载远程图片");
    expect(html).not.toContain('<img src="https://tracker.example/pixel.png"');
  });
});

describe("BlockStream browser attachments", () => {
  it("renders a remote attachment as a safe browser link outside Tauri", () => {
    const html = renderToStaticMarkup(
      <AttachmentRow attachment={{
        name: "report.pdf",
        mediaType: "application/pdf",
        url: "https://files.example/report.pdf",
      }} />,
    );

    expect(html).toContain('href="https://files.example/report.pdf"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).not.toContain("<button");
  });

  it("does not offer an unusable local-path action in the browser", () => {
    const html = renderToStaticMarkup(
      <AttachmentRow attachment={{
        name: "local.pdf",
        mediaType: "application/pdf",
        localPath: "C:\\work\\local.pdf",
      }} />,
    );

    expect(html).toContain("仅元数据");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a ");
  });
});
