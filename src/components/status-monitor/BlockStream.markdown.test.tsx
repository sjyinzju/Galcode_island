import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AttachmentRow,
  CollapsibleBlockContent,
  MarkdownText,
} from "./BlockStream";
import {
  localFilePathFromHref,
  requestOpenLocalFile,
} from "../SafeMarkdownLink";

describe("BlockStream markdown images", () => {
  it("requires consent before loading a remote markdown image", () => {
    const html = renderToStaticMarkup(
      <MarkdownText content="![private](https://tracker.example/pixel.png)" />,
    );

    expect(html).toContain("加载远程图片");
    expect(html).not.toContain('<img src="https://tracker.example/pixel.png"');
  });
});

describe("BlockStream collapsed notices", () => {
  it("does not mount long internal content until expanded", () => {
    const collapsed = renderToStaticMarkup(
      <CollapsibleBlockContent
        label="内部上下文"
        expanded={false}
        onToggle={() => undefined}
      >
        <span>secret system prompt</span>
      </CollapsibleBlockContent>,
    );
    const expanded = renderToStaticMarkup(
      <CollapsibleBlockContent
        label="内部上下文"
        expanded
        onToggle={() => undefined}
      >
        <span>secret system prompt</span>
      </CollapsibleBlockContent>,
    );

    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).toContain("内部上下文");
    expect(collapsed).not.toContain("secret system prompt");
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain("secret system prompt");
  });
});

describe("BlockStream markdown links", () => {
  it("renders an absolute local PDF as a non-navigating browser label", () => {
    const html = renderToStaticMarkup(
      <MarkdownText content="[Open PDF](C:/Users/test/report.pdf)" />,
    );

    expect(html).toContain("Open PDF");
    expect(html).toContain("仅桌面端可打开");
    expect(html).not.toContain('href=""');
    expect(html).not.toContain("<a ");
  });

  it("recognizes an encoded Windows backslash path from markdown", () => {
    const html = renderToStaticMarkup(
      <MarkdownText content={String.raw`[Open PDF](C:\Users\test\report.pdf)`} />,
    );

    expect(html).toContain("Open PDF");
    expect(html).toContain("仅桌面端可打开");
    expect(html).not.toContain("<a ");
  });

  it("normalizes an encoded Windows file URL before opening it", () => {
    expect(localFilePathFromHref("file:///C:%5CUsers%5Ctest%5Creport.pdf"))
      .toBe("C:\\Users\\test\\report.pdf");
  });

  it("rejects remote file shares and executable local targets", () => {
    expect(localFilePathFromHref(String.raw`\\server\share\report.pdf`)).toBeNull();
    expect(localFilePathFromHref("file://server/share/report.pdf")).toBeNull();
    expect(localFilePathFromHref(String.raw`C:\Users\test\run.exe`)).toBeNull();
  });

  it("keeps HTTPS links safe and blocks relative or script links", () => {
    const remote = renderToStaticMarkup(
      <MarkdownText content="[report](https://files.example/report.pdf)" />,
    );
    const blocked = renderToStaticMarkup(
      <MarkdownText content="[relative](report.pdf) [unsafe](javascript:alert(1))" />,
    );

    expect(remote).toContain('href="https://files.example/report.pdf"');
    expect(remote).toContain('target="_blank"');
    expect(remote).toContain('rel="noreferrer noopener"');
    expect(blocked).not.toContain("<a ");
    expect(blocked).not.toContain("javascript:");
  });

  it("routes local file opening through the validated desktop command", async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    await requestOpenLocalFile(
      "C:\\Users\\test\\report.pdf",
      async (command, args) => {
        calls.push({ command, args });
      },
    );

    expect(calls).toEqual([{
      command: "open_local_file",
      args: { path: "C:\\Users\\test\\report.pdf" },
    }]);
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

  it("does not treat a local attachment URL as a browser URL", () => {
    const html = renderToStaticMarkup(
      <AttachmentRow attachment={{
        name: "local.pdf",
        mediaType: "application/pdf",
        url: String.raw`C:\work\local.pdf`,
      }} />,
    );

    expect(html).toContain("仅元数据");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a ");
  });
});
