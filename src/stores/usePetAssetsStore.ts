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
import {
  isCommunityEnabled,
  uploadImage as communityUpload,
} from "../lib/communityClient";
import { CommunityError, type CommunityImageDto } from "../types/community";

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
  /// 来源："local" = 用户本机上传（默认，向后兼容老元数据）；
  ///       "community" = 用户从社区"看看大家的图"里选用了别人的图。
  /// 老元数据没有这个字段时按 "local" 处理。
  source?: "local" | "community";
  /// 关联到社区后端的 image id。本人上传时若 shareToCommunity=true 且上传成功，写入；
  /// "community" 来源的图必填。用于"我的上传"列表 / 自助隐藏 / 计数。
  communityImageId?: string | null;
  /// 该图在桌宠显示时，替换凉宫春日 system prompt 的"团长文案风格" prompt（可选）。
  /// 来自上传向导 / 社区图 dto.prompt。空字符串与 null 等效——回退默认凉宫人设。
  communityPrompt?: string | null;
}

/// addAsset 返回值：UI 据此显示"社区同步失败但本地已存"等差异化文案。
export interface AddAssetResult {
  /// 是否真的上传到了社区后端（社区未启用 / shareToCommunity=false / 网络失败 都为 false）。
  uploadedToCommunity: boolean;
  /// 上传到社区后拿到的 image id（仅成功时非空）。
  communityImageId: string | null;
  /// 上传过程中出现的错误（社区未启用不算错）；非空时 uploadedToCommunity 必为 false。
  uploadError?: CommunityError;
}

export interface AddAssetOptions {
  /// 团长文案风格 prompt（可选）；非空时也作为本地 meta.communityPrompt 落盘，
  /// 即便没上传到社区也保留——让"未配置社区地址"的用户也能在本地用上 prompt 替换功能。
  prompt?: string | null;
  /// 是否上传到社区（默认 true）。社区未启用时此选项被无视，效果等同 false。
  shareToCommunity?: boolean;
  /// 上传者昵称（可选；默认从 useProfileStore 读，由调用方传入）。
  uploaderName?: string | null;
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

/// 上次成功"保存到云端为图集"时的快照：用于检测当前自定义图集相对那一刻有无变动，
/// 决定 PetCharacterSection 的"保存到云端图集"按钮 active / 灰显。
/// id 集合无序比较，与添加顺序无关。
export interface LastAlbumSnapshot {
  /// 服务端返回的 album id
  albumId: string;
  /// 创建时用户填的图集名
  name: string;
  /// 那一刻自定义图集所包含的全部本地 asset id 列表（顺序无关，比对前会排序）
  imageIds: string[];
  /// 创建时间戳（毫秒）
  createdAt: number;
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
  /// 上次"保存到云端图集"成功后的快照（null = 从未保存过）
  lastAlbumSnapshot: LastAlbumSnapshot | null;

