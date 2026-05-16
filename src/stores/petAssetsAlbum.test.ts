// usePetAssetsStore 的预设选择器纯函数测试。
//
// 重构后旧的"图集快照变动检测"被移除（hasAlbumChanges / collectAllAssetIds /
// markAlbumUploaded），由"预设系统"接管：每个预设独立维护自己的 communityAlbumId。
// 这里只验证基础读路径的稳定性，避免选择器在 zustand 中失去 shallow-eq 优势。

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

describe("默认预设", () => {
  it("DEFAULT_PRESET 各类用打包 GIF 填充，meta.staticUrl 指向 /pet/<cat>/", async () => {
    const { DEFAULT_PRESET, PET_CATEGORIES } = await import("./usePetAssetsStore");
    expect(DEFAULT_PRESET.id).toBe("default");
    expect(DEFAULT_PRESET.source).toBe("default");
    for (const cat of PET_CATEGORIES) {
      const list = DEFAULT_PRESET.categories[cat];
      expect(list.length).toBeGreaterThan(0);
      for (const meta of list) {
        expect(meta.source).toBe("default");
        expect(meta.staticUrl).toMatch(new RegExp(`^/pet/${cat}/`));
        expect(meta.communityPrompt).toBeNull();
      }
    }
  });

  it("getPresetById('default') 始终返回 DEFAULT_PRESET，与 presets[] 无关", async () => {
    const { DEFAULT_PRESET, getPresetById } = await import("./usePetAssetsStore");
    expect(getPresetById({ presets: [] }, "default")).toBe(DEFAULT_PRESET);
  });

  it("getPresetById 找未知 id 返回 null", async () => {
    const { getPresetById } = await import("./usePetAssetsStore");
    expect(getPresetById({ presets: [] }, "nope")).toBeNull();
  });
});

describe("active 状态选择器", () => {
  it("activePresetId='default' 时 isCustomPresetActive=false，getActiveCategories 返回 DEFAULT 的映射", async () => {
    const { DEFAULT_PRESET, isCustomPresetActive, getActiveCategories } = await import(
      "./usePetAssetsStore"
    );
    const state = { presets: [], activePresetId: "default" };
    expect(isCustomPresetActive(state)).toBe(false);
    expect(getActiveCategories(state)).toBe(DEFAULT_PRESET.categories);
  });

  it("activePresetId 指向已有预设时返回该预设的 categories（引用稳定）", async () => {
    const { isCustomPresetActive, getActiveCategories } = await import(
      "./usePetAssetsStore"
    );
    const cats = {
      welcome: [],
      thinking: [],
      waiting: [],
      complete: [],
      error: [],
      others: [],
    };
    const presets = [
      {
        id: "p1",
        name: "我的",
        description: "",
        source: "mine" as const,
        authorName: null,
        communityAlbumId: null,
        createdAt: 0,
        updatedAt: 0,
        categories: cats,
      },
    ];
    const state = { presets, activePresetId: "p1" };
    expect(isCustomPresetActive(state)).toBe(true);
    // 同一 categories 对象引用，方便 zustand 选择器 shallow-eq 跳过重渲染
    expect(getActiveCategories(state)).toBe(cats);
  });

  it("activePresetId 指向不存在的预设时回退到 DEFAULT_PRESET", async () => {
    const { DEFAULT_PRESET, getActiveCategories } = await import("./usePetAssetsStore");
    expect(getActiveCategories({ presets: [], activePresetId: "ghost" })).toBe(
      DEFAULT_PRESET.categories,
    );
  });
});
