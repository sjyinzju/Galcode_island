// 左栏中部的 "Git" 视图：当前 active tab 的 projectPath 仓库面板。
//
// 数据流：
//   - 进入面板 + 切 tab + 手动刷新 → invoke("git_status", { cwd })
//   - 列表分三组：Staged / Changes / Untracked，每行 hover 出 stage/unstage/discard 操作
//   - 点击文件 → invoke("git_diff", { cwd, path, staged, untracked }) → 弹出全屏 diff 浮层
//   - 底部按钮：仿 VSCode 二合一 ——
//       有变更 → "提交"（按 stageAll 一次性提交；空 message 时 disabled）
//       无变更但 ahead/behind ≠ 0 → "同步更改"（先 pull --ff-only 再 push）
//       都没有 → 按钮 disabled，提示"已是最新"
//   - 顶部工具栏：刷新 / 历史图表（toggle 切换中部内容为 GitHistoryGraph，淡入淡出过渡）
//
// 设计：仓库列表轮询不主动开（避免没人看的 tab 也轮询）；面板可见时挂一个 6s 间隔
// 的 setInterval 自动刷新，足够同步外部 git 操作（用户切回来也能看到最新状态）。
//
// 样式遵循 ProjectTree / HistoryList：圆角卡片、白底/暗色玻璃感、灰边。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { invoke } from "../../lib/bridge";
import { useActiveTabField, useActiveTabId } from "../../hooks/useActiveTab";
import { BranchSwitcher } from "./BranchSwitcher";
import { GitDiffViewer } from "./GitDiffViewer";
import { GitHistoryGraph } from "./GitHistoryGraph";

interface GitFileEntry {
  path: string;
  indexStatus: string;
  workStatus: string;
  untracked: boolean;
  staged: boolean;
}

interface GitStatus {
  isRepo: boolean;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileEntry[];
}

interface GitDiffResult {
  diff: string;
  empty: boolean;
}

interface GitCommitResult {
  commitHash: string;
  summary: string;
}

interface GitPushResult {
  stdout: string;
  stderr: string;
}

/// 把 porcelain 状态字符翻成中文友好标签 + 颜色。
function statusInfo(file: GitFileEntry): { label: string; cls: string } {
  if (file.untracked) {
    return { label: "U", cls: "text-emerald-600 dark:text-emerald-400" };
  }
  // 优先看工作区状态（用户视角下"未 stage 的改动"更直观）
  const c = file.workStatus !== " " && file.workStatus !== "." ? file.workStatus : file.indexStatus;
  switch (c) {
    case "M":
      return { label: "M", cls: "text-amber-600 dark:text-amber-400" };
    case "A":
      return { label: "A", cls: "text-emerald-600 dark:text-emerald-400" };
    case "D":
      return { label: "D", cls: "text-rose-600 dark:text-rose-400" };
    case "R":
      return { label: "R", cls: "text-sky-600 dark:text-sky-400" };
    case "C":
      return { label: "C", cls: "text-sky-600 dark:text-sky-400" };
    default:
      return { label: c.trim() || "?", cls: "text-zinc-500 dark:text-zinc-400" };
  }
}

interface FileRowProps {
  file: GitFileEntry;
  onClick: () => void;
  /// 仅剩"放弃改动"——stage / unstage 已从 UI 移除（提交时永远 add -A，
  /// 用户不需要在 commit 前显式 stage）
  onDiscard?: () => void;
}

