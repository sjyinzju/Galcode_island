// 设置面板里的"自定义桌宠图片"section。
//
// UI:
//   - 顶部说明 + 启用开关（仅在 6 类全部 ≥1 张时可开；否则点开关弹错误）
//   - 6 个类别卡片（grid），每个卡片：
//     · 类名 + 文件输入按钮（"+ 添加图片"）
//     · 已上传图片缩略图：hover 出 × 删除
//     · 类别空时显示"暂无 — 将使用默认 GIF"
//
// 实时生效：
//   - 上传 / 删除即写 store + IDB；PetCharacter 订阅了 store，下一次 visualState
//     变化（或 useMemo 依赖刷新）就会自动用上新资源。这里不需要"保存"按钮。
//
// 错误处理：
//   - addAsset 抛错（mime / size / IDB quota）→ 在该类下方显示 1 行红色错误，
//     3s 后自动消失
//   - setEnabled 抛错（缺类）→ 顶部 toast 行显示"启用失败"，3s 自动消失

import { useEffect, useRef, useState } from "react";
import {
  PET_CATEGORIES,
  PET_CATEGORY_LABEL,
  usePetAssetsStore,
  type PetCategory,
} from "../../stores/usePetAssetsStore";
import { useProfileStore } from "../../stores/useProfileStore";
import { isCommunityEnabled } from "../../lib/communityClient";
import { hasAlbumChanges } from "../../stores/usePetAssetsStore";
import { UploadPromptDialog } from "./UploadPromptDialog";
import { UploadAlbumDialog } from "./UploadAlbumDialog";
import { CommunityPickerModal } from "./CommunityPickerModal";

const ACCEPTED_MIME = "image/gif,image/png,image/jpeg,image/webp,image/apng";

interface CategoryCardProps {
  category: PetCategory;
  /// 显示的错误消息（自动 3s 消失），空字符串表示无
  error: string;
  setError: (msg: string) => void;
}

