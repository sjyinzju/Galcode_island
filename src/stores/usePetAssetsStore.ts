// 桌宠"预设"系统：
//
// 概念：
//   - 一个 Preset 就是一整套桌宠形象 = 名字 + 描述 + 6 个类别（welcome / thinking /
//     waiting / complete / error / others）各自的图片列表。
//   - DEFAULT_PRESET = 凉宫春日，应用自带；不可编辑、不可删除。空 categories 表示
//     "全部回退默认 GIF"。
//   - source = "default" / "mine" / "community"：
//       · default：内置凉宫春日，唯一
//       · mine：用户本机创建或对其它预设编辑后 auto-fork 出来的本地预设
//       · community：从社区下载下来的整套图集，只读
//   - activePresetId：当前生效的预设。"default" 表示不替换，正常用内置 GIF；
//     其它 id 表示用该预设的图替换桌宠。
//
// Auto-fork：
//   - 用户对一个 default 或 community 预设进行写操作（addAsset / removeAsset /
//     addCommunityImageToActive）时，自动复制成一份 "mine" 预设并把 active 切到它。
//   - 设计意图：保留原始来源不被破坏，且用户不需要先点"复制为我的"再编辑——
//     "用着用着就改了"这条最自然的路径直接成立。
//   - fork 时所有 blob 都会被复制一份（生成新 IDB key + 新 PetAssetMeta.id），让
//     "删图"在不同预设里独立——避免删 fork 同时删原始预设的 blob。
//
// 持久化：
//   - 元数据（presets[] + activePresetId）走 zustand persist + sharedStorage
//   - 二进制 blob 在 IndexedDB（lib/petAssetStore）；blobUrls 仅运行时维护
//   - 老版本 (enabled, assets, lastAlbumSnapshot) 在 merge 时自动迁移成一份 mine 预设

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSharedStorage, onStorageExternalChange } from "../lib/sharedStorage";
import {
  getAssetBlob,
  getAssetUrl,
  putAssetBlob,
  removeAssetCompletely,
} from "../lib/petAssetStore";
import {
  isCommunityEnabled,
  uploadImage as communityUpload,
} from "../lib/communityClient";
import {
  CommunityError,
  type AlbumDto,
  type CommunityImageDto,
} from "../types/community";

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
  /// 来源："local" = 用户本机上传；"community" = 来自社区图（含 album 安装 / 单图选用）；
  ///       "default" = DEFAULT_PRESET 的内置 GIF（运行时由常量生成，不入 IDB / persist）
  source?: "local" | "community" | "default";
  /// 关联到社区后端的 image id（上传成功 / 社区来源时非空）
  communityImageId?: string | null;
  /// 该图在桌宠显示时，替换凉宫春日 system prompt 的"团长文案风格" prompt（可选）。
  /// 空字符串与 null 等效——回退默认凉宫人设。
  communityPrompt?: string | null;
  /// 静态资源直连地址，仅 source="default" 时填——指向 /pet/<cat>/*.gif，由 vite/Tauri
  /// 从 public/ 直接服务，**不进 IDB**。渲染处优先用 staticUrl ?? blobUrls[id]。
  staticUrl?: string;
}

export type PresetSource = "default" | "mine" | "community";

