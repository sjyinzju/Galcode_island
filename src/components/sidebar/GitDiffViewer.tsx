// 通用 diff 浮层：显示 unified diff，含双列行号 + hunk 折叠 + +/- 染色 + shiki 高亮。
//
// 定位：用 React Portal 渲染到 body，超脱侧边栏的窄宽度限制。
//   - 桌面端 (≥ lg)：fixed 定位从 sidebar 右边界 (260px) 向右延伸，宽度 min(60vw,800px)
//   - 移动端 (< lg)：fixed inset-0 占满整个 viewport（保持原"全屏 diff"体验）
// 不带 backdrop —— 让 diff 看着像"溢出"的浮卡，不阻塞用户切其它东西。
// 淡入淡出由 caller 用 AnimatePresence 包裹本组件实现（key 固定，避免切文件时重放动画）。
//
// 不绑定具体 git 命令 —— 调用方通过 loader 函数告知怎么拿 diff（工作区 / 已暂存 /
// 某个 commit / 文件未跟踪），本组件只关心：
//   - title / subtitle    顶栏标题
//   - loader              () => Promise<{ diff, empty }>
//   - loaderKey           变化时重新加载（同一个 viewer 切换文件可以避免每次都重建）
//   - onClose             返回回调
//
// 渲染流水线：
//   diff 文本 → parseUnifiedDiff → DiffFile[]
//   每文件一段 file header
//   每 hunk 一个可折叠 header + 行表
//   每行：旧行号 | 新行号 | 前缀符号 | 内容
//
// 浅 / 暗色都正确：所有 Tailwind 类带 dark: 变体，浅色用浅色面板 + 较深字。
// shiki syntax highlight 留到下一步接入；当前 +/- / context 仅用颜色区分。

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { useAppStore } from "../../stores/useAppStore";
import { parseUnifiedDiff, type DiffFile, type DiffHunk, type DiffLine } from "./diffParser";
import { inferLang } from "./inferLang";

interface GitDiffResult {
  diff: string;
  empty: boolean;
}

/// 单个 shiki token 渲染数据；只关心 React 渲染需要的几个字段。
interface ShikiTok {
  content: string;
  /// 来自 shiki 的颜色（单主题模式下直接用此颜色 inline）
  color?: string;
  /// 'italic' / 'bold' / 'underline' 等
  fontStyle?: number;
}

/// key 形如 `${fileIdx}-${hunkIdx}-${lineIdx}`；用于 token map 查询
type TokenKey = string;

/// shiki highlighter 是重资源（包含主题 + 已加载语言），全模块共享一个实例，
/// 避免每次打开 diff 都重建。Promise 缓存让并发调用复用同一加载流程。
let highlighterPromise: Promise<unknown> | null = null;

async function getHighlighter(): Promise<{
  codeToTokens: (code: string, opt: { lang: string; theme: string }) => { tokens: ShikiTok[][] };
  getLoadedLanguages: () => string[];
  loadLanguage: (lang: string) => Promise<unknown>;
}> {
  if (highlighterPromise) {
    return highlighterPromise as Promise<{
      codeToTokens: (code: string, opt: { lang: string; theme: string }) => { tokens: ShikiTok[][] };
      getLoadedLanguages: () => string[];
      loadLanguage: (lang: string) => Promise<unknown>;
    }>;
  }
  highlighterPromise = (async () => {
    // 动态 import：shiki 体积偏大（含主题 / 语言），lazy load 让首次打开 diff 才下载
    const shiki = await import("shiki");
    return shiki.createHighlighter({
      themes: ["vitesse-light", "vitesse-dark"],
      // 预加载几个最常用语言；其它走 loadLanguage 按需加载
      langs: ["typescript", "tsx", "javascript", "jsx", "rust", "python", "json", "markdown", "bash"],
    });
  })() as Promise<unknown>;
  return highlighterPromise as Promise<{
    codeToTokens: (code: string, opt: { lang: string; theme: string }) => { tokens: ShikiTok[][] };
    getLoadedLanguages: () => string[];
    loadLanguage: (lang: string) => Promise<unknown>;
  }>;
}