function CategoryCard({ category, error, setError }: CategoryCardProps): JSX.Element {
  const list = usePetAssetsStore((s) => s.assets[category]);
  const blobUrls = usePetAssetsStore((s) => s.blobUrls);
  const addAsset = usePetAssetsStore((s) => s.addAsset);
  const removeAsset = usePetAssetsStore((s) => s.removeAsset);
  const nickname = useProfileStore((s) => s.nickname);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  /// 选完文件等待用户填提示词的队列；FIFO 依次走完
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  /// "看看大家的图"窗口开关
  const [communityOpen, setCommunityOpen] = useState<boolean>(false);

  const handleFiles = (files: FileList | null): void => {
    if (!files || files.length === 0) return;
    // 直接把所有文件入队列；用户对每个都填一次 prompt（多选场景）。
    setPendingFiles(Array.from(files));
    // 立刻清空 input，让用户能重新选同一批文件
    if (inputRef.current) inputRef.current.value = "";
  };

  const currentPending = pendingFiles[0] ?? null;

  const handleDialogConfirm = async (input: {
    prompt: string | null;
    shareToCommunity: boolean;
    uploaderName: string | null;
  }): Promise<void> => {
    const file = pendingFiles[0];
    if (!file) return;
    setBusy(true);
    try {
      const result = await addAsset(category, file, {
        prompt: input.prompt,
        shareToCommunity: input.shareToCommunity,
        uploaderName: input.uploaderName,
      });
      if (result.uploadError) {
        // 本地落盘成功 + 社区同步失败：明显但非致命提示
        setError(`已存本地，社区同步失败：${result.uploadError.message}`);
      } else {
        setError("");
      }
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
      // 出队，继续下一张（若有）
      setPendingFiles((prev) => prev.slice(1));
    }
  };

  const handleDialogCancel = (): void => {
    // 取消当前 + 后续整批（避免逐个点取消）
    setPendingFiles([]);
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-black/5 bg-white/40 p-3 dark:border-white/5 dark:bg-slate-800/40">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-zinc-700 dark:text-zinc-200">
          {PET_CATEGORY_LABEL[category]}
          <span className="ml-1.5 text-[10px] text-zinc-400 dark:text-zinc-500">
            {list.length} 张
          </span>
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setCommunityOpen(true)}
            className="flex items-center gap-1 rounded border border-fuchsia-400/50 bg-fuchsia-500/10 px-2 py-0.5 text-[11px] font-medium text-fuchsia-700 transition-all hover:bg-fuchsia-500/20 dark:border-fuchsia-300/40 dark:text-fuchsia-300"
            title={isCommunityEnabled() ? "看看大家上传的图" : "去设置配置社区地址后可用"}
          >
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-2.5 w-2.5">
              <circle cx="7" cy="7" r="2" />
              <path d="M1.5 7s2-4 5.5-4 5.5 4 5.5 4-2 4-5.5 4S1.5 7 1.5 7z" strokeLinecap="round" />
            </svg>
            看看大家的图
          </button>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="flex items-center gap-1 rounded border border-sky-400/50 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-700 transition-all hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-sky-300/40 dark:text-sky-300"
          >
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-2.5 w-2.5">
              <path d="M6 2v8M2 6h8" strokeLinecap="round" />
            </svg>
            {busy ? "上传中…" : "添加图片"}
          </button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_MIME}
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {/* 选完文件 → 弹上传向导（多文件 FIFO） */}
      {currentPending ? (
        <UploadPromptDialog
          file={currentPending}
          category={category}
          defaultUploaderName={nickname}
          onConfirm={(v) => void handleDialogConfirm(v)}
          onCancel={handleDialogCancel}
        />
      ) : null}

      {/* "看看大家的图" 窗口 */}
      {communityOpen ? (
        <CommunityPickerModal
          initialCategory={category}
          onClose={() => setCommunityOpen(false)}
        />
      ) : null}

      {list.length === 0 ? (
        <div className="rounded border border-dashed border-zinc-300/60 bg-transparent px-3 py-2 text-center text-[11px] text-zinc-400 dark:border-zinc-700/60 dark:text-zinc-500">
          暂无图片 — 将使用默认 GIF
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {list.map((meta) => {
            const url = blobUrls[meta.id];
            return (
              <div
                key={meta.id}
                className="group relative h-14 w-14 shrink-0 overflow-hidden rounded border border-black/10 bg-white/50 dark:border-white/10 dark:bg-slate-900/50"
                title={`${meta.fileName} · ${(meta.sizeBytes / 1024).toFixed(1)} KB`}
              >
                {url ? (
                  // eslint-disable-next-line jsx-a11y/img-redundant-alt
                  <img src={url} alt={meta.fileName} className="h-full w-full object-cover" draggable={false} />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-[9px] text-zinc-400 dark:text-zinc-500">
                    加载中
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => void removeAsset(category, meta.id)}
                  aria-label="删除"
                  className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity hover:bg-rose-500/80 group-hover:opacity-100"
                >
                  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-2 w-2">
                    <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            );
          })}
        </div>
      )}

      {error ? (
        <div className="text-[10px] text-rose-600 dark:text-rose-400">{error}</div>
      ) : null}
    </div>
  );
}

