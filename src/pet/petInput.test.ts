import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PetInputEvent,
  PetInputKey,
  PetModelId,
} from "../types/pet";
import { PetInputTracker } from "./petInput";
import {
  PetInputParameterController,
  type PetParameterWriter,
} from "./petInputParameterController";

function createWriter(): {
  writer: PetParameterWriter;
  writes: Array<readonly [string, number]>;
  latest: (parameterId: string) => number | undefined;
} {
  const writes: Array<readonly [string, number]> = [];
  return {
    writer: {
      setParameterValueById(parameterId, value) {
        writes.push([parameterId, value]);
      },
    },
    writes,
    latest(parameterId) {
      return [...writes].reverse().find(([id]) => id === parameterId)?.[1];
    },
  };
}

describe("pet input tracker", () => {
  it("normalizes physical keys and suppresses repeats", () => {
    const tracker = new PetInputTracker();
    expect(tracker.keyDown("KeyQ")).toEqual({ type: "key-down", key: "Q" });
    expect(tracker.keyDown("KeyQ", true)).toBeNull();
    expect(tracker.keyDown("KeyQ")).toBeNull();
    expect(tracker.keyUp("KeyQ")).toEqual({ type: "key-up", key: "Q" });
    expect(tracker.keyUp("KeyQ")).toBeNull();
    expect(tracker.keyDown("Escape")).toBeNull();
  });

  it("reference-counts left and right modifier keys", () => {
    const tracker = new PetInputTracker();
    expect(tracker.keyDown("ShiftLeft")).toEqual({ type: "key-down", key: "Shift" });
    expect(tracker.keyDown("ShiftRight")).toBeNull();
    expect(tracker.keyUp("ShiftLeft")).toBeNull();
    expect(tracker.keyUp("ShiftRight")).toEqual({ type: "key-up", key: "Shift" });
  });

  it("maps middle click to primary while preserving button counts", () => {
    const tracker = new PetInputTracker();
    expect(tracker.pointerDown(0, "mouse")).toEqual({ type: "mouse-down", button: 0 });
    expect(tracker.pointerDown(1, "mouse")).toBeNull();
    expect(tracker.pointerUp(0, "mouse")).toBeNull();
    expect(tracker.pointerUp(1, "mouse")).toEqual({ type: "mouse-up", button: 0 });
    expect(tracker.pointerDown(2, "touch")).toBeNull();
    expect(tracker.pointerDown(2, "mouse")).toEqual({ type: "mouse-down", button: 2 });
    expect(tracker.releaseMouse()).toEqual([{ type: "mouse-up", button: 2 }]);
  });

  it("clears tracked state on reset", () => {
    const tracker = new PetInputTracker();
    tracker.keyDown("ControlLeft");
    tracker.pointerDown(0, "mouse");
    expect(tracker.reset()).toEqual({ type: "reset" });
    expect(tracker.keyUp("ControlLeft")).toBeNull();
    expect(tracker.pointerUp(0, "mouse")).toBeNull();
  });
});