/// 对一组解析好的 DiffFile 跑 shiki tokenize，输出 key→tokens map。
/// 性能考虑：每文件整段 tokenize 一次（不是逐行），让 shiki 跨行保持解析状态。
async function tokenizeAllFiles(
  files: DiffFile[],
  theme: "light" | "dark",
): Promise<Map<TokenKey, ShikiTok[]>> {
  const out = new Map<TokenKey, ShikiTok[]>();
  if (files.length === 0) return out;
  const hl = await getHighlighter();
  const themeName = theme === "dark" ? "vitesse-dark" : "vitesse-light";
  for (let fi = 0; fi < files.length; fi += 1) {
    const file = files[fi]!;
    let lang = inferLang(file.path);
    // 未预加载的语言运行时按需 load；shiki 不支持的语言 fallback 到 text
    if (lang !== "text" && !hl.getLoadedLanguages().includes(lang)) {
      try {
        await hl.loadLanguage(lang);
      } catch {
        lang = "text";
      }
    }
    // 把该文件所有 hunk 所有 line 的 content 按出现顺序拼成"伪代码"
    // —— shiki 跨行 tokenize 能保留 string/comment 状态，提高准确度
    const entries: { key: TokenKey; content: string }[] = [];
    for (let hi = 0; hi < file.hunks.length; hi += 1) {
      const hunk = file.hunks[hi]!;
      for (let li = 0; li < hunk.lines.length; li += 1) {
        const line = hunk.lines[li]!;
        if (line.kind === "noeol") continue;
        entries.push({ key: `${fi}-${hi}-${li}`, content: line.content });
      }
    }
    if (entries.length === 0) continue;
    const code = entries.map((e) => e.content).join("\n");
    try {
      const result = hl.codeToTokens(code, { lang, theme: themeName });
      for (let i = 0; i < entries.length; i += 1) {
        out.set(entries[i]!.key, result.tokens[i] ?? []);
      }
    } catch {
      /* tokenize 失败：跳过这个文件，渲染时 fallback 纯文本 */
    }
  }
  return out;
}

export interface GitDiffViewerProps {
  title: string;
  subtitle?: string;
  loader: () => Promise<GitDiffResult>;
  /// 用于驱动 useEffect 重新拉数据的 key（如 `${hash}:${path}`）
  loaderKey: string;
  onClose: () => void;
}

/// 把单行渲染成 React 节点：有 shiki tokens 时按 token 上色，没有时显示纯文本。
/// add/del 行的背景色由父 div 控制；shiki 的颜色作用于文字本身，跟 +/- 背景色叠加。
function renderLineContent(content: string, tokens: ShikiTok[] | undefined): React.ReactNode {
  if (!tokens || tokens.length === 0) return content || " ";
  return tokens.map((tok, i) => (
    <span key={i} style={{ color: tok.color }}>
      {tok.content}
    </span>
  ));
}

/// 单行渲染：双列行号 + 前缀符号 + 内容（含 shiki 高亮）；浅 / 暗主题各一组色。
function DiffLineRow({ line, tokens }: { line: DiffLine; tokens?: ShikiTok[] }): JSX.Element {
  if (line.kind === "noeol") {
    return (
      <div className="px-2 italic text-zinc-400 dark:text-zinc-500">
        \ {line.content || "No newline at end of file"}
      </div>
    );
  }
  // bgCls 给整行加 +/- 背景；前缀 + 行号列保持灰，shiki 颜色作用于内容文字
  let bgCls = "";
  let prefix = " ";
  let prefixCls = "text-zinc-400 dark:text-zinc-500";
  if (line.kind === "add") {
    bgCls = "bg-emerald-500/10";
    prefix = "+";
    prefixCls = "text-emerald-600 dark:text-emerald-400";
  } else if (line.kind === "del") {
    bgCls = "bg-rose-500/10";
    prefix = "-";
    prefixCls = "text-rose-600 dark:text-rose-400";
  }
  return (
    <div className={`flex ${bgCls}`}>
      <span
        className="w-9 shrink-0 select-none border-r border-zinc-200/60 px-1 text-right text-[10px] text-zinc-400 dark:border-zinc-700/60 dark:text-zinc-500"
        aria-label={line.oldLineNo !== null ? `旧行 ${line.oldLineNo}` : undefined}
      >
        {line.oldLineNo ?? ""}
      </span>
      <span
        className="w-9 shrink-0 select-none border-r border-zinc-200/60 px-1 text-right text-[10px] text-zinc-400 dark:border-zinc-700/60 dark:text-zinc-500"
        aria-label={line.newLineNo !== null ? `新行 ${line.newLineNo}` : undefined}
      >
        {line.newLineNo ?? ""}
      </span>
      <span className={`w-4 shrink-0 select-none px-1 ${prefixCls}`}>{prefix}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-all px-1">
        {renderLineContent(line.content, tokens)}
      </span>
    </div>
  );
}

