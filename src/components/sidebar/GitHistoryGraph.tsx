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
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
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

/// lane 槽位：除了等待的 hash，还带一个 colorId，让"分支身份"在压缩后
/// 仍能延续颜色。如果只用 idx 选色，压缩位置时颜色会跳变。
interface LaneSlot {
  hash: string;
  colorId: number;
}

interface LaneAssignment {
  /// 当前 commit 圆点画在 prevLanes 的第几列
  column: number;
  /// 进入本行前的 lanes 状态（已包含本行 commit 自己）
  prevLanes: (LaneSlot | null)[];
  /// 退出本行后的 lanes 状态（已压缩，去掉中间 null —— 让 lane 按需向左挤）
  nextLanes: (LaneSlot | null)[];
  /// commit 的某个 parent 已经在另一条 lane 上等待 → 视觉上从 commit 圆点
  /// 画曲线流入那条 lane（同一 hash 不能让两条 lane 等，否则会有"幽灵 lane"）。
  /// idx 是该 parent 在 nextLanes 中的列号，colorId 用来上色
  mergeOutLanes: { idx: number; colorId: number }[];
}

/// 用 5-6 种鲜艳色循环染色，跟 VSCode Git Graph 类似。
const LANE_COLORS = [
  "#38bdf8", // sky
  "#34d399", // emerald
  "#fbbf24", // amber
  "#f472b6", // pink
  "#a78bfa", // violet
  "#fb7185", // rose
];

function laneColor(colorId: number): string {
  return LANE_COLORS[colorId % LANE_COLORS.length] ?? LANE_COLORS[0]!;
}

/// 按需展开的 lane 算法。核心思路：
/// - lane 没东西时让位（每行末尾压缩，去掉中间 null）；下次复活时落在更靠左的位置
/// - lane 颜色绑定到"分支身份"（colorId 跟 hash 走），跨行稳定，压缩后不跳色
/// - 每个 hash 只能在一条 lane 上等待 —— 防止"幽灵 lane"贯穿到底
///
/// 每个 commit 的处理步骤：
///   1. 在 lanes 中找自己（findOrAdd）拿到 column；记录 prevLanes 快照
///   2. 清空当前 lane（commit 已被消化）
///   3. parents[0]：
///        - 已在另一条 lane 上等 → 不重复添加，记 mergeOutLane
///        - 否则 → 当前 column 继承（沿用 commit 的 colorId，分支身份不变）
///   4. parents[1..]：每个 parent
///        - 已在另一条 lane 上等 → 记 mergeOutLane
///        - 否则 → 新分支，分配新 colorId，放到 column 右侧（merge 视觉上向右分叉）
///   5. limit 外的 parent 不入 lane —— 否则 lane 会贯穿到底
///   6. 压缩 lanes（移除所有 null），让 lane 列号紧凑
function computeLanes(commits: GitCommit[]): LaneAssignment[] {
  const commitSet = new Set(commits.map((c) => c.hash));
  const lanes: (LaneSlot | null)[] = [];
  let nextColorId = 0;
  /// 在 lanes 中找 hash 所在 lane 的 idx；不存在返回 -1
  const findLane = (hash: string): number =>
    lanes.findIndex((l) => l !== null && l.hash === hash);
  /// 找 c.hash 在 lanes 中的位置；找不到则填第一个空位（或追加），并分配新 colorId
  /// 用于 commit 自身入列 —— ref tip 类 commit 首次出现时走 push 分支
  const findOrAdd = (hash: string): number => {
    const idx = findLane(hash);
    if (idx >= 0) return idx;
    const slot: LaneSlot = { hash, colorId: nextColorId++ };
    const empty = lanes.indexOf(null);
    if (empty >= 0) {
      lanes[empty] = slot;
      return empty;
    }
    lanes.push(slot);
    return lanes.length - 1;
  };
  /// merge 引入的 parent[1..] 专用：强制放在 column 右侧空位，否则新分支线
  /// 会跑到主线左侧、横跨主线显示
  const addAfter = (slot: LaneSlot, after: number): number => {
    for (let i = after + 1; i < lanes.length; i += 1) {
      if (lanes[i] === null) {
        lanes[i] = slot;
        return i;
      }
    }
    lanes.push(slot);
    return lanes.length - 1;
  };

  const result: LaneAssignment[] = [];
  for (const c of commits) {
    const column = findOrAdd(c.hash);
    const selfColorId = lanes[column]!.colorId;
    const prev = lanes.slice();
    // 当前 commit 已消化，清空它的 lane
    lanes[column] = null;
    const mergeOutLanes: { idx: number; colorId: number }[] = [];

    c.parents.forEach((p, pIdx) => {
      // limit 外的 parent：不入 lane（避免贯穿到底的幽灵线）
      if (!commitSet.has(p)) return;
      const existing = findLane(p);
      if (existing >= 0) {
        // 这个 hash 已经在等着 —— 不能重复入 lane（否则有幽灵 lane）
        // 记一条从 commit 流入该 lane 的合并曲线，颜色用那条 lane 的
        if (existing !== column) {
          mergeOutLanes.push({ idx: existing, colorId: lanes[existing]!.colorId });
        }
        return;
      }
      if (pIdx === 0 && lanes[column] === null) {
        // 主父继承 commit 的 lane —— 同一分支身份延续，颜色不变
        lanes[column] = { hash: p, colorId: selfColorId };
      } else {
        // 新分支 lane：新 colorId，放到 column 右侧
        addAfter({ hash: p, colorId: nextColorId++ }, column);
      }
    });

    // 压缩：移除所有 null —— 让 lane 列号按需展开、不预占位置
    // 注意：压缩会让 lane 的列号在行间漂移（这正是用户要的"按需展开"效果），
    // 颜色因为绑定 colorId 而不会跟着跳变；连线时上半段曲线会从 prev 列号
    // 弯到 next 列号，视觉上表达 lane 的横向挪动
    let w = 0;
    for (let r = 0; r < lanes.length; r += 1) {
      const l = lanes[r];
      if (l !== null) {
        lanes[w] = l;
        w += 1;
      }
    }
    lanes.length = w;

    // 修正 mergeOutLanes 的 idx —— 压缩后位置可能变了，根据 colorId 找新位置
    const fixedMerge = mergeOutLanes
      .map((m) => {
        const newIdx = lanes.findIndex((l) => l !== null && l.colorId === m.colorId);
        return newIdx >= 0 ? { idx: newIdx, colorId: m.colorId } : null;
      })
      .filter((m): m is { idx: number; colorId: number } => m !== null);

    result.push({ column, prevLanes: prev, nextLanes: lanes.slice(), mergeOutLanes: fixedMerge });
  }
  return result;
}

