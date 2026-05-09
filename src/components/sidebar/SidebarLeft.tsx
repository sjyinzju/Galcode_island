// 三栏布局的左栏：上下结构
//   - 顶部 28px drag bar：mac 上给 traffic lights 让位 + 整条可拖窗；
//     非 mac 上整条可拖 + 右侧嵌入 −/□/× 三连窗口控制按钮（GlobalTopBar 已删除，
//     窗口控制只能寄生在这里）
//   - 上：导航菜单（"所有项目" / "历史会话" / "搜索"切换中部视图）
//   - 中：按 useUiStore.leftSidebarView 切换显示 ProjectTree / HistoryList / SearchPanel
//   - 下：主题 / 设置 / 个人档案

import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MouseEvent } from "react";
import { isTauri } from "../../lib/bridge";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useAppStore } from "../../stores/useAppStore";
import { useUiStore } from "../../stores/useUiStore";
import { useTabsStore } from "../../stores/useTabsStore";
import { useProfileStore } from "../../stores/useProfileStore";
import { useAboutStore } from "../../stores/useAboutStore";
import { ProjectTree } from "./ProjectTree";
import { HistoryList } from "./HistoryList";
import { SearchPanel } from "./SearchPanel";
import { GitPanel } from "./GitPanel";

const isMacOS = typeof navigator !== "undefined"
  && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");

interface MenuButtonProps {
  label: string;
  icon: JSX.Element;
  onClick?: () => void;
  active?: boolean;
}

function MenuButton({ label, icon, onClick, active }: MenuButtonProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={`flex h-11 w-full items-center gap-2.5 rounded-md px-2 text-[14px] font-medium transition-colors sm:h-8 sm:gap-2 sm:text-[12px] ${
        active
          ? "bg-sky-400/15 text-sky-700 dark:bg-sky-400/15 dark:text-sky-200"
          : "text-zinc-600 hover:bg-black/5 dark:text-zinc-300 dark:hover:bg-white/5"
      }`}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-500 dark:text-zinc-400">
        {icon}
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}

