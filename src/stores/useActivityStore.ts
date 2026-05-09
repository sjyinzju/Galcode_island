// 活跃度记录：每天用户启动 task 的事件列表。
//
// 用途：在 GlobalOverview / ProjectOverview 渲染 GitHub 风格瓷砖热图。
// 鼠标 hover 显示当日次数；点击瓷砖展开当日所有 event 详情（时间 / 项目 / agent / prompt）。
//
// 数据格式：`events[YYYY-MM-DD] = ActivityEvent[]`。键用本地时区的日期串，
// 避免 UTC 偏移让"今天"的格子跑到错误的列。当天计数 = events.length。
//
// 首次启动且无任何记录时，从 useTabsStore.history 反推 seed 一次（带 summary / agent /
// projectPath），让老用户打开新版本立刻能看到分布与详情。
//
// 不走 createSharedStorage：活跃度是设备本地的轻量状态，跨设备同步反而会双计数。
//
// **持久化保护**：每天最多保留 200 条 event 防体积爆掉；store 整体最多保留 365 天。

import { create } from "zustand";
import { persist } from "zustand/middleware";

export function activityDayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export interface ActivityEvent {
  /// 启动时刻毫秒
  ts: number;
  projectPath: string | null;
  /// agent backend id（claude-code / codex / opencode / unknown）
  agent: string;
  /// 任务 prompt 摘要（截断到 80 字）
  prompt: string;
}

const MAX_EVENTS_PER_DAY = 200;
const MAX_DAYS_KEEP = 365;

interface ActivityState {
  /// YYYY-MM-DD → 当天所有启动事件
  events: Record<string, ActivityEvent[]>;
  /// 记录一次活跃。ts 默认取 Date.now()；其它字段调用方应尽量传齐，
  /// 缺省值用 null / "unknown" / 空串。
  recordActivity: (event: Partial<ActivityEvent>) => void;
  /// 一次性 seed：把传入事件按日聚合写入 events；
  /// **仅在 events 完全为空时执行**，避免重复 seed 把真实数据覆盖掉。
  seedFromHistory: (
    entries: Array<{
      ts: number;
      projectPath: string | null;
      agent: string;
      summary: string;
    }>,
  ) => void;
}

function pruneOldDays(events: Record<string, ActivityEvent[]>): Record<string, ActivityEvent[]> {
  const keys = Object.keys(events);
  if (keys.length <= MAX_DAYS_KEEP) return events;
  const sorted = keys.sort();
  const drop = sorted.slice(0, sorted.length - MAX_DAYS_KEEP);
  if (drop.length === 0) return events;
  const next = { ...events };
  for (const k of drop) delete next[k];
  return next;
}

export const useActivityStore = create<ActivityState>()(
  persist(
    (set, get) => ({
      events: {},

      recordActivity: (evt) => {
        const ts = evt.ts ?? Date.now();
        const key = activityDayKey(ts);
        const event: ActivityEvent = {
          ts,
          projectPath: evt.projectPath ?? null,
          agent: evt.agent ?? "unknown",
          prompt: (evt.prompt ?? "").slice(0, 80),
        };
        set((s) => {
          const dayList = s.events[key] ?? [];
          const nextDayList =
            dayList.length >= MAX_EVENTS_PER_DAY
              ? [...dayList.slice(-(MAX_EVENTS_PER_DAY - 1)), event]
              : [...dayList, event];
          return {
            events: pruneOldDays({ ...s.events, [key]: nextDayList }),
          };
        });
      },

      seedFromHistory: (entries) => {
        if (Object.keys(get().events).length > 0) return;
        if (entries.length === 0) return;
        const next: Record<string, ActivityEvent[]> = {};
        for (const e of entries) {
          if (!e.ts) continue;
          const key = activityDayKey(e.ts);
          const list = next[key] ?? (next[key] = []);
          list.push({
            ts: e.ts,
            projectPath: e.projectPath ?? null,
            agent: e.agent ?? "unknown",
            prompt: (e.summary ?? "").slice(0, 80),
          });
        }
        // 当天事件按时间升序，体验上"上午→下午→晚上"
        for (const k of Object.keys(next)) {
          next[k].sort((a, b) => a.ts - b.ts);
        }
        set({ events: pruneOldDays(next) });
      },
    }),
    {
      name: "galcode_activity",
      version: 2,
      // v1: { days: Record<string, number> } —— 仅有计数没有详情。
      // 升级时给每条计数生成一个占位 event：ts 落在当天 12:00、agent="unknown"、
      // prompt 空。计数得以保留（热图色阶不变），代价是详情面板对老数据只能显示
      // "记录已迁移"占位。新增的 event 仍带完整字段。
      migrate: (persisted: unknown, version: number) => {
        if (version >= 2) return persisted as ActivityState;
        const old = (persisted as { days?: Record<string, number> } | null) ?? {};
        const events: Record<string, ActivityEvent[]> = {};
        for (const [day, count] of Object.entries(old.days ?? {})) {
          if (!count || count <= 0) continue;
          const baseTs = Date.parse(`${day}T12:00:00`);
          if (Number.isNaN(baseTs)) continue;
          events[day] = Array.from({ length: count }, (_, i) => ({
            ts: baseTs + i * 1000,
            projectPath: null,
            agent: "unknown",
            prompt: "",
          }));
        }
        return { events } as ActivityState;
      },
    },
  ),
);
