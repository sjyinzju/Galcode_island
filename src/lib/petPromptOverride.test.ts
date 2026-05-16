// pickPromptOverride 纯函数单测：覆盖 enabled/empty/no-prompt/random 路径。

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
  it("enabled=false → null", () => {
    expect(pickPromptOverride(false, [mkMeta({})])).toBeNull();
  });

  it("空 complete 列表 → null", () => {
    expect(pickPromptOverride(true, [])).toBeNull();
  });

  it("唯一一张带 prompt → 返回那张的 prompt + 来源", () => {
    const meta = mkMeta({ id: "x", fileName: "x.png", prompt: "温柔姐姐风" });
    const sel = pickPromptOverride(true, [meta]);
    expect(sel).toEqual({
      prompt: "温柔姐姐风",
      sourceImageId: "x",
      sourceFileName: "x.png",
    });
  });

  it("图无 prompt → prompt=null 但 source 信息仍返回", () => {
    const meta = mkMeta({ id: "y", fileName: "y.png", prompt: null });
    const sel = pickPromptOverride(true, [meta]);
    expect(sel?.prompt).toBeNull();
    expect(sel?.sourceImageId).toBe("y");
  });

  it("prompt 为空字符串 / 全空格 → 视为 null", () => {
    expect(pickPromptOverride(true, [mkMeta({ prompt: "" })])?.prompt).toBeNull();
    expect(pickPromptOverride(true, [mkMeta({ prompt: "   " })])?.prompt).toBeNull();
  });

  it("多张图 + 注入 rand=0 → 选第 0 张", () => {
    const a = mkMeta({ id: "a", fileName: "a.png", prompt: "PA" });
    const b = mkMeta({ id: "b", fileName: "b.png", prompt: "PB" });
    const c = mkMeta({ id: "c", fileName: "c.png", prompt: "PC" });
    const sel = pickPromptOverride(true, [a, b, c], () => 0);
    expect(sel?.sourceImageId).toBe("a");
  });

  it("多张图 + 注入 rand=0.99 → 选最后一张（floor clamp 防越界）", () => {
    const a = mkMeta({ id: "a", prompt: "PA" });
    const b = mkMeta({ id: "b", prompt: "PB" });
    const c = mkMeta({ id: "c", prompt: "PC" });
    const sel = pickPromptOverride(true, [a, b, c], () => 0.99);
    expect(sel?.sourceImageId).toBe("c");
  });

  it("rand 返回边界值 1.0 → 不越界（取最后一张）", () => {
    const a = mkMeta({ id: "a" });
    const b = mkMeta({ id: "b" });
    const sel = pickPromptOverride(true, [a, b], () => 1.0);
    expect(sel?.sourceImageId).toBe("b");
  });

  it("3 张图 + 注入 rand=0.5 → 选第 1 张（floor(0.5*3)=1）", () => {
    const list = [
      mkMeta({ id: "a" }),
      mkMeta({ id: "b" }),
      mkMeta({ id: "c" }),
    ];
    expect(pickPromptOverride(true, list, () => 0.5)?.sourceImageId).toBe("b");
  });
});
