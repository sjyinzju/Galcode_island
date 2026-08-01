import { describe, expect, it } from "vitest";
import { PET_MODEL_IDS, PET_SEMANTIC_ACTIONS } from "../types/pet";
import { PET_MODEL_DEFINITIONS } from "./modelDefinitions";
import {
  PET_ACTION_MAX_FPS,
  PET_STEADY_MAX_FPS,
  resolvePetMotion,
  resolvePetMotionSteps,
  resolvePetTickerPolicy,
} from "./motionAdapter";

describe("pet model definitions", () => {
  it("defines exactly the three local models", () => {
    expect(Object.keys(PET_MODEL_DEFINITIONS).sort()).toEqual([...PET_MODEL_IDS].sort());
    for (const definition of Object.values(PET_MODEL_DEFINITIONS)) {
      expect(definition.modelUrl).toMatch(/^\/models\/(haruhi|mikuru|yuki)\//);
      expect(definition.modelUrl).not.toMatch(/^https?:/);
      expect(definition.fallbackImageUrl).toMatch(/^\//);
    }
  });

  it("resolves every semantic action to a real motion group or explicit fallback", () => {
    for (const definition of Object.values(PET_MODEL_DEFINITIONS)) {
      const available = new Set(definition.availableMotionGroups);
      for (const action of PET_SEMANTIC_ACTIONS) {
        const resolved = resolvePetMotion(definition, action, 0.75);
        if (resolved.enterGroup) expect(available.has(resolved.enterGroup)).toBe(true);
        if (resolved.loopGroup) expect(available.has(resolved.loopGroup)).toBe(true);
        if (resolved.exitGroup) expect(available.has(resolved.exitGroup)).toBe(true);
        expect(["idle", "accent", "mirror"]).toContain(resolved.fallback);
      }
    }
  });

  it("uses a safe visual fallback when a model has no error motion", () => {
    for (const definition of Object.values(PET_MODEL_DEFINITIONS)) {
      const resolved = resolvePetMotion(definition, "error");
      expect(resolved.enterGroup).toBeNull();
      expect(resolved.fallback).toBe("accent");
    }
  });

  it("selects motion variants deterministically from the supplied sample", () => {
    const definition = PET_MODEL_DEFINITIONS.haruhi;
    expect(resolvePetMotion(definition, "complete", 0).enterGroup).toBe("Smile0");
    expect(resolvePetMotion(definition, "complete", 0.999).enterGroup).toBe("Smile6");
  });

  it("keeps Mikuru enter, steady loop, and exit groups in order", () => {
    const thinking = resolvePetMotion(PET_MODEL_DEFINITIONS.mikuru, "thinking");
    const waiting = resolvePetMotion(PET_MODEL_DEFINITIONS.mikuru, "waiting");
    expect(thinking).toMatchObject({
      enterGroup: "duck-in",
      loopGroup: "duck",
      exitGroup: "duck-out",
    });
    expect(waiting).toMatchObject({
      enterGroup: "casement-in",
      loopGroup: "casement",
      exitGroup: "casement-out",
    });
    expect(resolvePetMotion(PET_MODEL_DEFINITIONS.mikuru, "idle").loopGroup).toBe("default");
    expect(resolvePetMotionSteps(thinking, waiting)).toEqual([
      { phase: "exit", group: "duck-out" },
      { phase: "enter", group: "casement-in" },
      { phase: "loop", group: "casement" },
    ]);
  });

  it("stops the ticker when rendering should be static", () => {
    const base = {
      nativeVisible: true,
      pageVisible: true,
      hasModel: true,
      reducedMotion: false,
      phase: "steady" as const,
    };
    expect(resolvePetTickerPolicy(base)).toEqual({ running: true, maxFPS: PET_STEADY_MAX_FPS });
    expect(resolvePetTickerPolicy({ ...base, phase: "action" })).toEqual({
      running: true,
      maxFPS: PET_ACTION_MAX_FPS,
    });
    expect(resolvePetTickerPolicy({ ...base, nativeVisible: false }).running).toBe(false);
    expect(resolvePetTickerPolicy({ ...base, hasModel: false }).running).toBe(false);
    expect(resolvePetTickerPolicy({ ...base, reducedMotion: true }).running).toBe(false);
  });
});