export interface Preset {
  /// 特殊值 DEFAULT_PRESET_ID = "default" 表示内置凉宫春日；其它为 UUID
  id: string;
  name: string;
  description: string;
  source: PresetSource;
  /// 来自社区时记下原作者（用于显示）；mine 自创填本地昵称、可空
  authorName: string | null;
  /// mine 上传到社区后填；community 来源时填来源 album id；其它 null
  communityAlbumId: string | null;
  createdAt: number;
  updatedAt: number;
  categories: CategoryMap<PetAssetMeta[]>;
  /// 预设级"人设 prompt"——作为单张图 prompt 缺失时的兜底。
  /// 解析顺序：图 prompt > 预设 persona > Rust 端硬编码的凉宫春日。
  /// 默认预设保持 ""（让 Rust 兜底直接生效）；mine 可编辑；community 当前从服务端
  /// 拿不到该字段（server schema 还没扩），下载后默认 ""，等用户复制为我的后再填。
  persona: string;
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

export const DEFAULT_PRESET_ID = "default";

/// 与 public/pet/<cat>/*.gif 同步——这里列的就是 vite/Tauri 实际打包进 dist 的文件。
/// 数量 / 名字变化时请同步 PetCharacter.tsx 里的 pickDefaultGif 表，避免运行时回退用到
/// 不存在的资源。
const DEFAULT_GIF_CATALOG: Record<PetCategory, string[]> = {
  welcome: ["welcome.gif"],
  thinking: ["thinking_1.gif", "thinking_2.gif"],
  waiting: ["waiting_1.gif", "waiting_2.gif"],
  complete: ["complete_1.gif", "complete_2.gif", "complete_3.gif"],
  error: ["error_1.gif", "error_2.gif"],
  others: [
    "对手指.gif",
    "thinking_2.gif",
    "启动.gif",
    "想要.gif",
    "戳戳.gif",
    "thinking_1.gif",
  ],
};

function buildDefaultCategories(): CategoryMap<PetAssetMeta[]> {
  const out = emptyByCategory<PetAssetMeta[]>(() => []);
  for (const cat of PET_CATEGORIES) {
    out[cat] = DEFAULT_GIF_CATALOG[cat].map((name, idx) => ({
      id: `__default__:${cat}:${idx}`,
      fileName: name,
      mime: "image/gif",
      sizeBytes: 0,
      addedAt: 0,
      source: "default" as const,
      communityImageId: null,
      communityPrompt: null,
      staticUrl: `/pet/${cat}/${name}`,
    }));
  }
  return out;
}

/// 内置预设：凉宫春日。categories 直接列出打包 GIF，让用户能在预设详情里看到实际素材。
/// 不进 presets[] 数组，由 selector 特判返回——保持持久化数据只装用户自定义的部分。
export const DEFAULT_PRESET: Preset = Object.freeze({
  id: DEFAULT_PRESET_ID,
  name: "凉宫春日",
  description: "应用自带的默认桌宠形象。",
  source: "default" as const,
  authorName: "凉宫春日应援团",
  communityAlbumId: null,
  createdAt: 0,
  updatedAt: 0,
  categories: buildDefaultCategories(),
  /// 留空：Rust 端 compose_system_prompt(None) 会自动用 haruhi_persona_section 兜底
  persona: "",
}) as Preset;

/// addAsset 返回值：UI 据此显示"社区同步失败但本地已存"等差异化文案。
export interface AddAssetResult {
  /// 是否真的上传到了社区后端（社区未启用 / shareToCommunity=false / 网络失败 都为 false）
  uploadedToCommunity: boolean;
  /// 上传到社区后拿到的 image id（仅成功时非空）
  communityImageId: string | null;
  uploadError?: CommunityError;
  /// 操作后 active 指向的预设 id（auto-fork 时会变）。调用方可用来判断"刚被 fork 了"
  activePresetId: string;
}

export interface AddAssetOptions {
  prompt?: string | null;
  shareToCommunity?: boolean;
  uploaderName?: string | null;
}

interface PetAssetsState {
  /// 用户本地预设库（不含 default —— default 是 selector 特判的虚拟项）
  presets: Preset[];
  /// 当前生效的预设 id（"default" 或 presets[i].id）
  activePresetId: string;
  /// asset id → ObjectURL（运行时维护，不持久化）
  blobUrls: Record<string, string>;
  hydrated: boolean;

  // ===== 预设级操作 =====

  /// 切换 active；若 id 不存在则忽略（防止外部传脏数据让 active 指空）
  setActivePreset: (id: string) => void;

  /// 新建一个空白本地预设并切到它，返回新 id
  createBlankPreset: (name: string, description?: string) => string;

