// 关于本应用 + 版本更新一站式弹窗。
//
// 跟 SettingsModal / ProfileModal 同款 sheet 风格（桌面居中、移动端贴底）。
// 内嵌了原本 SettingsModal 里的「应用更新」区 —— 当前版本、上次检查时间、
// 立即检查、新版本提示这些都在这里展示。检查到新版仍走 useUpdateStore 弹
// UpdateModal（下载进度 / ready / 重启 流程在那边），AboutModal 不必关心。

import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAboutStore } from "../../stores/useAboutStore";
import { useUpdateStore } from "../../stores/useUpdateStore";
import { isTauri } from "../../lib/bridge";

const REPO_URL = "https://github.com/sjyinzju/Galcode_island";

function relativeTime(ms: number, now: number): string {
  const diff = now - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

async function openExternal(url: string): Promise<void> {
  if (isTauri) {
    try {
      const mod = await import("@tauri-apps/plugin-opener");
      await mod.openUrl(url);
      return;
    } catch {
      /* fallthrough */
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export function AboutModal(): JSX.Element {
  const isOpen = useAboutStore((s) => s.isOpen);
  const close = useAboutStore((s) => s.closeAboutModal);

  const status = useUpdateStore((s) => s.status);
  const lastCheckedAt = useUpdateStore((s) => s.lastCheckedAt);
  const update = useUpdateStore((s) => s.update);
  const check = useUpdateStore((s) => s.check);

  // 每 30s 重渲染一下"X 分钟前"
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!isOpen) return;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [isOpen]);

  const isChecking = status === "checking";
  const isDownloading = status === "downloading";
  const hasAvailable = status === "available" && update;

  return (
    <AnimatePresence>
      {isOpen && (
        <React.Fragment>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[200] bg-black/30 backdrop-blur-sm"
            onClick={close}
          />

          <div className="fixed inset-0 z-[210] flex items-end justify-center pointer-events-none sm:items-center">
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="pointer-events-auto flex max-h-[88dvh] w-full flex-col rounded-t-2xl border border-white/60 bg-white/85 shadow-[0_-10px_40px_rgba(0,0,0,0.12)] backdrop-blur-2xl sm:max-h-[80vh] sm:w-[92%] sm:max-w-md sm:rounded-2xl sm:bg-white/70 sm:shadow-[0_20px_60px_rgba(0,0,0,0.12)] dark:border-white/10 dark:bg-slate-800/85 sm:dark:bg-slate-800/60"
            >
              <div className="flex items-center justify-between border-b border-black/5 px-5 py-4 sm:px-6 dark:border-white/5">
                <h2 className="text-lg font-bold text-zinc-800 sm:text-xl dark:text-zinc-100">
                  关于
                </h2>
                <button
                  type="button"
                  onClick={close}
                  aria-label="关闭"
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-black/5 dark:text-zinc-400 dark:hover:bg-white/5"
                >
                  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
                    <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" strokeLinecap="round" />
                  </svg>
                </button>
              </div>

              <div className="flex flex-col gap-5 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
                {/* 应用头部：logo + 名字 */}
                <div className="flex items-center gap-3">
                  <img
                    src="/50EE91C4-396A-4B96-B116-C8B7373D898B.png"
                    alt="Galcode Island"
                    className="h-12 w-12 shrink-0 rounded-2xl object-cover shadow-md shadow-amber-400/35"
                    draggable={false}
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <h3 className="text-base font-bold text-zinc-800 dark:text-zinc-100">
                      Galcode Island
                    </h3>
                    <p className="text-[12px] text-zinc-500 dark:text-zinc-400">
                      二次元风格的 Agent 工作台
                    </p>
                  </div>
                </div>

                {/* 简介 */}
                <p className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-300">
                  由凉宫春日开发组发布。
                </p>

                {/* 版本信息 + 检查更新 */}
                <section className="flex flex-col gap-2 rounded-lg border border-black/5 bg-white/40 p-3 dark:border-white/5 dark:bg-slate-900/30">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-zinc-600 dark:text-zinc-400">当前版本</span>
                    <code className="font-mono text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">
                      v{__APP_VERSION__}
                    </code>
                  </div>
                  {lastCheckedAt && (
                    <div className="flex items-center justify-between text-[11px] text-zinc-500 dark:text-zinc-400">
                      <span>上次检查</span>
                      <span>{relativeTime(lastCheckedAt, now)}</span>
                    </div>
                  )}
                  {hasAvailable && (
                    <div className="rounded border border-amber-300/40 bg-amber-50/60 px-2 py-1.5 text-[11px] text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300">
                      发现新版本{" "}
                      <code className="font-mono font-semibold">v{update.version}</code>{" "}
                      可用
                    </div>
                  )}
                  <div className="flex items-center justify-end gap-2 pt-1">
                    {!isTauri && (
                      <span className="text-[11px] text-zinc-400">仅桌面端可检查</span>
                    )}
                    <button
                      type="button"
                      onClick={() => void check(false)}
                      disabled={!isTauri || isChecking || isDownloading}
                      className="rounded-md border border-sky-400/50 bg-sky-500/10 px-3 py-1 text-[12px] font-medium text-sky-700 transition-all hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-sky-300/40 dark:text-sky-300"
                    >
                      {isChecking ? "检查中…" : isDownloading ? "下载中…" : "立即检查"}
                    </button>
                  </div>
                </section>

                {/* 链接 */}
                <section className="flex flex-col gap-1.5">
                  <button
                    type="button"
                    onClick={() => void openExternal(REPO_URL)}
                    className="flex items-center justify-between rounded-lg border border-black/5 bg-white/40 px-3 py-2.5 text-[13px] text-zinc-700 transition-colors hover:bg-white/70 dark:border-white/5 dark:bg-slate-900/30 dark:text-zinc-200 dark:hover:bg-slate-900/50"
                  >
                    <span className="flex items-center gap-2">
                      <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4">
                        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38v-1.33c-2.22.48-2.69-1.07-2.69-1.07-.36-.92-.89-1.17-.89-1.17-.73-.5.05-.49.05-.49.81.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.83-2.15-.08-.2-.36-1.02.08-2.13 0 0 .67-.21 2.2.82a7.6 7.6 0 014 0c1.53-1.04 2.2-.82 2.2-.82.44 1.11.16 1.93.08 2.13.51.56.83 1.27.83 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.74.54 1.49v2.21c0 .21.15.45.55.38A8 8 0 0016 8c0-4.42-3.58-8-8-8z" />
                      </svg>
                      GitHub 仓库
                    </span>
                    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3 text-zinc-400">
                      <path d="M4 2h6v6M10 2L3 9" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </section>

                {/* 致谢 / 一行小字 */}
                <p className="pt-1 text-center text-[10px] text-zinc-400 dark:text-zinc-500">
                  一个有凉宫春日陪你跑 Agent 的桌面应用
                </p>
              </div>
            </motion.div>
          </div>
        </React.Fragment>
      )}
    </AnimatePresence>
  );
}
