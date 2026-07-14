import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownText } from "./BlockStream";

describe("BlockStream markdown images", () => {
  it("requires consent before loading a remote markdown image", () => {
    const html = renderToStaticMarkup(
      <MarkdownText content="![private](https://tracker.example/pixel.png)" />,
    );

    expect(html).toContain("加载远程图片");
    expect(html).not.toContain('<img src="https://tracker.example/pixel.png"');
  });
});
