// 个性化弹窗：桌宠预设库的独立入口。
//
// 历史背景：这块功能原本嵌在「全局设置」弹窗的最底部，跟 LLM API / Agent backend
// 几个纯配置项排在一起。但桌宠预设相关功能（切换 / 上传 / 下载 / 编辑）使用频率
// 远高于其它设置项，且交互更"轻"——纯个人喜好类调整不应该藏在多层折叠的设置
// 面板里，于是拆到侧栏一级菜单。
//
// 渲染上直接复用 PetCharacterSection（保留在 settings/ 是因为其依赖
// CommunityPickerModal / UploadAlbumDialog / UploadPromptDialog 也在 settings/，
// 强行迁移收益小）；这个 modal 只做"壳"——背景遮罩 / 弹层动画 / 关闭按钮。
//
// 弹窗宽度：max-w-5xl 容纳两列布局（左 200px 列表 + 右侧 6 类卡片网格）。

import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useUiStore } from "../../stores/useUiStore";
import {
  APP_FONT_SIZE_LABELS,
  useSettingsStore,
  type AppFontSize,
} from "../../stores/useSettingsStore";
import { PetCharacterSection } from "../settings/PetCharacterSection";

const FONT_SIZE_OPTIONS: AppFontSize[] = ["small", "default", "large"];

export function PersonalizationModal(): JSX.Element {
  const isOpen = useUiStore((s) => s.isPersonalizationModalOpen);
  const close = useUiStore((s) => s.closePersonalizationModal);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const setFontSize = useSettingsStore((s) => s.setFontSize);

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

          {/* 桌面端居中弹窗；移动端 < sm 全屏 sheet 风格（边贴边、ribbon 顶 + safe area 底）*/}
          <div className="fixed inset-0 z-[210] flex items-end justify-center pointer-events-none sm:items-center">
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="pointer-events-auto flex h-[92dvh] w-full flex-col rounded-t-2xl border border-white/60 bg-white/85 shadow-[0_-10px_40px_rgba(0,0,0,0.12)] backdrop-blur-2xl sm:h-auto sm:max-h-[88vh] sm:w-[94%] sm:max-w-5xl sm:rounded-2xl sm:bg-white/70 sm:shadow-[0_20px_60px_rgba(0,0,0,0.12)] dark:border-white/10 dark:bg-slate-800/85 sm:dark:bg-slate-800/60 dark:shadow-none"
            >
              <div className="flex items-center justify-between border-b border-black/5 px-5 py-4 sm:px-6 dark:border-white/5">
                <h2 className="text-lg font-bold text-zinc-800 sm:text-xl dark:text-zinc-100">
                  个性化
                </h2>
                <button
                  type="button"
                  onClick={close}
                  aria-label="关闭个性化"
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-black/5 dark:text-zinc-400 dark:hover:bg-white/5"
                >
                  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
                    <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" strokeLinecap="round" />
                  </svg>
                </button>
              </div>

              <div className="flex flex-col gap-6 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
                <section className="flex flex-col gap-3">
                  <header className="flex flex-col gap-0.5">
                    <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
                      字体大小
                    </h3>
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                      调整主界面文字大小，设置会自动保存。
                    </p>
                  </header>

                  <div className="inline-flex w-full rounded-lg border border-black/5 bg-white/45 p-1 dark:border-white/5 dark:bg-slate-800/45 sm:w-fit">
                    {FONT_SIZE_OPTIONS.map((option) => {
                      const active = option === fontSize;
                      return (
                        <button
                          key={option}
                          type="button"
                          onClick={() => setFontSize(option)}
                          aria-pressed={active}
                          className={`min-h-[40px] flex-1 rounded-md px-4 py-2 text-sm font-medium transition-all sm:min-h-0 sm:flex-none ${
                            active
                              ? "bg-sky-500 text-white shadow-sm shadow-sky-400/25"
                              : "text-zinc-600 hover:bg-white/70 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-slate-700/70 dark:hover:text-white"
                          }`}
                        >
                          {APP_FONT_SIZE_LABELS[option]}
                        </button>
                      );
                    })}
                  </div>
                </section>

                <PetCharacterSection />
              </div>

              {/* 所有改动即时生效（切换预设 / 改名 / 加图都直接落 store），不需要保存按钮；
                  底部只留一个"关闭"对齐 SettingsModal 的视觉重量。 */}
              <div
                className="flex justify-end gap-3 border-t border-black/5 px-5 py-3 sm:px-6 sm:py-4 dark:border-white/5"
                style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
              >
                <button
                  type="button"
                  onClick={close}
                  className="min-h-[44px] rounded-lg bg-sky-500 px-5 py-2.5 text-sm font-medium text-white shadow-md shadow-sky-400/25 transition-all hover:bg-sky-600 hover:shadow-sky-400/40 active:bg-sky-700 sm:min-h-0 sm:px-4 sm:py-2"
                >
                  关闭
                </button>
              </div>
            </motion.div>
          </div>
        </React.Fragment>
      )}
    </AnimatePresence>
  );
}
