// "保存到云端图集"向导。
//
// 用户从 PetCharacterSection 点"保存到云端图集"按钮触发本组件挂载。
// 流程：
//   1. 列出当前所有自定义图（按 6 类分组缩略图），让用户先确认要打包的是什么
//   2. 必填：图集名称（1-80 字符）；可选：描述（≤500 字符）
//   3. 点提交：
//      a) 已上传到社区的图（meta.communityImageId 非空）→ 直接收集 id
//      b) 未上传的本地图 → 顺序补传（uploadImage），收集返回的 image.id
//      c) 全部 id 收齐后调 createAlbum
//      d) markAlbumUploaded 写快照 → 关闭弹窗
//   4. 任一步失败 → 显示错误，按钮恢复可点；本地 IDB 不动
//
// 设计：
//   - 与 UploadPromptDialog 风格统一（毛玻璃 + 顶部彩条 + ESC 关闭）
//   - "确认上传" 按钮在加载时显示进度（第 N/M 张）
//   - 跨平台：纯 DOM + CSS，不依赖任何 OS API；按钮 :hover 和 :disabled 在 win/mac 行为一致

import { useEffect, useMemo, useState } from "react";
import {
  PET_CATEGORIES,
  PET_CATEGORY_LABEL,
  usePetAssetsStore,
  type PetAssetMeta,
  type PetCategory,
} from "../../stores/usePetAssetsStore";
import { useProfileStore } from "../../stores/useProfileStore";
import {
  createAlbum,
  isCommunityEnabled,
  uploadImage,
} from "../../lib/communityClient";
import { CommunityError } from "../../types/community";
import { getAssetBlob } from "../../lib/petAssetStore";

const MAX_NAME_LEN = 80;
const MAX_DESC_LEN = 500;

export interface UploadAlbumDialogProps {
  onClose: () => void;
  onSuccess?: () => void;
}

interface ProgressState {
  /// 已经在做的事的人类描述（"补传 第 2/4 张..."）
  label: string;
  /// 0-100
  percent: number;
}