export function PetCharacterSection(): JSX.Element {
  const enabled = usePetAssetsStore((s) => s.enabled);
  const setEnabled = usePetAssetsStore((s) => s.setEnabled);
  const assets = usePetAssetsStore((s) => s.assets);
  const lastAlbumSnapshot = usePetAssetsStore((s) => s.lastAlbumSnapshot);
  const [albumDialogOpen, setAlbumDialogOpen] = useState<boolean>(false);

  // 每个类别一个独立的 error；用 record 而非 6 个 useState
  const [errors, setErrors] = useState<Record<PetCategory, string>>({
    welcome: "",
    thinking: "",
    waiting: "",
    complete: "",
    error: "",
    others: "",
  });
  const [topError, setTopError] = useState<string>("");

  // error / topError 自动 3s 后消失
  useEffect(() => {
    if (!topError) return;
    const id = window.setTimeout(() => setTopError(""), 3000);
    return () => window.clearTimeout(id);
  }, [topError]);
  useEffect(() => {
    const cleanup: number[] = [];
    for (const cat of PET_CATEGORIES) {
      if (errors[cat]) {
        const id = window.setTimeout(
          () => setErrors((e) => ({ ...e, [cat]: "" })),
          3000,
        );
        cleanup.push(id);
      }
    }
    return () => {
      for (const id of cleanup) window.clearTimeout(id);
    };
  }, [errors]);

  const allReady = PET_CATEGORIES.every((c) => (assets[c]?.length ?? 0) > 0);
  const totalAssetCount = PET_CATEGORIES.reduce(
    (sum, c) => sum + (assets[c]?.length ?? 0),
    0,
  );
  const albumDirty = hasAlbumChanges(assets, lastAlbumSnapshot);
  const albumButtonDisabled =
    totalAssetCount === 0 || !albumDirty || !isCommunityEnabled();
  const albumButtonTitle = !isCommunityEnabled()
    ? "社区服务未就绪"
    : totalAssetCount === 0
      ? "至少需要 1 张图"
      : !albumDirty
        ? `无变动${lastAlbumSnapshot ? `（已保存为「${lastAlbumSnapshot.name}」）` : ""}`
        : lastAlbumSnapshot
          ? "当前自定义图与上次图集不同，可保存为新图集"
          : "把所有自定义图打包上传为云端图集";

  const handleToggle = (next: boolean): void => {
    try {
      setEnabled(next);
      setTopError("");
    } catch (err) {
      setTopError(String((err as Error).message ?? err));
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
            自定义桌宠图片
          </h3>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            为 6 个状态各传至少 1 张图，启用后桌宠会按相同的触发逻辑（思考 / 等待 /
            完成 / 错误 / 欢迎 / 互动彩蛋）显示你的图片。立即生效，无需保存。
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => handleToggle(!enabled)}
          className={`relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
            enabled ? "bg-sky-500" : "bg-zinc-300 dark:bg-zinc-600"
          } ${!allReady && !enabled ? "opacity-60" : ""}`}
          title={
            allReady
              ? enabled
                ? "已启用自定义桌宠"
                : "启用自定义桌宠"
              : "每个类别至少需要 1 张图片才能启用"
          }
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
              enabled ? "translate-x-[18px]" : "translate-x-1"
            }`}
          />
        </button>
      </div>

      {topError ? (
        <div className="rounded-md border border-rose-300/40 bg-rose-50/70 px-3 py-1.5 text-[11px] text-rose-700 dark:border-rose-300/30 dark:bg-rose-400/10 dark:text-rose-300">
          {topError}
        </div>
      ) : null}

      {/* "保存到云端图集" 操作行：变动 → 按钮 active；无变动 → 灰显 tooltip 提示 */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-300/30 bg-emerald-50/40 px-3 py-2 dark:border-emerald-300/15 dark:bg-emerald-400/5">
        <div className="flex flex-col gap-0.5">
          <span className="text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
            云端图集
            {lastAlbumSnapshot ? (
              <span className="ml-1.5 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] text-emerald-700 dark:text-emerald-300">
                已保存：{lastAlbumSnapshot.name}
              </span>
            ) : (
              <span className="ml-1.5 rounded bg-zinc-300/40 px-1.5 py-0.5 text-[9px] text-zinc-500 dark:bg-zinc-700/40 dark:text-zinc-400">
                未保存
              </span>
            )}
          </span>
          <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
            把当前所有自定义图打包为图集上传，让其他用户能整套使用。
          </span>
        </div>
        <button
          type="button"
          onClick={() => setAlbumDialogOpen(true)}
          disabled={albumButtonDisabled}
          title={albumButtonTitle}
          className="shrink-0 rounded-md border border-emerald-400/60 bg-emerald-500/15 px-3 py-1 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-300/40 dark:text-emerald-300"
        >
          {albumDirty ? (lastAlbumSnapshot ? "保存为新图集" : "保存到云端图集") : "无变动"}
        </button>
      </div>

      {albumDialogOpen ? (
        <UploadAlbumDialog onClose={() => setAlbumDialogOpen(false)} />
      ) : null}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {PET_CATEGORIES.map((cat) => (
          <CategoryCard
            key={cat}
            category={cat}
            error={errors[cat]}
            setError={(msg) => setErrors((e) => ({ ...e, [cat]: msg }))}
          />
        ))}
      </div>
    </section>
  );
}