  setEnabled: (enabled: boolean) => void;
  /// 上传一张图片：写 blob 到 IDB + 在 store 加元数据 + 缓存 URL。
  /// 若 options.shareToCommunity !== false 且社区已配置，尝试上传到社区后端，
  ///   - 成功：把返回的 image id 落到 meta.communityImageId，meta.source='local'。
  ///   - 失败：仍保留本地落盘，AddAssetResult.uploadError 携带错误信息。
  /// mime / size 不符合时直接抛 Error（与社区无关，校验失败一律本地拒绝）。
  addAsset: (
    category: PetCategory,
    file: File,
    options?: AddAssetOptions,
  ) => Promise<AddAssetResult>;
  /// 把"从社区看看大家的图里选用的"图片落到本地：写 blob 到 IDB + 元数据带 source='community'。
  /// dto 提供 communityImageId 和 communityPrompt；blob 由调用方先 fetch 拿到。
  /// 不抛错（除了 IDB 写入失败）。
  saveCommunityImageLocally: (
    category: PetCategory,
    dto: CommunityImageDto,
    blob: Blob,
  ) => Promise<PetAssetMeta>;
  /// 删除一张图片：从 IDB 删 blob + revoke URL + 在 store 移除元数据。
  /// 删完最后一张会自动关闭 enabled。
  removeAsset: (category: PetCategory, id: string) => Promise<void>;
  /// 启动 / rehydrate 后调用：把已有元数据对应的 blob 转成 ObjectURL 填进 blobUrls
  hydrateBlobs: () => Promise<void>;
  /// 记录"保存到云端图集"成功后的快照（PetCharacterSection 的按钮据此判断有无变动）
  markAlbumUploaded: (snapshot: LastAlbumSnapshot) => void;
}

/// 比较"当前所有自定义图的 id 集合" vs 快照里的 id 集合。
/// 顺序无关；只看集合是否完全一致。null snapshot → 视为"有变动"。
export function hasAlbumChanges(
  assets: CategoryMap<PetAssetMeta[]>,
  snapshot: LastAlbumSnapshot | null,
): boolean {
  if (!snapshot) return true; // 从未保存过 → 任何已存图都算"待保存"
  const currentIds = new Set<string>();
  for (const cat of PET_CATEGORIES) {
    for (const m of assets[cat] ?? []) currentIds.add(m.id);
  }
  const snapshotIds = new Set(snapshot.imageIds);
  if (currentIds.size !== snapshotIds.size) return true;
  for (const id of currentIds) {
    if (!snapshotIds.has(id)) return true;
  }
  return false;
}

/// 当前所有自定义图的 id 列表（按类别顺序铺平），供 markAlbumUploaded 使用。
export function collectAllAssetIds(
  assets: CategoryMap<PetAssetMeta[]>,
): string[] {
  const out: string[] = [];
  for (const cat of PET_CATEGORIES) {
    for (const m of assets[cat] ?? []) out.push(m.id);
  }
  return out;
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
      lastAlbumSnapshot: null,

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

      addAsset: async (category, file, options = {}) => {
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

        // 3) 尝试上传到社区（best-effort，不阻塞本地落盘）。
        //    shareToCommunity 缺省 = true；社区未启用 / 未配置时静默跳过。
        const wantShare = options.shareToCommunity !== false;
        const promptToStore = options.prompt?.trim() ? options.prompt.trim() : null;
        let uploadedToCommunity = false;
        let communityImageId: string | null = null;
        let uploadError: CommunityError | undefined;
        if (wantShare && isCommunityEnabled()) {
          try {
            const res = await communityUpload({
              file,
              category,
              prompt: promptToStore,
              uploaderName: options.uploaderName ?? null,
            });
            uploadedToCommunity = true;
            communityImageId = res.image.id;
          } catch (err) {
            uploadError =
              err instanceof CommunityError
                ? err
                : new CommunityError({
                    code: "unknown",
                    status: 0,
                    message: String((err as Error).message ?? err),
                  });
          }
        }

        const meta: PetAssetMeta = {
          id,
          fileName: file.name,
          mime: file.type,
          sizeBytes: file.size,
          addedAt: Date.now(),
          source: "local",
          communityImageId,
          // 本地 prompt 与上传是否成功解耦——即使未上传，prompt 也保留供本地 LLM 替换人设用
          communityPrompt: promptToStore,
        };
        set((state) => ({
          assets: {
            ...state.assets,
            [category]: [...state.assets[category], meta],
          },
          blobUrls: url ? { ...state.blobUrls, [id]: url } : state.blobUrls,
        }));

        return { uploadedToCommunity, communityImageId, uploadError };
      },

      saveCommunityImageLocally: async (category, dto, blob) => {
        // 与 addAsset 类似但跳过 mime/size 校验（server 已校），跳过上传（本来就是从社区拿的）。
        const id = generateId();
        await putAssetBlob(id, blob);
        const url = await getAssetUrl(id);
        const meta: PetAssetMeta = {
          id,
          fileName: `${dto.id}.${dto.mime.split("/")[1] ?? "img"}`,
          mime: dto.mime,
          sizeBytes: dto.sizeBytes,
          addedAt: Date.now(),
          source: "community",
          communityImageId: dto.id,
          communityPrompt: dto.prompt && dto.prompt.trim() ? dto.prompt.trim() : null,
        };
        set((state) => ({
          assets: {
            ...state.assets,
            [category]: [...state.assets[category], meta],
          },
          blobUrls: url ? { ...state.blobUrls, [id]: url } : state.blobUrls,
        }));
        return meta;
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

      markAlbumUploaded: (snapshot) => {
        set({ lastAlbumSnapshot: snapshot });
      },
    }),
    {
      name: "pet-assets-storage",
      storage: createSharedStorage(),
      // 仅持久化元数据 + enabled；blobUrls 是进程内的 ObjectURL，重启后无效
      partialize: (state) => ({
        enabled: state.enabled,
        assets: state.assets,
        lastAlbumSnapshot: state.lastAlbumSnapshot,
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
