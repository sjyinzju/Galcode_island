// Git 历史图表视图：仿 VSCode 内置 Git Graph，展示当前仓库的提交时间线。
//
// 设计：
//   - 左侧画一根折线 + 多 lane 圆点，能展示分叉 / 合并
//   - 右侧显示 subject / refs 标签 / 作者 · 相对时间 / 短 hash
//   - 简化的 lane assignment：按 git log --date-order 顺序分配 lane，merge commit
//     会让 parent[1] 占用一条新 lane，root commit 让该 lane 退出
//
// 不做交互的高级功能（点击 commit 看详情、checkout 等）—— 当前只读视图够用，
// 后续如需扩展，FileRow 那一套 hover-action 模式可复用。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "../../lib/bridge";
import { GitDiffViewer } from "./GitDiffViewer";

interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  timestamp: number;
  parents: string[];
  refs: string[];
}

interface CommitFile {
  path: string;
  /// 单字符状态码：M / A / D / R / C / T / U
  status: string;
}

interface GitDiffResult {
  diff: string;
  empty: boolean;
}

/// 状态码 → 颜色（与主面板 statusInfo 一致：M=黄、A=绿、D=红、R=蓝）
function commitFileStatusColor(status: string): string {
  switch (status) {
    case "M":
      return "text-amber-600 dark:text-amber-400";
    case "A":
      return "text-emerald-600 dark:text-emerald-400";
    case "D":
      return "text-rose-600 dark:text-rose-400";
    case "R":
    case "C":
      return "text-sky-600 dark:text-sky-400";
    default:
      return "text-zinc-500 dark:text-zinc-400";
  }
}

interface LaneAssignment {
  /// 当前 commit 圆点画在第几列
  column: number;
  /// 进入本行前的 lanes 状态（每个元素是该 lane 正等着的 commit hash）
  prevLanes: (string | null)[];
  /// 退出本行后的 lanes 状态
  nextLanes: (string | null)[];
}

/// 用 5-6 种鲜艳色循环染色，跟 VSCode Git Graph 类似。透明度 0.95 让暗色背景下不刺眼。
const LANE_COLORS = [
  "#38bdf8", // sky
  "#34d399", // emerald
  "#fbbf24", // amber
  "#f472b6", // pink
  "#a78bfa", // violet
  "#fb7185", // rose
];

function laneColor(idx: number): string {
  return LANE_COLORS[idx % LANE_COLORS.length] ?? LANE_COLORS[0]!;
}

/// 把 commits 列表算出每行的 lane 布局。返回 commits 等长的 LaneAssignment 数组。
/// 算法：
///   维护 lanes[] —— 每个槽位存"在该 lane 上等着出现的 commit hash"
///   对每个 commit：
///     1. 找它在 lanes 里的位置；找不到则塞入第一个空位（或追加新 lane）
///     2. 记录 column = 找到的位置；prevLanes = 当前 lanes 的快照
///     3. 把该位置替换为 parents[0]；没有 parents 则置 null
///     4. parents[1..] 每个挨个去找空位放入（合并视为引出新 lane）
///     5. 记录 nextLanes = 替换后的快照
function computeLanes(commits: GitCommit[]): LaneAssignment[] {
  const lanes: (string | null)[] = [];
  const findOrAdd = (hash: string): number => {
    const idx = lanes.indexOf(hash);
    if (idx >= 0) return idx;
    const empty = lanes.indexOf(null);
    if (empty >= 0) {
      lanes[empty] = hash;
      return empty;
    }
    lanes.push(hash);
    return lanes.length - 1;
  };

  const result: LaneAssignment[] = [];
  for (const c of commits) {
    const column = findOrAdd(c.hash);
    const prev = lanes.slice();
    // 当前 commit 这条 lane 替换为 first parent（或 null）
    lanes[column] = c.parents[0] ?? null;
    // 处理 merge：parents[1..] 各自占一个 lane
    for (let i = 1; i < c.parents.length; i += 1) {
      findOrAdd(c.parents[i]!);
    }
    // trim 末尾连续 null，避免 lane 数无谓增长
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
    }
    result.push({ column, prevLanes: prev, nextLanes: lanes.slice() });
  }
  return result;
}

