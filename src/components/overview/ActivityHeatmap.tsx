// 活跃热图：GitHub / Claude 风格的瓷砖网格。
//
// 横轴：从 26 周前到本周，按周一为列首；纵轴：周一→周日。最后一列对齐"包含今天的那一周"。
// 每格按当日启动 task 次数染色（5 级，0 级是底色）。未来日期位置保留但不渲染色块。
//
// 交互：
//   - 鼠标 hover 一个非未来格：跟随鼠标弹出 tooltip 显示日期 + 次数 + 操作提示
//   - 点击格子（且 count > 0）：在热图下方展开当天 events 详情面板
//   - 再次点击同一格 / 点 ×：折叠详情
//
// 数据源：useActivityStore.events；mount 时若 events 空且 history 非空就 seed 一次。

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  useActivityStore,
  activityDayKey,
  type ActivityEvent,
} from "../../stores/useActivityStore";
import { useTabsStore } from "../../stores/useTabsStore";
import { AGENT_LABEL, basename } from "./overviewUtils";

const WEEKS = 26;
const DAYS_PER_WEEK = 7;
const CELL_SIZE = 11;
const CELL_GAP = 3;

const LEVEL_BG = [
  // 0：未发生 —— 极淡的中性底色
  "bg-zinc-200/55 dark:bg-zinc-700/40",
  "bg-sky-200/80 dark:bg-sky-900/55",
  "bg-sky-300 dark:bg-sky-700/85",
  "bg-sky-400 dark:bg-sky-500",
  "bg-sky-500 dark:bg-sky-400",
];

const WEEKDAY_LABELS = ["一", "", "三", "", "五", "", "日"];

function levelOf(count: number): number {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  return 4;
}