/// 单行高 / 单 lane 宽 / 圆点半径 —— 用统一常量便于 SVG 绝对定位。
/// VSCode 风格：graph 列尽量窄，把屏幕让给 commit subject。
const ROW_HEIGHT = 26;
const LANE_WIDTH = 8;
const DOT_RADIUS = 2.2;
const LINE_WIDTH = 1.2;
/// graph 区域硬上限：5 lanes (40px)。超出的分支被 SVG 视口裁掉，
/// 工程上罕见同时活着 5+ 条分支；超出也不会让 graph 抢走 commit 信息的空间。
const MAX_GRAPH_WIDTH = LANE_WIDTH * 5;

interface GraphCellProps {
  assign: LaneAssignment;
  isMerge: boolean;
  isRoot: boolean;
}

/// 单行的 graph 部分：把 prev → 本行中点的上半段竖线，本行中点 → next 的下半段
/// 竖线，以及圆点画进同一个 SVG。Merge 时 parent[1] 走斜线接到新 lane。
/// 跨列连接：用三次贝塞尔曲线让线条平滑（控制点在垂直方向的中点 → 视觉上 "S 形 → 接近直角"）。
/// 同列时退化成直线。stroke 不透明度 0.75 让 graph 不喧宾夺主，更接近 VSCode 视觉。
function curvePath(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  // 控制点：竖向中点处保持各自 x 坐标 → 顶部和底部都是直立切线，中段平滑过渡
  const midY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}

const LANE_OPACITY = 0.6;

