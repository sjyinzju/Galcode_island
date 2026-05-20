// "看看大家的图" 社区图选择窗口。
//
// 形态：全屏遮罩 + 居中卡片（占视口 90% 高），毛玻璃 + 暗色适配。
// 布局：
//   - 顶栏：标题 + 关闭按钮
//   - 维度切换栏：图片 | 图集
//   - 排序栏：人气 | 时间
//   - （图片维度）类别 tab：6 类
//   - 主区：网格列表 + 分页栏（页码 + 跳转输入框）
//   - 选中后弹出操作浮层（用 / 举报 / 跨类应用 popover / 查看所属图集）
//
// 数据：mode/sort/category/page 任一变化 → 重新 fetch；点赞 / 使用计数原地局部更新。
// 跨平台：纯 DOM + Tailwind，无 OS 专属 API；翻页输入框支持数字键和方向键。

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  PET_CATEGORIES,
  PET_CATEGORY_LABEL,
  usePetAssetsStore,
  type PetCategory,
} from "../../stores/usePetAssetsStore";
import {
  fetchCommunityBlob,
  getAlbum,
  getAlbumsByImage,
  isCommunityEnabled,
  likeAlbum,
  likeImage,
  listAlbumsPaged,
  listImagesPaged,
  recordImageUse,
  reportImage,
} from "../../lib/communityClient";
import type {
  AlbumDto,
  CommunityImageDto,
  PagedAlbumsResponse,
  PagedImagesResponse,
  SortMode,
  ViewDimension,
} from "../../types/community";
import { CommunityError } from "../../types/community";
import { AlbumDetailView } from "./AlbumDetailView";
import { AlbumManageDialog } from "./AlbumManageDialog";
import { PaginationBar } from "./community/PaginationBar";
import { LikeButton } from "./community/LikeButton";

export interface CommunityPickerModalProps {
  initialCategory: PetCategory;
  onClose: () => void;
}

