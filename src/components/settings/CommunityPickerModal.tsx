// "看看大家的图" 社区图选择窗口。
//
// 形态：全屏遮罩 + 居中卡片（占视口 90% 高），毛玻璃 + 暗色适配。
// 布局：
//   - 顶栏：标题"看看大家的图" + 6 类 tab + 右上角关闭按钮
//   - 主区：滚动列表
//     * 首行 Top10 热门（角标"热度 #N"）
//     * Top10 下面 timeline，按时间倒序
//     * 滚到底自动加载下一页（IntersectionObserver 监听 sentinel）
//   - 选中某张图后弹出"用到 {类别} / 举报 / 取消"小卡片（落在被点击的卡片中央偏右）
//
// 性能：
//   - 一次加载 24 张，不一次拉完
//   - 触底（sentinel 进入视口）触发下一页 fetch
//   - 图片 <img loading="lazy">，浏览器自动延迟解码
//
// 不分类列表：每个类别独立的 state（一进 modal 默认第一个类别；切 tab 只是切显示，
//   各类的列表 / cursor / loading 状态独立维护）。
//
// 选用流程：
//   1) 用户点"用到本类别"→ 调 fetchCommunityBlob 把图下载下来
//   2) saveCommunityImageLocally 落到本地（带 communityImageId + communityPrompt）
//   3) recordImageUse 异步通知 server 计数 +1（失败 silently；不影响本地体验）
//   4) toast 提示"已添加到 {类别}"，关闭小卡片

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PET_CATEGORIES,
  PET_CATEGORY_LABEL,
  usePetAssetsStore,
  type PetCategory,
} from "../../stores/usePetAssetsStore";
import {
  fetchCommunityBlob,
  getAlbumsByImage,
  listImages,
  recordImageUse,
  reportImage,
  isCommunityEnabled,
} from "../../lib/communityClient";
import type { AlbumDto, CommunityImageDto } from "../../types/community";
import { CommunityError } from "../../types/community";
import { AlbumDetailView } from "./AlbumDetailView";

export interface CommunityPickerModalProps {
  initialCategory: PetCategory;
  onClose: () => void;
}

interface CategoryState {
  topHot: CommunityImageDto[];
  timeline: CommunityImageDto[];
  topHotIds: string[];
  nextCursor: string | null;
  loading: boolean;
  loadedOnce: boolean;
  exhausted: boolean;
  error: string | null;
}

const emptyState: CategoryState = {
  topHot: [],
  timeline: [],
  topHotIds: [],
  nextCursor: null,
  loading: false,
  loadedOnce: false,
  exhausted: false,
  error: null,
};