function GraphCell({ assign, isMerge, isRoot }: GraphCellProps): JSX.Element {
  const cols = Math.max(assign.prevLanes.length, assign.nextLanes.length, assign.column + 1);
  const width = Math.max(cols * LANE_WIDTH, LANE_WIDTH);
  const dotX = assign.column * LANE_WIDTH + LANE_WIDTH / 2;
  const dotY = ROW_HEIGHT / 2;

  // 上半段：prev → dotY 这一段
  //   - commit 自身 lane（i == column）→ 直线进入圆点 (column.x, 0) → (dotX, dotY)
  //   - 其他 lane 在行中"通过"：在上半段就把横向位置挪到 next 列，圆点高度处就位 ——
  //     这样圆点处所有"通过 lane"都已经在 next 位置，视觉对齐
  //   - 其他 lane 在 next 里找不到（被本 commit 消化或终止）→ 弯进 dotX
  const upper: JSX.Element[] = [];
  assign.prevLanes.forEach((slot, i) => {
    if (slot === null) return;
    const x = i * LANE_WIDTH + LANE_WIDTH / 2;
    let targetX: number;
    if (i === assign.column) {
      targetX = dotX; // 自己 lane：直进圆点
    } else {
      // 用 colorId（不是 hash）在 next 找位置 —— commit 处理后 lane 上的 hash
      // 会变成 parent.hash，但 colorId 不变（同分支身份延续）
      const j = assign.nextLanes.findIndex((l) => l !== null && l.colorId === slot.colorId);
      targetX = j >= 0 ? j * LANE_WIDTH + LANE_WIDTH / 2 : dotX;
    }
    upper.push(
      <path
        key={`u${i}`}
        d={curvePath(x, 0, targetX, dotY)}
        stroke={laneColor(slot.colorId)}
        strokeWidth={LINE_WIDTH}
        fill="none"
        opacity={LANE_OPACITY}
      />,
    );
  });

  // 下半段：dotY → ROW_HEIGHT 这一段
  //   - 是 commit 自身 lane 的延续（P0 继承同 colorId）→ 从 dotX 出发，曲线/直线到 next 列
  //     （commit lane 在圆点处分叉是合理的"主线挪位置"视觉）
  //   - 是新引入 lane（prev 没有同 colorId）→ 从 dotX 曲线分叉
  //   - 是行中通过的其他 lane → 上半段已挪到 next 列，下半段直线到底
  const lower: JSX.Element[] = [];
  assign.nextLanes.forEach((slot, i) => {
    if (slot === null) return;
    const x = i * LANE_WIDTH + LANE_WIDTH / 2;
    const prevIdx = assign.prevLanes.findIndex((l) => l !== null && l.colorId === slot.colorId);
    let fromX: number;
    if (prevIdx < 0) {
      fromX = dotX; // 新 lane 从圆点分叉
    } else if (prevIdx === assign.column) {
      fromX = dotX; // commit 自身 lane 延续，从圆点出发
    } else {
      fromX = x; // 行中通过的 lane：上半段已经挪到位，下半段垂直
    }
    lower.push(
      <path
        key={`l${i}`}
        d={curvePath(fromX, dotY, x, ROW_HEIGHT)}
        stroke={laneColor(slot.colorId)}
        strokeWidth={LINE_WIDTH}
        fill="none"
        opacity={LANE_OPACITY}
      />,
    );
  });

  // 合并曲线：parent 已在另一 lane 上等待时，从 commit 圆点斜向流入那条 lane
  // 底部 —— 视觉上表达"汇入"，同时是幽灵 lane 修复的视觉补全
  const mergeLines: JSX.Element[] = [];
  assign.mergeOutLanes.forEach((m, k) => {
    const x = m.idx * LANE_WIDTH + LANE_WIDTH / 2;
    mergeLines.push(
      <path
        key={`m${k}`}
        d={curvePath(dotX, dotY, x, ROW_HEIGHT)}
        stroke={laneColor(m.colorId)}
        strokeWidth={LINE_WIDTH}
        fill="none"
        opacity={LANE_OPACITY}
      />,
    );
  });

  // commit 圆点的颜色：取 prev[column] 自己的 colorId（必然存在，刚 findOrAdd 进去的）
  const selfSlot = assign.prevLanes[assign.column];
  const fillColor = selfSlot ? laneColor(selfSlot.colorId) : LANE_COLORS[0]!;
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
      {upper}
      {lower}
      {mergeLines}
      {dot}
    </svg>
  );
}

