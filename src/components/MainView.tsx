// 三栏布局的中栏：流式区 / Overview + Pet/Bubble/ResultCard。
//
// 项目导航 / agent 切换 / 项目路径选择 都在左栏 SidebarLeft 接管，
// 所以中栏不再放 header，全部空间留给流式区。
//
// 上半部分按状态切换：
//   - 没有活动 tab → GlobalOverview（替代旧 WelcomeView）
//   - 有 tab 但还没跑过任何 turn 且 cliBlocks 为空 → ProjectOverview
//   - 其它 → StatusMonitor（流式区）
// 下半部分：InputBubble / RunningBubble / ResultCard 跟过去一致。

import { AnimatePresence, motion } from "framer-motion";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useActiveTab, useActiveTabId } from "../hooks/useActiveTab";
import { PetCharacter } from "./pet-character/PetCharacter";

import { InputBubble } from "./chat-bubble/InputBubble";
import { ResultCard } from "./chat-bubble/ResultCard";
import { RunningBubble } from "./chat-bubble/RunningBubble";
import { StatusMonitor } from "./status-monitor/StatusMonitor";
import { GlobalOverview } from "./overview/GlobalOverview";
import { ProjectOverview } from "./overview/ProjectOverview";

export function MainView(): JSX.Element {
  const tab = useActiveTab();
  const activeTabId = useActiveTabId();
  const uiState = tab.uiState;
  const mode = tab.mode;
  const cliBlockCount = tab.cliBlocks.length;
  // 完成后保留 StatusMonitor 让 BlockStream 历史可见，跟 ResultCard 共存。
  const showStatus =
    uiState === "running" ||
    mode === "working" ||
    mode === "thinking" ||
    cliBlockCount > 0;
  // 没有活动 tab → 走全局概览（替代旧 WelcomeView 整屏画面）；
  // 此时下方的 InputBubble / RunningBubble / ResultCard 都不渲染，
  // 用户通过 Overview 内置的"选择项目目录"按钮启动第一个 tab。
  const showGlobalOverview = !activeTabId;
  // 有 tab 但还没跑过任何 turn → 显示项目概览，让中栏不再空荡
  const showProjectOverview = !showGlobalOverview && !showStatus;

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.42, ease: "easeOut" }}
      // 桌面端 pt-7 给 SidebarLeft 顶部 28px drag bar 留位置；移动端没 drag bar
      // 由 MobileTopBar sticky 占位，MainView 直接从 pt-2 起步即可。
      // pb 移动端额外加 env(safe-area-inset-bottom) 给 iPhone home indicator 让位
      // —— 否则卡片底部输入框会被刘海/底栏遮挡。
      className="flex h-full w-full flex-col gap-2 px-2 pt-2 sm:gap-3 sm:px-4 sm:pt-3"
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      {/* 上半部分：按状态切换 GlobalOverview / ProjectOverview / StatusMonitor。
          AnimatePresence 用 wait 模式做柔和切换，避免三种视图叠加闪烁。 */}
      {/* 桌面端拖拽条，对应 SidebarLeft 顶部 28px */}
      <div data-tauri-drag-region
           onMouseDown={async (e) => { if (e.button !== 0) return; try { await getCurrentWindow().startDragging(); } catch {} }} className="hidden lg:block shrink-0 h-7 w-full" />
      <AnimatePresence mode="wait">
        {showGlobalOverview ? (
          <motion.div
            key="global-overview-wrap"
            initial={{ opacity: 0, scale: 0.99 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.99 }}
            transition={{ duration: 0.22 }}
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            <GlobalOverview />
          </motion.div>
        ) : showProjectOverview ? (
          <motion.div
            key="project-overview-wrap"
            initial={{ opacity: 0, scale: 0.99 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.99 }}
            transition={{ duration: 0.22 }}
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            <ProjectOverview />
          </motion.div>
        ) : (
          <motion.div
            key="status-monitor"
            initial={{ opacity: 0, height: 0, scale: 0.98 }}
            animate={{ opacity: 1, height: "auto", scale: 1 }}
            exit={{ opacity: 0, height: 0, scale: 0.98 }}
            transition={{ duration: 0.3 }}
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            <StatusMonitor />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Pet & Bubble Interaction Area —— shrink-0 自然高度，不抢上半部分空间。
          桌面端：外层桌宠 + 气泡横排；移动端：外层桌宠隐藏（嵌入卡片头部）。
          卡片内部 summary 自带 max-h-[35vh] cap，避免长内容撑爆。
          没有活动 tab 时整块隐藏 —— 此时由 GlobalOverview 提供启动入口。 */}
      {!showGlobalOverview && (
        <div className="relative flex w-full shrink-0 flex-col items-stretch gap-2 sm:flex-row sm:items-end sm:gap-3 sm:min-h-[220px]">
          <div className="hidden shrink-0 sm:block">
            <PetCharacter />
          </div>

          <div className="flex w-full flex-col sm:flex-1 sm:translate-y-3">
            <AnimatePresence mode="wait">
              {uiState === "idle" && (mode === "idle" || !mode) && (
                <InputBubble key="input-bubble" />
              )}

              {showStatus && uiState !== "done" && uiState !== "error" && (
                <RunningBubble key="running-bubble" />
              )}

              {(uiState === "done" || uiState === "error" || mode === "complete" || mode === "suggestion" || mode === "error") && (
                <ResultCard key="result-card" />
              )}
            </AnimatePresence>
          </div>
        </div>
      )}
    </motion.section>
  );
}
