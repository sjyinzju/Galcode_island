// 通用 diff 浮层：覆盖中栏，单色等宽，按 +/- 染色。
//
// 不绑定具体 git 命令 —— 调用方通过 loader 函数告知怎么拿 diff（工作区 / 已暂存 /
// 某个 commit / 文件未跟踪），本组件只关心：
//   - title / subtitle    顶栏标题
//   - loader              () => Promise<{ diff, empty }>
//   - loaderKey           变化时重新加载（同一个 viewer 切换文件可以避免每次都重建）
//   - onClose             返回回调

import { useEffect, useMemo, useState } from "react";

interface GitDiffResult {
  diff: string;
  empty: boolean;
}

export interface GitDiffViewerProps {
  title: string;
  subtitle?: string;
  loader: () => Promise<GitDiffResult>;
  /// 用于驱动 useEffect 重新拉数据的 key（如 `${hash}:${path}`）
  loaderKey: string;
  onClose: () => void;
}

export function GitDiffViewer({
  title,
  subtitle,
  loader,
  loaderKey,
  onClose,
}: GitDiffViewerProps): JSX.Element {
  const [diff, setDiff] = useState<string>("");
  const [empty, setEmpty] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loader()
      .then((res) => {
        if (cancelled) return;
        setDiff(res.diff);
        setEmpty(res.empty);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // loaderKey 变化驱动重新加载；loader 函数引用变化忽略
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaderKey]);

  const lines = useMemo(() => {
    return diff.split("\n").map((line, i) => {
      let cls = "text-zinc-300";
      if (line.startsWith("+++") || line.startsWith("---")) cls = "text-zinc-400";
      else if (line.startsWith("+")) cls = "bg-emerald-500/10 text-emerald-300";
      else if (line.startsWith("-")) cls = "bg-rose-500/10 text-rose-300";
      else if (line.startsWith("@@")) cls = "text-amber-300";
      else if (line.startsWith("diff ")) cls = "text-sky-300";
      return (
        <div key={i} className={`px-2 ${cls}`}>
          {line || " "}
        </div>
      );
    });
  }, [diff]);

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-white/95 backdrop-blur-md dark:bg-zinc-900/95">
      <div className="flex shrink-0 items-center gap-2 border-b border-black/5 px-3 py-2 dark:border-white/5">
        <button
          type="button"
          onClick={onClose}
          aria-label="返回"
          className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-black/5 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-zinc-100"
        >
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-3 w-3">
            <path d="M7.5 2.5L4 6l3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-zinc-800 dark:text-zinc-100" title={title}>
            {title}
          </div>
          {subtitle ? (
            <div className="truncate text-[10px] text-zinc-500 dark:text-zinc-400" title={subtitle}>
              {subtitle}
            </div>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-zinc-900 font-mono text-[11px] leading-relaxed">
        {loading ? (
          <div className="p-4 text-center text-zinc-400">加载中…</div>
        ) : error ? (
          <div className="p-4 text-rose-400">读取失败：{error}</div>
        ) : empty ? (
          <div className="p-4 text-center text-zinc-400">无变更</div>
        ) : (
          <div className="py-1">{lines}</div>
        )}
      </div>
    </div>
  );
}
