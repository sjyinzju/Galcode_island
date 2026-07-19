import { describe, expect, it } from "vitest";
import {
  PET_POKE_COOLDOWN_MS,
  PokeRequestGate,
  classifyPetPointerGesture,
  nextPetScale,
  shouldStartPetDrag,
} from "./interactionPolicy";
import { PET_SCALE_MAX, PET_SCALE_MIN } from "./protocol";

describe("pet interaction policy", () => {
  it("keeps a small movement as poke and starts native drag at the threshold", () => {
    const start = { x: 10, y: 10 };
    expect(shouldStartPetDrag(start, { x: 13, y: 13 })).toBe(false);
    expect(shouldStartPetDrag(start, { x: 15, y: 10 })).toBe(true);
    expect(classifyPetPointerGesture(start, { x: 11, y: 11 }, false)).toBe("poke");
  });

  it("never reports poke after a native drag started", () => {
    expect(classifyPetPointerGesture({ x: 0, y: 0 }, { x: 0, y: 0 }, true)).toBe("drag");
  });

  it("clamps wheel scaling to the supported range", () => {
    expect(nextPetScale(PET_SCALE_MAX, -100)).toBe(PET_SCALE_MAX);
    expect(nextPetScale(PET_SCALE_MIN, 100)).toBe(PET_SCALE_MIN);
    expect(nextPetScale(1, -100)).toBe(1.1);
    expect(nextPetScale(1, 100)).toBe(0.9);
  });

  it("enforces poke cooldown and rejects stale async results", () => {
    const gate = new PokeRequestGate();
    const first = gate.begin(1_000);
    expect(first).toBe(1);
    expect(gate.begin(1_000 + PET_POKE_COOLDOWN_MS - 1)).toBeNull();

    const second = gate.begin(1_000 + PET_POKE_COOLDOWN_MS);
    expect(second).toBe(2);
    expect(gate.isCurrent(first!)).toBe(false);
    expect(gate.isCurrent(second!)).toBe(true);
  });
});