export const CommunityPickerModal = memo(function CommunityPickerModal({
  initialCategory,
  onClose,
}: CommunityPickerModalProps): JSX.Element {
  // ----- 查询参数 -----
  // 入口名字叫"看看大家的预设"，整套图集是用户更关心的对象；默认从图集维度开门见山，
  // 单图浏览是次要场景，需要时再切过去。
  const [mode, setMode] = useState<ViewDimension>("albums");
  const [sort, setSort] = useState<SortMode>("popular");
  const [active, setActive] = useState<PetCategory>(initialCategory);
  const [page, setPage] = useState<number>(1);
  // ----- 列表数据：根据 mode 区分两套 -----
  const [imagesData, setImagesData] = useState<PagedImagesResponse | null>(null);
  const [albumsData, setAlbumsData] = useState<PagedAlbumsResponse | null>(null);
  const [listLoading, setListLoading] = useState<boolean>(false);
  const [listError, setListError] = useState<string>("");
  // ----- 浮层 / 视图状态 -----
  const [pickedFor, setPickedFor] = useState<CommunityImageDto | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [toast, setToast] = useState<string>("");
  const [view, setView] = useState<
    { kind: "list" } | { kind: "album"; albumId: string }
  >({ kind: "list" });
  const [albumPickList, setAlbumPickList] = useState<AlbumDto[] | null>(null);
  const [albumLoading, setAlbumLoading] = useState<boolean>(false);
  const [applyMenuOpen, setApplyMenuOpen] = useState<boolean>(false);
  // "管理上传预设"弹窗——挂在 CommunityPickerModal 之上，z-index 比 picker 高一级
  const [manageDialogOpen, setManageDialogOpen] = useState<boolean>(false);
  // 当前 pickedFor / 当前 picked album 的"我对它点赞"日剩余配额（null = 还没点过 = 未知）
  const [pickedDailyRemaining, setPickedDailyRemaining] = useState<number | null>(null);
  const enabled = isCommunityEnabled();

  const addCommunityImageToActive = usePetAssetsStore(
    (s) => s.addCommunityImageToActive,
  );
  const installAlbumAsPreset = usePetAssetsStore((s) => s.installAlbumAsPreset);
  const setActivePreset = usePetAssetsStore((s) => s.setActivePreset);

  // 切换 mode / sort 时把 page 重置到 1，避免落到不存在的页
  useEffect(() => {
    setPage(1);
  }, [mode, sort, active]);

  // mode/sort/category/page 任一变化 → fetch 当前页数据
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setListLoading(true);
    setListError("");
    const run = async (): Promise<void> => {
      try {
        if (mode === "images") {
          const res = await listImagesPaged({
            category: active,
            sort,
            page,
          });
          if (!cancelled) setImagesData(res);
        } else {
          const res = await listAlbumsPaged({ sort, page });
          if (!cancelled) setAlbumsData(res);
        }
      } catch (err) {
        if (cancelled) return;
        const msg =
          err instanceof CommunityError ? err.message : String((err as Error).message ?? err);
        setListError(msg);
      } finally {
        if (!cancelled) setListLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [enabled, mode, sort, active, page]);

  // ESC 关闭：优先关 popover → 关浮层 → 退出 album view → 关 modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        if (applyMenuOpen) {
          setApplyMenuOpen(false);
        } else if (pickedFor) {
          setPickedFor(null);
          setAlbumPickList(null);
        } else if (view.kind === "album") {
          setView({ kind: "list" });
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickedFor, onClose, view, applyMenuOpen]);

  // 关闭 picked overlay 时也关 popover
  useEffect(() => {
    if (!pickedFor) setApplyMenuOpen(false);
  }, [pickedFor]);

  // toast 自动消失
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(""), 2500);
    return () => window.clearTimeout(t);
  }, [toast]);

  // 当前页要展示的 image items（mode=images 才用）
  const imageItems = useMemo(
    () => (mode === "images" ? imagesData?.items ?? [] : []),
    [mode, imagesData],
  );
  // 当前页要展示的 album items（mode=albums 才用）
  const albumItems = useMemo(
    () => (mode === "albums" ? albumsData?.items ?? [] : []),
    [mode, albumsData],
  );

  /// 局部更新 image 列表中某张图的 likes / useCount（点赞 / 使用后调）
  const patchImageInList = useCallback(
    (imageId: string, patch: Partial<CommunityImageDto>) => {
      setImagesData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          items: prev.items.map((x) => (x.id === imageId ? { ...x, ...patch } : x)),
        };
      });
      // pickedFor 如果是这张图，也同步更新
      setPickedFor((prev) => (prev && prev.id === imageId ? { ...prev, ...patch } : prev));
    },
    [],
  );
  /// 局部更新 album 列表中某个图集的 likes
  const patchAlbumInList = useCallback(
    (albumId: string, patch: Partial<AlbumDto>) => {
      setAlbumsData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          items: prev.items.map((x) => (x.id === albumId ? { ...x, ...patch } : x)),
        };
      });
    },
    [],
  );

  /// 把社区图加进"当前 active 预设"的指定类别。
  /// targetCategory 缺省 = img.category（图本身的来源类）；调用方传别的就走"跨类应用"。
  /// 若 active 是 default 或 community 来源，store 内部会 auto-fork 一份 mine 副本再写——
  /// 这里只关心结果：图最终落在当前生效的预设里。
  const handleUse = useCallback(
    async (img: CommunityImageDto, targetCategory: PetCategory = img.category) => {
      setBusy(true);
      try {
        const blob = await fetchCommunityBlob(img);
        await addCommunityImageToActive(targetCategory, img, blob);
        setToast(`已加到当前预设的「${PET_CATEGORY_LABEL[targetCategory]}」`);
        recordImageUse(img.id)
          .then((res) => {
            if (!res.counted) return;
            patchImageInList(img.id, {
              useCount: res.useCount,
              popularity: res.useCount + 3 * (img.likes ?? 0),
            });
          })
          .catch(() => {});
        setPickedFor(null);
        setApplyMenuOpen(false);
      } catch (err) {
        const msg =
          err instanceof CommunityError ? err.message : String((err as Error).message ?? err);
        setToast(`加入失败：${msg}`);
      } finally {
        setBusy(false);
      }
    },
    [addCommunityImageToActive, patchImageInList],
  );

  /// 点赞当前 pickedFor（也用于卡片角心形按钮）。
  /// 成功 → 更新本地状态 + dailyRemaining；429 → 显示 toast + 锁配额。
  const handleLikeImage = useCallback(
    async (img: CommunityImageDto): Promise<void> => {
      try {
        const res = await likeImage(img.id);
        patchImageInList(img.id, {
          likes: res.likes,
          popularity: img.useCount + 3 * res.likes,
        });
        setPickedDailyRemaining(res.dailyRemaining);
      } catch (err) {
        if (err instanceof CommunityError && err.code === "daily_limit") {
          setPickedDailyRemaining(0);
          setToast("今日点赞配额已用完（UTC 0 点重置）");
        } else {
          const msg =
            err instanceof CommunityError ? err.message : String((err as Error).message ?? err);
          setToast(`点赞失败：${msg}`);
        }
      }
    },
    [patchImageInList],
  );

  /// "下载整套预设" —— 把图集作为一份完整的 community 来源预设安装到本地预设库，
  /// 并切换 active 到它。原有预设和原 active 不变。
  /// 流程：
  ///   1. getAlbum 拿图集元数据 + 全部图
  ///   2. 顺序 fetchCommunityBlob 收集 {image, blob}[]
  ///   3. installAlbumAsPreset 一次性写入并生成新预设
  ///   4. setActivePreset 切到新预设
  ///   5. 通知 server 计数（per-image fire-and-forget）
  /// 任一步失败的图 skip 不阻塞其它；toast 显示成功/失败计数。
  const handleApplyAlbum = useCallback(
    async (albumId: string): Promise<void> => {
      setBusy(true);
      try {
        setToast("加载图集…");
        const res = await getAlbum(albumId);
        const total = res.images.length;
        if (total === 0) {
          setToast("该图集是空的，无可应用");
          return;
        }
        const items: Array<{ image: CommunityImageDto; blob: Blob }> = [];
        let downloadFailed = 0;
        for (let i = 0; i < total; i += 1) {
          const img = res.images[i]!;
          setToast(`下载中 ${i + 1}/${total}…`);
          try {
            const blob = await fetchCommunityBlob(img);
            items.push({ image: img, blob });
          } catch {
            downloadFailed += 1;
          }
        }
        setToast(`安装为本地预设…`);
        const newPresetId = await installAlbumAsPreset(res.album, items);
        setActivePreset(newPresetId);
        for (const item of items) {
          recordImageUse(item.image.id)
            .then((r) => {
              if (!r.counted) return;
              patchImageInList(item.image.id, {
                useCount: r.useCount,
                popularity: r.useCount + 3 * (item.image.likes ?? 0),
              });
            })
            .catch(() => {});
        }
        if (downloadFailed === 0) {
          setToast(`已下载并启用预设：「${res.album.name}」`);
        } else {
          setToast(
            `已下载预设「${res.album.name}」：${items.length}/${total} 张成功，${downloadFailed} 张下载失败`,
          );
        }
      } catch (err) {
        const msg =
          err instanceof CommunityError ? err.message : String((err as Error).message ?? err);
        setToast(`下载预设失败：${msg}`);
      } finally {
        setBusy(false);
      }
    },
    [installAlbumAsPreset, setActivePreset, patchImageInList],
  );

  const handleLikeAlbum = useCallback(
    async (album: AlbumDto): Promise<void> => {
      try {
        const res = await likeAlbum(album.id);
        patchAlbumInList(album.id, {
          likes: res.likes,
          popularity: 3 * res.likes,
        });
        setPickedDailyRemaining(res.dailyRemaining);
      } catch (err) {
        if (err instanceof CommunityError && err.code === "daily_limit") {
          setPickedDailyRemaining(0);
          setToast("今日点赞配额已用完（UTC 0 点重置）");
        } else {
          const msg =
            err instanceof CommunityError ? err.message : String((err as Error).message ?? err);
          setToast(`点赞失败：${msg}`);
        }
      }
    },
    [patchAlbumInList],
  );

  /// 点"查看所属图集"：拉该图所属 album 元数据
  ///   - 0 个（理论上不应出现，按钮在 albumIds 非空时才显示）→ toast 提示
  ///   - 1 个 → 直接进 album view
  ///   - 多个 → 浮层底部展开 album 子菜单让用户选
  const handleOpenAlbumsForPicked = useCallback(async (img: CommunityImageDto) => {
    if (img.albumIds.length === 0) {
      setToast("该图未关联任何图集");
      return;
    }
    setAlbumLoading(true);
    try {
      const res = await getAlbumsByImage(img.id);
      const visible = res.albums.filter((a) => a.status === "active");
      if (visible.length === 0) {
        setToast("所属图集已被隐藏");
      } else if (visible.length === 1) {
        setView({ kind: "album", albumId: visible[0]!.id });
        setPickedFor(null);
        setAlbumPickList(null);
      } else {
        setAlbumPickList(visible);
      }
    } catch (err) {
      const msg = err instanceof CommunityError ? err.message : String((err as Error).message ?? err);
      setToast(`加载图集失败：${msg}`);
    } finally {
      setAlbumLoading(false);
    }
  }, []);

  const handleReport = useCallback(async (img: CommunityImageDto) => {
    const reason = window.prompt("举报理由（可选）：")?.trim() ?? "";
    setBusy(true);
    try {
      await reportImage(img.id, reason || null);
      setToast("已举报，工作人员将复核");
      setPickedFor(null);
    } catch (err) {
      const msg = err instanceof CommunityError ? err.message : String((err as Error).message ?? err);
      setToast(`举报失败：${msg}`);
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/55 backdrop-blur-md"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="看看大家的图"
    >
      <div className="relative flex h-[min(720px,90vh)] w-[min(960px,94vw)] flex-col overflow-hidden rounded-2xl border border-white/30 bg-white/90 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/90">
        <div className="h-1 shrink-0 bg-gradient-to-r from-fuchsia-400 via-sky-400 to-emerald-400" />

        {/* 顶栏 */}
        <header className="flex items-center justify-between gap-3 border-b border-black/5 px-5 py-3 dark:border-white/5">
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-5 w-5 text-fuchsia-500">
              <circle cx="12" cy="12" r="3.2" />
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" strokeLinecap="round" />
            </svg>
            <h2 className="text-base font-semibold text-zinc-800 dark:text-zinc-100">
              看看大家的图
            </h2>
            <span className="rounded-full bg-fuchsia-500/10 px-2 py-0.5 text-[10px] text-fuchsia-700 dark:text-fuchsia-300">
              社区
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setManageDialogOpen(true)}
              title="用上传时拿到的密钥管理自己发布的预设"
              className="flex items-center gap-1 rounded-md border border-amber-400/50 bg-amber-50/70 px-2 py-1 text-[11px] font-medium text-amber-800 transition-colors hover:bg-amber-100/80 dark:border-amber-300/30 dark:bg-amber-400/10 dark:text-amber-300 dark:hover:bg-amber-400/15"
            >
              <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3">
                <rect x="3" y="6" width="8" height="6" rx="1" />
                <path d="M5 6V4a2 2 0 014 0v2" strokeLinecap="round" />
              </svg>
              管理上传预设
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-black/5 hover:text-zinc-800 dark:hover:bg-white/10 dark:hover:text-zinc-100"
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </header>

        {/* mode + sort 切换栏：进入图集详情视图时隐藏 */}
        {view.kind === "list" ? (
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-black/5 px-3 py-2 dark:border-white/5">
            {/* mode = 维度切换 */}
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setMode("images")}
                className={`shrink-0 rounded-full px-3 py-1 text-[12px] transition-all ${
                  mode === "images"
                    ? "bg-fuchsia-500 text-white shadow-sm"
                    : "bg-black/5 text-zinc-700 hover:bg-black/10 dark:bg-white/10 dark:text-zinc-200 dark:hover:bg-white/15"
                }`}
              >
                图片
              </button>
              <button
                type="button"
                onClick={() => setMode("albums")}
                className={`shrink-0 rounded-full px-3 py-1 text-[12px] transition-all ${
                  mode === "albums"
                    ? "bg-fuchsia-500 text-white shadow-sm"
                    : "bg-black/5 text-zinc-700 hover:bg-black/10 dark:bg-white/10 dark:text-zinc-200 dark:hover:bg-white/15"
                }`}
              >
                图集
              </button>
            </div>
            {/* sort = 排序切换 */}
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setSort("popular")}
                className={`shrink-0 rounded-full px-3 py-1 text-[11px] transition-all ${
                  sort === "popular"
                    ? "bg-amber-500 text-white shadow-sm"
                    : "bg-black/5 text-zinc-600 hover:bg-black/10 dark:bg-white/10 dark:text-zinc-300 dark:hover:bg-white/15"
                }`}
                title="按 useCount + 3×likes 综合人气倒序"
              >
                人气
              </button>
              <button
                type="button"
                onClick={() => setSort("time")}
                className={`shrink-0 rounded-full px-3 py-1 text-[11px] transition-all ${
                  sort === "time"
                    ? "bg-amber-500 text-white shadow-sm"
                    : "bg-black/5 text-zinc-600 hover:bg-black/10 dark:bg-white/10 dark:text-zinc-300 dark:hover:bg-white/15"
                }`}
                title="按上传时间倒序"
              >
                时间
              </button>
            </div>
          </div>
        ) : null}

        {/* 图片维度下的 6 类 tab */}
        {view.kind === "list" && mode === "images" ? (
          <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-black/5 px-3 py-2 dark:border-white/5">
            {PET_CATEGORIES.map((cat) => {
              const isActive = cat === active;
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setActive(cat)}
                  className={`shrink-0 rounded-full px-3 py-1 text-[12px] transition-all ${
                    isActive
                      ? "bg-sky-500 text-white shadow-sm"
                      : "bg-black/5 text-zinc-700 hover:bg-black/10 dark:bg-white/10 dark:text-zinc-200 dark:hover:bg-white/15"
                  }`}
                >
                  {PET_CATEGORY_LABEL[cat]}
                </button>
              );
            })}
          </nav>
        ) : null}

        {/* 主区：list / album 两态切换 */}
        {view.kind === "album" ? (
          <div className="relative flex-1 overflow-hidden">
            <AlbumDetailView
              albumId={view.albumId}
              onBack={() => setView({ kind: "list" })}
              onPick={(img) => setPickedFor(img)}
              onApplyAll={(albumId) => handleApplyAlbum(albumId)}
              busy={busy}
            />
          </div>
        ) : (
        <div className="relative flex flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto px-5 py-4">
          {!enabled ? (
            <EmptyHint
              title="未配置社区服务地址"
              hint="去 设置 → 桌宠社区 配置后端地址后，刷新这里就能看到大家的图。"
            />
          ) : listError && (mode === "images" ? imageItems.length === 0 : albumItems.length === 0) ? (
            <EmptyHint title="加载失败" hint={listError} retry={() => setPage((p) => p)} />
          ) : !listLoading && (mode === "images" ? imageItems.length === 0 : albumItems.length === 0) ? (
            <EmptyHint
              title={mode === "images" ? "这个类别还没有图" : "还没人发布图集"}
              hint={mode === "images" ? "抢沙发！上传一张让大家用上。" : "去保存自己的自定义图作为图集吧。"}
            />
          ) : mode === "images" ? (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {imageItems.map((img) => (
                <CommunityCard
                  key={img.id}
                  img={img}
                  busy={busy}
                  onPick={() => setPickedFor(img)}
                  onLike={() => handleLikeImage(img)}
                />
              ))}
            </ul>
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {albumItems.map((album) => (
                <AlbumCard
                  key={album.id}
                  album={album}
                  busy={busy}
                  onOpen={() => setView({ kind: "album", albumId: album.id })}
                  onLike={() => handleLikeAlbum(album)}
                  onApplyAll={() => handleApplyAlbum(album.id)}
                />
              ))}
            </ul>
          )}
          {listLoading ? (
            <div className="py-4 text-center text-[11px] text-zinc-500">加载中…</div>
          ) : null}
          </div>
          {/* 分页栏：只在有数据时显示 */}
          {enabled && (mode === "images" ? imagesData : albumsData) ? (
            <div className="shrink-0 border-t border-black/5 dark:border-white/5">
              <PaginationBar
                page={mode === "images" ? imagesData?.page ?? 1 : albumsData?.page ?? 1}
                totalPages={
                  mode === "images"
                    ? imagesData?.totalPages ?? 1
                    : albumsData?.totalPages ?? 1
                }
                onChange={(p) => setPage(p)}
                disabled={listLoading}
              />
            </div>
          ) : null}
        </div>
        )}

        {/* "选中后" 操作浮层 */}
        {pickedFor ? (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center bg-black/30 backdrop-blur-sm"
            onClick={(e) => {
              if (e.target === e.currentTarget) setPickedFor(null);
            }}
          >
            <div
              className="w-[min(360px,88vw)] overflow-hidden rounded-xl border border-white/30 bg-white/95 shadow-xl dark:border-white/10 dark:bg-slate-900/95"
              onClick={() => {
                // 点卡片任意位置（不包括 popover 和角标本身——它们 stopPropagation 了）
                // 自动收起跨类应用 popover，避免它一直挂着遮挡视线
                if (applyMenuOpen) setApplyMenuOpen(false);
              }}
            >
              <div className="aspect-video w-full overflow-hidden bg-zinc-100 dark:bg-slate-800">
                <img src={pickedFor.url} alt="" className="h-full w-full object-contain" />
              </div>
              <div className="flex flex-col gap-1.5 p-4">
                <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                  <span>{pickedFor.uploaderName ?? "匿名"}</span>
                  <span>热度 {pickedFor.useCount}</span>
                </div>
                {pickedFor.prompt ? (
                  <p className="line-clamp-3 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:bg-amber-400/10 dark:text-amber-300">
                    风格 prompt：{pickedFor.prompt}
                  </p>
                ) : null}

                {/* "查看所属图集" 按钮 / 子菜单：仅当该图属于 active 图集时显示 */}
                {pickedFor.albumIds.length > 0 ? (
                  <div className="mt-1">
                    {albumPickList ? (
                      <div className="rounded border border-fuchsia-300/40 bg-fuchsia-50/60 p-2 dark:border-fuchsia-300/20 dark:bg-fuchsia-400/10">
                        <div className="mb-1.5 text-[10px] font-medium text-fuchsia-700 dark:text-fuchsia-300">
                          这张图属于以下 {albumPickList.length} 个图集，选一个查看：
                        </div>
                        <ul className="flex max-h-32 flex-col gap-1 overflow-y-auto">
                          {albumPickList.map((a) => (
                            <li key={a.id}>
                              <button
                                type="button"
                                onClick={() => {
                                  setView({ kind: "album", albumId: a.id });
                                  setPickedFor(null);
                                  setAlbumPickList(null);
                                }}
                                className="flex w-full items-center justify-between gap-2 rounded bg-white/70 px-2 py-1 text-[11px] text-zinc-800 hover:bg-fuchsia-100/70 dark:bg-slate-800/70 dark:text-zinc-100 dark:hover:bg-fuchsia-500/15"
                              >
                                <span className="truncate font-medium">{a.name}</span>
                                <span className="shrink-0 text-[10px] text-zinc-500 dark:text-zinc-400">
                                  {a.uploaderName?.trim() || "匿名"} · {a.imageCount} 张
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                        <button
                          type="button"
                          onClick={() => setAlbumPickList(null)}
                          className="mt-1.5 w-full rounded border border-fuchsia-300/40 bg-white/60 px-2 py-1 text-[10px] text-fuchsia-700 hover:bg-fuchsia-100/50 dark:bg-slate-800/60 dark:text-fuchsia-300"
                        >
                          收起
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleOpenAlbumsForPicked(pickedFor)}
                        disabled={albumLoading || busy}
                        className="w-full rounded-md border border-fuchsia-400/50 bg-fuchsia-500/10 px-3 py-1 text-[11px] font-medium text-fuchsia-700 transition-colors hover:bg-fuchsia-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-fuchsia-300/40 dark:text-fuchsia-300"
                      >
                        {albumLoading
                          ? "加载中…"
                          : `查看所属图集${pickedFor.albumIds.length > 1 ? ` (${pickedFor.albumIds.length})` : ""}`}
                      </button>
                    )}
                  </div>
                ) : null}

                <div className="mt-2 flex items-center justify-end gap-2">
                  {/* 浮层中也允许点赞，用同一个 handler；dailyRemaining 给反馈 */}
                  <LikeButton
                    likes={pickedFor.likes}
                    dailyRemaining={pickedDailyRemaining}
                    onLike={() => handleLikeImage(pickedFor)}
                  />
                  <button
                    type="button"
                    onClick={() => void handleReport(pickedFor)}
                    disabled={busy}
                    className="rounded-md border border-rose-300/50 bg-rose-50/70 px-3 py-1 text-[11px] text-rose-700 hover:bg-rose-100/70 disabled:opacity-50 dark:border-rose-300/20 dark:bg-rose-500/10 dark:text-rose-300"
                  >
                    举报
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPickedFor(null);
                      setAlbumPickList(null);
                    }}
                    disabled={busy}
                    className="rounded-md border border-black/10 bg-white px-3 py-1 text-[11px] text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-white/10 dark:bg-slate-800 dark:text-zinc-200"
                  >
                    取消
                  </button>
                  {/* "用到「xx」" 分裂按钮：
                        - 主体（左半）= 默认用到 img.category（图自带的类别）
                        - 角标（右半）= 点开 popover 选其它类别（跨类应用）
                      整组 button 用 relative + 弹层用 absolute 锚到组的右边底部上方。
                      用 div 包裹 → 让左右两个 button 视觉合一（中间细分隔线），但分别可点。 */}
                  <div className="relative inline-flex">
                    <button
                      type="button"
                      onClick={() => void handleUse(pickedFor)}
                      disabled={busy}
                      className="rounded-l-md border border-emerald-400/60 border-r-emerald-700/30 bg-emerald-500 px-3 py-1 text-[11px] font-medium text-white shadow-sm hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {busy
                        ? "处理中…"
                        : `用到「${PET_CATEGORY_LABEL[pickedFor.category]}」`}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setApplyMenuOpen((v) => !v);
                      }}
                      disabled={busy}
                      aria-label="应用到其它类别"
                      aria-expanded={applyMenuOpen}
                      title="应用到其它类别"
                      className="flex items-center justify-center rounded-r-md border border-l-0 border-emerald-400/60 bg-emerald-500 px-1.5 text-white shadow-sm hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <svg
                        viewBox="0 0 10 10"
                        className={`h-2.5 w-2.5 transition-transform ${applyMenuOpen ? "rotate-180" : ""}`}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                      >
                        <path d="M2 4l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>

                    {applyMenuOpen ? (
                      <div
                        className="absolute bottom-full right-0 z-20 mb-1 min-w-[160px] overflow-hidden rounded-md border border-emerald-300/40 bg-white shadow-lg dark:border-emerald-300/20 dark:bg-slate-900"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="border-b border-black/5 px-2.5 py-1 text-[10px] text-zinc-500 dark:border-white/5 dark:text-zinc-400">
                          应用到类别
                        </div>
                        <ul className="max-h-56 overflow-y-auto py-0.5">
                          {PET_CATEGORIES.map((cat) => {
                            const isDefault = cat === pickedFor.category;
                            return (
                              <li key={cat}>
                                <button
                                  type="button"
                                  onClick={() => void handleUse(pickedFor, cat)}
                                  disabled={busy}
                                  className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-[11px] text-zinc-800 transition-colors hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-100 dark:hover:bg-emerald-500/15"
                                >
                                  <span>{PET_CATEGORY_LABEL[cat]}</span>
                                  {isDefault ? (
                                    <span className="rounded bg-emerald-500/15 px-1 text-[9px] text-emerald-700 dark:text-emerald-300">
                                      默认
                                    </span>
                                  ) : null}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {/* toast */}
        {toast ? (
          <div className="pointer-events-none absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-black/80 px-4 py-1.5 text-[11px] text-white shadow-lg backdrop-blur-sm">
            {toast}
          </div>
        ) : null}

        {/* 管理上传预设弹窗——更高的 z 层，盖在 picker 之上 */}
        {manageDialogOpen ? (
          <AlbumManageDialog onClose={() => setManageDialogOpen(false)} />
        ) : null}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// 子组件
// ---------------------------------------------------------------------------

function CommunityCard({
  img,
  busy,
  onPick,
  onLike,
}: {
  img: CommunityImageDto;
  busy: boolean;
  onPick: () => void;
  onLike: () => Promise<void>;
}): JSX.Element {
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onPick}
        disabled={busy}
        className="block aspect-square w-full overflow-hidden rounded-lg border border-black/10 bg-zinc-100 shadow-sm transition-transform hover:scale-[1.02] hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-slate-800"
        title={img.prompt ? `${img.uploaderName ?? "匿名"} · ${img.prompt}` : img.uploaderName ?? "匿名"}
      >
        <img
          src={img.url}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover transition-opacity group-hover:opacity-90"
          draggable={false}
        />
        <span
          className="absolute bottom-1.5 right-1.5 rounded-full bg-black/55 px-1.5 py-0.5 text-[9px] text-white"
          title={`使用 ${img.useCount} · 人气 ${img.popularity}`}
        >
          使用 {img.useCount}
        </span>
      </button>
      {/* 心形点赞按钮：右上角浮在卡片上方 */}
      <div className="absolute left-1.5 top-1.5">
        <LikeButton likes={img.likes} dailyRemaining={null} onLike={onLike} />
      </div>
    </li>
  );
}

function AlbumCard({
  album,
  busy,
  onOpen,
  onLike,
  onApplyAll,
}: {
  album: AlbumDto;
  busy: boolean;
  onOpen: () => void;
  onLike: () => Promise<void>;
  onApplyAll: () => Promise<void>;
}): JSX.Element {
  // 卡片高度统一策略：
  //   - <li> + 内卡 div 加 h-full：让 grid 同 row stretch 把高度传到内部
  //   - description 区始终占两行高（line-clamp-2 + min-h）：空 description 时也保留同样高度
  //   不再依赖内容自适应 → 所有卡片视觉等高
  const descText = album.description?.trim() ?? "";
  return (
    <li className="h-full">
      <div className="group relative flex h-full gap-3 rounded-lg border border-black/10 bg-white/80 p-2.5 shadow-sm transition-all hover:shadow-md dark:border-white/10 dark:bg-slate-800/80">
        <button
          type="button"
          onClick={onOpen}
          className="h-20 w-20 shrink-0 overflow-hidden rounded-md border border-black/10 bg-zinc-100 dark:border-white/10 dark:bg-slate-900"
          title="点击查看图集详情"
        >
          {album.coverUrl ? (
            <img
              src={album.coverUrl}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover transition-transform group-hover:scale-[1.03]"
              draggable={false}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[10px] text-zinc-400">
              无封面
            </div>
          )}
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <button
            type="button"
            onClick={onOpen}
            className="truncate text-left text-[13px] font-medium text-zinc-800 hover:text-fuchsia-600 dark:text-zinc-100 dark:hover:text-fuchsia-300"
          >
            {album.name}
          </button>
          <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
            {album.uploaderName?.trim() || "匿名"} · {album.imageCount} 张
          </div>
          {/* description 始终占两行高（约 26px）；空时显示淡灰占位文案，让卡片对齐 */}
          <div
            className={`line-clamp-2 min-h-[26px] text-[10px] ${
              descText
                ? "text-zinc-500 dark:text-zinc-400"
                : "text-zinc-300 dark:text-zinc-600 italic"
            }`}
          >
            {descText || "（无描述）"}
          </div>
          {/* 底部两行布局：上行 点赞（左对齐）；下行 下载预设 + 进入图集 并排等宽对称 */}
          <div className="mt-auto flex flex-col gap-1.5">
            <div>
              <LikeButton likes={album.likes} dailyRemaining={null} onLike={onLike} />
            </div>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => void onApplyAll()}
                disabled={busy}
                title="把整套图作为一份预设安装到本地预设库，并切到该预设"
                className="flex-1 rounded-md border border-emerald-400/60 bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-700 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-300/40 dark:text-emerald-300"
              >
                下载预设
              </button>
              <button
                type="button"
                onClick={onOpen}
                className="flex-1 rounded-md border border-fuchsia-400/50 bg-fuchsia-500/10 px-2 py-1 text-[10px] font-medium text-fuchsia-700 hover:bg-fuchsia-500/20 dark:border-fuchsia-300/40 dark:text-fuchsia-300"
              >
                进入图集
              </button>
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}

function EmptyHint({
  title,
  hint,
  retry,
}: {
  title: string;
  hint: string;
  retry?: () => void;
}): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-zinc-500 dark:text-zinc-400">
      <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-12 w-12 opacity-50">
        <circle cx="24" cy="24" r="20" />
        <path d="M16 26s2 4 8 4 8-4 8-4" strokeLinecap="round" />
        <circle cx="18" cy="20" r="1.5" fill="currentColor" />
        <circle cx="30" cy="20" r="1.5" fill="currentColor" />
      </svg>
      <div className="text-[13px] font-medium text-zinc-700 dark:text-zinc-200">{title}</div>
      <div className="text-[11px]">{hint}</div>
      {retry ? (
        <button
          type="button"
          onClick={retry}
          className="mt-1 rounded border border-sky-300/60 bg-sky-50 px-3 py-1 text-[11px] text-sky-700 hover:bg-sky-100 dark:border-sky-300/30 dark:bg-sky-500/10 dark:text-sky-300"
        >
          重试
        </button>
      ) : null}
    </div>
  );
}
