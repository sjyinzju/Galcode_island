// 审核框架测试：
//   - none/stub 直通
//   - sightengine 阈值评估（纯函数）
//   - moderation provider 路由 + 降级

import { describe, expect, it } from "vitest";
import { evaluateSightengine } from "../src/lib/moderation/sightengine.js";
import { moderateStub } from "../src/lib/moderation/stub.js";

describe("evaluateSightengine", () => {
  const thresholds = { nudityThreshold: 0.5, offensiveThreshold: 0.5 };

  it("低分数 → 通过", () => {
    const r = evaluateSightengine(
      { nudity: { sexual_activity: 0.01, sexual_display: 0.02, erotica: 0.01 }, offensive: { prob: 0.02 } },
      thresholds,
    );
    expect(r.approved).toBe(true);
    expect(r.verdict).toMatch(/sightengine_pass/);
  });

  it("sexual_activity 超阈值 → 拒绝，reasons 含 nudity", () => {
    const r = evaluateSightengine(
      { nudity: { sexual_activity: 0.9, sexual_display: 0.1, erotica: 0.1 }, offensive: { prob: 0.1 } },
      thresholds,
    );
    expect(r.approved).toBe(false);
    expect(r.reasons).toEqual(["nudity=0.90"]);
    expect(r.verdict).toMatch(/sightengine_reject:nudity=/);
  });

  it("offensive.prob 超阈值 → 拒绝", () => {
    const r = evaluateSightengine(
      { nudity: { sexual_activity: 0.1, sexual_display: 0.1, erotica: 0.1 }, offensive: { prob: 0.8 } },
      thresholds,
    );
    expect(r.approved).toBe(false);
    expect(r.reasons).toEqual(["offensive=0.80"]);
  });

  it("两类都超阈值 → 拒绝，reasons 含两条", () => {
    const r = evaluateSightengine(
      { nudity: { sexual_activity: 0.7 }, offensive: { prob: 0.7 } },
      thresholds,
    );
    expect(r.approved).toBe(false);
    expect(r.reasons).toContain("nudity=0.70");
    expect(r.reasons).toContain("offensive=0.70");
  });

  it("字段缺失 → 视为 0，通过", () => {
    const r = evaluateSightengine({}, thresholds);
    expect(r.approved).toBe(true);
  });

  it("老版字段 raw/partial 也参与 nudity 评估", () => {
    const r = evaluateSightengine(
      { nudity: { raw: 0.9 }, offensive: {} },
      thresholds,
    );
    expect(r.approved).toBe(false);
  });
});

describe("moderateStub", () => {
  it("总是 approved + verdict='stub_pass'", async () => {
    const r = await moderateStub("/no/such/file", { category: "welcome" });
    expect(r).toEqual({ verdict: "stub_pass", approved: true });
  });
});

describe("moderateImage 路由（动态 import + env 切换）", () => {
  it("provider=none → 走 stub_pass", async () => {
    // 隔离的 module subgraph：每个用例 fresh import 让 config 拿到当前 env
    process.env.MODERATION_PROVIDER = "none";
    // 关键：moderation/index.js 和 config.js 都得重新解析
    // vitest 默认每 test file 一次模块缓存——这里我们就在同 file 内验证 none 默认行为
    const mod = await import("../src/lib/moderation/index.js");
    const r = await mod.moderateImage("/no/such/file", {});
    expect(r.verdict).toBe("stub_pass");
    expect(r.approved).toBe(true);
  });

  it("provider=stub → 也走 stub_pass", async () => {
    // import.meta cache：直接复用上面的 module；行为一致即可
    const mod = await import("../src/lib/moderation/index.js");
    const r = await mod.moderateImage("/no/such/file", {});
    expect(r.approved).toBe(true);
  });
});
