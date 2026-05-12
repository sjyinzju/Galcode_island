// 分支切换浮窗：点 GitPanel 顶部工具栏的"切换分支"按钮弹出本组件。
//
// 行为：
//   - 挂载时拉一次 `git_list_branches`，按 local / remote 分两组显示
//   - 点击非当前分支 → 调 `git_checkout_branch`（remote 自动建 local tracking）
//   - 成功后 onSwitched 回调让父组件刷新 status；失败 onError 把错误冒泡上去
//   - 点击当前分支或外部 → 关闭浮窗
//
// 视觉：fixed 定位，从触发按钮下方 8px 处展开；淡入淡出 framer-motion。
// 风格沿用项目已有 popover/卡片样式（白底/玻璃感、圆角、阴影）。

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { invoke } from "../../lib/bridge";

interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
}

export interface BranchSwitcherProps {
  cwd: string;
  /// 浮窗左上角的相对屏幕坐标（一般来自触发按钮的 getBoundingClientRect）
  anchorRect: { left: number; bottom: number; right: number };
  onClose: () => void;
  /// 切换成功后通知父组件，父组件 refresh status / 重新拉历史
  onSwitched: () => void;
  /// 任意错误冒泡，父组件用统一的 error 栏展示
  onError: (msg: string) => void;
}

export function BranchSwitcher({
  cwd,
  anchorRect,
  onClose,
  onSwitched,
  onError,
}: BranchSwitcherProps): JSX.Element {
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState<string>("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 拉分支列表（仅 mount 时一次）
  useEffect(() => {
    let cancelled = false;
    invoke<GitBranch[]>("git_list_branches", { cwd })
      .then((res) => {
        if (cancelled) return;
        setBranches(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        onError(String(err));
        onClose();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // 故意只在 mount 一次；onError / onClose 引用变化忽略
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  // 点击浮窗外关闭
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      onClose();
    };
    // mousedown 而非 click，避免按钮触发的 click 也命中这条
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // 过滤 + 分组
  const { locals, remotes, current } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filter = (b: GitBranch): boolean => !q || b.name.toLowerCase().includes(q);
    const locals = branches.filter((b) => !b.remote && filter(b));
    const remotes = branches.filter((b) => b.remote && filter(b));
    const current = branches.find((b) => b.current) ?? null;
    return { locals, remotes, current };
  }, [branches, query]);

  const handlePick = async (branch: GitBranch): Promise<void> => {
    if (branch.current) {
      onClose();
      return;
    }
    setBusy(branch.name);
    try {
      await invoke("git_checkout_branch", {
        cwd,
        branch: branch.name,
        remote: branch.remote,
      });
      onSwitched();
      onClose();
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(null);
    }
  };

  // 浮窗位置：触发按钮下方 8px，左对齐到按钮左边；超出右边界时回退到右对齐
  const POPOVER_WIDTH = 240;
  const margin = 8;
  const viewportW = typeof window !== "undefined" ? window.innerWidth : 1024;
  const left = Math.min(anchorRect.left, viewportW - POPOVER_WIDTH - margin);
  const top = anchorRect.bottom + 4;

  return (
    <motion.div
      ref={rootRef}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      style={{ left, top, width: POPOVER_WIDTH }}
      className="fixed z-50 flex max-h-[60vh] flex-col overflow-hidden rounded-lg border border-black/10 bg-white/95 shadow-xl backdrop-blur-md dark:border-white/10 dark:bg-zinc-900/95"
      role="dialog"
    >
      <div className="shrink-0 border-b border-black/5 px-2 py-1.5 dark:border-white/5">
        <input
          type="text"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={current ? `当前: ${current.name}` : "搜索分支…"}
          className="w-full rounded border border-black/10 bg-white/80 px-2 py-1 text-[12px] text-zinc-800 placeholder:text-zinc-400 focus:border-sky-400/50 focus:outline-none focus:ring-0 dark:border-white/10 dark:bg-zinc-800/60 dark:text-zinc-100 dark:placeholder:text-zinc-500"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {loading ? (
          <div className="px-2 py-2 text-center text-[11px] text-zinc-400 dark:text-zinc-500">
            加载分支…
          </div>
        ) : (
          <>
            {locals.length > 0 ? (
              <>
                <div className="px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-zinc-400 dark:text-zinc-500">
                  本地分支
                </div>
                {locals.map((b) => (
                  <BranchRow
                    key={`l:${b.name}`}
                    branch={b}
                    busy={busy === b.name}
                    onPick={() => void handlePick(b)}
                  />
                ))}
              </>
            ) : null}
            {remotes.length > 0 ? (
              <>
                <div className="mt-1 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-zinc-400 dark:text-zinc-500">
                  远端分支
                </div>
                {remotes.map((b) => (
                  <BranchRow
                    key={`r:${b.name}`}
                    branch={b}
                    busy={busy === b.name}
                    onPick={() => void handlePick(b)}
                  />
                ))}
              </>
            ) : null}
            {locals.length === 0 && remotes.length === 0 ? (
              <div className="px-2 py-2 text-center text-[11px] text-zinc-400 dark:text-zinc-500">
                {query ? "没有匹配的分支" : "仓库里没有分支"}
              </div>
            ) : null}
          </>
        )}
      </div>
    </motion.div>
  );
}

function BranchRow({
  branch,
  busy,
  onPick,
}: {
  branch: GitBranch;
  busy: boolean;
  onPick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={busy}
      className={`flex w-full items-center gap-1.5 px-2 py-1 text-left text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        branch.current
          ? "bg-sky-400/10 text-sky-700 dark:text-sky-300"
          : "text-zinc-700 hover:bg-black/5 dark:text-zinc-200 dark:hover:bg-white/5"
      }`}
    >
      <span className={`shrink-0 ${branch.current ? "text-sky-600 dark:text-sky-400" : "text-transparent"}`}>
        ✓
      </span>
      <span className={`min-w-0 flex-1 truncate ${branch.remote ? "text-zinc-500 dark:text-zinc-400" : ""}`}>
        {branch.name}
      </span>
      {busy ? (
        <span className="shrink-0 text-[10px] text-zinc-400 dark:text-zinc-500">切换中…</span>
      ) : null}
    </button>
  );
}
