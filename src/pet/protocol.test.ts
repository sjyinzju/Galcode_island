import { describe, expect, it } from "vitest";
import { DEFAULT_DESKTOP_PET_SETTINGS } from "../types/pet";
import {
  PET_SCALE_MAX,
  PET_SCALE_MIN,
  PetSnapshotReceiver,
  clampPetScale,
  normalizeDesktopPetSettings,
  parsePetAction,
  parsePetBridgeEvent,
  parsePetInputEvent,
  parsePetSettingsSnapshot,
  parsePetSnapshot,
} from "./protocol";

const validSnapshot = {
  version: 1,
  seq: 1,
  modelId: "haruhi",
  visualState: "working",
  activeTaskId: "task-1",
  activeTaskTitle: "Task",
  runningCount: 1,
  speech: "Working",
  reducedMotion: false,
} as const;

describe("pet protocol", () => {
  it("accepts a valid, bounded snapshot", () => {
    expect(parsePetSnapshot(validSnapshot)).toEqual(validSnapshot);
  });

  it("rejects invalid model, task id and oversized speech", () => {
    expect(parsePetSnapshot({ ...validSnapshot, modelId: "remote" })).toBeNull();
    expect(parsePetSnapshot({ ...validSnapshot, activeTaskId: "../secret" })).toBeNull();
    expect(parsePetSnapshot({ ...validSnapshot, speech: "x".repeat(161) })).toBeNull();
  });

  it("drops duplicate and out-of-order snapshots", () => {
    const receiver = new PetSnapshotReceiver();
    expect(receiver.accept({ ...validSnapshot, seq: 3 })?.seq).toBe(3);
    expect(receiver.accept({ ...validSnapshot, seq: 3 })).toBeNull();
    expect(receiver.accept({ ...validSnapshot, seq: 2 })).toBeNull();
    expect(receiver.accept({ ...validSnapshot, seq: 4 })?.seq).toBe(4);
  });

  it("accepts a new sequence after a bridge reset", () => {
    const receiver = new PetSnapshotReceiver();
    expect(receiver.accept({ ...validSnapshot, seq: 8 })?.seq).toBe(8);
    receiver.reset();
    expect(receiver.getLatestSeq()).toBe(0);
    expect(receiver.accept(validSnapshot)?.seq).toBe(1);
  });

  it("normalizes old or corrupt persisted desktop-pet settings", () => {
    expect(normalizeDesktopPetSettings(null)).toEqual(DEFAULT_DESKTOP_PET_SETTINGS);
    expect(normalizeDesktopPetSettings({ modelId: "bad", scale: 99, enabled: true })).toEqual({
      ...DEFAULT_DESKTOP_PET_SETTINGS,
      enabled: true,
      scale: PET_SCALE_MAX,
    });
    expect(clampPetScale(-1)).toBe(PET_SCALE_MIN);
  });

  it("validates settings revisions without silently repairing event payloads", () => {
    const settings = { version: 1, revision: 2, ...DEFAULT_DESKTOP_PET_SETTINGS };
    expect(parsePetSettingsSnapshot(settings)).toEqual(settings);
    expect(parsePetSettingsSnapshot({ ...settings, scale: 99 })).toBeNull();
  });

  it("whitelists pet actions and their payloads", () => {
    expect(parsePetAction({ type: "open-task", taskId: "task-1" })).toEqual({
      type: "open-task",
      taskId: "task-1",
    });
    expect(parsePetAction({ type: "set-model", modelId: "mikuru" })).toEqual({
      type: "set-model",
      modelId: "mikuru",
    });
    expect(parsePetAction({ type: "set-enabled", enabled: true })).toEqual({
      type: "set-enabled",
      enabled: true,
    });
    expect(parsePetAction({ type: "set-enabled", enabled: "yes" })).toBeNull();
    expect(parsePetAction({ type: "start-agent" })).toBeNull();
    expect(parsePetAction({ type: "set-scale", scale: 50 })).toBeNull();
  });

  it("parses reset, settings, snapshot and visibility bridge events", () => {
    const settings = { version: 1, revision: 2, ...DEFAULT_DESKTOP_PET_SETTINGS } as const;
    expect(parsePetBridgeEvent({ type: "reset" })).toEqual({ type: "reset" });
    expect(parsePetBridgeEvent({ type: "settings", payload: settings })).toEqual({
      type: "settings",
      payload: settings,
    });
    expect(parsePetBridgeEvent({ type: "snapshot", payload: validSnapshot })).toEqual({
      type: "snapshot",
      payload: validSnapshot,
    });
    expect(parsePetBridgeEvent({ type: "visibility", payload: false })).toEqual({
      type: "visibility",
      payload: false,
    });
    expect(parsePetBridgeEvent({
      type: "input",
      payload: { source: "global", event: { type: "key-down", key: "W" } },
    })).toEqual({
      type: "input",
      payload: { source: "global", event: { type: "key-down", key: "W" } },
    });
  });

  it("accepts only narrow, whitelisted input payloads", () => {
    expect(parsePetInputEvent({ type: "mouse-down", button: 0 })).toEqual({
      type: "mouse-down",
      button: 0,
    });
    expect(parsePetInputEvent({ type: "mouse-move", deltaX: -24, deltaY: 9 })).toEqual({
      type: "mouse-move",
      deltaX: -24,
      deltaY: 9,
    });
    expect(parsePetInputEvent({ type: "reset" })).toEqual({ type: "reset" });
    expect(parsePetInputEvent({ type: "key-down", key: "Escape" })).toBeNull();
    expect(parsePetInputEvent({ type: "mouse-down", button: 1 })).toBeNull();
    expect(parsePetInputEvent({ type: "key-down", key: "W", text: "secret" })).toBeNull();
    expect(parsePetInputEvent({ type: "mouse-move", deltaX: 0.5, deltaY: 1 })).toBeNull();
    expect(parsePetInputEvent({ type: "mouse-move", deltaX: Number.NaN, deltaY: 1 })).toBeNull();
    expect(parsePetInputEvent({ type: "mouse-move", deltaX: 2_147_483_648, deltaY: 1 })).toBeNull();
    expect(parsePetInputEvent({ type: "reset", x: 1 })).toBeNull();
  });

  it("rejects malformed bridge envelopes and payloads", () => {
    expect(parsePetBridgeEvent(null)).toBeNull();
    expect(parsePetBridgeEvent({ type: "reset", payload: null })).toBeNull();
    expect(parsePetBridgeEvent({ type: "visibility", payload: "visible" })).toBeNull();
    expect(parsePetBridgeEvent({ type: "snapshot", payload: { ...validSnapshot, seq: 0 } })).toBeNull();
    expect(parsePetBridgeEvent({ type: "settings", payload: {} })).toBeNull();
    expect(parsePetBridgeEvent({
      type: "input",
      payload: { source: "pet", event: { type: "key-down", key: "W" } },
    })).toBeNull();
    expect(parsePetBridgeEvent({
      type: "input",
      payload: { source: "global", event: { type: "reset" }, text: "secret" },
    })).toBeNull();
    expect(parsePetBridgeEvent({ type: "remote-script", payload: "https://example.com" })).toBeNull();
  });
});
