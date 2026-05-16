// 把某个本地预设上传到社区。
//
// 调用入口：本地预设库 → 选中一份 mine 预设 → "上传到社区" 按钮。
// 上传成功后预设的 communityAlbumId 会被记下来，UI 上显示"已发布"。
//
// 流程：
//   1. 列出该预设的全部图（按 6 类分组缩略图），让用户先确认要打包的是什么
//   2. 用户填：图集名称（默认 = 预设名）+ 描述（默认 = 预设描述）
//   3. 点提交：
//      a) 每张图都走 uploadImage 重新上传（去重交给 server）；收集返回的 image.id
//      b) createAlbum
//      c) markPresetUploaded 写下 communityAlbumId
//   4. 任一步失败 → 错误条；本地 IDB / 预设不动
//
// 与历史版本区别：以前是"上传当前所有 assets 作为图集"，现在精确指向某一份预设。

import { useEffect, useMemo, useState } from "react";
import {
  PET_CATEGORIES,
  PET_CATEGORY_LABEL,
  getPresetById,
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
  /// 待上传的本地预设 id（必须 source=mine；不是 mine 由调用方先 fork）
  presetId: string;
  onClose: () => void;
  onSuccess?: (albumId: string) => void;
}

interface ProgressState {
  label: string;
  percent: number;
}

export function UploadAlbumDialog({
  presetId,
  onClose,
  onSuccess,
}: UploadAlbumDialogProps): JSX.Element {
  const preset = usePetAssetsStore((s) => getPresetById(s, presetId));
  const blobUrls = usePetAssetsStore((s) => s.blobUrls);
  const markPresetUploaded = usePetAssetsStore((s) => s.markPresetUploaded);
  const nickname = useProfileStore((s) => s.nickname);

  // 用预设自带的 name/description 作初值，方便"再次上传"时不丢之前填过的信息
  const [name, setName] = useState<string>(preset?.name ?? "");
  const [description, setDescription] = useState<string>(preset?.description ?? "");
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [error, setError] = useState<string>("");

  // 当外部 presetId 变化（基本不会发生）时把表单刷新一次
  useEffect(() => {
    if (preset) {
      setName(preset.name);
      setDescription(preset.description);
    }
  }, [preset?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const allItems = useMemo(() => {
    if (!preset) return [] as Array<{ category: PetCategory; meta: PetAssetMeta }>;
    const out: Array<{ category: PetCategory; meta: PetAssetMeta }> = [];
    for (const cat of PET_CATEGORIES) {
      for (const m of preset.categories[cat]) out.push({ category: cat, meta: m });
    }
    return out;
  }, [preset]);

  const totalCount = allItems.length;

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
    isCommunityEnabled() &&
    !!preset;

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit || !preset) return;
    setError("");
    setProgress({ label: "准备上传…", percent: 0 });

    const collectedIds: string[] = [];
    let processedSoFar = 0;

    try {
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
        // 回写 meta.communityImageId：让后续浏览能"关联到社区记录"
        usePetAssetsStore.setState((state) => ({
          presets: state.presets.map((p) =>
            p.id === preset.id
              ? {
                  ...p,
                  categories: {
                    ...p.categories,
                    [item.category]: p.categories[item.category].map((m) =>
                      m.id === item.meta.id
                        ? { ...m, communityImageId: res.image.id }
                        : m,
                    ),
                  },
                }
              : p,
          ),
        }));
      }

      setProgress({ label: "建立图集…", percent: 95 });
      const album = await createAlbum({
        name: nameTrim,
        description: description.trim() || null,
        imageIds: collectedIds,
        uploaderName: nickname?.trim() || null,
      });

      // 同步名字/描述/AlbumId 到本地预设
      markPresetUploaded(preset.id, album.album.id);
      usePetAssetsStore.setState((state) => ({
        presets: state.presets.map((p) =>
          p.id === preset.id
            ? { ...p, name: nameTrim, description: description.trim() }
            : p,
        ),
      }));

      setProgress({ label: "完成", percent: 100 });
      onSuccess?.(album.album.id);
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

  // 预设不存在（被并发删除）→ 显示简单错误
  if (!preset) {
    return (
      <div
        className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 backdrop-blur-sm"
        onClick={onClose}
      >
        <div className="rounded-xl bg-white px-6 py-4 text-sm text-zinc-800 dark:bg-slate-900 dark:text-zinc-100">
          预设已不存在
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !progress) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="上传预设到社区"
    >
      <div className="relative w-[min(640px,94vw)] max-h-[88vh] overflow-hidden rounded-2xl border border-white/30 bg-white/85 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/85 flex flex-col">
        <div className="h-1 shrink-0 bg-gradient-to-r from-emerald-400 via-sky-400 to-fuchsia-400" />

        <header className="flex items-start justify-between gap-2 px-5 py-4 shrink-0">
          <div>
            <h2 className="text-base font-semibold text-zinc-800 dark:text-zinc-100">
              上传预设到社区
            </h2>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
              把预设「{preset.name}」的 {totalCount} 张图作为一个图集发布，让别人也能下载使用。
              {preset.communityAlbumId ? "（再次提交会创建一份新版本，旧版仍保留）" : ""}
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
              placeholder="可写写这套预设的风格、灵感来源、推荐场景..."
              rows={3}
              disabled={!!progress}
              className="w-full resize-y rounded-md border border-black/10 bg-white/80 px-2.5 py-2 text-[12px] text-zinc-800 outline-none transition-colors placeholder:text-zinc-400 focus:border-emerald-400 disabled:opacity-60 dark:border-white/10 dark:bg-slate-800/60 dark:text-zinc-100"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
                包含的图（共 {totalCount} 张）
              </span>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {PET_CATEGORIES.map((cat) => {
                const list = preset.categories[cat];
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
                          title={m.fileName}
                        >
                          {blobUrls[m.id] ? (
                            <img
                              src={blobUrls[m.id]}
                              alt=""
                              className="h-full w-full object-cover"
                              draggable={false}
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
                这份预设还是空的，先给它加几张图再来上传。
              </div>
            ) : null}
          </div>

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
                    : "上传预设到社区"
            }
          >
            {progress ? "上传中…" : "上传预设"}
          </button>
        </div>
      </div>
    </div>
  );
}
