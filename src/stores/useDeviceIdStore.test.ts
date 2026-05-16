// vitest 默认 node 环境没有 localStorage —— 在 import store 之前先植一个 in-memory
// 模拟，让 zustand persist 跑得起来。

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

beforeAll(() => {
  if (typeof globalThis.localStorage === "undefined") {
    const mem = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => void mem.set(k, v),
        removeItem: (k: string) => void mem.delete(k),
        clear: () => mem.clear(),
        key: (i: number) => Array.from(mem.keys())[i] ?? null,
        get length() {
          return mem.size;
        },
      },
    });
  }
});

beforeEach(() => {
  globalThis.localStorage?.clear();
});
afterEach(() => {
  globalThis.localStorage?.clear();
});

describe("useDeviceIdStore", () => {
  it("首次启动生成一个非空 deviceId", async () => {
    // dynamic import 让 module-level 的 create() 在 localStorage 已被 stub 之后执行
    const { useDeviceIdStore } = await import("./useDeviceIdStore");
    const id = useDeviceIdStore.getState().deviceId;
    expect(id).toBeTruthy();
    expect(id.length).toBeGreaterThanOrEqual(8);
  });

  it("getDeviceId() 与 store.getState().deviceId 一致", async () => {
    const { getDeviceId, useDeviceIdStore } = await import("./useDeviceIdStore");
    expect(getDeviceId()).toBe(useDeviceIdStore.getState().deviceId);
  });

  it("state shape 只有 deviceId 这一个 key", async () => {
    const { useDeviceIdStore } = await import("./useDeviceIdStore");
    const keys = Object.keys(useDeviceIdStore.getState());
    expect(keys).toEqual(["deviceId"]);
  });
});
