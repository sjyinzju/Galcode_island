// Windows / Linux 原生顶栏：仿 macOS Overlay 风格的自画窗口控件。
//
// 为什么需要：
// - tauri.conf.json 把所有平台 decorations 设为 false（无装饰窗口）；macOS 在
//   lib.rs 里单独 set_decorations(true) 重新打开，红绿灯由系统画在 Overlay 模式
//   的透明 titlebar 上，配合 hiddenTitle 不占整行高度。
// - Windows / Linux 没有这个 Overlay 机制，所以保持完全 borderless，需要自画
//   一条 28px 顶栏，提供两件事：1) 拖窗（含 Linux 兜底），2) 最小化 / 最大化
//   / 关闭三个按钮。
//
// 渲染条件：`isTauri && !isMacOS`。LAN 客户端（浏览器）和 macOS 桌面端都不渲染。
//
// 位置：在 App.tsx 玻璃容器内 absolute top-0 left-0 right-0，跟容器 inset-2
// 桌面边距自然对齐；不用 fixed 避免被祖先 transform 影响 containing block。
// 玻璃容器内的 motion.div 同时 pt-7 把内容下移 28px 让位。
//
// 拖窗双机制：data-tauri-drag-region（Tauri 原生处理，mac/Windows 稳定）+
// onMouseDown startDragging()（Linux WebKitGTK 上 drag-region 经常失效需要 JS
// 兜底）。两者并存时不冲突（startDragging 已在拖即忽略二次调用）。

import { useEffect, useState, type MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "../lib/bridge";

// 跟 SidebarLeft 用同一份 mac 判断逻辑（保持一致行为）。抽公共 helper 留待
// 这种判断在第 3 处出现时再做。
const isMacOS = typeof navigator !== "undefined"
  && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");

export function WindowsTopBar(): JSX.Element | null {
  // 仅 Tauri 非 macOS 渲染。提前 return 让组件树更干净。
  if (!isTauri || isMacOS) return null;

  const appWindow = getCurrentWindow();
  const [isMaximized, setIsMaximized] = useState(false);

  // 监听窗口大小变化推断 max/restore 状态，按钮图标跟着切换。
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    const syncMaximizedState = async (): Promise<void> => {
      try {
        const v = await appWindow.isMaximized();
        if (!cancelled) setIsMaximized(v);
      } catch {
        /* 窗口被销毁等极端情况；按钮状态不变 */
      }
    };
    void syncMaximizedState();
    appWindow
      .onResized(() => {
        void syncMaximizedState();
      })
      .then((fn) => {
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {
        /* listener 挂不上不影响初始状态 */
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [appWindow]);

  const handleDragMouseDown = async (e: MouseEvent<HTMLDivElement>): Promise<void> => {
    if (e.button !== 0) return;
    try {
      await appWindow.startDragging();
    } catch {
      /* 已经在拖 / 窗口已销毁 — 静默 */
    }
  };

  const handleMin = async (): Promise<void> => {
    try { await appWindow.minimize(); } catch { /* noop */ }
  };
  const handleMax = async (): Promise<void> => {
    try { await appWindow.toggleMaximize(); } catch { /* noop */ }
  };
  const handleClose = async (): Promise<void> => {
    try { await appWindow.close(); } catch { /* noop */ }
  };

  return (
    <div
      // absolute（不是 fixed）：fixed 受祖先 transform/filter/backdrop-filter
      // 创建 containing block 的影响，App.tsx 内多处 backdrop-blur-2xl 会让
      // fixed 变成相对玻璃容器定位。直接用 absolute 既绕开这层 quirk 又
      // 自动跟随玻璃容器 sm:inset-2 桌面边距，跟整体视觉一致。
      // z-[60]：高于 MobileTopBar (z-40)、低于 SettingsModal 等弹层 (z-200+)。
      className="absolute top-0 left-0 right-0 z-[60] flex h-7 items-stretch"
    >
      {/* 拖窗区：占满左侧到按钮之前的所有空间 */}
      <div
        data-tauri-drag-region
        onMouseDown={(e) => { void handleDragMouseDown(e); }}
        className="h-full flex-1"
      />

      <button
        type="button"
        onClick={() => { void handleMin(); }}
        aria-label="最小化"
        title="最小化"
        className="flex h-full w-11 items-center justify-center text-zinc-600 transition-colors hover:bg-black/10 dark:text-zinc-300 dark:hover:bg-white/10"
      >
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" className="h-3 w-3">
          <path d="M2 6h8" strokeLinecap="round" />
        </svg>
      </button>

      <button
        type="button"
        onClick={() => { void handleMax(); }}
        aria-label={isMaximized ? "还原" : "最大化"}
        title={isMaximized ? "还原" : "最大化"}
        className="flex h-full w-11 items-center justify-center text-zinc-600 transition-colors hover:bg-black/10 dark:text-zinc-300 dark:hover:bg-white/10"
      >
        {isMaximized ? (
          // 还原图标：两个错开的方框，跟 Win11 一致
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.1" className="h-3 w-3">
            <rect x="3" y="3" width="7" height="7" rx="0.4" />
            <path d="M2 4.5V2.5A0.5 0.5 0 012.5 2H9.5" strokeLinecap="round" />
          </svg>
        ) : (
          // 最大化图标：单个方框
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" className="h-2.5 w-2.5">
            <rect x="2" y="2" width="8" height="8" rx="0.4" />
          </svg>
        )}
      </button>

      <button
        type="button"
        onClick={() => { void handleClose(); }}
        aria-label="关闭"
        title="关闭"
        // close 按钮 hover 时变红 — Fluent / macOS 共同视觉语言
        className="flex h-full w-11 items-center justify-center text-zinc-600 transition-colors hover:bg-rose-500 hover:text-white dark:text-zinc-300"
      >
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" className="h-3 w-3">
          <path d="M3 3l6 6M9 3l-6 6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
