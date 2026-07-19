import { describe, expect, it } from "vitest";
import type { PetModelId } from "../types/pet";
import {
  PetPointerFocusController,
  type PetFocusPoint,
} from "./petPointerFocusController";

function createController(modelId: PetModelId): {
  controller: PetPointerFocusController;
  applied: PetFocusPoint[];
} {
  const applied: PetFocusPoint[] = [];
  return {
    controller: new PetPointerFocusController(modelId, (x, y) => {
      applied.push({ x, y });
    }),
    applied,
  };
}

describe("pet pointer focus controller", () => {
  it.each(["haruhi", "mikuru"] as const)(
    "applies the original %s relative pointer weights",
    (modelId) => {
      const { controller, applied } = createController(modelId);

      expect(controller.handle({ deltaX: 90, deltaY: 60 }, false)).toEqual({
        x: 0.1,
        y: -0.1,
      });
      expect(controller.handle({ deltaX: 45, deltaY: -30 }, false)).toEqual({
        x: 0.15,
        y: -0.05,
      });
      expect(applied).toHaveLength(2);
    },
  );

  it("mirrors Haruhi's horizontal focus without changing accumulated movement", () => {
    const { controller, applied } = createController("haruhi");

    controller.handle({ deltaX: 90, deltaY: 60 }, false);
    expect(controller.applyCurrent(true)).toEqual({ x: -0.1, y: -0.1 });
    expect(controller.applyCurrent(false)).toEqual({ x: 0.1, y: -0.1 });
    expect(applied.at(-1)).toEqual({ x: 0.1, y: -0.1 });
  });

  it("clamps Haruhi and Mikuru on each individual event", () => {
    const { controller } = createController("mikuru");

    expect(controller.handle({ deltaX: 1_000, deltaY: -1_000 }, false)).toEqual({
      x: 1,
      y: 1,
    });
    const point = controller.handle({ deltaX: -10, deltaY: 10 }, false);
    expect(point?.x).toBeCloseTo(356 / 360);
    expect(point?.y).toBeCloseTo(354 / 360);
  });

  it("uses Yuki's original accumulator as a continuous focus vector", () => {
    const { controller } = createController("yuki");

    const point = controller.handle({ deltaX: 100, deltaY: 50 }, false);
    expect(point?.x).toBeCloseTo(2 / 15);
    expect(point?.y).toBeCloseTo(-1 / 15);

    const mirrored = controller.applyCurrent(true);
    expect(mirrored.x).toBeCloseTo(-2 / 15);
    expect(mirrored.y).toBeCloseTo(-1 / 15);
  });

  it("clamps Yuki's accumulated movement to the original limits", () => {
    const { controller } = createController("yuki");

    expect(controller.handle({ deltaX: 1_000, deltaY: -1_000 }, false)).toEqual({
      x: 1,
      y: 1,
    });
    expect(controller.applyCurrent(true)).toEqual({ x: -1, y: 1 });
  });

  it.each(["haruhi", "mikuru", "yuki"] as const)(
    "resets %s to its neutral focus and clears accumulated movement",
    (modelId) => {
      const { controller, applied } = createController(modelId);
      controller.handle({ deltaX: 200, deltaY: 100 }, false);

      const neutral = controller.reset(true);
      expect(neutral).toEqual({ x: 0, y: 0 });
      expect(applied.at(-1)).toEqual(neutral);

      const next = controller.handle({ deltaX: 10, deltaY: 10 }, false);
      if (modelId === "yuki") {
        expect(next?.x).toBeCloseTo(1 / 75);
        expect(next?.y).toBeCloseTo(-1 / 75);
      } else {
        expect(next?.x).toBeCloseTo(4 / 360);
        expect(next?.y).toBeCloseTo(-6 / 360);
      }
    },
  );

  it("ignores non-finite and non-integer deltas without changing state", () => {
    const { controller, applied } = createController("haruhi");

    expect(controller.handle({ deltaX: Number.NaN, deltaY: 0 }, false)).toBeNull();
    expect(controller.handle({ deltaX: 1.5, deltaY: 0 }, false)).toBeNull();
    expect(controller.handle({ deltaX: 0, deltaY: Number.POSITIVE_INFINITY }, false))
      .toBeNull();
    expect(applied).toEqual([]);
    expect(controller.applyCurrent(false)).toEqual({ x: 0, y: 0 });
  });
});