/// 数个 hunk 行的 + / - 统计，用在折叠态 header 摘要
function hunkStats(hunk: DiffHunk): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of hunk.lines) {
    if (l.kind === "add") add += 1;
    else if (l.kind === "del") del += 1;
  }
  return { add, del };
}

interface HunkBlockProps {
  hunk: DiffHunk;
  /// 该 hunk 在 file 数组里的 (fi, hi) — 用来从 tokenMap 取每行 tokens
  fileIdx: number;
  hunkIdx: number;
  tokenMap: Map<TokenKey, ShikiTok[]>;
  collapsed: boolean;
  onToggle: () => void;
}

function HunkBlock({ hunk, fileIdx, hunkIdx, tokenMap, collapsed, onToggle }: HunkBlockProps): JSX.Element {
  const { add, del } = useMemo(() => hunkStats(hunk), [hunk]);
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 border-y border-zinc-200/70 bg-zinc-100/70 px-2 py-1 text-left font-mono text-[10px] text-amber-700 transition-colors hover:bg-zinc-200/70 dark:border-zinc-700/60 dark:bg-zinc-800/60 dark:text-amber-300 dark:hover:bg-zinc-800"
        title={collapsed ? "展开" : "折叠"}
      >
        <span className="shrink-0 text-zinc-400 dark:text-zinc-500">
          {collapsed ? "▶" : "▼"}
        </span>
        <span className="min-w-0 flex-1 truncate">{hunk.header}</span>
        <span className="shrink-0 font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
          <span className="text-emerald-600 dark:text-emerald-400">+{add}</span>
          {" "}
          <span className="text-rose-600 dark:text-rose-400">−{del}</span>
        </span>
      </button>
      {collapsed
        ? null
        : hunk.lines.map((line, li) => (
            <DiffLineRow
              key={li}
              line={line}
              tokens={tokenMap.get(`${fileIdx}-${hunkIdx}-${li}`)}
            />
          ))}
    </div>
  );
}

