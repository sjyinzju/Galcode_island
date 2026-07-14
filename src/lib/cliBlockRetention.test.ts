import { describe, expect, it } from "vitest";
import type { CliBlock } from "../types/blocks";
import { limitCliBlocks } from "./cliBlockRetention";

const blocks: CliBlock[] = [
  { id: "prompt", type: "user-prompt", content: "Hello" },
  { id: "tool", type: "tool", tool: "Tool result", detail: "data" },
  { id: "reply", type: "text", content: "Done" },
];

describe("limitCliBlocks", () => {
  it("keeps the complete ordered timeline when full history is required", () => {
    expect(limitCliBlocks(blocks, 2, true)).toBe(blocks);
  });

  it("keeps a contiguous recent window for ordinary tabs", () => {
    expect(limitCliBlocks(blocks, 2, false).map((block) => block.id)).toEqual([
      "tool",
      "reply",
    ]);
  });
});