  /// 把当前 active 复制为一份新的 mine 预设（包括 blob 复制），切到新预设，返回新 id。
  /// 用户没显式调用时由 addAsset/removeAsset 在编辑非 mine 时自动调用。
  forkActive: (newName?: string) => Promise<string>;

  /// 重命名预设；不可改 default
  renamePreset: (id: string, name: string) => void;
  /// 改描述；不可改 default
  updatePresetDescription: (id: string, description: string) => void;

  /// 改预设级 persona prompt（参与"图 prompt > 预设 persona > 凉宫"的兜底链）。
  /// 仅对 mine 来源生效；default / community 静默 no-op（UI 应置灰输入框）。
  updatePresetPersona: (id: string, persona: string) => void;

  /// 删除预设：从 presets[] 移除 + 删它持有的所有 blob。
  /// 不能删 default；如果删的是 active，自动切回 default。
  deletePreset: (id: string) => Promise<void>;

  /// 标记某预设"已发布到社区"，写 communityAlbumId
  markPresetUploaded: (id: string, albumId: string) => void;

  /// 把社区图集（album + 全部 image dto + 已下载的 blob 列表）安装为一份本地预设。
  /// 不切 active —— 调用方决定要不要 setActivePreset。返回新 preset id。
  installAlbumAsPreset: (
    album: AlbumDto,
    items: ReadonlyArray<{ image: CommunityImageDto; blob: Blob }>,
  ) => Promise<string>;

  // ===== 资源级操作（操作的目标永远是 active 预设；若 active 非 mine 自动 fork） =====

  addAsset: (
    category: PetCategory,
    file: File,
    options?: AddAssetOptions,
  ) => Promise<AddAssetResult>;

  /// 把社区单图加到 active 预设的 category（auto-fork）。
  addCommunityImageToActive: (
    category: PetCategory,
    dto: CommunityImageDto,
    blob: Blob,
  ) => Promise<{ activePresetId: string; meta: PetAssetMeta }>;

  removeAsset: (category: PetCategory, assetId: string) => Promise<void>;

  /// 改某张图的 communityPrompt（在桌宠展示该图时替换 LLM 人设的文案）。
  /// 仅对 source=mine 预设生效；default / community / 找不到的预设静默 no-op
  /// （UI 应在 source!==mine 时把 prompt 输入框置灰，并引导先「复制为我的副本」）。
  /// 不走 auto-fork —— prompt 编辑成本应该和"切换预设"分得清，避免误触造成意外 fork。
  updateAssetPrompt: (
    presetId: string,
    category: PetCategory,
    assetId: string,
    prompt: string | null,
  ) => void;

  // ===== 启动 / 维护 =====

