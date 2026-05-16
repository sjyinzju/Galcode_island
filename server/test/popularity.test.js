import { describe, expect, it } from "vitest";
import {
  DAILY_LIKE_LIMIT,
  LIKE_WEIGHT,
  computeAlbumPopularity,
  computeImagePopularity,
  utcDateStr,
} from "../src/lib/popularity.js";

describe("computeImagePopularity", () => {
  it("基本：use_count + 3*likes", () => {
    expect(computeImagePopularity(10, 0)).toBe(10);
    expect(computeImagePopularity(0, 5)).toBe(15);
    expect(computeImagePopularity(7, 2)).toBe(7 + 6);
  });

  it("权重常量是 3（双向 sanity）", () => {
    expect(LIKE_WEIGHT).toBe(3);
    expect(computeImagePopularity(0, 1)).toBe(3);
  });

  it("负数 / NaN / null 防御 → 0", () => {
    expect(computeImagePopularity(-1, -5)).toBe(0);
    expect(computeImagePopularity(NaN, 3)).toBe(9);
    expect(computeImagePopularity(null, undefined)).toBe(0);
  });

  it("浮点数 floor", () => {
    expect(computeImagePopularity(3.7, 1.9)).toBe(3 + 3);
  });
});

describe("computeAlbumPopularity", () => {
  it("3 * likes", () => {
    expect(computeAlbumPopularity(0)).toBe(0);
    expect(computeAlbumPopularity(4)).toBe(12);
  });
  it("负数防御 → 0", () => {
    expect(computeAlbumPopularity(-3)).toBe(0);
  });
});

describe("utcDateStr", () => {
  it("UTC 日期 → YYYY-MM-DD 形式", () => {
    expect(utcDateStr(new Date("2026-05-16T08:30:00Z"))).toBe("2026-05-16");
    expect(utcDateStr(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-31");
  });
  it("跨日（UTC）切换", () => {
    expect(utcDateStr(new Date("2026-05-16T23:59:59Z"))).toBe("2026-05-16");
    expect(utcDateStr(new Date("2026-05-17T00:00:01Z"))).toBe("2026-05-17");
  });
  it("默认 = now（格式合法）", () => {
    expect(utcDateStr()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("DAILY_LIKE_LIMIT", () => {
  it("值是 10（防止改动时跑偏）", () => {
    expect(DAILY_LIKE_LIMIT).toBe(10);
  });
});
