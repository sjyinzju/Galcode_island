// 移动端顶栏：< lg 断点时显示，桌面端隐藏。
//
// 三块布局：
//   - 左：汉堡 → 切换 SidebarLeft 抽屉
//   - 中：当前 active tab 的项目目录 basename + 当前任务摘要
//   - 右：设置图标
//
// 高度 44px；safe-area-top 让刘海屏不顶到状态栏。

import { useSettingsStore } from "../stores/useSettingsStore";
import { useTabsStore } from "../stores/useTabsStore";
import { useUiStore } from "../stores/useUiStore";
import { PermissionModeBadge } from "./PermissionModeBadge";

export function MobileTopBar(): JSX.Element {
  const toggleDrawer = useUiStore((s) => s.toggleMobileLeftDrawer);
  const openSettings = useSettingsStore((s) => s.openSettingsModal);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const tab = useTabsStore((s) => (activeTabId ? s.tabs[activeTabId] ?? null : null));

  const title =
    (tab?.lastUserPrompt && tab.lastUserPrompt.trim()) ||
    (tab?.task && tab.task.trim().slice(0, 40)) ||
    tab?.title ||
    "Galcode Island";
  const subtitle = tab?.projectPath ? basename(tab.projectPath) : "未选择项目";

  return (
    <header
      className="lg:hidden sticky top-0 z-40 flex shrink-0 items-center gap-2 border-b border-black/5 bg-white/70 px-2 backdrop-blur-md dark:border-white/5 dark:bg-slate-900/70"
      // sticky + min-h 让 safe-area-top 计入容器高度，下方主区不会被刘海遮挡
      style={{
        paddingTop: "env(safe-area-inset-top)",
        minHeight: "calc(2.75rem + env(safe-area-inset-top))",
      }}
    >
      <button
        type="button"
        onClick={toggleDrawer}
        aria-label="打开侧边栏"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-700 transition-colors hover:bg-black/5 active:bg-black/10 dark:text-zinc-200 dark:hover:bg-white/5"
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          className="h-4 w-4"
        >
          <path d="M2 4h12M2 8h12M2 12h12" strokeLinecap="round" />
        </svg>
      </button>

      <div className="min-w-0 flex-1">
        <div
          className="truncate text-sm font-semibold leading-tight text-zinc-800 dark:text-zinc-100"
          title={title}
        >
          {title}
        </div>
        <div className="truncate text-[10px] leading-tight text-zinc-500 dark:text-zinc-400">
          {subtitle}
        </div>
      </div>

      <PermissionModeBadge compact />

      <button
        type="button"
        onClick={openSettings}
        aria-label="打开设置"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-700 transition-colors hover:bg-black/5 active:bg-black/10 dark:text-zinc-200 dark:hover:bg-white/5"
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          className="h-4 w-4"
        >
          <circle cx="8" cy="8" r="2.4" />
          <path
            d="M8 1.5v1.7M8 12.8v1.7M14.5 8h-1.7M3.2 8H1.5M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2M12.6 12.6l-1.2-1.2M4.6 4.6L3.4 3.4"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </header>
  );
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}