/// 单行高 / 单 lane 宽 / 圆点半径 —— 用统一常量便于 SVG 绝对定位。
/// VSCode 风格：graph 列只占很窄一条（约 28px），把屏幕让给 commit subject。
const ROW_HEIGHT = 26;
const LANE_WIDTH = 10;
const DOT_RADIUS = 2.6;
const LINE_WIDTH = 1.3;
/// graph 区域的硬上限：5 lanes (50px)。超出的分支被 SVG 视口裁掉，
/// 工程上罕见同时活着 5+ 条分支；超出也不会让 graph 抢走 commit 信息的空间。
const MAX_GRAPH_WIDTH = LANE_WIDTH * 5;

interface GraphCellProps {
  assign: LaneAssignment;
  isMerge: boolean;
  isRoot: boolean;
}

/// 单行的 graph 部分：把 prev → 本行中点的上半段竖线，本行中点 → next 的下半段
/// 竖线，以及圆点画进同一个 SVG。Merge 时 parent[1] 走斜线接到新 lane。
function GraphCell({ assign, isMerge, isRoot }: GraphCellProps): JSX.Element {
  const cols = Math.max(assign.prevLanes.length, assign.nextLanes.length, assign.column + 1);
  const width = Math.max(cols * LANE_WIDTH, LANE_WIDTH);
  const dotX = assign.column * LANE_WIDTH + LANE_WIDTH / 2;
  const dotY = ROW_HEIGHT / 2;

  // 上半段：每个 prev lane 从 (x, 0) 到 (x, dotY) 都画线（如果 lane 在 prev 不为 null）
  const upperLines: JSX.Element[] = [];
  assign.prevLanes.forEach((hash, i) => {
    if (hash === null) return;
    const x = i * LANE_WIDTH + LANE_WIDTH / 2;
    // 当前 commit 那条 lane 的上半段也画（让圆点跟上一行的线衔接）
    upperLines.push(
      <line
        key={`u${i}`}
        x1={x}
        y1={0}
        x2={x === dotX ? x : x}
        y2={x === dotX ? dotY : dotY}
        stroke={laneColor(i)}
        strokeWidth={LINE_WIDTH}
      />,
    );
    // 如果该 prev lane 不是当前 commit 这条，需要把它直通到 next 那侧的同名 lane
    // —— 这里 upper 部分只画到 dotY，下半段由 lowerLines 处理
  });

  // 下半段：next lanes 从 (x, dotY) 到 (x, ROW_HEIGHT)
  const lowerLines: JSX.Element[] = [];
  assign.nextLanes.forEach((hash, i) => {
    if (hash === null) return;
    const x = i * LANE_WIDTH + LANE_WIDTH / 2;
    lowerLines.push(
      <line
        key={`l${i}`}
        x1={x}
        y1={dotY}
        x2={x}
        y2={ROW_HEIGHT}
        stroke={laneColor(i)}
        strokeWidth={LINE_WIDTH}
      />,
    );
  });

  // 直通连线：prev lane（非当前列）需要从上方接到下方对应 lane（即使位置变了，也连一根）
  // 简化：如果某个 hash 同时出现在 prev 和 next，但 prev/next 列号不同，画一根斜线衔接
  const passthrough: JSX.Element[] = [];
  assign.prevLanes.forEach((hash, i) => {
    if (hash === null) return;
    if (i === assign.column) return;
    const j = assign.nextLanes.indexOf(hash);
    if (j < 0) return;
    if (i === j) return; // 同列已由上下竖线覆盖
    passthrough.push(
      <line
        key={`p${i}-${j}`}
        x1={i * LANE_WIDTH + LANE_WIDTH / 2}
        y1={0}
        x2={j * LANE_WIDTH + LANE_WIDTH / 2}
        y2={ROW_HEIGHT}
        stroke={laneColor(i)}
        strokeWidth={LINE_WIDTH}
      />,
    );
  });

  // Merge 提示：parents[1..] 占了新 lane，从圆点画一条到这些新 lane 的下半段
  // —— 已经被 lowerLines 的同 lane 竖线覆盖一部分，再补一根斜线从 dotX,dotY 到 newLaneX,ROW_HEIGHT
  const mergeBranches: JSX.Element[] = [];
  if (isMerge) {
    assign.nextLanes.forEach((hash, i) => {
      if (hash === null) return;
      if (i === assign.column) return;
      // 只对"在 prev 里不存在的新 lane"画分叉斜线
      if (assign.prevLanes.indexOf(hash) >= 0) return;
      mergeBranches.push(
        <line
          key={`m${i}`}
          x1={dotX}
          y1={dotY}
          x2={i * LANE_WIDTH + LANE_WIDTH / 2}
          y2={ROW_HEIGHT}
          stroke={laneColor(i)}
          strokeWidth={LINE_WIDTH}
        />,
      );
    });
  }

  const fillColor = laneColor(assign.column);
  // root commit 用空心圆区分 + 不再画下半段（lowerLines 自然不会画该 lane）
  // 普通 commit 实心圆，merge commit 双层圆（外圈空，内圈填）
  const dot = isMerge ? (
    <>
      <circle cx={dotX} cy={dotY} r={DOT_RADIUS + 1.4} fill="none" stroke={fillColor} strokeWidth={LINE_WIDTH} />
      <circle cx={dotX} cy={dotY} r={DOT_RADIUS - 0.6} fill={fillColor} />
    </>
  ) : isRoot ? (
    <circle cx={dotX} cy={dotY} r={DOT_RADIUS} fill="none" stroke={fillColor} strokeWidth={LINE_WIDTH} />
  ) : (
    <circle cx={dotX} cy={dotY} r={DOT_RADIUS} fill={fillColor} />
  );

  return (
    <svg width={width} height={ROW_HEIGHT} className="shrink-0">
      {passthrough}
      {upperLines}
      {lowerLines}
      {mergeBranches}
      {dot}
    </svg>
  );
}