/// commit 展开区左侧的"lane 续接"图：只画当前活跃的 lanes 各一根从顶到底的直线。
/// 用 div 而非 SVG —— SVG 的 percentage height 在 flex `self-stretch` 父容器下
/// 会 fallback 到 default 150px（无确定 parent height）；div absolute inset-y-0
/// 不存在这个 chicken-and-egg 问题，高度由 sibling（文件列表）主导，完美自适应。
function ContinuationGraph({ lanes }: { lanes: (LaneSlot | null)[] }): JSX.Element {
  const cols = Math.max(lanes.length, 1);
  return (
    <div className="relative h-full" style={{ width: cols * LANE_WIDTH }}>
      {lanes.map((slot, i) => {
        if (slot === null) return null;
        const x = i * LANE_WIDTH + LANE_WIDTH / 2;
        return (
          <div
            key={i}
            className="absolute inset-y-0"
            style={{
              left: x - LINE_WIDTH / 2,
              width: LINE_WIDTH,
              backgroundColor: laneColor(slot.colorId),
              opacity: LANE_OPACITY,
            }}
          />
        );
      })}
    </div>
  );
}

/// 从 git remote URL 解析出 GitHub 仓库 base 链接（https://github.com/{user}/{repo}）。
/// 支持 SSH 和 HTTPS 两种 origin 格式；其它 host（GitLab / Gitee / 自建）返回 null，
/// 卡片就不显示"在 GitHub 打开"按钮。
function parseGithubBase(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl) return null;
  // SSH: git@github.com:user/repo(.git)
  let m = remoteUrl.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (m) return `https://github.com/${m[1]}/${m[2]}`;
  // HTTPS: https://github.com/user/repo(.git)
  m = remoteUrl.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (m) return `https://github.com/${m[1]}/${m[2]}`;
  return null;
}

