// usePetAssetsStore 的图集快照变动检测纯函数测试。
//
// hasAlbumChanges 是 PetCharacterSection "保存到云端图集" 按钮 active 状态的依据，
// 误判会让用户错过保存或被反复弹提示——必须有覆盖正反向用例的单测兜底。

import { beforeAll, describe, expect, it } from "vitest";

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

function meta(id: string) {
  // 仅 hasAlbumChanges 用到的字段
  return {
    id,
    fileName: `${id}.png`,
    mime: "image/png",
    sizeBytes: 100,
    addedAt: 1,
  };
}

function emptyAssets() {
  return {
    welcome: [],
    thinking: [],
    waiting: [],
    complete: [],
    error: [],
    others: [],
  };
}

describe("hasAlbumChanges", () => {
  it("从未保存过（snapshot=null）→ 始终 true", async () => {
    const { hasAlbumChanges } = await import("./usePetAssetsStore");
    expect(hasAlbumChanges(emptyAssets(), null)).toBe(true);
    expect(
      hasAlbumChanges(
        { ...emptyAssets(), welcome: [meta("a")] },
        null,
      ),
    ).toBe(true);
  });

  it("当前 ids 和快照 ids 完全一致 → false（无变动）", async () => {
    const { hasAlbumChanges } = await import("./usePetAssetsStore");
    const assets = {
      ...emptyAssets(),
      welcome: [meta("a")],
      thinking: [meta("b"), meta("c")],
    };
    expect(
      hasAlbumChanges(assets, {
        albumId: "x",
        name: "n",
        imageIds: ["a", "b", "c"],
        createdAt: 1,
      }),
    ).toBe(false);
  });

  it("顺序不同 → 还是 false（无变动）", async () => {
    const { hasAlbumChanges } = await import("./usePetAssetsStore");
    const assets = {
      ...emptyAssets(),
      welcome: [meta("a")],
      thinking: [meta("b")],
    };
    expect(
      hasAlbumChanges(assets, {
        albumId: "x",
        name: "n",
        imageIds: ["b", "a"], // 倒序
        createdAt: 1,
      }),
    ).toBe(false);
  });

  it("当前多了一张图 → true", async () => {
    const { hasAlbumChanges } = await import("./usePetAssetsStore");
    const assets = {
      ...emptyAssets(),
      welcome: [meta("a"), meta("new")],
    };
    expect(
      hasAlbumChanges(assets, {
        albumId: "x",
        name: "n",
        imageIds: ["a"],
        createdAt: 1,
      }),
    ).toBe(true);
  });

  it("当前少了一张图 → true", async () => {
    const { hasAlbumChanges } = await import("./usePetAssetsStore");
    const assets = {
      ...emptyAssets(),
      welcome: [meta("a")],
    };
    expect(
      hasAlbumChanges(assets, {
        albumId: "x",
        name: "n",
        imageIds: ["a", "b"],
        createdAt: 1,
      }),
    ).toBe(true);
  });

  it("数量一样但 id 不同 → true", async () => {
    const { hasAlbumChanges } = await import("./usePetAssetsStore");
    const assets = {
      ...emptyAssets(),
      welcome: [meta("a")],
      thinking: [meta("b")],
    };
    expect(
      hasAlbumChanges(assets, {
        albumId: "x",
        name: "n",
        imageIds: ["a", "different"],
        createdAt: 1,
      }),
    ).toBe(true);
  });

  it("跨类别移动同一张图 → false（id 集合未变）", async () => {
    const { hasAlbumChanges } = await import("./usePetAssetsStore");
    // 同一 id 出现在不同类别是 store 不会发生的，但函数应稳健
    const a1 = { ...emptyAssets(), welcome: [meta("a")] };
    const a2 = { ...emptyAssets(), thinking: [meta("a")] };
    const snap = { albumId: "x", name: "n", imageIds: ["a"], createdAt: 1 };
    expect(hasAlbumChanges(a1, snap)).toBe(false);
    expect(hasAlbumChanges(a2, snap)).toBe(false);
  });
});

describe("collectAllAssetIds", () => {
  it("空 → 空数组", async () => {
    const { collectAllAssetIds } = await import("./usePetAssetsStore");
    expect(collectAllAssetIds(emptyAssets())).toEqual([]);
  });

  it("按类别顺序铺平 + 去保留同类内顺序", async () => {
    const { collectAllAssetIds } = await import("./usePetAssetsStore");
    const assets = {
      ...emptyAssets(),
      welcome: [meta("w1"), meta("w2")],
      complete: [meta("c1")],
    };
    const got = collectAllAssetIds(assets);
    // welcome 类先于 complete（按 PET_CATEGORIES 顺序）
    expect(got).toEqual(["w1", "w2", "c1"]);
  });
});

describe("markAlbumUploaded", () => {
  it("set state 后 hasAlbumChanges 返回 false", async () => {
    const { usePetAssetsStore, hasAlbumChanges, collectAllAssetIds } =
      await import("./usePetAssetsStore");
    // 准备：写一些资源到 store
    usePetAssetsStore.setState({
      assets: {
        ...emptyAssets(),
        welcome: [meta("a")],
        thinking: [meta("b")],
      },
    });
    const ids = collectAllAssetIds(usePetAssetsStore.getState().assets);
    usePetAssetsStore.getState().markAlbumUploaded({
      albumId: "abc",
      name: "init",
      imageIds: ids,
      createdAt: Date.now(),
    });
    const snap = usePetAssetsStore.getState().lastAlbumSnapshot;
    expect(snap?.albumId).toBe("abc");
    expect(
      hasAlbumChanges(usePetAssetsStore.getState().assets, snap),
    ).toBe(false);
  });
});