describe("pet input parameter controller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const keyCases = [
    ["haruhi", "1", 12, 17], ["haruhi", "2", 6, 14], ["haruhi", "3", -3, 18],
    ["haruhi", "4", -26, 26], ["haruhi", "Q", 20, -2], ["haruhi", "W", 15, -1],
    ["haruhi", "E", 8, -2], ["haruhi", "R", 1, 0], ["haruhi", "T", -21, 8],
    ["haruhi", "A", 23, -18], ["haruhi", "S", 9, -17], ["haruhi", "D", 1, -14],
    ["haruhi", "F", -10, -10], ["haruhi", "Z", 17, -30], ["haruhi", "X", 8, -30],
    ["haruhi", "C", -2, -27], ["haruhi", "V", -15, -30], ["haruhi", "Tab", 27, 27],
    ["haruhi", "Shift", 30, -5], ["haruhi", "Ctrl", 30, -24],
    ["haruhi", "Enter", -30, 1], ["haruhi", "Space", -30, -28],
    ["mikuru", "1", 14, 30], ["mikuru", "2", 6, 30], ["mikuru", "3", -5.5, 30],
    ["mikuru", "4", -16.5, 21.3], ["mikuru", "5", -26.7, 17],
    ["mikuru", "Q", 15.5, 0], ["mikuru", "W", 7, 2.2], ["mikuru", "E", -2.2, 4.8],
    ["mikuru", "R", -13, -1], ["mikuru", "T", -23, -1], ["mikuru", "A", 17, -14],
    ["mikuru", "S", 8, -14], ["mikuru", "D", -2, -12], ["mikuru", "F", -15, -15],
    ["mikuru", "Z", 24, -30], ["mikuru", "X", 10, -30], ["mikuru", "C", -2, -26],
    ["mikuru", "V", -13, -30], ["mikuru", "Tab", 26, 20],
    ["mikuru", "Shift", 26, -1], ["mikuru", "Ctrl", 30, -17],
    ["mikuru", "Enter", -30, -18], ["mikuru", "Space", -30, -28],
    ["yuki", "W", -9, 30], ["yuki", "A", 2, 8], ["yuki", "S", -16, 6],
    ["yuki", "D", -30, 4], ["yuki", "Z", 18, 2], ["yuki", "Ctrl", 30, -4],
    ["yuki", "Enter", 30, 24], ["yuki", "Space", -28, -28],
  ] as const satisfies readonly (readonly [PetModelId, PetInputKey, number, number])[];

  it.each(keyCases)("maps %s %s to the original key position", (modelId, key, x, y) => {
    const { writer, latest } = createWriter();
    const controller = new PetInputParameterController(modelId, writer);
    controller.handle("main", { type: "key-down", key });
    expect(latest("ParamKeyboardX")).toBe(x - 2);
    expect(latest("ParamKeyboardY")).toBe(y - 4);
    vi.advanceTimersByTime(50);
    expect(latest("ParamKeyboardX")).toBe(x);
    expect(latest("ParamKeyboardY")).toBe(y);
    expect(latest(`ParamKey${key}`)).toBe(1);
    controller.dispose();
  });

  it("reproduces the original Haruhi key travel and release", () => {
    const { writer, writes, latest } = createWriter();
    const controller = new PetInputParameterController("haruhi", writer);

    controller.handle("main", { type: "key-down", key: "Q" });
    expect(latest("ParamKeyboardX")).toBe(18);
    expect(latest("ParamKeyboardY")).toBe(-6);
    expect(latest("ParamKeyQ")).toBeUndefined();

    vi.advanceTimersByTime(49);
    expect(latest("ParamKeyQ")).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(latest("ParamKeyboardX")).toBe(20);
    expect(latest("ParamKeyboardY")).toBe(-2);
    expect(latest("ParamKeyQ")).toBe(1);

    writes.length = 0;
    controller.flush();
    expect(writes).toEqual(expect.arrayContaining([
      ["ParamKeyboardX", 20],
      ["ParamKeyboardY", -2],
      ["ParamKeyQ", 1],
    ]));

    controller.handle("main", { type: "key-up", key: "Q" });
    expect(latest("ParamKeyQ")).toBe(0);
    expect(latest("ParamKeyboardX")).toBe(18);
    expect(latest("ParamKeyboardY")).toBe(-6);
  });

  it("cancels a delayed press when the key is released early", () => {
    const { writer, latest } = createWriter();
    const controller = new PetInputParameterController("mikuru", writer);
    controller.handle("main", { type: "key-down", key: "5" });
    controller.handle("main", { type: "key-up", key: "5" });
    vi.advanceTimersByTime(100);
    expect(latest("ParamKey5")).toBe(0);
    expect(latest("ParamKeyboardX")).toBe(-28.7);
    expect(latest("ParamKeyboardY")).toBe(13);
  });

  it("uses Yuki's restricted map and resets unsupported keys to the neutral cursor", () => {
    const { writer, latest } = createWriter();
    const controller = new PetInputParameterController("yuki", writer);
    controller.handle("main", { type: "key-down", key: "W" });
    expect(latest("ParamKeyboardX")).toBe(-11);
    expect(latest("ParamKeyboardY")).toBe(26);
    vi.advanceTimersByTime(50);
    expect(latest("ParamKeyW")).toBe(1);
    expect(latest("ParamKeyboardX")).toBe(-9);
    expect(latest("ParamKeyboardY")).toBe(30);
    controller.handle("main", { type: "key-down", key: "Q" });
    expect(latest("ParamKeyboardX")).toBe(0);
    expect(latest("ParamKeyboardY")).toBe(0);
    expect(latest("ParamKeyQ")).toBeUndefined();
  });

  it("keeps a parameter pressed until both input sources release it", () => {
    const { writer, latest } = createWriter();
    const controller = new PetInputParameterController("haruhi", writer);
    const down: PetInputEvent = { type: "mouse-down", button: 0 };
    controller.handle("main", down);
    controller.handle("pet", down);
    expect(latest("ParamMouse0")).toBe(1);
    controller.handle("main", { type: "reset" });
    expect(latest("ParamMouse0")).toBe(1);
    controller.handle("pet", { type: "mouse-up", button: 0 });
    expect(latest("ParamMouse0")).toBe(0);
  });

  it("keeps global state when a focused WebView resets its local source", () => {
    const { writer, latest } = createWriter();
    const controller = new PetInputParameterController("haruhi", writer);
    controller.handle("main", { type: "key-down", key: "Q" });
    controller.handle("global", { type: "key-down", key: "Q" });
    vi.advanceTimersByTime(50);
    expect(latest("ParamKeyQ")).toBe(1);
    controller.handle("main", { type: "reset" });
    expect(latest("ParamKeyQ")).toBe(1);
    controller.handle("global", { type: "key-up", key: "Q" });
    expect(latest("ParamKeyQ")).toBe(0);
  });

  it("holds pressed values but writes released values for only one model frame", () => {
    const { writer, writes } = createWriter();
    const controller = new PetInputParameterController("haruhi", writer);
    controller.handle("main", { type: "mouse-down", button: 2 });
    writes.length = 0;
    controller.flush();
    expect(writes).toContainEqual(["ParamMouse2", 1]);

    controller.handle("main", { type: "mouse-up", button: 2 });
    writes.length = 0;
    controller.flush();
    expect(writes).toEqual([["ParamMouse2", 0]]);
    writes.length = 0;
    controller.flush();
    expect(writes).toEqual([]);
  });

  it("reset and dispose cancel timers and clear every interactive parameter", () => {
    const { writer, writes, latest } = createWriter();
    const controller = new PetInputParameterController("haruhi", writer);
    controller.handle("main", { type: "key-down", key: "A" });
    controller.handle("main", { type: "mouse-down", button: 2 });
    controller.resetAll();
    const writesAfterReset = writes.length;
    vi.advanceTimersByTime(100);
    expect(writes).toHaveLength(writesAfterReset);
    expect(latest("ParamKeyA")).toBe(0);
    expect(latest("ParamMouse0")).toBe(0);
    expect(latest("ParamMouse2")).toBe(0);
    expect(latest("ParamKeyboardX")).toBe(0);
    expect(latest("ParamKeyboardY")).toBe(0);
    controller.dispose();
  });
});
