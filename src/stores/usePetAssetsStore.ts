// 自定义桌宠图片设置：
//   - 6 个类别 (welcome / thinking / waiting / complete / error / others) 的元数据
//   - enabled 开关：true 时 PetCharacter 改用自定义资源
//
// 持久化：
//   - 元数据（id / fileName / mime / sizeBytes / addedAt）+ enabled 用 zustand persist
//     （走和其它 store 一样的 sharedStorage，目的不是跨设备同步图片，而是单端
//     重启后元数据不丢；图片二进制 blob 在 IndexedDB 单独管理）
//   - blobUrls 仅运行时维护（启动 / 上传时拿 ObjectURL 填进来，删除时 revoke）
//
// 启用约束（用户要求"每类至少 1 张"）：
//   - setEnabled(true) 仅在 6 类全部 ≥1 张时成功，否则 throw（UI 显示错误）
//   - removeAsset 删除最后 1 张时若 enabled，会自动 disable enabled，避免 invalid state

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSharedStorage, onStorageExternalChange } from "../lib/sharedStorage";
import {
  getAssetUrl,
  putAssetBlob,
  removeAssetCompletely,
} from "../lib/petAssetStore";

export type PetCategory = "welcome" | "thinking" | "waiting" | "complete" | "error" | "others";
export const PET_CATEGORIES: readonly PetCategory[] = [
  "welcome",
  "thinking",
  "waiting",
  "complete",
  "error",
  "others",
] as const;

export const PET_CATEGORY_LABEL: Record<PetCategory, string> = {
  welcome: "欢迎",
  thinking: "思考",
  waiting: "等待",
  complete: "完成",
  error: "错误",
  others: "互动彩蛋",
};

export interface PetAssetMeta {
  id: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  addedAt: number;
}

type CategoryMap<T> = Record<PetCategory, T>;

function emptyByCategory<T>(make: () => T): CategoryMap<T> {
  return {
    welcome: make(),
    thinking: make(),
    waiting: make(),
    complete: make(),
    error: make(),
    others: make(),
  };
}

interface PetAssetsState {
  /// 是否启用自定义桌宠图片
  enabled: boolean;
  /// 每类的元数据列表
  assets: CategoryMap<PetAssetMeta[]>;
  /// 每个 id 对应的 ObjectURL（运行时填，不持久化）
  blobUrls: Record<string, string>;
  /// hydrate 是否完成；UI 在未完成时显示"加载中"
  hydrated: boolean;

  setEnabled: (enabled: boolean) => void;
  /// 上传一张图片：写 blob 到 IDB + 在 store 加元数据 + 缓存 URL
  /// 失败抛错（quota / 非图片）
  addAsset: (category: PetCategory, file: File) => Promise<void>;
  /// 删除一张图片：从 IDB 删 blob + revoke URL + 在 store 移除元数据。
  /// 删完最后一张会自动关闭 enabled。
  removeAsset: (category: PetCategory, id: string) => Promise<void>;
  /// 启动 / rehydrate 后调用：把已有元数据对应的 blob 转成 ObjectURL 填进 blobUrls
  hydrateBlobs: () => Promise<void>;
}

function generateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const ALLOWED_MIME = /^image\/(gif|png|jpeg|webp|apng)$/i;
const MAX_SIZE = 8 * 1024 * 1024; // 8MB / 张：避免 IDB 卡住 webview

export const usePetAssetsStore = create<PetAssetsState>()(
  persist(
    (set, get) => ({
      enabled: false,
      assets: emptyByCategory<PetAssetMeta[]>(() => []),
      blobUrls: {},
      hydrated: false,

      setEnabled: (enabled) => {
        if (enabled) {
          // 校验：所有 6 类必须 ≥1 张
          const a = get().assets;
          const missing = PET_CATEGORIES.filter((c) => (a[c]?.length ?? 0) === 0);
          if (missing.length > 0) {
            throw new Error(
              `以下类别还没有任何图片：${missing.map((c) => PET_CATEGORY_LABEL[c]).join("、")}`,
            );
          }
        }
        set({ enabled });
      },

      addAsset: async (category, file) => {
        if (!ALLOWED_MIME.test(file.type)) {
          throw new Error("仅支持 GIF / PNG / JPEG / WEBP / APNG 图片");
        }
        if (file.size > MAX_SIZE) {
          throw new Error(
            `单张图片不能超过 ${(MAX_SIZE / 1024 / 1024).toFixed(0)}MB（当前 ${(file.size / 1024 / 1024).toFixed(2)}MB）`,
          );
        }
        const id = generateId();
        // 1) 先落库（落库失败不入 store）
        await putAssetBlob(id, file);
        // 2) 拿 ObjectURL
        const url = await getAssetUrl(id);
        const meta: PetAssetMeta = {
          id,
          fileName: file.name,
          mime: file.type,
          sizeBytes: file.size,
          addedAt: Date.now(),
        };
        set((state) => ({
          assets: {
            ...state.assets,
            [category]: [...state.assets[category], meta],
          },
          blobUrls: url ? { ...state.blobUrls, [id]: url } : state.blobUrls,
        }));
      },

      removeAsset: async (category, id) => {
        // 1) IDB 释放（缺失也安全）
        await removeAssetCompletely(id);
        // 2) 移除元数据 + URL
        set((state) => {
          const nextList = state.assets[category].filter((m) => m.id !== id);
          const nextAssets = { ...state.assets, [category]: nextList };
          const nextBlobUrls = { ...state.blobUrls };
          delete nextBlobUrls[id];
          // 若删完该类最后一张且当前已启用：自动关闭，避免 invalid state
          let nextEnabled = state.enabled;
          if (nextEnabled && nextList.length === 0) {
            nextEnabled = false;
          }
          return { assets: nextAssets, blobUrls: nextBlobUrls, enabled: nextEnabled };
        });
      },

      hydrateBlobs: async () => {
        const { assets } = get();
        const updates: Record<string, string> = {};
        for (const cat of PET_CATEGORIES) {
          for (const meta of assets[cat]) {
            const url = await getAssetUrl(meta.id);
            if (url) updates[meta.id] = url;
          }
        }
        set((state) => ({
          blobUrls: { ...state.blobUrls, ...updates },
          hydrated: true,
        }));
      },
    }),
    {
      name: "pet-assets-storage",
      storage: createSharedStorage(),
      // 仅持久化元数据 + enabled；blobUrls 是进程内的 ObjectURL，重启后无效
      partialize: (state) => ({
        enabled: state.enabled,
        assets: state.assets,
      }),
      // rehydrate 完成后自动从 IDB 重建 ObjectURL
      onRehydrateStorage: () => (state) => {
        if (state) {
          void state.hydrateBlobs();
        }
      },
      // 兼容老版本：assets 字段缺失或类别不全时用空数组兜底
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<PetAssetsState>;
        const mergedAssets: CategoryMap<PetAssetMeta[]> = {
          welcome: persisted.assets?.welcome ?? [],
          thinking: persisted.assets?.thinking ?? [],
          waiting: persisted.assets?.waiting ?? [],
          complete: persisted.assets?.complete ?? [],
          error: persisted.assets?.error ?? [],
          others: persisted.assets?.others ?? [],
        };
        return {
          ...currentState,
          ...persisted,
          assets: mergedAssets,
          // 这两个不从持久化恢复
          blobUrls: {},
          hydrated: false,
        };
      },
    },
  ),
);

// 跨标签 / 跨设备同步元数据（图片二进制还是各端各 IDB 独立）
onStorageExternalChange("pet-assets-storage", () => {
  void usePetAssetsStore.persist.rehydrate();
});
