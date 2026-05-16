// 图集详情视图（嵌入在 CommunityPickerModal 内的 view 切换）。
//
// 渲染：
//   - 顶栏：返回按钮 + 图集名 + 上传者 + 上传时间 + 描述（可折叠）+ 图片数
//   - 主区：图集所含全部图缩略图 grid
//   - 每张图点击 → 调用 props.onPick(image, sourceCategory)，让外层主 modal 的 picked overlay
//     接管使用 / 举报流程，避免在本组件里复刻一份选择 UI
//
// 数据：mount 时调 getAlbum(albumId)。loading / error / empty 三态。

import { useEffect, useState } from "react";
import { getAlbum, likeAlbum } from "../../lib/communityClient";
import {
  CommunityError,
  type AlbumDto,
  type CommunityImageDto,
} from "../../types/community";
import { PET_CATEGORY_LABEL } from "../../stores/usePetAssetsStore";
import { LikeButton } from "./community/LikeButton";

export interface AlbumDetailViewProps {
  albumId: string;
  onBack: () => void;
  onPick: (image: CommunityImageDto) => void;
  /// "下载为预设"：把整个图集作为一份新预设安装到本地预设库。父组件已有 handleApplyAlbum 走批量逻辑。
  onApplyAll: (albumId: string) => Promise<void>;
  /// 父级有正在跑的批量操作时为 true，用于 disable 按钮
  busy: boolean;
}

function formatDate(ts: number): string {
  try {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return "—";
  }
}

export function AlbumDetailView({
  albumId,
  onBack,
  onPick,
  onApplyAll,
  busy,
}: AlbumDetailViewProps): JSX.Element {
  const [album, setAlbum] = useState<AlbumDto | null>(null);
  const [images, setImages] = useState<CommunityImageDto[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");
  const [dailyRemaining, setDailyRemaining] = useState<number | null>(null);
  const [toast, setToast] = useState<string>("");

  const handleLike = async (): Promise<void> => {
    if (!album) return;
    try {
      const res = await likeAlbum(album.id);
      setAlbum((prev) =>
        prev ? { ...prev, likes: res.likes, popularity: 3 * res.likes } : prev,
      );
      setDailyRemaining(res.dailyRemaining);
    } catch (err) {
      if (err instanceof CommunityError && err.code === "daily_limit") {
        setDailyRemaining(0);
        setToast("今日点赞配额已用完");
      } else {
        const msg =
          err instanceof CommunityError ? err.message : String((err as Error).message ?? err);
        setToast(`点赞失败：${msg}`);
      }
    }
  };

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(""), 2500);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    getAlbum(albumId)
      .then((res) => {
        if (cancelled) return;
        setAlbum(res.album);
        setImages(res.images);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        const msg =
          err instanceof CommunityError
            ? err.message
            : String((err as Error).message ?? err);
        setError(msg);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [albumId]);

  return (
    <div className="flex h-full flex-col">
      {/* 头部 */}
      <header className="flex items-start gap-3 border-b border-black/5 px-5 py-3 dark:border-white/5">
        <button
          type="button"
          onClick={onBack}
          aria-label="返回"
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-black/5 hover:text-zinc-800 dark:hover:bg-white/10 dark:hover:text-zinc-100"
          title="返回列表"
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M10 3l-5 5 5 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {loading ? (
            <div className="text-[13px] text-zinc-500 dark:text-zinc-400">加载中…</div>
          ) : album ? (
            <>
              <div className="flex flex-wrap items-baseline gap-2">
                <h3 className="text-[14px] font-semibold text-zinc-800 dark:text-zinc-100">
                  {album.name}
                </h3>
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300">
                  {album.imageCount} 张
                </span>
                {/* 图集本身的点赞按钮 */}
                <LikeButton
                  likes={album.likes}
                  dailyRemaining={dailyRemaining}
                  onLike={handleLike}
                  size="md"
                />
                {/* 下载为本地预设：作为一份新预设安装到本地预设库，并切到该预设 */}
                <button
                  type="button"
                  onClick={() => void onApplyAll(album.id)}
                  disabled={busy || album.imageCount === 0}
                  title="把整个图集作为一份预设安装到本地预设库，并切到该预设"
                  className="ml-auto rounded-md border border-emerald-400/60 bg-emerald-500 px-3 py-1 text-[11px] font-medium text-white shadow-sm transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? "下载中…" : `下载为预设 (${album.imageCount} 张)`}
                </button>
              </div>
              <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
                上传者：{album.uploaderName?.trim() || "匿名"} · 上传时间：
                {formatDate(album.createdAt)}
              </div>
              {album.description ? (
                <p className="mt-1 max-h-[5em] overflow-y-auto whitespace-pre-wrap rounded bg-zinc-100/80 px-2 py-1 text-[11px] text-zinc-600 dark:bg-slate-800/60 dark:text-zinc-300">
                  {album.description}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </header>

      {toast ? (
        <div className="pointer-events-none absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-black/80 px-4 py-1.5 text-[11px] text-white shadow-lg backdrop-blur-sm">
          {toast}
        </div>
      ) : null}

      {/* 主区 */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <div className="py-10 text-center text-[12px] text-zinc-500 dark:text-zinc-400">
            加载中…
          </div>
        ) : error ? (
          <div className="py-10 text-center text-[12px] text-rose-600 dark:text-rose-400">
            加载失败：{error}
          </div>
        ) : images.length === 0 ? (
          <div className="py-10 text-center text-[12px] text-zinc-500 dark:text-zinc-400">
            该图集已被清空
          </div>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {images.map((img) => (
              <li key={img.id}>
                <button
                  type="button"
                  onClick={() => onPick(img)}
                  className="group relative block aspect-square w-full overflow-hidden rounded-lg border border-black/10 bg-zinc-100 shadow-sm transition-transform hover:scale-[1.02] hover:shadow-md dark:border-white/10 dark:bg-slate-800"
                  title={`${PET_CATEGORY_LABEL[img.category]} · 使用 ${img.useCount}`}
                >
                  <img
                    src={img.url}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover transition-opacity group-hover:opacity-90"
                    draggable={false}
                  />
                  <span className="absolute left-1.5 top-1.5 rounded bg-sky-500/85 px-1.5 py-0.5 text-[9px] font-medium text-white">
                    {PET_CATEGORY_LABEL[img.category]}
                  </span>
                  <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/55 px-1.5 py-0.5 text-[9px] text-white">
                    {img.useCount}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
