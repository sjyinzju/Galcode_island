import { describe, expect, it } from "vitest";
import { isNearBottom } from "./scrollUtils";

describe("isNearBottom", () => {
  it("scrollTop=0 / 内容比容器大很多 → 远离底部 → false", () => {
    expect(isNearBottom(1000, 0, 400)).toBe(false);
  });
  it("scrollTop 完全到底 → distance=0 → true", () => {
    expect(isNearBottom(1000, 600, 400)).toBe(true);
  });
  it("距离底部恰好 = 阈值 → 不算贴底（< 而不是 <=）", () => {
    // distance = 32，默认阈值 32，按 < 判定 → false
    expect(isNearBottom(1000, 568, 400, 32)).toBe(false);
  });
  it("距离底部 = 阈值 - 1 → 算贴底", () => {
    // distance = 31 < 32 → true
    expect(isNearBottom(1000, 569, 400, 32)).toBe(true);
  });
  it("自定义阈值生效", () => {
    // distance = 100, threshold = 150 → true
    expect(isNearBottom(1000, 500, 400, 150)).toBe(true);
    // distance = 100, threshold = 50 → false
    expect(isNearBottom(1000, 500, 400, 50)).toBe(false);
  });
  it("内容比容器小（scrollHeight ≤ clientHeight）→ distance ≤ 0 → 一直算贴底", () => {
    // 短内容时容器不需要滚动；这种情况应该一直算"在底部"，让 auto-scroll 生效
    expect(isNearBottom(200, 0, 400)).toBe(true);
    expect(isNearBottom(400, 0, 400)).toBe(true);
  });
  it("scrollTop 超出 scrollHeight（极端边界）→ distance 为负 → 算贴底", () => {
    // 浏览器在 bounce / overscroll 时可能给出超出值；按贴底处理，避免误判离开
    expect(isNearBottom(1000, 700, 400)).toBe(true);
  });
});