export const CommunityPickerModal = memo(function CommunityPickerModal({
  initialCategory,
  onClose,
}: CommunityPickerModalProps): JSX.Element {
  const [active, setActive] = useState<PetCategory>(initialCategory);
  // 每个类别一份独立状态；不一进 modal 就一次性把 6 类都拉了，按需触发
  const [byCat, setByCat] = useState<Record<PetCategory, CategoryState>>(() => ({
    welcome: { ...emptyState },
    thinking: { ...emptyState },
    waiting: { ...emptyState },
    complete: { ...emptyState },
    error: { ...emptyState },
    others: { ...emptyState },
  }));
  const [pickedFor, setPickedFor] = useState<CommunityImageDto | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [toast, setToast] = useState<string>("");
  // view 切换：'list' = 6 类列表；'album' = 看图集详情
  const [view, setView] = useState<
    { kind: "list" } | { kind: "album"; albumId: string }
  >({ kind: "list" });
  // 若图属于多个图集：点"查看所属图集"先在浮层底部展开 album 选择子菜单
  const [albumPickList, setAlbumPickList] = useState<AlbumDto[] | null>(null);
  const [albumLoading, setAlbumLoading] = useState<boolean>(false);
  // "用到「xx」"分裂按钮的角标 popover 开关：展开后显示 6 类别选项，可跨类应用
  const [applyMenuOpen, setApplyMenuOpen] = useState<boolean>(false);
  const enabled = isCommunityEnabled();

  const saveCommunityImageLocally = usePetAssetsStore((s) => s.saveCommunityImageLocally);

  const loadMore = useCallback(
    async (category: PetCategory) => {
      const cur = byCat[category];
      if (!enabled) return;
      if (cur.loading || cur.exhausted) return;
      setByCat((prev) => ({ ...prev, [category]: { ...prev[category], loading: true, error: null } }));
      try {
        const res = await listImages({
          category,
          cursor: cur.nextCursor,
          excludeIds: cur.loadedOnce ? cur.topHotIds : undefined,
        });
        setByCat((prev) => {
          const merged = prev[category];
          return {
            ...prev,
            [category]: {
              topHot: merged.loadedOnce ? merged.topHot : res.topHot,
              timeline: [...merged.timeline, ...res.timeline],
              topHotIds: merged.loadedOnce ? merged.topHotIds : res.topHotIds,
              nextCursor: res.nextCursor,
              loading: false,
              loadedOnce: true,
              exhausted: res.nextCursor === null,
              error: null,
            },
          };
        });
      } catch (err) {
        const msg =
          err instanceof CommunityError ? err.message : String((err as Error).message ?? err);
        setByCat((prev) => ({
          ...prev,
          [category]: { ...prev[category], loading: false, error: msg },
        }));
      }
    },
    [byCat, enabled],
  );

  // 切 tab：首次访问该 tab 时拉第一页
  useEffect(() => {
    if (!enabled) return;
    if (byCat[active].loadedOnce || byCat[active].loading) return;
    void loadMore(active);
    // 依赖 active 即可；byCat 变化会让 loadMore 重新闭包，但 loadedOnce 判断会兜底
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, enabled]);

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

  // 触底自动加载下一页
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            void loadMore(active);
          }
        }
      },
      { root: null, threshold: 0.1 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [active, loadMore]);

  const state = byCat[active];
  const combinedList = useMemo(
    () => [
      ...state.topHot.map((img, idx) => ({ img, hotRank: idx + 1 as number | null })),
      ...state.timeline.map((img) => ({ img, hotRank: null })),
    ],
    [state.topHot, state.timeline],
  );

  /// 把社区图保存到本地。
  /// targetCategory 缺省 = img.category（图本身的来源类）；调用方传别的就走"跨类应用"。
  /// 设计：所有"用到「X」"入口（主按钮、popover 内每个类别按钮）都走这一个函数，
  /// 行为一致，UI 怎么切换都不会出第二条路径产生差异。
  const handleUse = useCallback(
    async (img: CommunityImageDto, targetCategory: PetCategory = img.category) => {
      setBusy(true);
      try {
        const blob = await fetchCommunityBlob(img);
        await saveCommunityImageLocally(targetCategory, img, blob);
        setToast(`已添加到「${PET_CATEGORY_LABEL[targetCategory]}」`);
        // 异步通知 server 计数，不阻塞 UI
        recordImageUse(img.id)
          .then((res) => {
            // 局部更新 useCount 让用户立刻看到 +1（同设备幂等，counted 为 false 时不变）
            if (!res.counted) return;
            setByCat((prev) => {
              const next: typeof prev = { ...prev };
              for (const cat of PET_CATEGORIES) {
                const cs = next[cat];
                const apply = (arr: CommunityImageDto[]): CommunityImageDto[] =>
                  arr.map((x) => (x.id === img.id ? { ...x, useCount: res.useCount } : x));
                next[cat] = {
                  ...cs,
                  topHot: apply(cs.topHot),
                  timeline: apply(cs.timeline),
                };
              }
              return next;
            });
          })
          .catch(() => {
            /* 计数失败 silently */
          });
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
    [saveCommunityImageLocally],
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
        </header>

        {/* 类别 tab：进入图集视图时隐藏（避免视觉竞争） */}
        {view.kind === "list" ? (
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
            />
          </div>
        ) : (
        <div className="relative flex-1 overflow-y-auto px-5 py-4">
          {!enabled ? (
            <EmptyHint
              title="未配置社区服务地址"
              hint="去 设置 → 桌宠社区 配置后端地址后，刷新这里就能看到大家的图。"
            />
          ) : state.error && combinedList.length === 0 ? (
            <EmptyHint title="加载失败" hint={state.error} retry={() => void loadMore(active)} />
          ) : state.loadedOnce && combinedList.length === 0 && !state.loading ? (
            <EmptyHint
              title="这个类别还没有图"
              hint="抢沙发！上传一张让大家用上。"
            />
          ) : (
            <>
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {combinedList.map(({ img, hotRank }) => (
                  <CommunityCard
                    key={img.id}
                    img={img}
                    hotRank={hotRank}
                    onPick={() => setPickedFor(img)}
                  />
                ))}
              </ul>
              {/* 触底 sentinel */}
              <div ref={sentinelRef} className="h-10" />
              {state.loading ? (
                <div className="py-4 text-center text-[11px] text-zinc-500">加载中…</div>
              ) : state.exhausted && combinedList.length > 0 ? (
                <div className="py-4 text-center text-[10px] text-zinc-400">— 已经到底了 —</div>
              ) : null}
              {state.error && combinedList.length > 0 ? (
                <div className="py-2 text-center text-[11px] text-rose-600">
                  {state.error}{" "}
                  <button
                    type="button"
                    onClick={() => void loadMore(active)}
                    className="underline"
                  >
                    重试
                  </button>
                </div>
              ) : null}
            </>
          )}
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

                <div className="mt-2 flex justify-end gap-2">
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
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// 子组件
// ---------------------------------------------------------------------------

function CommunityCard({
  img,
  hotRank,
  onPick,
}: {
  img: CommunityImageDto;
  hotRank: number | null;
  onPick: () => void;
}): JSX.Element {
  return (
    <li>
      <button
        type="button"
        onClick={onPick}
        className="group relative block aspect-square w-full overflow-hidden rounded-lg border border-black/10 bg-zinc-100 shadow-sm transition-transform hover:scale-[1.02] hover:shadow-md dark:border-white/10 dark:bg-slate-800"
        title={img.prompt ? `${img.uploaderName ?? "匿名"} · ${img.prompt}` : img.uploaderName ?? "匿名"}
      >
        <img
          src={img.url}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover transition-opacity group-hover:opacity-90"
          draggable={false}
        />
        {hotRank !== null ? (
          <span className="absolute left-1.5 top-1.5 rounded-full bg-gradient-to-br from-amber-400 to-rose-500 px-2 py-0.5 text-[10px] font-semibold text-white shadow">
            热 #{hotRank}
          </span>
        ) : null}
        <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/55 px-1.5 py-0.5 text-[9px] text-white">
          {img.useCount}
        </span>
      </button>
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