export function SidebarLeft(): JSX.Element {
  const openSettingsModal = useSettingsStore((s) => s.openSettingsModal);
  const openProfileModal = useProfileStore((s) => s.openProfileModal);
  const openAboutModal = useAboutStore((s) => s.openAboutModal);
  const profileNickname = useProfileStore((s) => s.nickname);
  const theme = useAppStore((s) => s.theme);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const leftSidebarView = useUiStore((s) => s.leftSidebarView);
  const setLeftSidebarView = useUiStore((s) => s.setLeftSidebarView);
  const historyCount = useTabsStore((s) => s.history.length);
  // 浏览器（LAN 客户端）模式下没有 Tauri 窗口，getCurrentWindow 调用会抛错
  // —— 用 null 标记跳过窗口控制 UI / drag 行为
  const appWindow = isTauri ? getCurrentWindow() : null;
  const closeMobileLeftDrawer = useUiStore((s) => s.closeMobileLeftDrawer);

  const handleDragMouseDown = async (event: MouseEvent<HTMLDivElement>): Promise<void> => {
    if (!appWindow) return;
    if (event.button !== 0) return;
    try {
      await appWindow.startDragging();
    } catch (error) {
      console.error("Failed to start dragging window", error);
    }
  };

  return (
    <aside
      // 移动端抽屉：fixed inset-y-0 全高 z-30，但 MobileTopBar (z-40) 会盖住顶部
      // → 给 aside 加 pt = header 高度（2.75rem 基础 + env(safe-area-inset-top) 刘海）
      // 让菜单内容从 header 下方开始；底部 pb env(safe-area-inset-bottom) 避开 home
      // indicator。桌面端 lg+ 这两个值自动归零（lg:pt-0 lg:pb-0），不影响内嵌布局。
      className="flex h-full w-full shrink-0 flex-col border-r border-black/5 bg-white/85 backdrop-blur-md
                 pt-[calc(2.75rem_+_env(safe-area-inset-top))]
                 pb-[env(safe-area-inset-bottom)]
                 lg:w-[260px] lg:bg-white/35 lg:pt-0 lg:pb-0
                 dark:border-white/5 dark:bg-zinc-900/85 lg:dark:bg-zinc-900/30"
    >
      {/* 顶部 28px drag/控制条 —— 替代被删掉的 GlobalTopBar；
          浏览器（LAN）模式下窗口控制无意义，改成抽屉关闭按钮 */}
      <div className="flex h-7 shrink-0 items-center">
        {isTauri && isMacOS && <div className="h-full w-[72px] shrink-0" />}
        {isTauri && (
          <div
            data-tauri-drag-region
            onMouseDown={(event) => { void handleDragMouseDown(event); }}
            className="h-full flex-1"
          />
        )}
        {!isTauri && (
          <>
            <div className="h-full flex-1" />
            <button
              type="button"
              onClick={closeMobileLeftDrawer}
              aria-label="收起侧边栏"
              className="mr-1 flex h-5 w-6 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-black/10 dark:text-zinc-400 dark:hover:bg-white/10 lg:hidden"
            >
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3">
                <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" strokeLinecap="round" />
              </svg>
            </button>
          </>
        )}
        {isTauri && !isMacOS && (
          <div className="flex items-center gap-0.5 pr-1">
            <button
              type="button"
              onClick={async () => {
                try { if (appWindow) await appWindow.minimize(); }
                catch (error) { console.error("Failed to minimize", error); }
              }}
              className="flex h-5 w-6 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-black/10 dark:text-zinc-400 dark:hover:bg-white/10"
              aria-label="最小化窗口"
            >
              -
            </button>
            <button
              type="button"
              onClick={async () => {
                try { if (appWindow) await appWindow.toggleMaximize(); }
                catch (error) { console.error("Failed to toggle maximize", error); }
              }}
              className="flex h-5 w-6 items-center justify-center rounded text-[10px] text-zinc-500 transition-colors hover:bg-black/10 dark:text-zinc-400 dark:hover:bg-white/10"
              aria-label="最大化窗口"
            >
              □
            </button>
            <button
              type="button"
              onClick={async () => {
                try { if (appWindow) await appWindow.close(); }
                catch (error) { console.error("Failed to close", error); }
              }}
              className="flex h-5 w-6 items-center justify-center rounded text-rose-500 transition-colors hover:bg-rose-400/15 dark:text-rose-300"
              aria-label="关闭窗口"
            >
              ×
            </button>
          </div>
        )}
      </div>

      {/* 顶部菜单：紧贴 drag bar 下方（pt-0），让第一个按钮顶部 y === drag bar
          底边（28px），跟中栏 pt-7 起点对齐，避免左侧出现一段空白 */}
      <div className="flex flex-col gap-0.5 border-b border-black/5 px-2 pb-2 dark:border-white/5">
        <MenuButton
          label="所有项目"
          active={leftSidebarView === "projects"}
          onClick={() => setLeftSidebarView("projects")}
          icon={
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="h-3.5 w-3.5">
              <path d="M2 4h6l1 1.5h5v6.5a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" />
            </svg>
          }
        />
        <MenuButton
          label={historyCount > 0 ? `历史会话 (${historyCount})` : "历史会话"}
          active={leftSidebarView === "history"}
          onClick={() => setLeftSidebarView("history")}
          icon={
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="h-3.5 w-3.5">
              <circle cx="8" cy="8" r="6" />
              <path d="M8 5v3l2 1.5" strokeLinecap="round" />
            </svg>
          }
        />
        <MenuButton
          label="Git"
          active={leftSidebarView === "git"}
          onClick={() => setLeftSidebarView("git")}
          icon={
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="h-3.5 w-3.5">
              <circle cx="4" cy="4" r="1.5" />
              <circle cx="4" cy="12" r="1.5" />
              <circle cx="12" cy="6" r="1.5" />
              <path d="M4 5.5v5M5.5 4h5a2 2 0 012 2" strokeLinecap="round" />
            </svg>
          }
        />
        <MenuButton
          label="搜索"
          active={leftSidebarView === "search"}
          onClick={() => setLeftSidebarView("search")}
          icon={
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="h-3.5 w-3.5">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5L13.5 13.5" strokeLinecap="round" />
            </svg>
          }
        />
      </div>

      {/* 中部按 view 切换 */}
      {leftSidebarView === "history" ? (
        <HistoryList />
      ) : leftSidebarView === "search" ? (
        <SearchPanel />
      ) : leftSidebarView === "git" ? (
        <GitPanel />
      ) : (
        <ProjectTree />
      )}

      {/* 底部菜单 */}
      <div className="flex flex-col gap-0.5 border-t border-black/5 px-2 py-2 dark:border-white/5">
        <MenuButton
          label={theme === "dark" ? "切换浅色" : "切换深色"}
          onClick={toggleTheme}
          icon={
            theme === "dark" ? (
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="h-3.5 w-3.5">
                <circle cx="8" cy="8" r="3" />
                <path
                  strokeLinecap="round"
                  d="M8 1.5v1.5M8 13v1.5M14.5 8H13M3 8H1.5M12.5 3.5l-1 1M4.5 11.5l-1 1M12.5 12.5l-1-1M4.5 4.5l-1-1"
                />
              </svg>
            ) : (
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="h-3.5 w-3.5">
                <path d="M14 8.5A6 6 0 117.5 2a4.5 4.5 0 006.5 6.5z" strokeLinejoin="round" />
              </svg>
            )
          }
        />
        <MenuButton
          label="设置"
          onClick={openSettingsModal}
          icon={
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="h-3.5 w-3.5">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6.9 2.2c.3-1.2 2-1.2 2.2 0a1.1 1.1 0 001.7.7c1-.6 2.2.6 1.6 1.6a1.1 1.1 0 00.7 1.7c1.2.3 1.2 2 0 2.2a1.1 1.1 0 00-.7 1.7c.6 1-.6 2.2-1.6 1.6a1.1 1.1 0 00-1.7.7c-.3 1.2-2 1.2-2.2 0a1.1 1.1 0 00-1.7-.7c-1 .6-2.2-.6-1.6-1.6a1.1 1.1 0 00-.7-1.7c-1.2-.3-1.2-2 0-2.2a1.1 1.1 0 00.7-1.7c-.6-1 .6-2.2 1.6-1.6.7.4 1.5.1 1.7-.7z"
              />
              <circle cx="8" cy="8" r="2" />
            </svg>
          }
        />
        <MenuButton
          label={profileNickname.trim() ? `个人档案 · ${profileNickname.slice(0, 8)}` : "个人档案"}
          onClick={openProfileModal}
          icon={
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="h-3.5 w-3.5">
              <circle cx="8" cy="6" r="2.5" />
              <path d="M3 13c0-2.4 2.2-4 5-4s5 1.6 5 4" strokeLinecap="round" />
            </svg>
          }
        />
        <MenuButton
          label="关于"
          onClick={openAboutModal}
          icon={
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="h-3.5 w-3.5">
              <circle cx="8" cy="8" r="6.2" />
              <path d="M8 7.5v3.5" strokeLinecap="round" />
              <circle cx="8" cy="5.2" r="0.6" fill="currentColor" stroke="none" />
            </svg>
          }
        />
      </div>
    </aside>
  );
}