function FileRow({ file, onClick, onDiscard }: FileRowProps): JSX.Element {
  const info = statusInfo(file);
  // 只显示 basename 作为主标题，目录路径作副标题
  const idx = file.path.lastIndexOf("/");
  const name = idx >= 0 ? file.path.slice(idx + 1) : file.path;
  const dir = idx >= 0 ? file.path.slice(0, idx) : "";
  return (
    <div
      onClick={onClick}
      className="group relative flex cursor-pointer items-center gap-1.5 rounded-md border border-white/40 bg-white/40 px-2 py-1.5 text-[12px] text-zinc-700 transition-all hover:bg-white/70 sm:text-[11px] dark:border-white/10 dark:bg-zinc-800/40 dark:text-zinc-300 dark:hover:bg-zinc-800/65"
      role="button"
      title={file.path}
    >
      <span className={`shrink-0 font-mono text-[10px] font-bold ${info.cls}`}>{info.label}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium leading-tight">{name}</div>
        {dir ? (
          <div className="truncate text-[10px] text-zinc-400 dark:text-zinc-500">{dir}</div>
        ) : null}
      </div>
      {/* hover 操作区 —— 仅"放弃改动"按钮 */}
      {onDiscard ? (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDiscard();
            }}
            aria-label="放弃改动"
            title="放弃改动"
            className="flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:bg-rose-400/15 hover:text-rose-500 dark:text-zinc-400 dark:hover:text-rose-400"
          >
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-2.5 w-2.5">
              <path d="M2.5 4h7M5 6.5v2M7 6.5v2M3.5 4l.5 5.5h4l.5-5.5M4.5 4V2.5h3V4" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ) : null}
    </div>
  );
}

type ViewMode = "changes" | "history";