  hydrateBlobs: () => Promise<void>;
}

const ALLOWED_MIME = /^image\/(gif|png|jpeg|webp|apng)$/i;
const MAX_SIZE = 8 * 1024 * 1024;

function generateId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/// 找一份预设（特判 default）
export function getPresetById(
  state: Pick<PetAssetsState, "presets">,
  id: string,
): Preset | null {
  if (id === DEFAULT_PRESET_ID) return DEFAULT_PRESET;
  return state.presets.find((p) => p.id === id) ?? null;
}

/// 当前 active 预设（特判 default）
export function getActivePreset(
  state: Pick<PetAssetsState, "presets" | "activePresetId">,
): Preset {
  return getPresetById(state, state.activePresetId) ?? DEFAULT_PRESET;
}

/// 当前 active 预设的 6 类资源映射（默认预设返回的是 DEFAULT_PRESET.categories，
/// 空数组的 reference 在多次调用之间保持稳定，让 zustand 选择器 shallow-eq 生效）
export function getActiveCategories(
  state: Pick<PetAssetsState, "presets" | "activePresetId">,
): CategoryMap<PetAssetMeta[]> {
  return getActivePreset(state).categories;
}

/// 当前是否在用自定义预设（非 default）。
/// 老 enabled 字段的语义继任者。
export function isCustomPresetActive(
  state: Pick<PetAssetsState, "activePresetId">,
): boolean {
  return state.activePresetId !== DEFAULT_PRESET_ID;
}

/// 内部 helper：把一个预设深拷贝出来（含 blob），用于 fork。
/// 失败的图会跳过；返回新 Preset + 用于 set 的 blobUrls 增量。
///
/// blob 来源策略：
///   - meta.staticUrl 非空（default 来源）→ fetch /pet/.../*.gif 拿 Blob，进 IDB
///     —— 让 fork 出来的 mine 副本有自己的 blob，跟其它来源等价；将来用户改 prompt /
///        删图 / 上传社区都走统一路径。
///   - 否则 → 从 IDB 读 meta.id 对应的 blob
async function clonePresetDeep(
  src: Preset,
  newName: string,
  authorName: string | null,
): Promise<{ preset: Preset; blobUrls: Record<string, string> }> {
  const now = Date.now();
  const id = generateId();
  const newCategories = emptyByCategory<PetAssetMeta[]>(() => []);
  const blobUrls: Record<string, string> = {};
  for (const cat of PET_CATEGORIES) {
    for (const meta of src.categories[cat]) {
      try {
        let blob: Blob | null = null;
        if (meta.staticUrl) {
          const res = await fetch(meta.staticUrl);
          if (res.ok) blob = await res.blob();
        } else {
          blob = await getAssetBlob(meta.id);
        }
        if (!blob) continue;
        const newId = generateId();
        await putAssetBlob(newId, blob);
        const url = await getAssetUrl(newId);
        // fork 后的 meta 必须脱离 default：去掉 staticUrl，source 落地到 local，
        // 让所有后续操作（prompt 编辑 / 删除 / 上传社区）走统一的 IDB 路径。
        const { staticUrl: _omit, ...rest } = meta;
        const newMeta: PetAssetMeta = {
          ...rest,
          id: newId,
          addedAt: now,
          source: meta.source === "default" ? "local" : (meta.source ?? "local"),
          sizeBytes: blob.size,
        };
        newCategories[cat].push(newMeta);
        if (url) blobUrls[newId] = url;
      } catch (err) {
        console.error("[fork] 复制 blob 失败，跳过", meta.id, err);
      }
    }
  }
  const preset: Preset = {
    id,
    name: newName,
    description: src.description,
    source: "mine",
    authorName,
    communityAlbumId: null,
    createdAt: now,
    updatedAt: now,
    categories: newCategories,
    // fork 时把 source 的 persona 一并带过来；default 通常是 ""，community 也 ""
    persona: src.persona ?? "",
  };
  return { preset, blobUrls };
}

/// 内部 helper：在 set 函数内不可用 async；fork 后再 set。
/// 调用方应在 await 后用返回的新 preset id 继续操作。
async function ensureActiveIsEditable(
  get: () => PetAssetsState,
  set: (
    partial: Partial<PetAssetsState> | ((s: PetAssetsState) => Partial<PetAssetsState>),
  ) => void,
): Promise<string> {
  const state = get();
  const active = getActivePreset(state);
  if (active.source === "mine") return active.id;
  // 需要 fork
  const baseName = active.source === "default" ? "我的桌宠" : `${active.name}（我的副本）`;
  const { preset, blobUrls } = await clonePresetDeep(active, baseName, null);
  set((s) => ({
    presets: [...s.presets, preset],
    activePresetId: preset.id,
    blobUrls: { ...s.blobUrls, ...blobUrls },
  }));
  return preset.id;
}

export const usePetAssetsStore = create<PetAssetsState>()(
  persist(
    (set, get) => ({
      presets: [],
      activePresetId: DEFAULT_PRESET_ID,
      blobUrls: {},
      hydrated: false,

      setActivePreset: (id) => {
        if (id !== DEFAULT_PRESET_ID && !get().presets.some((p) => p.id === id)) {
          console.warn("[setActivePreset] 未知 preset id，忽略：", id);
          return;
        }
        set({ activePresetId: id });
      },

      createBlankPreset: (name, description = "") => {
        const now = Date.now();
        const preset: Preset = {
          id: generateId(),
          name: name.trim() || "新预设",
          description,
          source: "mine",
          authorName: null,
          communityAlbumId: null,
          createdAt: now,
          updatedAt: now,
          categories: emptyByCategory<PetAssetMeta[]>(() => []),
          persona: "",
        };
        set((s) => ({ presets: [...s.presets, preset], activePresetId: preset.id }));
        return preset.id;
      },

      forkActive: async (newName) => {
        const state = get();
        const active = getActivePreset(state);
        const name = newName?.trim() || (
          active.source === "default" ? "我的桌宠" : `${active.name}（副本）`
        );
        const { preset, blobUrls } = await clonePresetDeep(active, name, null);
        set((s) => ({
          presets: [...s.presets, preset],
          activePresetId: preset.id,
          blobUrls: { ...s.blobUrls, ...blobUrls },
        }));
        return preset.id;
      },

      renamePreset: (id, name) => {
        if (id === DEFAULT_PRESET_ID) return;
        const trimmed = name.trim();
        if (!trimmed) return;
        set((s) => ({
          presets: s.presets.map((p) =>
            p.id === id ? { ...p, name: trimmed, updatedAt: Date.now() } : p,
          ),
        }));
      },

      updatePresetDescription: (id, description) => {
        if (id === DEFAULT_PRESET_ID) return;
        set((s) => ({
          presets: s.presets.map((p) =>
            p.id === id ? { ...p, description, updatedAt: Date.now() } : p,
          ),
        }));
      },

      updatePresetPersona: (id, persona) => {
        if (id === DEFAULT_PRESET_ID) return;
        set((s) => ({
          presets: s.presets.map((p) => {
            if (p.id !== id) return p;
            // 仅 mine 来源可写——community 想改请先复制为我的
            if (p.source !== "mine") return p;
            return { ...p, persona, updatedAt: Date.now() };
          }),
        }));
      },

      deletePreset: async (id) => {
        if (id === DEFAULT_PRESET_ID) return;
        const state = get();
        const target = state.presets.find((p) => p.id === id);
        if (!target) return;
        // 1) 删 IDB 里所有 blob
        for (const cat of PET_CATEGORIES) {
          for (const meta of target.categories[cat]) {
            try {
              await removeAssetCompletely(meta.id);
            } catch (err) {
              console.error("[deletePreset] 删 blob 失败", meta.id, err);
            }
          }
        }
        // 2) 删 store；如果删的是 active，自动回到 default
        set((s) => {
          const nextPresets = s.presets.filter((p) => p.id !== id);
          const nextBlobUrls = { ...s.blobUrls };
          for (const cat of PET_CATEGORIES) {
            for (const meta of target.categories[cat]) {
              delete nextBlobUrls[meta.id];
            }
          }
          return {
            presets: nextPresets,
            activePresetId:
              s.activePresetId === id ? DEFAULT_PRESET_ID : s.activePresetId,
            blobUrls: nextBlobUrls,
          };
        });
      },

      markPresetUploaded: (id, albumId) => {
        if (id === DEFAULT_PRESET_ID) return;
        set((s) => ({
          presets: s.presets.map((p) =>
            p.id === id
              ? { ...p, communityAlbumId: albumId, updatedAt: Date.now() }
              : p,
          ),
        }));
      },

      installAlbumAsPreset: async (album, items) => {
        const now = Date.now();
        const presetId = generateId();
        const newCategories = emptyByCategory<PetAssetMeta[]>(() => []);
        const blobUrls: Record<string, string> = {};
        for (const { image, blob } of items) {
          try {
            const newId = generateId();
            await putAssetBlob(newId, blob);
            const url = await getAssetUrl(newId);
            const meta: PetAssetMeta = {
              id: newId,
              fileName: `${image.id}.${image.mime.split("/")[1] ?? "img"}`,
              mime: image.mime,
              sizeBytes: image.sizeBytes,
              addedAt: now,
              source: "community",
              communityImageId: image.id,
              communityPrompt:
                image.prompt && image.prompt.trim() ? image.prompt.trim() : null,
            };
            newCategories[image.category].push(meta);
            if (url) blobUrls[newId] = url;
          } catch (err) {
            console.error("[installAlbumAsPreset] 写入失败，跳过", image.id, err);
          }
        }
        const preset: Preset = {
          id: presetId,
          name: album.name,
          description: album.description?.trim() ?? "",
          source: "community",
          authorName: album.uploaderName?.trim() || null,
          communityAlbumId: album.id,
          createdAt: now,
          updatedAt: now,
          categories: newCategories,
          // TODO: server schema 暂未带 persona 字段；下载下来留空，用户复制为我的后自配
          persona: "",
        };
        set((s) => ({
          presets: [...s.presets, preset],
          blobUrls: { ...s.blobUrls, ...blobUrls },
        }));
        return presetId;
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
        // 1) 确保 active 可写（必要时 fork）
        const presetId = await ensureActiveIsEditable(get, set);
        // 2) 落 blob
        const id = generateId();
        await putAssetBlob(id, file);
        const url = await getAssetUrl(id);
        // 3) 可选：上传社区
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
        // 4) 写 meta
        const meta: PetAssetMeta = {
          id,
          fileName: file.name,
          mime: file.type,
          sizeBytes: file.size,
          addedAt: Date.now(),
          source: "local",
          communityImageId,
          communityPrompt: promptToStore,
        };
        set((s) => ({
          presets: s.presets.map((p) =>
            p.id === presetId
              ? {
                  ...p,
                  categories: {
                    ...p.categories,
                    [category]: [...p.categories[category], meta],
                  },
                  updatedAt: Date.now(),
                }
              : p,
          ),
          blobUrls: url ? { ...s.blobUrls, [id]: url } : s.blobUrls,
        }));
        return {
          uploadedToCommunity,
          communityImageId,
          uploadError,
          activePresetId: presetId,
        };
      },

      addCommunityImageToActive: async (category, dto, blob) => {
        const presetId = await ensureActiveIsEditable(get, set);
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
          communityPrompt:
            dto.prompt && dto.prompt.trim() ? dto.prompt.trim() : null,
        };
        set((s) => ({
          presets: s.presets.map((p) =>
            p.id === presetId
              ? {
                  ...p,
                  categories: {
                    ...p.categories,
                    [category]: [...p.categories[category], meta],
                  },
                  updatedAt: Date.now(),
                }
              : p,
          ),
          blobUrls: url ? { ...s.blobUrls, [id]: url } : s.blobUrls,
        }));
        return { activePresetId: presetId, meta };
      },

      removeAsset: async (category, assetId) => {
        const presetId = await ensureActiveIsEditable(get, set);
        // IDB 释放
        await removeAssetCompletely(assetId);
        set((s) => {
          const nextBlobUrls = { ...s.blobUrls };
          delete nextBlobUrls[assetId];
          return {
            presets: s.presets.map((p) =>
              p.id === presetId
                ? {
                    ...p,
                    categories: {
                      ...p.categories,
                      [category]: p.categories[category].filter(
                        (m) => m.id !== assetId,
                      ),
                    },
                    updatedAt: Date.now(),
                  }
                : p,
            ),
            blobUrls: nextBlobUrls,
          };
        });
      },

      updateAssetPrompt: (presetId, category, assetId, prompt) => {
        if (presetId === DEFAULT_PRESET_ID) return;
        const trimmed = prompt?.trim() ?? "";
        const normalized = trimmed.length > 0 ? trimmed : null;
        set((s) => ({
          presets: s.presets.map((p) => {
            if (p.id !== presetId) return p;
            if (p.source !== "mine") return p;
            return {
              ...p,
              categories: {
                ...p.categories,
                [category]: p.categories[category].map((m) =>
                  m.id === assetId ? { ...m, communityPrompt: normalized } : m,
                ),
              },
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      hydrateBlobs: async () => {
        const { presets } = get();
        const updates: Record<string, string> = {};
        for (const preset of presets) {
          for (const cat of PET_CATEGORIES) {
            for (const meta of preset.categories[cat]) {
              const url = await getAssetUrl(meta.id);
              if (url) updates[meta.id] = url;
            }
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
      partialize: (state) => ({
        presets: state.presets,
        activePresetId: state.activePresetId,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          void state.hydrateBlobs();
        }
      },
      /// 兼容老版本数据（v0：{ enabled, assets, lastAlbumSnapshot }）→ 新版 (presets, activePresetId)
      ///   - 老 assets 非空：搬成一份名为 "我的桌宠"（或老 albumSnapshot.name）的 mine 预设
      ///   - 老 enabled=true 时切 active 为新预设，否则回 default
      merge: (persistedState, currentState) => {
        const raw = (persistedState ?? {}) as Record<string, unknown>;
        // 已经是新版（有 presets 字段）
        if (Array.isArray(raw.presets)) {
          const presets = (raw.presets as Preset[]).map((p) => ({
            ...p,
            categories: {
              welcome: p.categories?.welcome ?? [],
              thinking: p.categories?.thinking ?? [],
              waiting: p.categories?.waiting ?? [],
              complete: p.categories?.complete ?? [],
              error: p.categories?.error ?? [],
              others: p.categories?.others ?? [],
            },
            // v1 → v2 兼容：旧持久化没有 persona 字段，背填 ""
            persona: typeof p.persona === "string" ? p.persona : "",
          }));
          return {
            ...currentState,
            presets,
            activePresetId:
              typeof raw.activePresetId === "string"
                ? (raw.activePresetId as string)
                : DEFAULT_PRESET_ID,
            blobUrls: {},
            hydrated: false,
          };
        }
        // v0 迁移路径
        const legacyAssets = raw.assets as Partial<CategoryMap<PetAssetMeta[]>> | undefined;
        const legacyEnabled = raw.enabled === true;
        const legacySnapshot = raw.lastAlbumSnapshot as
          | { albumId: string; name: string }
          | null
          | undefined;
        if (legacyAssets) {
          const categories: CategoryMap<PetAssetMeta[]> = {
            welcome: legacyAssets.welcome ?? [],
            thinking: legacyAssets.thinking ?? [],
            waiting: legacyAssets.waiting ?? [],
            complete: legacyAssets.complete ?? [],
            error: legacyAssets.error ?? [],
            others: legacyAssets.others ?? [],
          };
          const totalCount = PET_CATEGORIES.reduce(
            (n, c) => n + categories[c].length,
            0,
          );
          if (totalCount > 0) {
            const now = Date.now();
            const migrated: Preset = {
              id: generateId(),
              name: legacySnapshot?.name?.trim() || "我的桌宠",
              description: "由旧版本自定义图迁移而来。",
              source: "mine",
              authorName: null,
              communityAlbumId: legacySnapshot?.albumId ?? null,
              persona: "",
              createdAt: now,
              updatedAt: now,
              categories,
            };
            return {
              ...currentState,
              presets: [migrated],
              activePresetId: legacyEnabled ? migrated.id : DEFAULT_PRESET_ID,
              blobUrls: {},
              hydrated: false,
            };
          }
        }
        return {
          ...currentState,
          presets: [],
          activePresetId: DEFAULT_PRESET_ID,
          blobUrls: {},
          hydrated: false,
        };
      },
    },
  ),
);

// 跨标签 / 跨设备同步
onStorageExternalChange("pet-assets-storage", () => {
  void usePetAssetsStore.persist.rehydrate();
});
