// Permission mode 徽章 + 下拉选择器。
//
// 显示位置：
//   - MobileTopBar 右侧（紧凑徽章，点开切换）
//   - 桌面端 InputBubble / RunningBubble 上方（同组件，自动复用样式）
//
// 仅 claude-code backend 渲染；其它 backend 不显示（hidden / null 由调用方决定）。
// 切到 bypassPermissions 时给出一次性提示，避免误触。

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { useActiveTab, useActiveTabActions } from "../hooks/useActiveTab";
import { useAppStore } from "../stores/useAppStore";
import type { PermissionMode } from "../types/agent";

interface ModeMeta {
  value: PermissionMode;
  label: string;
  short: string;
  description: string;
  /// tailwind 颜色组合（背景 / 边框 / 文字）；浅深色都覆盖
  palette: string;
}

const MODE_META: readonly ModeMeta[] = [
  {
    value: "default",
    label: "default",
    short: "DEFAULT",
    description: "每次工具调用都弹审批卡",
    palette:
      "bg-zinc-100/80 text-zinc-700 border-zinc-300/60 dark:bg-zinc-700/30 dark:text-zinc-200 dark:border-zinc-500/40",
  },
  {
    value: "acceptEdits",
    label: "acceptEdits",
    short: "ACCEPT",
    description: "自动放行编辑类工具",
    palette:
      "bg-sky-100/80 text-sky-700 border-sky-300/60 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-400/40",
  },
  {
    value: "plan",
    label: "plan",
    short: "PLAN",
    description: "先列计划再执行",
    palette:
      "bg-violet-100/80 text-violet-700 border-violet-300/60 dark:bg-violet-500/15 dark:text-violet-300 dark:border-violet-400/40",
  },
  {
    value: "auto",
    label: "auto",
    short: "AUTO",
    description: "classifier 把关，不弹审批（需 v2.1.83+/付费计划）",
    palette:
      "bg-emerald-100/80 text-emerald-700 border-emerald-300/60 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-400/40",
  },
  {
    value: "bypassPermissions",
    label: "bypassPermissions",
    short: "BYPASS",
    description: "完全跳过审批（危险）",
    palette:
      "bg-rose-100/80 text-rose-700 border-rose-300/60 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-400/40",
  },
];

interface PermissionModeBadgeProps {
  /// 紧凑模式（mobile top bar）— 只显示 short 文案，pad 更小
  compact?: boolean;
}

