import { invoke } from "../../lib/bridge";
import { motion, AnimatePresence } from "framer-motion";
import { useActiveTab, useActiveTabActions } from "../../hooks/useActiveTab";
import { useAppStore } from "../../stores/useAppStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { PetCharacter } from "../pet-character/PetCharacter";
import { PermissionModeBadge } from "../PermissionModeBadge";

export function RunningBubble(): JSX.Element {
  const tab = useActiveTab();
  const { activeTabId, reset } = useActiveTabActions();
  const addLogEntry = useAppStore((s) => s.addLogEntry);
  const bubble = tab.bubble;
  const uiState = tab.uiState;
  const mode = tab.mode;
  const petEnabled = useSettingsStore((s) => s.petEnabled);
  const isVisible = uiState === "running" || mode === "thinking" || mode === "working";

  const handleStop = async (): Promise<void> => {
    try {
      await invoke("stop_agent", {
        runId: activeTabId,
        sessionId: tab.sessionId,
      });
      reset();
      addLogEntry({ timestamp: Date.now(), level: "info", message: "已停止当前 tab 的 Agent。" });
    } catch (err) {
      addLogEntry({ timestamp: Date.now(), level: "error", message: `stop: ${String(err)}` });
    }
  };

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          key="running-bubble"
          initial={{ opacity: 0, y: 10, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.95 }}
          transition={{ type: "spring", damping: 22, stiffness: 280 }}
          className="relative w-full rounded-2xl rounded-bl-sm shadow-lg shadow-amber-500/10 dark:shadow-none"
        >
          {/* 真·环绕光效：跟 ResultCard / InputBubble 同款 .glow-frame —— 静止 div
              + 动画 conic-gradient from 角度，详见 index.css */}
          <div aria-hidden="true" className="glow-frame rounded-2xl rounded-bl-sm" />

          {/* Inner glass content container —— 自然高度三段式 */}
          <div className="relative flex w-full flex-col gap-3 rounded-2xl rounded-bl-sm border border-white/60 bg-white/70 p-3 backdrop-blur-2xl sm:p-4 dark:border-white/10 dark:bg-slate-800/60">
            {/* 顶部：状态徽章 + 权限模式 + 停止 */}
            <div className="flex shrink-0 items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.5)] animate-pulse" />
              <span className="truncate text-[11px] font-bold uppercase tracking-wider text-sky-600 sm:text-xs dark:text-sky-400">
                Agent正在全力执行...
              </span>
              <div className="ml-auto flex items-center gap-2">
                {/* 桌面端：把 permission mode 徽章嵌进 RunningBubble 头部，
                    让对话运行中也能随时切换；移动端 MobileTopBar 已有，不重复。 */}
                <div className="hidden sm:block">
                  <PermissionModeBadge compact />
                </div>
                <button
                  type="button"
                  onClick={() => void handleStop()}
                  className="flex min-h-[32px] items-center rounded-md bg-rose-400/15 px-3 text-[12px] font-medium text-rose-500 transition-all hover:-translate-y-0.5 hover:bg-rose-400/25 sm:min-h-0 sm:h-6 sm:px-2 sm:text-[11px] dark:text-rose-300"
                >
                  停止
                </button>
              </div>
            </div>

            {/* 移动端嵌入式：左 桌宠（thinking 立绘）+ 右 进度文字 */}
            <div className="flex shrink-0 items-start gap-3 sm:hidden">
              {petEnabled && (
                <div className="shrink-0">
                  <PetCharacter size="compact" />
                </div>
              )}
              <p className="min-h-[5rem] flex-1 self-stretch text-[14px] font-medium leading-relaxed text-zinc-600 dark:text-zinc-300">
                {bubble || "脑电波同步中..."}
              </p>
            </div>

            {/* 桌面端：进度文字单独行 */}
            <p className="hidden text-sm font-medium leading-relaxed text-zinc-600 sm:block dark:text-zinc-300">
              {bubble || "脑电波同步中..."}
            </p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
