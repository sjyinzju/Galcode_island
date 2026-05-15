// Permission mode 徽章 + 下拉选择器。
//
// 显示位置：
//   - MobileTopBar 右侧（紧凑徽章，点开切换）
//   - 桌面端 InputBubble / RunningBubble 上方（同组件，自动复用样式）
//
// 仅 claude-code backend 渲染；其它 backend 不显示（hidden / null 由调用方决定）。
// 切到 bypassPermissions 时给出一次性提示，避免误触。

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
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
    short: "DEFAULT ⚠",
    description:
      "工具调用需要审批 — 但本应用尚未实现内联审批 UI，Claude CLI 在 stream-json 模式下会直接拒绝所有工具调用。推荐用 auto / acceptEdits / bypassPermissions。",
    palette:
      "bg-amber-50/80 text-amber-700 border-amber-300/60 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-500/40",
  },
  {
    value: "auto",
    label: "auto",
    short: "AUTO",
    description: "Auto Mode（同 acceptEdits 实际行为；保留桌面版同名档位）",
    palette:
      "bg-amber-100/80 text-amber-700 border-amber-300/60 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-400/40",
  },
  {
    value: "acceptEdits",
    label: "acceptEdits",
    short: "ACCEPT",
    description: "自动接受所有编辑（写文件 / Edit / Patch）",
    palette:
      "bg-sky-100/80 text-sky-700 border-sky-300/60 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-400/40",
  },
  {
    value: "plan",
    label: "plan",
    short: "PLAN",
    description: "Plan Mode：先列计划再执行，需 ExitPlanMode",
    palette:
      "bg-violet-100/80 text-violet-700 border-violet-300/60 dark:bg-violet-500/15 dark:text-violet-300 dark:border-violet-400/40",
  },
  {
    value: "bypassPermissions",
    label: "bypassPermissions",
    short: "BYPASS",
    description: "完全跳过审批 — 危险，请谨慎",
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
  const hasWarnedBypassRef = useRef(false);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
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

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-lg border border-black/10 bg-white/95 shadow-lg backdrop-blur dark:border-white/10 dark:bg-slate-900/95"
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
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