/// 相对时间（中文）—— 卡片头部显示，比绝对时间一眼能看出"多久之前"。
function relTime(ts: number): string {
  const diff = Math.max(0, Date.now() / 1000 - ts);
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400 / 7)} 周前`;
  if (diff < 86400 * 365) return `${Math.floor(diff / 86400 / 30)} 个月前`;
  return `${Math.floor(diff / 86400 / 365)} 年前`;
}

interface CommitHoverCardProps {
  commit: GitCommit;
  /// commit 行的 boundingClientRect，用来定位卡片
  anchorRect: DOMRect;
  /// GitHub 仓库 base URL；null 表示不显示 GitHub 相关按钮
  githubBase: string | null;
  /// commit 是否已推送到远端 —— 未推送时 GitHub 按钮禁用 + 状态提示
  /// null 表示"还不知道"（推送状态尚在加载），按钮默认 enabled
  isPushed: boolean | null;
  /// 鼠标进入卡片时调用 —— 取消父级的隐藏延时（让卡片不消失）
  onMouseEnter: () => void;
  /// 鼠标离开卡片 —— 触发隐藏
  onMouseLeave: () => void;
}

/// commit 悬停信息卡片：subject、refs、作者 · 时间、hash + 复制按钮、GitHub 跳转。
/// portal 到 body 避免被 sidebar 的 overflow-hidden 裁掉；用 fixed 定位锚到 commit 行右侧。
function CommitHoverCard({
  commit,
  anchorRect,
  githubBase,
  isPushed,
  onMouseEnter,
  onMouseLeave,
}: CommitHoverCardProps): JSX.Element {
  /// 复制反馈：用 enum 区分复制了什么 ——
  /// 同时显示"复制 hash 成功"和"复制链接成功"在同一卡片上需要区分两个状态
  const [copiedKind, setCopiedKind] = useState<"hash" | "link" | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  // 卡片渲染后才能拿到实际宽高 → 用 state 触发二次渲染来 clamp 位置
  const [pos, setPos] = useState<{ left: number; top: number }>(() => ({
    left: anchorRect.right + 8,
    top: anchorRect.top,
  }));

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 默认放右侧；放不下翻到左侧；左右都放不下就 clamp 到右边界
    let left = anchorRect.right + 8;
    if (left + w > vw - 8) {
      left = anchorRect.left - w - 8;
      if (left < 8) left = vw - w - 8;
    }
    let top = anchorRect.top;
    if (top + h > vh - 8) top = vh - h - 8;
    if (top < 8) top = 8;
    setPos({ left, top });
  }, [anchorRect.left, anchorRect.right, anchorRect.top]);

  const commitUrl = githubBase ? `${githubBase}/commit/${commit.hash}` : null;

  const copyTo = async (kind: "hash" | "link", text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKind(kind);
      window.setTimeout(() => setCopiedKind((k) => (k === kind ? null : k)), 1400);
    } catch {
      /* clipboard 被拒——静默失败 */
    }
  };

  const handleOpenGithub = async (): Promise<void> => {
    if (!commitUrl || isPushed === false) return;
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(commitUrl);
    } catch {
      window.open(commitUrl, "_blank", "noopener,noreferrer");
    }
  };

  const absTime = new Date(commit.timestamp * 1000).toLocaleString();
  const githubDisabled = isPushed === false;

  return createPortal(
    <motion.div
      ref={cardRef}
      initial={{ opacity: 0, y: -2 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -2 }}
      transition={{ duration: 0.12 }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 60 }}
      className="w-[300px] rounded-lg border border-zinc-200 bg-white/95 p-3 shadow-xl backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95"
    >
      <div className="mb-1.5 break-words text-[12px] font-medium leading-snug text-zinc-900 dark:text-zinc-50">
        {commit.subject || "(无提交说明)"}
      </div>
      {commit.refs.length > 0 ? (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {commit.refs.map((r) => (
            <span
              key={r}
              className="truncate rounded bg-sky-400/15 px-1.5 py-px font-mono text-[10px] leading-tight text-sky-700 dark:bg-sky-400/15 dark:text-sky-300"
            >
              {r}
            </span>
          ))}
        </div>
      ) : null}
      <div className="mb-2 flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
        <span className="truncate">{commit.author}</span>
        <span className="opacity-50">·</span>
        <span title={absTime}>{relTime(commit.timestamp)}</span>
      </div>
      {githubDisabled && githubBase ? (
        <div className="mb-2 rounded bg-amber-500/10 px-1.5 py-1 text-[10px] leading-tight text-amber-700 dark:bg-amber-400/10 dark:text-amber-300">
          此提交尚未推送到远端，GitHub 上可能找不到
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          onClick={() => void copyTo("hash", commit.hash)}
          className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-1 font-mono text-[10px] transition-colors ${
            copiedKind === "hash"
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
              : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
          }`}
          title={copiedKind === "hash" ? "已复制完整 hash" : "复制完整 hash"}
        >
          <span>{commit.shortHash}</span>
          <span className="opacity-60">{copiedKind === "hash" ? "✓" : "⧉"}</span>
        </button>
        {commitUrl ? (
          <>
            <button
              type="button"
              onClick={handleOpenGithub}
              disabled={githubDisabled}
              className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[10px] transition-colors ${
                githubDisabled
                  ? "cursor-not-allowed bg-zinc-100/60 text-zinc-400 dark:bg-zinc-800/60 dark:text-zinc-600"
                  : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
              }`}
              title={githubDisabled ? "此 commit 未推送到远端" : "在 GitHub 打开此提交"}
            >
              <span>GitHub</span>
              <span className="opacity-60">↗</span>
            </button>
            <button
              type="button"
              onClick={() => void copyTo("link", commitUrl)}
              className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[10px] transition-colors ${
                copiedKind === "link"
                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                  : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
              }`}
              title={copiedKind === "link" ? "已复制 GitHub 链接" : "复制 GitHub 链接"}
            >
              <span>{copiedKind === "link" ? "已复制" : "复制链接"}</span>
              <span className="opacity-60">{copiedKind === "link" ? "✓" : "⧉"}</span>
            </button>
          </>
        ) : null}
      </div>
    </motion.div>,
    document.body,
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
  // 当前悬停的 commit 卡片 —— null 表示不显示
  const [hoverCard, setHoverCard] = useState<{ commit: GitCommit; rect: DOMRect } | null>(null);
  // 原始 remote URL（用于解析 GitHub base）。null = 还在加载或没有 remote
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  const githubBase = useMemo(() => parseGithubBase(remoteUrl), [remoteUrl]);
  // 已推送到远端的 commit hash 集合；null = 还在加载（按钮先按 enabled 显示）
  const [pushedSet, setPushedSet] = useState<Set<string> | null>(null);
  // hover 显示 / 隐藏延时句柄 —— 给用户从 commit 行移到卡片上的反应时间
  const showTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);

  /// commit 行 hover 进入：延时 250ms 显示卡片；同时取消上一次"将要隐藏"的计时器
  const scheduleShow = useCallback((commit: GitCommit, el: HTMLElement) => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    if (showTimerRef.current !== null) window.clearTimeout(showTimerRef.current);
    const rect = el.getBoundingClientRect();
    showTimerRef.current = window.setTimeout(() => {
      setHoverCard({ commit, rect });
    }, 250);
  }, []);

  /// commit 行 hover 离开：200ms 后隐藏卡片，留时间让用户移动到卡片上 hover
  const scheduleHide = useCallback(() => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      setHoverCard(null);
    }, 200);
  }, []);

  /// 卡片被 hover → 取消隐藏（让卡片保持显示）
  const cancelHide = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (showTimerRef.current !== null) window.clearTimeout(showTimerRef.current);
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    };
  }, []);

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
    setHoverCard(null);
    setRemoteUrl(null);
    setPushedSet(null);
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
    // 拉 origin URL —— 失败 / 没有 origin 都视为"不能跳 GitHub"，静默
    invoke<string | null>("git_remote_url", { cwd })
      .then((url) => {
        if (seq !== reqSeqRef.current) return;
        setRemoteUrl(url);
      })
      .catch(() => {
        /* ignore */
      });
    // 拉"已推送到远端"的 commit 集合 —— 区分本地未 push commit，避免点 GitHub 404
    invoke<string[]>("git_pushed_commits", { cwd })
      .then((list) => {
        if (seq !== reqSeqRef.current) return;
        setPushedSet(new Set(list));
      })
      .catch(() => {
        if (seq !== reqSeqRef.current) return;
        // 失败时给空集 —— 所有 commit 视为未 push（保守，避免误导用户）
        setPushedSet(new Set());
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
  /// 全局最大 lane 数 —— graph 区在每行实际按需展开，但容器宽度统一到这个值，
  /// 让所有 commit subject 起点对齐到同一列；上限 MAX_GRAPH_WIDTH 防止过宽抢空间
  const globalCellWidth = useMemo(() => {
    let maxCols = 1;
    for (const a of assignments) {
      const c = Math.max(a.prevLanes.length, a.nextLanes.length, a.column + 1);
      if (c > maxCols) maxCols = c;
    }
    return Math.min(maxCols * LANE_WIDTH, MAX_GRAPH_WIDTH);
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
          const files = filesByHash.get(c.hash);
          const isFilesLoading = filesLoading.has(c.hash);
          const fileErr = filesError.get(c.hash);
          // graph 区容器宽度用全局 max —— 让所有 commit subject 起点对齐
          // 每行内部按需展开 lane（GraphCell SVG 会自己算实际占用宽度）
          const rowCellWidth = globalCellWidth;
          return (
            <div key={c.hash} className="flex flex-col">
              <button
                type="button"
                onClick={() => toggleExpand(c.hash)}
                onMouseEnter={(e) => scheduleShow(c, e.currentTarget)}
                onMouseLeave={scheduleHide}
                className={`group flex w-full cursor-pointer items-center gap-1.5 overflow-hidden pr-2 text-left text-[12px] text-zinc-700 transition-colors hover:bg-black/[0.04] dark:text-zinc-300 dark:hover:bg-white/[0.04] ${
                  isExpanded ? "bg-sky-400/10 dark:bg-sky-400/10" : ""
                }`}
                style={{ minHeight: ROW_HEIGHT, height: ROW_HEIGHT }}
              >
                <div
                  style={{ width: rowCellWidth }}
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

              {/* 展开区：左侧 graph 续接（pass-through lanes 直线），右侧文件列表。
                  续接区用同 row 的 cellWidth，保证 commit 行 / 展开区 / 下一 commit 行
                  视觉对齐（subject / 文件列表起点 x 一致） */}
              {isExpanded ? (
                <div className="flex bg-zinc-50/40 dark:bg-zinc-800/30">
                  <div
                    style={{ width: rowCellWidth }}
                    className="relative shrink-0 self-stretch overflow-hidden"
                  >
                    <ContinuationGraph lanes={assign.nextLanes} />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5 border-l border-sky-400/30 py-1 pl-3 pr-2 text-[11px] dark:border-sky-300/30">
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
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* commit diff 浮层：portal 到 body，溢出 sidebar 宽度，淡入淡出 */}
      <AnimatePresence>
        {viewingCommitFile ? (
          <GitDiffViewer
            key="commit-diff"
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
      </AnimatePresence>

      {/* commit 悬停卡片：portal 到 body 在 commit 行外部显示，可点按钮 */}
      <AnimatePresence>
        {hoverCard ? (
          <CommitHoverCard
            key={`hover-${hoverCard.commit.hash}`}
            commit={hoverCard.commit}
            anchorRect={hoverCard.rect}
            githubBase={githubBase}
            isPushed={pushedSet === null ? null : pushedSet.has(hoverCard.commit.hash)}
            onMouseEnter={cancelHide}
            onMouseLeave={scheduleHide}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}
