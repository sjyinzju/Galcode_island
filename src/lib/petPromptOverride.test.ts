// pickPromptOverride 纯函数单测：覆盖 enabled/empty/no-prompt/preset-fallback/random 路径。

import { describe, expect, it } from "vitest";
import { pickPromptOverride } from "./petPromptOverride";

function mkMeta(o: Partial<{ id: string; fileName: string; prompt: string | null }>) {
  return {
    id: o.id ?? "i1",
    fileName: o.fileName ?? "i1.png",
    mime: "image/png",
    sizeBytes: 100,
    addedAt: 1,
    communityPrompt: o.prompt ?? null,
  } as Parameters<typeof pickPromptOverride>[1][number];
}

describe("pickPromptOverride", () => {
  it("enabled=false → null（不管 persona 有没有）", () => {
    expect(pickPromptOverride(false, [mkMeta({})], null)).toBeNull();
    expect(pickPromptOverride(false, [mkMeta({})], "温柔姐姐风")).toBeNull();
  });

  it("空 complete 列表 + 无预设 persona → null", () => {
    expect(pickPromptOverride(true, [], null)).toBeNull();
    expect(pickPromptOverride(true, [], "")).toBeNull();
    expect(pickPromptOverride(true, [], "   ")).toBeNull();
  });

  it("空 complete 列表 + 有预设 persona → 用预设 persona 占位", () => {
    const sel = pickPromptOverride(true, [], "硬汉风");
    expect(sel).toEqual({
      prompt: "硬汉风",
      sourceImageId: "__preset__",
      sourceFileName: "(preset)",
    });
  });

  it("唯一一张带 prompt → 用图 prompt（预设 persona 被覆盖）", () => {
    const meta = mkMeta({ id: "x", fileName: "x.png", prompt: "温柔姐姐风" });
    const sel = pickPromptOverride(true, [meta], "fallback persona");
    expect(sel).toEqual({
      prompt: "温柔姐姐风",
      sourceImageId: "x",
      sourceFileName: "x.png",
    });
  });

  it("图无 prompt + 有预设 persona → 回退到预设 persona，source 仍是该图", () => {
    const meta = mkMeta({ id: "y", fileName: "y.png", prompt: null });
    const sel = pickPromptOverride(true, [meta], "兜底风");
    expect(sel?.prompt).toBe("兜底风");
    expect(sel?.sourceImageId).toBe("y");
  });

  it("图无 prompt + 无预设 persona → prompt=null（Rust 走凉宫）", () => {
    const meta = mkMeta({ id: "y", fileName: "y.png", prompt: null });
    const sel = pickPromptOverride(true, [meta], null);
    expect(sel?.prompt).toBeNull();
    expect(sel?.sourceImageId).toBe("y");
  });

  it("图 prompt 空字符串 / 全空格 + 预设 persona 非空 → 用预设 persona", () => {
    expect(pickPromptOverride(true, [mkMeta({ prompt: "" })], "X")?.prompt).toBe("X");
    expect(pickPromptOverride(true, [mkMeta({ prompt: "   " })], "X")?.prompt).toBe("X");
  });

  it("多张图 + 注入 rand=0 → 选第 0 张", () => {
    const a = mkMeta({ id: "a", fileName: "a.png", prompt: "PA" });
    const b = mkMeta({ id: "b", fileName: "b.png", prompt: "PB" });
    const c = mkMeta({ id: "c", fileName: "c.png", prompt: "PC" });
    const sel = pickPromptOverride(true, [a, b, c], null, () => 0);
    expect(sel?.sourceImageId).toBe("a");
  });

  it("多张图 + 注入 rand=0.99 → 选最后一张（floor clamp 防越界）", () => {
    const a = mkMeta({ id: "a", prompt: "PA" });
    const b = mkMeta({ id: "b", prompt: "PB" });
    const c = mkMeta({ id: "c", prompt: "PC" });
    const sel = pickPromptOverride(true, [a, b, c], null, () => 0.99);
    expect(sel?.sourceImageId).toBe("c");
  });

  it("rand 返回边界值 1.0 → 不越界（取最后一张）", () => {
    const a = mkMeta({ id: "a" });
    const b = mkMeta({ id: "b" });
    const sel = pickPromptOverride(true, [a, b], null, () => 1.0);
    expect(sel?.sourceImageId).toBe("b");
  });

  it("3 张图 + 注入 rand=0.5 → 选第 1 张（floor(0.5*3)=1）", () => {
    const list = [
      mkMeta({ id: "a" }),
      mkMeta({ id: "b" }),
      mkMeta({ id: "c" }),
    ];
    expect(pickPromptOverride(true, list, null, () => 0.5)?.sourceImageId).toBe("b");
  });
});
