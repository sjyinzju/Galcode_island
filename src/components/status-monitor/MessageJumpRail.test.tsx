import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MessageJumpRail } from "./MessageJumpRail";
import type { MessageJumpItem } from "./messageJumps";

describe("MessageJumpRail", () => {
  it("renders a compact Codex-style rail without its own scrollbar", () => {
    const items: MessageJumpItem[] = Array.from({ length: 20 }, (_, index) => ({
      blockId: `user-${index}`,
      blockIndex: index * 3,
      prompt: `Prompt ${index + 1}`,
      responsePreview: `Response ${index + 1}`,
      files: [],
      extraFileCount: 0,
    }));

    const html = renderToStaticMarkup(
      <MessageJumpRail items={items} activeBlockId="user-2" onJump={vi.fn()} />,
    );

    expect(html.match(/data-message-marker="true"/g)).toHaveLength(20);
    expect(html).toContain("消息跳转，共 20 条");
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-valuenow="3"');
    expect(html).toContain('data-active="true"');
    expect(html).toContain("w-6");
    expect(html).toContain("height:min(280px, 100%)");
    expect(html).not.toContain("overflow-y-auto");
    expect(html).not.toContain("scrollbar");
  });

  it("keeps a short session in a compact centered cluster", () => {
    const items: MessageJumpItem[] = Array.from({ length: 5 }, (_, index) => ({
      blockId: `short-${index}`,
      blockIndex: index,
      prompt: `Short ${index + 1}`,
      responsePreview: "",
      files: [],
      extraFileCount: 0,
    }));

    const html = renderToStaticMarkup(
      <MessageJumpRail items={items} onJump={vi.fn()} />,
    );

    expect(html).toContain("height:min(70px, 100%)");
    expect(html).toContain("top-1/2");
  });

  it("stays hidden when there is only one message", () => {
    const item: MessageJumpItem = {
      blockId: "user-1",
      blockIndex: 0,
      prompt: "Only prompt",
      responsePreview: "",
      files: [],
      extraFileCount: 0,
    };

    expect(renderToStaticMarkup(
      <MessageJumpRail items={[item]} onJump={vi.fn()} />,
    )).toBe("");
  });
});