export function UploadAlbumDialog({
  onClose,
  onSuccess,
}: UploadAlbumDialogProps): JSX.Element {
  const assets = usePetAssetsStore((s) => s.assets);
  const blobUrls = usePetAssetsStore((s) => s.blobUrls);
  const markAlbumUploaded = usePetAssetsStore((s) => s.markAlbumUploaded);
  const nickname = useProfileStore((s) => s.nickname);

  const [name, setName] = useState<string>("");
  const [description, setDescription] = useState<string>("");
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [error, setError] = useState<string>("");

  // 扁平化所有图（按 6 类顺序）+ 标记是否已上传，用于 UI 预览 + 提交逻辑
  const allItems = useMemo(() => {
    const out: Array<{ category: PetCategory; meta: PetAssetMeta }> = [];
    for (const cat of PET_CATEGORIES) {
      for (const m of assets[cat]) out.push({ category: cat, meta: m });
    }
    return out;
  }, [assets]);

  const totalCount = allItems.length;
  const needsUploadCount = allItems.filter(
    (i) => !i.meta.communityImageId,
  ).length;

  // ESC 关闭（仅在非提交状态下生效，避免中途取消导致部分上传副作用）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !progress) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, progress]);

  const nameTrim = name.trim();
  const nameValid = nameTrim.length > 0 && nameTrim.length <= MAX_NAME_LEN;
  const descValid = description.length <= MAX_DESC_LEN;
  const canSubmit =
    !progress &&
    nameValid &&
    descValid &&
    totalCount > 0 &&
    isCommunityEnabled();

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return;
    setError("");
    setProgress({ label: "准备上传…", percent: 0 });

    const collectedIds: string[] = [];
    let processedSoFar = 0;

    try {
      // 上传策略：**每张图都走 uploadImage**，不复用本地 meta.communityImageId。
      // 原因：
      //   1) server 端去重已升级到 (device_id, file_hash)，同张图同设备二次上传秒返
      //      duplicate=true + 本设备拥有的 image id，没浪费——上传带宽只读 IDB+网络一次
      //   2) 本地旧 meta.communityImageId 可能在老 schema 时期被 server 返成了**别设备**
      //      的 id（hash 命中跨 device 旧图）；直接复用会让 createAlbum 报 403。
      //      重传 → 由 server 返当前 device 自己的 id → 同时回写本地 meta，
      //      自然治好被污染的旧 store。
      for (const item of allItems) {
        processedSoFar += 1;
        setProgress({
          label: `同步第 ${processedSoFar}/${totalCount} 张…`,
          percent: Math.round((processedSoFar / Math.max(totalCount, 1)) * 90),
        });
        const blob = await getAssetBlob(item.meta.id);
        if (!blob) {
          throw new Error(
            `本地图片 ${item.meta.fileName} 找不到对应的二进制（可能已被清理）`,
          );
        }
        const file =
          blob instanceof File
            ? blob
            : new File([blob], item.meta.fileName, { type: item.meta.mime });
        const res = await uploadImage({
          file,
          category: item.category,
          prompt: item.meta.communityPrompt ?? null,
          uploaderName: nickname?.trim() || null,
        });
        collectedIds.push(res.image.id);
        // 回写 meta.communityImageId 让下次按"已上传"显示（虽然下次还会重传，
        // 但 UI 上显示"全部已就绪"更顺眼，也方便单图浏览时关联社区记录）
        usePetAssetsStore.setState((state) => {
          const list = state.assets[item.category];
          const idx = list.findIndex((m) => m.id === item.meta.id);
          if (idx < 0) return state;
          const updated = [...list];
          updated[idx] = { ...list[idx]!, communityImageId: res.image.id };
          return {
            assets: { ...state.assets, [item.category]: updated },
          };
        });
      }

      // 2) 创建图集
      setProgress({ label: "建立图集…", percent: 95 });
      const album = await createAlbum({
        name: nameTrim,
        description: description.trim() || null,
        imageIds: collectedIds,
        uploaderName: nickname?.trim() || null,
      });

      // 3) 写快照
      const currentIds = allItems.map((i) => i.meta.id);
      markAlbumUploaded({
        albumId: album.album.id,
        name: album.album.name,
        imageIds: currentIds,
        createdAt: album.album.createdAt,
      });

      setProgress({ label: "完成", percent: 100 });
      onSuccess?.();
      onClose();
    } catch (err) {
      const msg =
        err instanceof CommunityError
          ? err.message
          : String((err as Error).message ?? err);
      setError(msg);
      setProgress(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !progress) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="保存到云端图集"
    >
      <div className="relative w-[min(640px,94vw)] max-h-[88vh] overflow-hidden rounded-2xl border border-white/30 bg-white/85 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/85 flex flex-col">
        <div className="h-1 shrink-0 bg-gradient-to-r from-emerald-400 via-sky-400 to-fuchsia-400" />

        <header className="flex items-start justify-between gap-2 px-5 py-4 shrink-0">
          <div>
            <h2 className="text-base font-semibold text-zinc-800 dark:text-zinc-100">
              保存到云端图集
            </h2>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
              把当前 {totalCount} 张自定义桌宠图作为一个图集上传，让别人可以"查看所属图集"整套使用。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={!!progress}
            aria-label="关闭"
            className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-black/5 hover:text-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/10 dark:hover:text-zinc-100"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="overflow-y-auto px-5 pb-2 flex flex-col gap-4">
          {/* 名称 */}
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center justify-between text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
              <span>
                图集名称
                <span className="ml-1.5 rounded bg-rose-500/15 px-1 text-[9px] text-rose-700 dark:text-rose-300">
                  必填
                </span>
              </span>
              <span className={`text-[10px] ${nameTrim.length > MAX_NAME_LEN ? "text-rose-600" : "text-zinc-400 dark:text-zinc-500"}`}>
                {nameTrim.length} / {MAX_NAME_LEN}
              </span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：温柔姐姐版桌宠"
              maxLength={MAX_NAME_LEN + 20}
              disabled={!!progress}
              className="w-full rounded-md border border-black/10 bg-white/80 px-2.5 py-2 text-[13px] text-zinc-800 outline-none transition-colors placeholder:text-zinc-400 focus:border-emerald-400 disabled:opacity-60 dark:border-white/10 dark:bg-slate-800/60 dark:text-zinc-100"
            />
          </div>

          {/* 描述 */}
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center justify-between text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
              <span>
                描述
                <span className="ml-1.5 rounded bg-zinc-200/70 px-1 text-[9px] text-zinc-500 dark:bg-zinc-700/60 dark:text-zinc-400">可选</span>
              </span>
              <span className={`text-[10px] ${description.length > MAX_DESC_LEN ? "text-rose-600" : "text-zinc-400 dark:text-zinc-500"}`}>
                {description.length} / {MAX_DESC_LEN}
              </span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="可写写这套图的风格、灵感来源、推荐场景..."
              rows={3}
              disabled={!!progress}
              className="w-full resize-y rounded-md border border-black/10 bg-white/80 px-2.5 py-2 text-[12px] text-zinc-800 outline-none transition-colors placeholder:text-zinc-400 focus:border-emerald-400 disabled:opacity-60 dark:border-white/10 dark:bg-slate-800/60 dark:text-zinc-100"
            />
          </div>

          {/* 预览 */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
                包含的图（共 {totalCount} 张{needsUploadCount > 0 ? `，其中 ${needsUploadCount} 张待补传` : "，全部已就绪"}）
              </span>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {PET_CATEGORIES.map((cat) => {
                const list = assets[cat];
                if (list.length === 0) return null;
                return (
                  <div
                    key={cat}
                    className="rounded-lg border border-black/5 bg-white/40 p-2 dark:border-white/5 dark:bg-slate-800/40"
                  >
                    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-zinc-700 dark:text-zinc-200">
                      <span>{PET_CATEGORY_LABEL[cat]}</span>
                      <span className="text-[10px] text-zinc-400 dark:text-zinc-500">
                        {list.length} 张
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {list.map((m) => (
                        <div
                          key={m.id}
                          className="relative h-10 w-10 shrink-0 overflow-hidden rounded border border-black/10 bg-white dark:border-white/10 dark:bg-slate-900"
                          title={`${m.fileName}${m.communityImageId ? " · 已上传" : " · 待上传"}`}
                        >
                          {blobUrls[m.id] ? (
                            <img
                              src={blobUrls[m.id]}
                              alt=""
                              className="h-full w-full object-cover"
                              draggable={false}
                            />
                          ) : null}
                          {!m.communityImageId ? (
                            <span
                              className="absolute right-0 top-0 h-1.5 w-1.5 rounded-full bg-amber-400 ring-1 ring-white"
                              aria-label="待上传"
                            />
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            {totalCount === 0 ? (
              <div className="rounded-md border border-amber-300/40 bg-amber-50/70 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-300/30 dark:bg-amber-400/10 dark:text-amber-300">
                还没有任何自定义图。先去各类别上传图片后再来保存图集。
              </div>
            ) : null}
          </div>

          {/* 进度条 / 错误 */}
          {progress ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-[11px] text-zinc-600 dark:text-zinc-300">
                <span>{progress.label}</span>
                <span>{progress.percent}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-slate-700">
                <div
                  className="h-full bg-emerald-500 transition-all"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
            </div>
          ) : null}
          {error ? (
            <div className="rounded-md border border-rose-300/40 bg-rose-50/70 px-3 py-2 text-[11px] text-rose-700 dark:border-rose-300/30 dark:bg-rose-400/10 dark:text-rose-300">
              {error}
            </div>
          ) : null}
        </div>

        {/* 底部按钮 */}
        <div className="flex justify-end gap-2 border-t border-black/5 px-5 py-3 dark:border-white/5">
          <button
            type="button"
            onClick={onClose}
            disabled={!!progress}
            className="rounded-md border border-black/10 bg-white/60 px-4 py-1.5 text-[12px] text-zinc-700 transition-colors hover:bg-zinc-100/80 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-slate-800/60 dark:text-zinc-200 dark:hover:bg-slate-800"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="rounded-md border border-emerald-400/60 bg-emerald-500 px-4 py-1.5 text-[12px] font-medium text-white shadow-sm transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
            title={
              !isCommunityEnabled()
                ? "社区服务地址未配置"
                : !nameValid
                  ? "请填写有效的图集名称"
                  : totalCount === 0
                    ? "至少需要 1 张图"
                    : "保存为云端图集"
            }
          >
            {progress ? "上传中…" : "保存图集"}
          </button>
        </div>
      </div>
    </div>
  );
}