function formatDateLabel(d: Date): string {
  const w = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${w}`;
}

function formatTimeOfDay(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

interface Cell {
  date: Date;
  key: string;
  count: number;
  /// -1 表示"未来日期 / 不渲染色块"
  level: number;
}

interface HoverState {
  cell: Cell;
  /// 视口坐标（fixed 定位用）
  x: number;
  y: number;
}

export function ActivityHeatmap(): JSX.Element {
  const events = useActivityStore((s) => s.events);
  const seedFromHistory = useActivityStore((s) => s.seedFromHistory);

  const [hovered, setHovered] = useState<HoverState | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  // 首次挂载时若 store 为空，从 history 反推填充。seedFromHistory 自带"已有数据则跳过"
  useEffect(() => {
    const entries = useTabsStore
      .getState()
      .history.filter((h) => typeof h.closedAt === "number" && h.closedAt > 0)
      .map((h) => ({
        ts: h.closedAt,
        projectPath: h.projectPath,
        agent: h.agent,
        summary: h.summary,
      }));
    if (entries.length > 0) seedFromHistory(entries);
  }, [seedFromHistory]);

  const grid = useMemo<Cell[][]>(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const start = new Date(today);
    const weekday = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - weekday - (WEEKS - 1) * 7);

    const cells: Cell[][] = [];
    for (let w = 0; w < WEEKS; w++) {
      const week: Cell[] = [];
      for (let d = 0; d < DAYS_PER_WEEK; d++) {
        const date = new Date(start);
        date.setDate(start.getDate() + w * 7 + d);
        const key = activityDayKey(date.getTime());
        const count = (events[key]?.length ?? 0) || 0;
        const isFuture = date.getTime() > today.getTime();
        week.push({
          date,
          key,
          count: isFuture ? 0 : count,
          level: isFuture ? -1 : levelOf(count),
        });
      }
      cells.push(week);
    }
    return cells;
  }, [events]);

  const monthLabels = useMemo<{ index: number; label: string }[]>(() => {
    const out: { index: number; label: string }[] = [];
    let lastMonth = -1;
    for (let w = 0; w < grid.length; w++) {
      const firstDay = grid[w][0].date;
      const m = firstDay.getMonth();
      if (m !== lastMonth) {
        out.push({ index: w, label: `${m + 1}月` });
        lastMonth = m;
      }
    }
    return out;
  }, [grid]);

  const total = useMemo(
    () => Object.values(events).reduce((a, l) => a + l.length, 0),
    [events],
  );
  const activeDays = useMemo(
    () => Object.values(events).filter((l) => l.length > 0).length,
    [events],
  );
  const todayCount = useMemo(() => {
    const k = activityDayKey(Date.now());
    return events[k]?.length ?? 0;
  }, [events]);

  const selectedEvents = selectedDay ? events[selectedDay] ?? [] : [];

  const handleCellClick = (cell: Cell): void => {
    if (cell.level === -1) return;
    if (cell.count === 0) {
      // 没数据的格子点了也没东西可看；折叠当前 detail
      setSelectedDay(null);
      return;
    }
    setSelectedDay((prev) => (prev === cell.key ? null : cell.key));
  };

  const handleCellEnter = (cell: Cell, e: React.MouseEvent): void => {
    if (cell.level === -1) return;
    setHovered({ cell, x: e.clientX, y: e.clientY });
  };

  const handleCellMove = (cell: Cell, e: React.MouseEvent): void => {
    if (cell.level === -1) return;
    setHovered({ cell, x: e.clientX, y: e.clientY });
  };

  const handleCellLeave = (): void => {
    setHovered(null);
  };

  return (
    <div className="rounded-2xl border border-white/60 bg-white/55 p-4 backdrop-blur-md dark:border-white/10 dark:bg-slate-800/45">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
          活跃记录
        </span>
        <span className="text-[10px] tracking-wide text-zinc-400 dark:text-zinc-500">
          {total} 次任务 · {activeDays} 个活跃天 · 今日 {todayCount}
        </span>
      </div>

      {/* 横向滚动：窄屏时优先保完整 26 周，不要被压扁 */}
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <div className="inline-flex min-w-max flex-col gap-1">
          <div
            className="relative ml-[18px] h-3 text-[9px] tracking-wide text-zinc-400 dark:text-zinc-500"
          >
            {monthLabels.map((m) => (
              <span
                key={`m-${m.index}`}
                className="absolute top-0"
                style={{ left: `${m.index * (CELL_SIZE + CELL_GAP)}px` }}
              >
                {m.label}
              </span>
            ))}
          </div>

          <div className="flex gap-1">
            <div className="flex flex-col gap-[3px] pr-0.5">
              {WEEKDAY_LABELS.map((label, i) => (
                <div
                  key={i}
                  className="flex h-[11px] w-3 items-center justify-end text-[9px] leading-none text-zinc-400 dark:text-zinc-500"
                >
                  {label}
                </div>
              ))}
            </div>

            <div className="flex gap-[3px]">
              {grid.map((week, wi) => (
                <div key={wi} className="flex flex-col gap-[3px]">
                  {week.map((cell) => {
                    const isFuture = cell.level === -1;
                    const isSelected = selectedDay === cell.key;
                    const interactable = !isFuture && cell.count > 0;
                    return (
                      <button
                        type="button"
                        key={cell.key}
                        onMouseEnter={(e) => handleCellEnter(cell, e)}
                        onMouseMove={(e) => handleCellMove(cell, e)}
                        onMouseLeave={handleCellLeave}
                        onClick={() => handleCellClick(cell)}
                        aria-hidden={isFuture}
                        aria-label={
                          isFuture ? undefined : `${cell.key}：${cell.count} 次任务`
                        }
                        disabled={isFuture}
                        className={`h-[11px] w-[11px] rounded-[2px] outline-none transition-all ${
                          isFuture
                            ? "invisible"
                            : `${LEVEL_BG[cell.level]} ${
                                interactable ? "cursor-pointer" : "cursor-default"
                              } ${
                                isSelected
                                  ? "ring-2 ring-amber-400 ring-offset-1 ring-offset-white dark:ring-offset-slate-800"
                                  : "hover:ring-1 hover:ring-sky-400/70"
                              }`
                        }`}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-end gap-1 text-[9px] tracking-wide text-zinc-400 dark:text-zinc-500">
        <span>少</span>
        {LEVEL_BG.map((cls, i) => (
          <div key={i} className={`h-[11px] w-[11px] rounded-[2px] ${cls}`} />
        ))}
        <span>多</span>
      </div>

      {/* 详情面板：点击非空格子展开 */}
      <AnimatePresence initial={false}>
        {selectedDay && selectedEvents.length > 0 && (
          <motion.div
            key="day-detail"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="mt-3 overflow-hidden border-t border-white/50 pt-3 dark:border-white/10"
          >
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
                {(() => {
                  const [y, m, d] = selectedDay.split("-").map(Number);
                  const date = new Date(y, (m ?? 1) - 1, d ?? 1);
                  return `${formatDateLabel(date)} · ${selectedEvents.length} 次任务`;
                })()}
              </div>
              <button
                type="button"
                onClick={() => setSelectedDay(null)}
                aria-label="收起详情"
                className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-black/5 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-white/5 dark:hover:text-zinc-200"
              >
                <svg
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className="h-3 w-3"
                >
                  <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <div className="flex max-h-48 flex-col gap-1 overflow-y-auto pr-1">
              {selectedEvents
                .slice()
                .sort((a, b) => a.ts - b.ts)
                .map((evt, i) => (
                  <EventRow key={`${evt.ts}-${i}`} evt={evt} />
                ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 自定义 tooltip：portal 到 body，绕开 motion.section / motion.div 的
          transform —— framer-motion 在动画期间会给祖先写 transform 属性，
          这会让 position: fixed 失效（变成相对最近 transform 容器定位）。
          挂到 body 后 fixed 行为正常，z-50 也不会被外层 overflow-hidden 截断。 */}
      {hovered && hovered.cell.level !== -1 && typeof document !== "undefined"
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[60] whitespace-nowrap rounded-lg border border-white/60 bg-white/95 px-2.5 py-1.5 text-[11px] text-zinc-700 shadow-lg backdrop-blur dark:border-white/10 dark:bg-slate-900/95 dark:text-zinc-200"
              style={{
                // 偏右下 12px，避免遮住手指 / 光标本身；接近边缘自动翻转
                left: Math.min(hovered.x + 12, window.innerWidth - 220),
                top: Math.min(hovered.y + 12, window.innerHeight - 60),
              }}
            >
              <div className="font-medium">
                {formatDateLabel(hovered.cell.date)}
              </div>
              <div className="mt-0.5 text-[10px] text-zinc-500 dark:text-zinc-400">
                {hovered.cell.count > 0
                  ? `${hovered.cell.count} 次任务 · 点击查看详情`
                  : "无活动"}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function EventRow({ evt }: { evt: ActivityEvent }): JSX.Element {
  const time = formatTimeOfDay(evt.ts);
  const projectName = evt.projectPath ? basename(evt.projectPath) : "未选择目录";
  const agentLabel = AGENT_LABEL[evt.agent] ?? evt.agent;
  const prompt = evt.prompt?.trim();
  const isLegacy = evt.agent === "unknown" && !prompt;

  return (
    <div className="rounded-lg border border-white/40 bg-white/40 px-3 py-2 text-[12px] dark:border-white/10 dark:bg-zinc-800/40">
      <div className="flex items-center gap-2 text-[10px] tracking-wide text-zinc-400 dark:text-zinc-500">
        <span className="font-mono text-zinc-500 dark:text-zinc-300">{time}</span>
        <span>·</span>
        <span className="truncate" title={evt.projectPath ?? ""}>
          {projectName}
        </span>
        <span>·</span>
        <span>{agentLabel}</span>
      </div>
      {isLegacy ? (
        <div className="mt-1 text-[11px] italic text-zinc-400 dark:text-zinc-500">
          老版本记录已迁移，仅保留计数
        </div>
      ) : prompt ? (
        <div className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-zinc-700 dark:text-zinc-200">
          {prompt}
        </div>
      ) : (
        <div className="mt-1 text-[11px] italic text-zinc-400 dark:text-zinc-500">
          (无 prompt 记录)
        </div>
      )}
    </div>
  );
}
