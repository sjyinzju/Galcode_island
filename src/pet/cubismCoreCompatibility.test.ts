import { describe, expect, it, vi } from "vitest";

import { applyCubismCoreCompatibility } from "./cubismCoreCompatibility";

interface TestDrawables {
  count?: unknown;
  renderOrders?: unknown;
}

interface TestModel {
  drawables?: TestDrawables;
  offscreens?: { count?: unknown };
  getRenderOrders?: () => unknown;
}

function expectNoRenderOrders(model: TestModel): void {
  expect(model.drawables).not.toHaveProperty("renderOrders");
}

describe("Cubism Core compatibility", () => {
  it("aliases the R5 combined render orders without copying them", () => {
    const renderOrders = new Int32Array([1, 0]);
    const model: TestModel = {
      drawables: { count: 2 },
      offscreens: { count: 0 },
    };
    const getRenderOrders = vi.fn(function (this: unknown) {
      expect(this).toBe(model);
      return renderOrders;
    });
    model.getRenderOrders = getRenderOrders;

    applyCubismCoreCompatibility(model);

    expect(getRenderOrders).toHaveBeenCalledOnce();
    expect(model.drawables?.renderOrders).toBe(renderOrders);
  });

  it("is idempotent for an already adapted R5 model", () => {
    const renderOrders = new Int32Array([0]);
    const getRenderOrders = vi.fn(() => renderOrders);
    const model: TestModel = {
      drawables: { count: 1 },
      offscreens: { count: 0 },
      getRenderOrders,
    };

    applyCubismCoreCompatibility(model);
    applyCubismCoreCompatibility(model);

    expect(getRenderOrders).toHaveBeenCalledTimes(2);
    expect(model.drawables?.renderOrders).toBe(renderOrders);
  });

  it("leaves a legacy Core render-order array unchanged", () => {
    const renderOrders = new Int32Array([0]);
    const model: TestModel = { drawables: { count: 1, renderOrders } };

    applyCubismCoreCompatibility(model);

    expect(model.drawables?.renderOrders).toBe(renderOrders);
  });

  it("rejects a legacy render-order array with the wrong length", () => {
    const renderOrders = new Int32Array([0]);
    const model: TestModel = {
      drawables: { count: 2, renderOrders },
    };

    expect(() => applyCubismCoreCompatibility(model)).toThrow(
      "Invalid legacy Cubism Core render-order layout: expected 2 drawable orders, got 1",
    );
    expect(model.drawables?.renderOrders).toBe(renderOrders);
  });

  it("rejects an existing R5 alias when offscreen objects are present", () => {
    const renderOrders = new Int32Array([0, 1]);
    const model: TestModel = {
      drawables: { count: 1, renderOrders },
      offscreens: { count: 1 },
      getRenderOrders: () => renderOrders,
    };

    expect(() => applyCubismCoreCompatibility(model)).toThrow(
      "Unsupported Cubism Core render-order layout: offscreen objects require a matching Cubism Framework",
    );
  });

  it("rejects an existing R5 alias that is not the live Core array", () => {
    const existingRenderOrders = new Int32Array([0]);
    const liveRenderOrders = new Int32Array([0]);
    const model: TestModel = {
      drawables: { count: 1, renderOrders: existingRenderOrders },
      offscreens: { count: 0 },
      getRenderOrders: () => liveRenderOrders,
    };

    expect(() => applyCubismCoreCompatibility(model)).toThrow(
      "Invalid Cubism Core render-order alias: expected the live combined order array",
    );
    expect(model.drawables?.renderOrders).toBe(existingRenderOrders);
  });

  it("rejects an invalid legacy render-order field", () => {
    const model: TestModel = {
      drawables: { count: 1, renderOrders: new Uint32Array([0]) },
    };

    expect(() => applyCubismCoreCompatibility(model)).toThrow(
      "Invalid Cubism Core render-order type",
    );
  });

  it("rejects offscreen objects after validating the combined order list", () => {
    const model: TestModel = {
      drawables: { count: 1 },
      offscreens: { count: 1 },
      getRenderOrders: vi.fn(() => new Int32Array([0, 1])),
    };

    expect(() => applyCubismCoreCompatibility(model)).toThrow(
      "offscreen objects",
    );
    expectNoRenderOrders(model);
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", Number.NaN],
    ["unsafe", Number.MAX_SAFE_INTEGER + 1],
    ["missing", undefined],
  ])("rejects a %s drawable count without mutation", (_name, count) => {
    const model: TestModel = {
      drawables: { count },
      offscreens: { count: 0 },
      getRenderOrders: vi.fn(() => new Int32Array()),
    };

    expect(() => applyCubismCoreCompatibility(model)).toThrow(
      "Invalid Cubism Core drawable count",
    );
    expectNoRenderOrders(model);
  });

  it.each([
    ["negative", -1],
    ["fractional", 0.5],
    ["missing", undefined],
  ])("rejects a %s offscreen count without mutation", (_name, count) => {
    const model: TestModel = {
      drawables: { count: 1 },
      offscreens: { count },
      getRenderOrders: vi.fn(() => new Int32Array([0])),
    };

    expect(() => applyCubismCoreCompatibility(model)).toThrow(
      "Invalid Cubism Core offscreen count",
    );
    expectNoRenderOrders(model);
  });

  it.each([
    ["too short", new Int32Array([0])],
    ["too long", new Int32Array([0, 1, 2])],
    ["wrong type", new Uint32Array([0, 1])],
  ])("rejects %s render orders without mutation", (_name, orders) => {
    const model: TestModel = {
      drawables: { count: 2 },
      offscreens: { count: 0 },
      getRenderOrders: vi.fn(() => orders),
    };

    expect(() => applyCubismCoreCompatibility(model)).toThrow(/render-order/);
    expectNoRenderOrders(model);
  });

  it.each([
    ["model", null],
    ["drawables", { offscreens: { count: 0 } }],
    [
      "getter",
      { drawables: { count: 0 }, offscreens: { count: 0 } },
    ],
  ])("rejects a missing %s API without mutation", (_name, model) => {
    expect(() => applyCubismCoreCompatibility(model)).toThrow(/unavailable/);
    if (model && "drawables" in model && model.drawables) {
      expectNoRenderOrders(model);
    }
  });
});
