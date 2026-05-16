// 通用分页栏：上一页 / 第 N 页 / 下一页 + 跳转输入 + 总页数显示。
// 受控组件：父组件持有 page state，本组件只负责输入校验和触发 onChange。
//
// 跨平台：纯 DOM input + button，mac/win/Linux 行为一致。
// 数字输入用 type="number" + min/max 让浏览器自带的 +/- 在 win 上也能用。

import { useEffect, useState } from "react";

export interface PaginationBarProps {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
  /// 是否禁用（正加载时父组件传 true）
  disabled?: boolean;
}

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

export function PaginationBar({
  page,
  totalPages,
  onChange,
  disabled = false,
}: PaginationBarProps): JSX.Element {
  // jump 输入框是独立的 "草稿"，让用户能边打字边校验，回车 / blur 时再 commit
  const [draft, setDraft] = useState<string>(String(page));
  useEffect(() => {
    setDraft(String(page));
  }, [page]);

  const safeTotal = Math.max(1, totalPages);
  const atFirst = page <= 1;
  const atLast = page >= safeTotal;

  const commitJump = (): void => {
    const n = clampInt(Number.parseInt(draft, 10), 1, safeTotal);
    setDraft(String(n));
    if (n !== page) onChange(n);
  };

  return (
    <div className="flex items-center justify-center gap-1.5 py-3 text-[11px] text-zinc-600 dark:text-zinc-300">
      <button
        type="button"
        onClick={() => onChange(page - 1)}
        disabled={disabled || atFirst}
        className="rounded-md border border-black/10 bg-white/80 px-2.5 py-1 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:bg-slate-800/60 dark:hover:bg-slate-800"
      >
        ←
      </button>
      <span className="px-1">
        第
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={safeTotal}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitJump}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitJump();
            }
          }}
          disabled={disabled || safeTotal === 1}
          aria-label="页码"
          className="mx-1 w-12 rounded border border-black/10 bg-white px-1.5 py-0.5 text-center outline-none focus:border-sky-400 disabled:opacity-50 dark:border-white/10 dark:bg-slate-800"
        />
        / {safeTotal} 页
      </span>
      <button
        type="button"
        onClick={() => onChange(page + 1)}
        disabled={disabled || atLast}
        className="rounded-md border border-black/10 bg-white/80 px-2.5 py-1 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:bg-slate-800/60 dark:hover:bg-slate-800"
      >
        →
      </button>
    </div>
  );
}