interface GitHistoryGraphProps {
  cwd: string;
  /// 父组件改变这个值（比如刚 commit 完）时，本组件会重新拉 git log
  reloadKey: number;
}

export function GitHistoryGraph({ cwd, reloadKey }: GitHistoryGraphProps): JSX.Element {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const reqSeqRef = useRef(0);

  // 已展开的 commit hash 集合（多选支持，跟 VSCode 一致——可同时展开多个）
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 各 commit 的文件列表缓存：避免折叠再展开时重复拉
  const [filesByHash, setFilesByHash] = useState<Map<string, CommitFile[]>>(new Map());
  // 哪些 hash 正在加载文件列表
  const [filesLoading, setFilesLoading] = useState<Set<string>>(new Set());
  const [filesError, setFilesError] = useState<Map<string, string>>(new Map());
  // 当前查看的 commit 文件（触发 diff 浮层）
  const [viewingCommitFile, setViewingCommitFile] = useState<{
    hash: string;
    shortHash: string;
    path: string;
    status: string;
  } | null>(null);

  useEffect(() => {
    if (!cwd) return;
    const seq = ++reqSeqRef.current;
    setLoading(true);
    setError(null);
    // 切 cwd / reload 时清缓存，避免展示旧仓库的文件列表
    setExpanded(new Set());
    setFilesByHash(new Map());
    setFilesLoading(new Set());
    setFilesError(new Map());
    setViewingCommitFile(null);
    invoke<GitCommit[]>("git_log", { cwd, limit: 200 })
      .then((res) => {
        if (seq !== reqSeqRef.current) return;
        setCommits(res);
      })
      .catch((err: unknown) => {
        if (seq !== reqSeqRef.current) return;
        setError(String(err));
      })
      .finally(() => {
        if (seq === reqSeqRef.current) setLoading(false);
      });
  }, [cwd, reloadKey]);

  /// 切换某个 commit 的展开状态；首次展开时拉文件列表（带缓存）。
  const toggleExpand = useCallback(
    (hash: string): void => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(hash)) {
          next.delete(hash);
        } else {
          next.add(hash);
        }
        return next;
      });
      // 已经缓存或正在加载就不再发请求
      setFilesByHash((cache) => {
        if (cache.has(hash)) return cache;
        if (filesLoading.has(hash)) return cache;
        // 拉取
        setFilesLoading((s) => new Set(s).add(hash));
        invoke<CommitFile[]>("git_show_commit_files", { cwd, hash })
          .then((res) => {
            setFilesByHash((m) => {
              const nm = new Map(m);
              nm.set(hash, res);
              return nm;
            });
          })
          .catch((err: unknown) => {
            setFilesError((m) => {
              const nm = new Map(m);
              nm.set(hash, String(err));
              return nm;
            });
          })
          .finally(() => {
            setFilesLoading((s) => {
              const ns = new Set(s);
              ns.delete(hash);
              return ns;
            });
          });
        return cache;
      });
    },
    [cwd, filesLoading],
  );

  const assignments = useMemo(() => computeLanes(commits), [commits]);
  const maxLanes = useMemo(() => {
    let m = 1;
    for (const a of assignments) {
      m = Math.max(m, a.prevLanes.length, a.nextLanes.length, a.column + 1);
    }
    return m;
  }, [assignments]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-[11px] text-zinc-400 dark:text-zinc-500">
        加载历史…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center px-3 text-center text-[11px] text-rose-500 dark:text-rose-400">
        {error}
      </div>
    );
  }
  if (commits.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-[11px] text-zinc-400 dark:text-zinc-500">
        还没有任何提交
      </div>
    );
  }

  // graph 区域宽度 = min(实际 lanes, 上限) × LANE_WIDTH。
  // SVG 内部仍按真实 column 画线条，超出 graphWidth 的分支被裁切，不会侵占 commit 信息空间。
  const graphWidth = Math.min(Math.max(maxLanes, 1) * LANE_WIDTH, MAX_GRAPH_WIDTH);

  return (
    // overflow-x-hidden：单行如果某段意外超长（比如非常宽的 ref 标签），不让它撑出
    // 横向滚动条 —— 内层每一行都靠 truncate / shrink-0 处理溢出。
    <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden py-1">
      <div className="mb-0.5 flex items-center justify-between px-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400 dark:text-zinc-500">
          最近 {commits.length} 个提交
        </span>
      </div>
      <div className="flex flex-col">
        {commits.map((c, i) => {
          const assign = assignments[i]!;
          const isMerge = c.parents.length >= 2;
          const isRoot = c.parents.length === 0;
          const isHead = c.refs.includes("HEAD") || i === 0;
          const isExpanded = expanded.has(c.hash);
          const tooltip = `${c.subject}\n\n${c.author} · ${new Date(
            c.timestamp * 1000,
          ).toLocaleString()}\n${c.shortHash}${c.refs.length > 0 ? `\n${c.refs.join(", ")}` : ""}`;
          const files = filesByHash.get(c.hash);
          const isFilesLoading = filesLoading.has(c.hash);
          const fileErr = filesError.get(c.hash);
          return (
            <div key={c.hash} className="flex flex-col">
              <button
                type="button"
                onClick={() => toggleExpand(c.hash)}
                className={`group flex w-full cursor-pointer items-center gap-1.5 overflow-hidden pr-2 text-left text-[12px] text-zinc-700 transition-colors hover:bg-black/[0.04] dark:text-zinc-300 dark:hover:bg-white/[0.04] ${
                  isExpanded ? "bg-sky-400/10 dark:bg-sky-400/10" : ""
                }`}
                style={{ minHeight: ROW_HEIGHT, height: ROW_HEIGHT }}
                title={tooltip}
              >
                <div
                  style={{ width: graphWidth }}
                  className="relative shrink-0 self-stretch overflow-hidden"
                >
                  <GraphCell assign={assign} isMerge={isMerge} isRoot={isRoot} />
                </div>
                <span
                  className={`min-w-0 flex-1 truncate ${
                    isHead ? "font-semibold text-zinc-900 dark:text-zinc-50" : ""
                  }`}
                >
                  {c.subject || "(no message)"}
                </span>
                {c.refs.length > 0 ? (
                  <span className="flex max-w-[45%] shrink items-center gap-1 overflow-hidden">
                    {c.refs.slice(0, 2).map((r) => (
                      <span
                        key={r}
                        className="truncate rounded bg-sky-400/15 px-1 py-px font-mono text-[9px] leading-tight text-sky-700 dark:bg-sky-400/15 dark:text-sky-300"
                        title={r}
                      >
                        {r}
                      </span>
                    ))}
                  </span>
                ) : null}
              </button>

              {/* 展开区：commit 修改的文件列表，缩进对齐到 graph 区右侧 */}
              {isExpanded ? (
                <div
                  className="flex flex-col gap-0.5 border-l border-sky-400/30 bg-zinc-50/40 py-1 pr-2 text-[11px] dark:border-sky-300/30 dark:bg-zinc-800/30"
                  style={{ paddingLeft: graphWidth + 12 }}
                >
                  {isFilesLoading && !files ? (
                    <div className="px-1 py-0.5 text-[10px] text-zinc-400 dark:text-zinc-500">
                      读取文件列表…
                    </div>
                  ) : fileErr ? (
                    <div className="px-1 py-0.5 text-[10px] text-rose-500 dark:text-rose-400">
                      {fileErr}
                    </div>
                  ) : files && files.length === 0 ? (
                    <div className="px-1 py-0.5 text-[10px] italic text-zinc-400 dark:text-zinc-500">
                      此提交未修改任何文件
                    </div>
                  ) : files ? (
                    files.map((f) => {
                      const idx = f.path.lastIndexOf("/");
                      const name = idx >= 0 ? f.path.slice(idx + 1) : f.path;
                      const dir = idx >= 0 ? f.path.slice(0, idx) : "";
                      return (
                        <button
                          key={f.path}
                          type="button"
                          onClick={() =>
                            setViewingCommitFile({
                              hash: c.hash,
                              shortHash: c.shortHash,
                              path: f.path,
                              status: f.status,
                            })
                          }
                          className="group flex w-full cursor-pointer items-center gap-1.5 overflow-hidden rounded px-1 py-0.5 text-left text-zinc-700 transition-colors hover:bg-sky-400/15 dark:text-zinc-300"
                          title={`${f.status}  ${f.path}`}
                        >
                          <span className={`shrink-0 font-mono text-[10px] font-bold ${commitFileStatusColor(f.status)}`}>
                            {f.status}
                          </span>
                          <span className="truncate text-[11px]">{name}</span>
                          {dir ? (
                            <span className="ml-auto truncate text-[10px] text-zinc-400 dark:text-zinc-500">
                              {dir}
                            </span>
                          ) : null}
                        </button>
                      );
                    })
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* commit diff 浮层：覆盖整个图表区域 */}
      {viewingCommitFile ? (
        <GitDiffViewer
          title={viewingCommitFile.path}
          subtitle={`${viewingCommitFile.shortHash} · 此提交中的变更`}
          loaderKey={`commit:${viewingCommitFile.hash}:${viewingCommitFile.path}`}
          loader={() =>
            invoke<GitDiffResult>("git_show_file_diff", {
              cwd,
              hash: viewingCommitFile.hash,
              path: viewingCommitFile.path,
            })
          }
          onClose={() => setViewingCommitFile(null)}
        />
      ) : null}
    </div>
  );
}