export function GitPanel(): JSX.Element {
  const projectPath = useActiveTabField("projectPath");
  const activeTabId = useActiveTabId();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState<string>("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [viewingFile, setViewingFile] = useState<GitFileEntry | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("changes");
  /// 用单调递增的 key 让历史图表知道何时该重新拉取（每次 commit / sync / 切分支后 +1）
  const [historyReloadKey, setHistoryReloadKey] = useState<number>(0);
  // 切 tab 时上一份 status 立刻失效，避免短暂闪现旧仓库数据
  const requestSeqRef = useRef(0);
  // 分支切换浮窗：anchor 记录"切换分支"按钮的位置，让浮窗定位到按钮正下方
  const [branchPickerAnchor, setBranchPickerAnchor] = useState<DOMRect | null>(null);
  const branchBtnRef = useRef<HTMLButtonElement | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!projectPath) {
      setStatus(null);
      setError(null);
      return;
    }
    const seq = ++requestSeqRef.current;
    setLoading(true);
    try {
      const res = await invoke<GitStatus>("git_status", { cwd: projectPath });
      if (seq !== requestSeqRef.current) return;
      setStatus(res);
      setError(null);
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      setStatus(null);
      setError(String(err));
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [projectPath]);

  // 进入面板 / 切 tab 立即拉取一次
  useEffect(() => {
    void refresh();
  }, [refresh, activeTabId]);

  // 面板可见期间每 6s 自动刷新一次（外部 git 操作也能同步过来）
  useEffect(() => {
    if (!projectPath) return;
    const id = window.setInterval(() => {
      void refresh();
    }, 6000);
    return () => window.clearInterval(id);
  }, [projectPath, refresh]);

  // actionFeedback 自动 3s 后清掉
  useEffect(() => {
    if (!actionFeedback) return;
    const id = window.setTimeout(() => setActionFeedback(null), 3000);
    return () => window.clearTimeout(id);
  }, [actionFeedback]);

  // 仿 VSCode：所有改动（modified / added / deleted / untracked）统一在一个分组里，
  // 类型靠左侧 M/A/D/U 状态徽标区分。同一 path 即使 staged + unstaged 双行也只显示一次。
  const files = useMemo(() => {
    if (!status) return [] as GitFileEntry[];
    const seen = new Set<string>();
    const out: GitFileEntry[] = [];
    for (const f of status.files) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      out.push(f);
    }
    // 按文件路径字典序排序——稳定输出，跟 VSCode 一致
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }, [status]);

  const handleAction = async (
    name: string,
    fn: () => Promise<void>,
    successMsg?: string,
  ): Promise<void> => {
    setBusyAction(name);
    setError(null);
    try {
      await fn();
      if (successMsg) setActionFeedback(successMsg);
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyAction(null);
    }
  };

  /// 唯一保留的文件级操作：放弃单文件改动。stage / unstage 已从 UI 移除——
  /// 提交时永远 git add -A，用户不再需要"先暂存再提交"的两步式工作流。
  const discardFile = (file: GitFileEntry): Promise<void> =>
    handleAction(`discard:${file.path}`, async () => {
      if (!projectPath) return;
      const msg = file.untracked
        ? `删除未跟踪文件 ${file.path}？此操作不可撤销。`
        : `放弃 ${file.path} 的工作区改动？此操作不可撤销。`;
      if (!window.confirm(msg)) throw new Error("已取消");
      await invoke("git_discard", {
        cwd: projectPath,
        path: file.path,
        untracked: file.untracked,
      });
    });

  const doCommit = async (): Promise<void> => {
    if (!projectPath || !commitMessage.trim()) return;
    await handleAction(
      "commit",
      async () => {
        // stageAll 永远 true：提交工作流不再分"先暂存再提交"两步。
        const res = await invoke<GitCommitResult>("git_commit", {
          cwd: projectPath,
          message: commitMessage,
          stageAll: true,
        });
        setCommitMessage("");
        setActionFeedback(`已提交 ${res.commitHash.slice(0, 7)}：${res.summary}`);
        setHistoryReloadKey((k) => k + 1);
      },
    );
  };

  /// 让 LLM 基于 staged diff 生成 commit message —— 跟"AI 工作台"产品定位契合。
  /// 后端守护：staged 空 / LLM 未配置 都会返回 Err，handleAction 自动转 setError 展示。
  /// 前端 disabled 条件再加一道：stagedCount === 0 时按钮变灰 + tooltip 提示。
  const doGenerateCommitMessage = async (): Promise<void> => {
    if (!projectPath) return;
    await handleAction(
      "generate-commit",
      async () => {
        const msg = await invoke<string>("git_generate_commit_message", { cwd: projectPath });
        setCommitMessage(msg);
        setActionFeedback("✓ AI 生成完成，可直接编辑或点提交");
      },
    );
  };

  /// VSCode 风格的"同步更改"：先 pull --ff-only 再 push，一键双向。
  /// 上游不存在 / 没有改动等情况用 status 里的 ahead/behind 决定走哪一支：
  ///   - 没有 upstream → 仅 push（git 会自动提示设置 upstream，失败时把 stderr 透出去）
  ///   - behind > 0 → 先拉再推
  ///   - 否则直接 push
  const doSync = (): Promise<void> =>
    handleAction(
      "sync",
      async () => {
        if (!projectPath) return;
        const hasUpstream = !!status?.upstream;
        const behind = status?.behind ?? 0;
        const ahead = status?.ahead ?? 0;
        const messages: string[] = [];
        if (hasUpstream && behind > 0) {
          await invoke("git_pull", { cwd: projectPath });
          messages.push(`已拉取 ${behind} 个提交`);
        }
        if (!hasUpstream || ahead > 0) {
          const res = await invoke<GitPushResult>("git_push", { cwd: projectPath });
          const note = res.stderr.trim() || res.stdout.trim();
          messages.push(note || (ahead > 0 ? `已推送 ${ahead} 个提交` : "已推送"));
        }
        if (messages.length === 0) messages.push("已是最新");
        setActionFeedback(messages.join(" · "));
        setHistoryReloadKey((k) => k + 1);
      },
    );

  // ── 渲染分支 ──
  if (!projectPath) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-[11px] text-zinc-400 dark:text-zinc-500">
        请先在「所有项目」里选择一个项目目录
      </div>
    );
  }

  if (status && !status.isRepo) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-[11px] text-zinc-400 dark:text-zinc-500">
        <div>当前目录不是 Git 仓库</div>
        <div className="text-[10px] text-zinc-400 dark:text-zinc-500">{projectPath}</div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="mt-2 rounded border border-zinc-300/70 px-2 py-1 text-zinc-500 transition-colors hover:border-sky-400/50 hover:text-sky-600 dark:border-zinc-700/70 dark:hover:border-sky-300/40 dark:hover:text-sky-300"
        >
          重试
        </button>
      </div>
    );
  }

  const totalFiles = files.length;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* 顶部信息条：分支 + ahead/behind + 工具栏 */}
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-black/5 px-2 py-2 dark:border-white/5">
        <div className="flex items-center gap-1.5">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="h-3.5 w-3.5 shrink-0 text-zinc-500 dark:text-zinc-400">
            <circle cx="4" cy="4" r="1.5" />
            <circle cx="4" cy="12" r="1.5" />
            <circle cx="12" cy="6" r="1.5" />
            <path d="M4 5.5v5M5.5 4h5a2 2 0 012 2" strokeLinecap="round" />
          </svg>
          <span
            className="min-w-0 flex-1 truncate text-[12px] font-medium text-zinc-700 dark:text-zinc-200"
            title={status?.branch ?? ""}
          >
            {status?.branch || "—"}
          </span>
          {status && (status.ahead > 0 || status.behind > 0) && (
            <span className="shrink-0 rounded bg-zinc-200/60 px-1 py-0.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-700/60 dark:text-zinc-300">
              {status.ahead > 0 ? `↑${status.ahead}` : ""}
              {status.ahead > 0 && status.behind > 0 ? " " : ""}
              {status.behind > 0 ? `↓${status.behind}` : ""}
            </span>
          )}
        </div>
        {/* 工具栏：切换分支 / 历史图表 等分剩余宽度；刷新缩成纯图标固定在最右 */}
        <div className="flex items-center gap-0.5">
          <button
            ref={branchBtnRef}
            type="button"
            onClick={() => {
              if (branchPickerAnchor) {
                setBranchPickerAnchor(null);
                return;
              }
              const rect = branchBtnRef.current?.getBoundingClientRect();
              if (rect) setBranchPickerAnchor(rect);
            }}
            title="切换分支"
            className={`flex h-6 flex-1 items-center justify-center gap-1 rounded text-[11px] transition-colors ${
              branchPickerAnchor
                ? "bg-sky-400/15 text-sky-700 dark:bg-sky-400/15 dark:text-sky-200"
                : "text-zinc-500 hover:bg-black/5 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-zinc-200"
            }`}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="h-3 w-3">
              <circle cx="4" cy="3.5" r="1.4" />
              <circle cx="4" cy="12.5" r="1.4" />
              <circle cx="12" cy="8" r="1.4" />
              <path d="M4 5v6M5.5 3.5h5a2 2 0 012 2v1M5.5 12.5h5a2 2 0 002-2V9.5" strokeLinecap="round" />
            </svg>
            切换分支
          </button>
          <button
            type="button"
            onClick={() => setViewMode((m) => (m === "history" ? "changes" : "history"))}
            title={viewMode === "history" ? "返回更改列表" : "查看提交历史图"}
            className={`flex h-6 flex-1 items-center justify-center gap-1 rounded text-[11px] transition-colors ${
              viewMode === "history"
                ? "bg-sky-400/15 text-sky-700 dark:bg-sky-400/15 dark:text-sky-200"
                : "text-zinc-500 hover:bg-black/5 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-zinc-200"
            }`}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="h-3 w-3">
              <circle cx="4" cy="3.5" r="1.4" />
              <circle cx="4" cy="12.5" r="1.4" />
              <circle cx="11.5" cy="8" r="1.4" />
              <path d="M4 5v6M5.4 3.5h4.7a2 2 0 012 2v0.5M5.4 12.5h4.7a2 2 0 002-2V10" strokeLinecap="round" />
            </svg>
            历史图表
          </button>
          {/* 刷新：紧凑图标按钮，占固定 24px 宽，不与左侧两按钮抢空间 */}
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            title="刷新状态"
            aria-label="刷新状态"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-black/5 hover:text-zinc-700 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-white/5 dark:hover:text-zinc-200"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className={`h-3 w-3 ${loading ? "animate-spin" : ""}`}>
              <path d="M2.5 8a5.5 5.5 0 019.6-3.6M13.5 8a5.5 5.5 0 01-9.6 3.6" strokeLinecap="round" />
              <path d="M11.5 2v2.5h-2.5M4.5 14v-2.5h2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* 错误 / 反馈条 */}
      {error ? (
        <div className="shrink-0 border-b border-rose-300/30 bg-rose-50/70 px-3 py-1.5 text-[11px] text-rose-700 dark:border-rose-300/20 dark:bg-rose-400/10 dark:text-rose-300">
          {error}
        </div>
      ) : null}
      {actionFeedback ? (
        <div className="shrink-0 border-b border-emerald-300/30 bg-emerald-50/70 px-3 py-1.5 text-[11px] text-emerald-700 dark:border-emerald-300/20 dark:bg-emerald-400/10 dark:text-emerald-300">
          {actionFeedback}
        </div>
      ) : null}

      {/* 中部内容：changes 视图 与 history 视图 叠加，opacity 切换实现淡入淡出 */}
      <div className="relative min-h-0 flex-1">
        <div
          className={`absolute inset-0 flex flex-col gap-3 overflow-y-auto px-2 py-2 transition-opacity duration-300 ${
            viewMode === "changes" ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
        {totalFiles === 0 ? (
          <div className="flex flex-1 items-center justify-center text-center text-[11px] text-zinc-400 dark:text-zinc-500">
            工作区干净，暂无变更
          </div>
        ) : null}

        {/* 仿 VSCode：所有改动统一在一个"更改"分组里，类型用左侧 M/A/D/U 徽标区分；
            按 path 去重，按字典序排序。提交时永远 git add -A，用户无需分组操作。 */}
        {totalFiles > 0 ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between px-1">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400 dark:text-zinc-500">
                更改 {totalFiles}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              {files.map((file) => (
                <FileRow
                  key={file.path}
                  file={file}
                  // 文件点击查看 diff —— 用工作区视角（staged=false 让 git_diff 走
                  // git diff 而非 git diff --cached，等价于"我会提交的所有改动"）
                  onClick={() => setViewingFile({ ...file, staged: false })}
                  onDiscard={() => void discardFile(file)}
                />
              ))}
            </div>
          </div>
        ) : null}
        </div>

        {/* 历史图表视图：与 changes 叠在同一容器，不渲染时仍保持 mounted 让淡出动画完整 */}
        <div
          className={`absolute inset-0 flex flex-col transition-opacity duration-300 ${
            viewMode === "history" ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          {projectPath ? (
            <GitHistoryGraph cwd={projectPath} reloadKey={historyReloadKey} />
          ) : null}
        </div>
      </div>

      {/* 提交 / 同步区 —— 仿 VSCode 单按钮二合一：
          - 有任何改动 → 显示"提交"，需要 commit message；按 stageAll 一次性提交
          - 没改动但 ahead/behind ≠ 0 → 显示"同步更改"
          - 全都没有 → 按钮 disabled，仅作占位 */}
      {(() => {
        const ahead = status?.ahead ?? 0;
        const behind = status?.behind ?? 0;
        const canSync = totalFiles === 0 && (ahead > 0 || behind > 0);
        const showSync = canSync;
        const buttonLabel = showSync
          ? busyAction === "sync"
            ? "同步中…"
            : "同步更改"
          : busyAction === "commit"
            ? "提交中…"
            : "提交";
        const buttonDisabled = busyAction !== null
          || (showSync ? false : (totalFiles === 0 || !commitMessage.trim()));
        const buttonOnClick = (): void => {
          if (showSync) void doSync();
          else void doCommit();
        };

        return (
          <div className="shrink-0 border-t border-black/5 px-2 py-2 dark:border-white/5">
            {/* AI 生成 commit message：仅 commit 模式 + 有任何改动时可点。
                disabled 时 tooltip 解释原因，避免用户疑惑"为什么不能点" */}
            {!showSync && (
              <div className="mb-1 flex items-center justify-end">
                <button
                  type="button"
                  onClick={() => void doGenerateCommitMessage()}
                  disabled={busyAction !== null || totalFiles === 0}
                  title={
                    totalFiles === 0
                      ? "工作区没有任何改动，先动两笔代码再来生成"
                      : "基于工作区所有改动让 LLM 生成 conventional commit message"
                  }
                  className="flex items-center gap-1 rounded border border-sky-400/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 transition-colors hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-40 dark:border-sky-300/30 dark:bg-sky-400/10 dark:text-sky-300 dark:hover:bg-sky-400/20"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className={`h-3 w-3 ${busyAction === "generate-commit" ? "animate-spin" : ""}`}>
                    <path d="M8 1.5l1.3 3.4L12.7 6 9.3 7.1 8 10.5 6.7 7.1 3.3 6l3.4-1.1L8 1.5zM12.5 9.5l.7 1.8 1.8.5-1.8.5-.7 1.7-.7-1.7-1.8-.5 1.8-.5.7-1.8z" />
                  </svg>
                  {busyAction === "generate-commit" ? "生成中…" : "AI 生成"}
                </button>
              </div>
            )}
            <textarea
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder={
                showSync
                  ? "工作区干净 — 按下方按钮可推/拉同步"
                  : "输入提交信息（Cmd/Ctrl + Enter 提交），或点上方「AI 生成」"
              }
              rows={2}
              disabled={showSync}
              onKeyDown={(e) => {
                if (showSync) return;
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && commitMessage.trim()) {
                  e.preventDefault();
                  void doCommit();
                }
              }}
              className={`w-full resize-none rounded-md border border-white/40 bg-white/40 px-2 py-1.5 text-[12px] text-zinc-800 placeholder:text-zinc-400 focus:border-sky-400/45 focus:outline-none focus:ring-0 dark:border-white/10 dark:bg-zinc-800/40 dark:text-zinc-100 dark:placeholder:text-zinc-500 ${
                showSync ? "cursor-not-allowed opacity-60" : ""
              }`}
            />
            <div className="mt-1 flex items-center justify-between gap-1.5">
              {showSync ? (
                <span className="shrink-0 font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                  {behind > 0 ? `↓${behind}` : ""}
                  {ahead > 0 && behind > 0 ? " " : ""}
                  {ahead > 0 ? `↑${ahead}` : ""}
                </span>
              ) : (
                // 占位：让"提交"按钮保持右对齐；总数提示放这里给用户感知影响范围
                <span className="shrink-0 text-[10px] text-zinc-400 dark:text-zinc-500">
                  {totalFiles > 0 ? `将提交 ${totalFiles} 个文件的改动` : ""}
                </span>
              )}
              <button
                type="button"
                onClick={buttonOnClick}
                disabled={buttonDisabled}
                className="flex items-center gap-1 rounded-md bg-sky-500/85 px-3 py-1 text-[11px] font-medium text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-500 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-500"
              >
                {showSync ? (
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={`h-3 w-3 ${busyAction === "sync" ? "animate-spin" : ""}`}>
                    <path d="M2.5 8a5.5 5.5 0 019.6-3.6M13.5 8a5.5 5.5 0 01-9.6 3.6" strokeLinecap="round" />
                    <path d="M11.5 2v2.5h-2.5M4.5 14v-2.5h2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : null}
                {buttonLabel}
              </button>
            </div>
          </div>
        );
      })()}

      {/* diff 浮层 —— 工作区 / 暂存区 / 未跟踪都走 git_diff。
          AnimatePresence 让 GitDiffViewer 的 exit 动画（淡出 + 左移）有机会播完。
          注意 key 必须稳定（不绑 file.path），切换文件时同一 viewer 重 load，
          不要 unmount → remount 重放动画。 */}
      <AnimatePresence>
        {viewingFile && projectPath ? (
          <GitDiffViewer
            key="workdir-diff"
            title={viewingFile.path}
            subtitle={
              viewingFile.staged ? "已暂存" : viewingFile.untracked ? "未跟踪" : "未暂存"
            }
            loaderKey={`workdir:${viewingFile.path}:${viewingFile.staged}:${viewingFile.untracked}`}
            loader={() =>
              invoke<GitDiffResult>("git_diff", {
                cwd: projectPath,
                path: viewingFile.path,
                staged: viewingFile.staged,
                untracked: viewingFile.untracked,
              })
            }
            onClose={() => setViewingFile(null)}
          />
        ) : null}
      </AnimatePresence>

      {/* 分支切换浮窗：fixed 定位到"切换分支"按钮下方，淡入淡出 */}
      <AnimatePresence>
        {branchPickerAnchor && projectPath ? (
          <BranchSwitcher
            key="branch-switcher"
            cwd={projectPath}
            anchorRect={{
              left: branchPickerAnchor.left,
              bottom: branchPickerAnchor.bottom,
              right: branchPickerAnchor.right,
            }}
            onClose={() => setBranchPickerAnchor(null)}
            onSwitched={() => {
              setActionFeedback("分支已切换");
              setHistoryReloadKey((k) => k + 1);
              void refresh();
            }}
            onError={(msg) => setError(msg)}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}
