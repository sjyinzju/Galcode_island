import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridgeMocks = vi.hoisted(() => {
  const listeners = new Map<
    string,
    (event: { payload: Record<string, string> }) => void
  >();
  return {
    invoke: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    listen: vi.fn(async (
      event: string,
      handler: (event: { payload: Record<string, string> }) => void,
    ) => {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    }),
    listeners,
  };
});

vi.mock("./bridge", () => ({
  invoke: bridgeMocks.invoke,
  isTauri: true,
  listen: bridgeMocks.listen,
}));

import { createSharedStorage } from "./sharedStorage";

function emitStorageChanged(key: string, value: string): void {
  const listener = bridgeMocks.listeners.get("storage://changed");
  expect(listener).toBeDefined();
  listener?.({ payload: { key, value, source: "remote-client" } });
}

function emitStorageRemoved(key: string): void {
  const listener = bridgeMocks.listeners.get("storage://removed");
  expect(listener).toBeDefined();
  listener?.({ payload: { key, source: "remote-client" } });
}

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

  it("cancels a delayed local snapshot when a remote value arrives", async () => {
    const storage = createSharedStorage({ writeDelayMs: 200 });
    const remoteRaw = JSON.stringify({ state: { value: 2 }, version: 0 });

    storage.setItem("tabs", { state: { value: 1 }, version: 0 });
    emitStorageChanged("tabs", remoteRaw);

    await vi.advanceTimersByTimeAsync(200);

    expect(values.get("tabs")).toBe(remoteRaw);
    expect(bridgeMocks.invoke).not.toHaveBeenCalled();
  });

  it("cancels a delayed local snapshot when the remote value is removed", async () => {
    const storage = createSharedStorage({ writeDelayMs: 200 });

    storage.setItem("tabs", { state: { value: 1 }, version: 0 });
    emitStorageRemoved("tabs");

    await vi.advanceTimersByTimeAsync(200);

    expect(values.has("tabs")).toBe(false);
    expect(bridgeMocks.invoke).not.toHaveBeenCalled();
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

  it("reasserts a remote value after an older local write already in flight", async () => {
    let finishFirst!: () => void;
    bridgeMocks.invoke
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        finishFirst = resolve;
      }))
      .mockResolvedValue(undefined);
    const storage = createSharedStorage();
    const remoteRaw = JSON.stringify({ state: { value: 3 }, version: 0 });

    storage.setItem("tabs", { state: { value: 1 }, version: 0 });
    storage.setItem("tabs", { state: { value: 2 }, version: 0 });
    emitStorageChanged("tabs", remoteRaw);

    finishFirst();
    await Promise.resolve();
    await Promise.resolve();

    expect(values.get("tabs")).toBe(remoteRaw);
    expect(bridgeMocks.invoke).toHaveBeenCalledTimes(2);
    const latestArgs = bridgeMocks.invoke.mock.calls[1]?.[1] as { value: string };
    expect(latestArgs.value).toBe(remoteRaw);
  });

  it("reasserts a remote removal after an older local write already in flight", async () => {
    let finishFirst!: () => void;
    bridgeMocks.invoke
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        finishFirst = resolve;
      }))
      .mockResolvedValue(undefined);
    const storage = createSharedStorage();

    storage.setItem("tabs", { state: { value: 1 }, version: 0 });
    emitStorageRemoved("tabs");

    finishFirst();
    await Promise.resolve();
    await Promise.resolve();

    expect(values.has("tabs")).toBe(false);
    expect(bridgeMocks.invoke).toHaveBeenCalledTimes(2);
    expect(bridgeMocks.invoke.mock.calls[1]?.[0]).toBe("lan_remove_storage");
  });

  it("keeps a local edit made after the remote event", async () => {
    let finishFirst!: () => void;
    bridgeMocks.invoke
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        finishFirst = resolve;
      }))
      .mockResolvedValue(undefined);
    const storage = createSharedStorage();
    const remoteRaw = JSON.stringify({ state: { value: 2 }, version: 0 });

    storage.setItem("tabs", { state: { value: 1 }, version: 0 });
    emitStorageChanged("tabs", remoteRaw);
    storage.setItem("tabs", { state: { value: 3 }, version: 0 });

    finishFirst();
    await Promise.resolve();
    await Promise.resolve();

    expect(bridgeMocks.invoke).toHaveBeenCalledTimes(2);
    const latestArgs = bridgeMocks.invoke.mock.calls[1]?.[1] as { value: string };
    expect(JSON.parse(latestArgs.value)).toMatchObject({ state: { value: 3 } });
  });
});