export function PermissionModeBadge({ compact = false }: PermissionModeBadgeProps): JSX.Element | null {
  const tab = useActiveTab();
  const { activeTabId, update } = useActiveTabActions();
  const addLogEntry = useAppStore((s) => s.addLogEntry);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const hasWarnedBypassRef = useRef(false);

  // 下拉走 portal 渲染到 document.body：badge 多嵌在 ResultCard / 各种 bubble
  // 内部，这些容器普遍带 overflow-hidden rounded-2xl 切角，absolute 下拉会
  // 被祖先 overflow 裁切。portal + fixed 视口坐标定位绕开所有 overflow 限制。
  //
  // anchorRect 跟踪 button 的 viewport 位置 + 视窗高度；resize / 祖先滚动时同步。
  interface AnchorRect {
    left: number;
    right: number;
    top: number;
    bottom: number;
    viewportHeight: number;
  }
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  // 下拉展开方向：下方空间不足且上方更宽裕时翻转向上。打开瞬间根据 anchor 决定。
  const [dropUp, setDropUp] = useState(false);
  const PANEL_ESTIMATED_HEIGHT = 280;

  // 打开时测量 button viewport 坐标 + 监听 resize / 祖先滚动同步重算
  useEffect(() => {
    if (!open) return;
    const updateAnchor = (): void => {
      const btn = buttonRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setAnchor({
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        viewportHeight: window.innerHeight,
      });
    };
    updateAnchor();
    // 仅在打开瞬间决定上 / 下方向，避免下拉展开后又随滚动反复翻转视觉抖动
    const btn = buttonRef.current;
    if (btn) {
      const r = btn.getBoundingClientRect();
      const spaceBelow = window.innerHeight - r.bottom;
      const spaceAbove = r.top;
      setDropUp(spaceBelow < PANEL_ESTIMATED_HEIGHT && spaceAbove > spaceBelow);
    }
    window.addEventListener("resize", updateAnchor);
    window.addEventListener("scroll", updateAnchor, true);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && buttonRef.current) {
      ro = new ResizeObserver(updateAnchor);
      ro.observe(buttonRef.current);
    }
    return () => {
      window.removeEventListener("resize", updateAnchor);
      window.removeEventListener("scroll", updateAnchor, true);
      ro?.disconnect();
    };
  }, [open]);

  // 点击外部关闭：只检查 containerRef（badge button）是否包含 target。
  // panel 在 portal 下渲染（脱离 React 父子链对 DOM contains 仍然有效），
  // 为避开"portal 节点不在 containerRef 子树"导致点选项被误判成外部点击，
  // panel 自己用 stopPropagation 拦截 click —— 这样这里只需要判 badge 自己。
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);

  const onPick = useCallback(
    (value: PermissionMode) => {
      setOpen(false);
      if (!activeTabId) return;
      update({ permissionMode: value });
      if (value === "bypassPermissions" && !hasWarnedBypassRef.current) {
        hasWarnedBypassRef.current = true;
        addLogEntry({
          timestamp: Date.now(),
          level: "warn",
          message:
            "已切到 bypassPermissions：Claude Code 将不再请求工具审批。请仅在可信任务下使用。",
        });
      }
    },
    [activeTabId, addLogEntry, update]
  );

  // 仅 claude-code 渲染
  if (!activeTabId || tab.agent !== "claude-code") return null;

  const current = MODE_META.find((m) => m.value === tab.permissionMode) ?? MODE_META[0];

  return (
    <div ref={containerRef} className="relative inline-flex">
      <motion.button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.96 }}
        aria-label={`切换 permission mode（当前：${current.label}）`}
        title={`${current.description}\n快捷键：Shift+Tab 循环切换`}
        className={`inline-flex items-center gap-1 rounded-md border ${current.palette} font-mono font-semibold tracking-wider transition-colors ${
          compact ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-1 text-[10px]"
        }`}
      >
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
        {compact ? current.short : current.label}
        <svg viewBox="0 0 8 5" className="h-1.5 w-2 opacity-60" aria-hidden>
          <path d="M0 0l4 5 4-5z" fill="currentColor" />
        </svg>
      </motion.button>

      {/* 下拉走 portal 渲染到 body：避开 ResultCard 等容器的 overflow-hidden 裁切。
          不嵌进 AnimatePresence —— framer-motion 12 的 AnimatePresence 直接子元素
          要求是 motion component，包了 createPortal 返回的 Portal 类型后可能
          影响 ref 注入与点击事件正常工作。这里牺牲 exit 动画换稳定。 */}
      {open &&
        anchor &&
        createPortal(
          <motion.div
            // 拦掉 click 冒泡：document 上 native 注册的关闭 listener 看不到 panel
            // 内点击，不会误把 onPick 当外部点击。注意必须用 e.nativeEvent —
            // React 17+ 用 root 委托，synthetic event 的 stopPropagation 拦不住
            // native bubble 到 document 的事件流。
            onClick={(e) => e.nativeEvent.stopPropagation()}
            initial={{ opacity: 0, y: dropUp ? 4 : -4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.12 }}
            className="fixed z-50 w-56 overflow-hidden rounded-lg border border-black/10 bg-white/95 shadow-lg backdrop-blur dark:border-white/10 dark:bg-slate-900/95"
            // 水平：right 对齐到 anchor 右边（保持原 `right-0` 视觉）
            // 垂直：dropUp 时 bottom 贴到 anchor 顶部上方 4px；否则 top 贴到 anchor 底部下方 4px
            style={{
              right: window.innerWidth - anchor.right,
              ...(dropUp
                ? { bottom: anchor.viewportHeight - anchor.top + 4 }
                : { top: anchor.bottom + 4 }),
            }}
            role="listbox"
          >
            {MODE_META.map((m) => {
              const active = m.value === current.value;
              return (
                <button
                  key={m.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => onPick(m.value)}
                  className={`flex w-full flex-col items-start gap-0.5 border-l-2 px-2.5 py-1.5 text-left text-xs transition-colors ${
                    active
                      ? "border-sky-400 bg-sky-50/60 dark:bg-sky-500/10"
                      : "border-transparent hover:bg-zinc-100/70 dark:hover:bg-slate-800/70"
                  }`}
                >
                  <span className="font-mono text-[11px] font-semibold text-zinc-800 dark:text-zinc-100">
                    {m.label}
                  </span>
                  <span className="text-[10px] leading-tight text-zinc-500 dark:text-zinc-400">
                    {m.description}
                  </span>
                </button>
              );
            })}
            <div className="border-t border-black/5 px-2.5 py-1 text-[10px] text-zinc-400 dark:border-white/5 dark:text-zinc-500">
              快捷键：Shift+Tab 循环切换
            </div>
          </motion.div>,
          document.body
        )}
    </div>
  );
}
