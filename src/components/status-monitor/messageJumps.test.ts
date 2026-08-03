import { describe, expect, it, vi } from "vitest";
import type { CliBlock } from "../../types/blocks";
import {
  buildMessageJumps,
  findActiveMessageJump,
  jumpToMessage,
  updateMessageJumps,
} from "./messageJumps";

describe("buildMessageJumps", () => {
  it("creates one jump per non-empty user prompt and groups each turn", () => {
    const blocks: CliBlock[] = [
      { id: "status", type: "status", message: "Starting" },
      { id: "user-1", type: "user-prompt", content: "  First   request  " },
      { id: "thought", type: "thought", content: "Thinking" },
      { id: "answer-1", type: "text", content: " First\nanswer " },
      { id: "file-a", type: "file", path: "C:\\work\\src\\App.tsx" },
      { id: "diff-a", type: "diff", path: "C:\\work\\src\\App.tsx" },
      { id: "file-b", type: "file", path: "/work/src/store.ts" },
      { id: "file-c", type: "file", path: "/work/src/view.tsx" },
      { id: "empty-user", type: "user-prompt", content: "   " },
      { id: "user-2", type: "user-prompt", content: "Second request" },
      { id: "answer-2", type: "text", content: "Second answer" },
    ];

    expect(buildMessageJumps(blocks)).toEqual([
      {
        blockId: "user-1",
        blockIndex: 1,
        prompt: "First request",
        responsePreview: "First answer",
        files: ["App.tsx", "store.ts"],
        extraFileCount: 1,
      },
      {
        blockId: "user-2",
        blockIndex: 9,
        prompt: "Second request",
        responsePreview: "Second answer",
        files: [],
        extraFileCount: 0,
      },
    ]);
  });

  it("caps long preview text", () => {
    const blocks: CliBlock[] = [
      { id: "user", type: "user-prompt", content: "p".repeat(300) },
      { id: "answer", type: "text", content: "a".repeat(500) },
    ];

    const [jump] = buildMessageJumps(blocks);
    expect(jump?.prompt.length).toBeLessThanOrEqual(181);
    expect(jump?.responsePreview.length).toBeLessThanOrEqual(321);
    expect(jump?.prompt.endsWith("…")).toBe(true);
    expect(jump?.responsePreview.endsWith("…")).toBe(true);
  });

  it("never treats tool results or non-user source roles as message jumps", () => {
    const blocks: CliBlock[] = [
      { id: "tool-before", type: "tool", tool: "Tool result", detail: "hidden result" },
      { id: "context", type: "user-prompt", sourceRole: "developer", content: "internal context" },
      { id: "user", type: "user-prompt", sourceRole: "user", content: "visible prompt" },
      { id: "tool-after", type: "tool", tool: "Tool result", detail: "not an answer" },
      { id: "answer", type: "text", sourceRole: "assistant", content: "visible answer" },
    ];

    expect(buildMessageJumps(blocks)).toEqual([
      expect.objectContaining({
        blockId: "user",
        prompt: "visible prompt",
        responsePreview: "visible answer",
      }),
    ]);
  });

  it("updates only the active tail while preserving earlier jump objects", () => {
    const first: CliBlock[] = [
      { id: "user-1", type: "user-prompt", content: "First" },
      { id: "answer-1", type: "text", content: "Answer one" },
      { id: "user-2", type: "user-prompt", content: "Second" },
      { id: "answer-2", type: "text", content: "Draft" },
    ];
    const initial = buildMessageJumps(first);
    const next = [...first.slice(0, -1), { ...first.at(-1)!, content: "Finished" }];
    const updated = updateMessageJumps(first, initial, next);

    expect(updated[0]).toBe(initial[0]);
    expect(updated[1]?.responsePreview).toBe("Finished");
  });

  it("finds the current message with a binary-search boundary", () => {
    const items = buildMessageJumps([
      { id: "user-1", type: "user-prompt", content: "First" },
      { id: "answer-1", type: "text", content: "Answer" },
      { id: "user-2", type: "user-prompt", content: "Second" },
      { id: "answer-2", type: "text", content: "Answer" },
    ]);

    expect(findActiveMessageJump(items, 0)).toBe("user-1");
    expect(findActiveMessageJump(items, 1)).toBe("user-1");
    expect(findActiveMessageJump(items, 2)).toBe("user-2");
  });

  it("jumps to the current block index and disables bottom following", () => {
    const blocks: CliBlock[] = [
      { id: "first", type: "user-prompt", content: "First" },
      { id: "answer", type: "text", content: "Answer" },
      { id: "second", type: "user-prompt", content: "Second" },
    ];
    const scrollToIndex = vi.fn();
    const stickToBottom = { current: true };

    expect(jumpToMessage(blocks, "second", scrollToIndex, stickToBottom, "smooth")).toBe(true);
    expect(stickToBottom.current).toBe(false);
    expect(scrollToIndex).toHaveBeenCalledWith(2, {
      align: "center",
      behavior: "smooth",
    });
  });

  it("ignores a message that was removed or trimmed", () => {
    const scrollToIndex = vi.fn();
    const stickToBottom = { current: true };

    expect(jumpToMessage([], "missing", scrollToIndex, stickToBottom, "auto")).toBe(false);
    expect(stickToBottom.current).toBe(true);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });
});