export function GitDiffViewer({
  title,
  subtitle,
  loader,
  loaderKey,
  onClose,
}: GitDiffViewerProps): JSX.Element {
  const theme = useAppStore((s) => s.theme);
  const [diff, setDiff] = useState<string>("");
  const [empty, setEmpty] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  // 折叠状态：key = `${fileIdx}-${hunkIdx}`；不存在 = 默认展开
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // shiki 高亮 tokens —— 异步加载，加载中 / 失败时渲染 fallback 纯文本
  const [tokenMap, setTokenMap] = useState<Map<TokenKey, ShikiTok[]>>(new Map());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCollapsed(new Set()); // 切换文件时重置折叠状态
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

  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);

  // 异步跑 shiki 高亮；切主题或换文件都重跑。失败 / 加载中时 tokenMap 为空，
  // DiffLineRow 退化为纯文本渲染——视觉上无副作用，只是没颜色。
  useEffect(() => {
    if (files.length === 0) {
      setTokenMap(new Map());
      return;
    }
    let cancelled = false;
    void (async () => {
      const next = await tokenizeAllFiles(files, theme);
      if (!cancelled) setTokenMap(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [files, theme]);

  /// 全部折叠 / 全部展开 —— 当 diff 文件多时方便用户一键聚焦
  const totalHunks = useMemo(() => files.reduce((n, f) => n + f.hunks.length, 0), [files]);
  const allCollapsed = totalHunks > 0 && collapsed.size >= totalHunks;
  const toggleAll = (): void => {
    if (allCollapsed) {
      setCollapsed(new Set());
    } else {
      const all = new Set<string>();
      files.forEach((f, fi) => f.hunks.forEach((_, hi) => all.add(`${fi}-${hi}`)));
      setCollapsed(all);
    }
  };

  const toggleHunk = (key: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // 进/退场动画：从 sidebar 右边滑入一点（x:-8），同时淡入；exit 反向。caller 用
  // AnimatePresence 包裹本组件让 exit 动画生效。
  // 定位：桌面端 (lg) 从 left=260px 起、宽 min(60vw,800px)；移动端全屏（覆盖 sidebar drawer 之上）。
  // z-40 高于 sidebar(z-30)、低于 SettingsModal(z-200)。
  return createPortal(
    <motion.div
      key="git-diff-viewer-root"
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -8 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="
        fixed inset-0 z-40 flex flex-col bg-white/95 backdrop-blur-md shadow-2xl
        lg:inset-y-0 lg:left-[260px] lg:right-auto lg:w-[min(60vw,800px)]
        lg:border-r lg:border-black/10
        dark:bg-zinc-900/95 dark:lg:border-white/10
      "
    >
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
        {totalHunks > 1 ? (
          <button
            type="button"
            onClick={toggleAll}
            className="shrink-0 rounded border border-zinc-300/60 px-1.5 py-0.5 text-[10px] text-zinc-600 transition-colors hover:bg-black/5 hover:text-zinc-800 dark:border-zinc-600/60 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-zinc-200"
          >
            {allCollapsed ? "全部展开" : "全部折叠"}
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-white font-mono text-[11px] leading-relaxed dark:bg-zinc-900">
        {loading ? (
          <div className="p-4 text-center text-zinc-400 dark:text-zinc-500">加载中…</div>
        ) : error ? (
          <div className="p-4 text-rose-600 dark:text-rose-400">读取失败：{error}</div>
        ) : empty || files.length === 0 ? (
          <div className="p-4 text-center text-zinc-400 dark:text-zinc-500">无变更</div>
        ) : (
          files.map((file, fi) => (
            <div key={`${fi}-${file.path}`} className="border-b border-zinc-200/60 last:border-b-0 dark:border-zinc-700/60">
              {/* 文件头：路径 + flag 标签 */}
              <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-zinc-200/70 bg-zinc-100/90 px-2 py-1 backdrop-blur-sm dark:border-zinc-700/60 dark:bg-zinc-800/90">
                <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-zinc-700 dark:text-zinc-200" title={file.path}>
                  {file.path || "(无文件名)"}
                </span>
                {file.flags.map((f) => (
                  <span
                    key={f}
                    className="shrink-0 rounded bg-sky-400/15 px-1 py-px font-mono text-[9px] text-sky-700 dark:bg-sky-400/15 dark:text-sky-300"
                  >
                    {f}
                  </span>
                ))}
              </div>
              {file.flags.includes("binary") && file.hunks.length === 0 ? (
                <div className="px-3 py-2 text-[11px] italic text-zinc-500 dark:text-zinc-400">
                  二进制文件，无法显示 diff
                </div>
              ) : null}
              {file.hunks.map((hunk, hi) => {
                const key = `${fi}-${hi}`;
                return (
                  <HunkBlock
                    key={key}
                    hunk={hunk}
                    fileIdx={fi}
                    hunkIdx={hi}
                    tokenMap={tokenMap}
                    collapsed={collapsed.has(key)}
                    onToggle={() => toggleHunk(key)}
                  />
                );
              })}
            </div>
          ))
        )}
      </div>
    </motion.div>,
    document.body,
  );
}
