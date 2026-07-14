import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridgeMocks = vi.hoisted(() => ({
  invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  listen: vi.fn(async () => () => {}),
}));

vi.mock("./bridge", () => ({
  invoke: bridgeMocks.invoke,
  isTauri: true,
  listen: bridgeMocks.listen,
}));

import { createSharedStorage } from "./sharedStorage";

describe("createSharedStorage write coalescing", () => {
  const values = new Map<string, string>();
  const setItem = vi.fn((key: string, value: string) => values.set(key, value));

  beforeEach(() => {
    vi.useFakeTimers();
    values.clear();
    setItem.mockClear();
    bridgeMocks.invoke.mockReset();
    bridgeMocks.invoke.mockResolvedValue(undefined);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem,
      removeItem: (key: string) => values.delete(key),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("serializes and writes only the latest snapshot in a delay window", async () => {
    const storage = createSharedStorage({ writeDelayMs: 200 });

    storage.setItem("tabs", { state: { value: 1 }, version: 0 });
    storage.setItem("tabs", { state: { value: 2 }, version: 0 });
    storage.setItem("tabs", { state: { value: 3 }, version: 0 });

    expect(setItem).not.toHaveBeenCalled();
    expect(bridgeMocks.invoke).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);

    expect(setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(values.get("tabs") ?? "{}")).toMatchObject({
      state: { value: 3 },
    });
    expect(bridgeMocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("keeps one remote write in flight and drops superseded snapshots", async () => {
    let finishFirst!: () => void;
    bridgeMocks.invoke
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        finishFirst = resolve;
      }))
      .mockResolvedValue(undefined);
    const storage = createSharedStorage();

    storage.setItem("tabs", { state: { value: 1 }, version: 0 });
    storage.setItem("tabs", { state: { value: 2 }, version: 0 });
    storage.setItem("tabs", { state: { value: 3 }, version: 0 });

    expect(bridgeMocks.invoke).toHaveBeenCalledTimes(1);
    finishFirst();
    await Promise.resolve();
    await Promise.resolve();

    expect(bridgeMocks.invoke).toHaveBeenCalledTimes(2);
    const latestArgs = bridgeMocks.invoke.mock.calls[1]?.[1] as { value: string };
    expect(JSON.parse(latestArgs.value)).toMatchObject({ state: { value: 3 } });
  });
});
