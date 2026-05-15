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
// 位置：用 createPortal 挂到 document.body。
// 之前尝试过 absolute in glass container（z-60）和 fixed in main（z-100），
// 都被侧边栏穿透 — Tauri WebView 上 fixed 元素的 stacking 在多层
// transform/backdrop-filter 嵌套下表现不可预测，侧边栏 fixed z-30 实际跑到
// 比 main 还外层。挂到 body 之后 WindowsTopBar 的 stacking ancestor 就是
// 文档根，谁也跑不出去；只要 z-index 比侧边栏 30 高，必然在上。
// 桌面端 sm:inset-2 + h-7 跟玻璃容器顶部 8px 边距对齐。
// motion.div 的 pt-7 让位仍然需要（避免内容被 fixed 顶栏盖住 28px）。
//
// 拖窗：仅挂 data-tauri-drag-region，Tauri 自己处理 mousedown→startDragging
// 与双击→toggleMaximize 两件事。**不要叠加 onMouseDown startDragging()**：
// 那会让双击 #2 的 mousedown 又启动一次 drag，把 drag-region 刚触发的最大化
// 立刻通过 drag mode 还原回去 — 视觉上就是"跳一下缩回去"的那个 bug。
// Linux WebKitGTK 上 drag-region 历史上不稳定，如果将来有用户报告再用平台
// 探测条件挂 onMouseDown 兜底，先优先保证 mac/Windows 双击正常。

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
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

  const handleMin = async (): Promise<void> => {
    try { await appWindow.minimize(); } catch { /* noop */ }
  };
  const handleMax = async (): Promise<void> => {
    try { await appWindow.toggleMaximize(); } catch { /* noop */ }
  };
  const handleClose = async (): Promise<void> => {
    try { await appWindow.close(); } catch { /* noop */ }
  };

  // 用 portal 挂到 document.body，让 WindowsTopBar 完全脱离 React 组件树
  // 在 DOM 上的祖先，stacking ancestor 直接是文档根 — 不受任何 transform /
  // backdrop-filter / motion.div / glass container 的 stacking 嵌套影响。
  // z-[100] 仍然保留（虽然 body 内基本无对手，留余量给同样挂 body 的弹层
  // 维持顺序），SettingsModal 等 z-[200+] 仍盖得住。
  return createPortal(
    <div
      // 窄屏 top-0 left-0 right-0；桌面端 sm:top-2 sm:left-2 sm:right-2 跟
      // 玻璃容器 sm:inset-2 边距对齐，视觉上嵌入玻璃容器顶部。
      className="fixed top-0 left-0 right-0 z-[100] flex h-7 items-stretch sm:top-2 sm:left-2 sm:right-2"
    >
      {/* 拖窗区：data-tauri-drag-region 自己处理拖窗 + 双击最大化，不挂 JS handler */}
      <div data-tauri-drag-region className="h-full flex-1" />

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
    </div>,
    document.body
  );
}
