// 左栏中部：项目管理区。
//
// 数据视角：每个 useTabsStore 里的 tab 就是一个"项目会话"；按 projectPath 分组。
// 同一目录可以有多个项目（同目录开多个会话场景）。null 目录归到"未选择目录"组，
// 由用户后续点击 ProjectPathButton 或新建时选目录补上。
//
// 交互：
//   - 单击项目卡 → setActiveTab，切到该 tab
//   - 目录标题旁的 + 按钮：在该目录下新建一个 tab（agent 用全局 selectedAgent 默认）
//   - 底部"在新目录中开始"按钮：弹文件对话框选目录 + 新建 tab
//   - 中键 / hover ×：关闭 tab（复用 TabBar 的 handleClose 同款逻辑）

import { invoke, pickFolder } from "../../lib/bridge";
import { useMemo } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { useTabsStore, type TabState } from "../../stores/useTabsStore";
import { useNow } from "../../hooks/useNow";

const NO_DIR_KEY = "__no_dir__";

interface DirectoryGroup {
  /// projectPath 字符串（NO_DIR_KEY 表示未选择目录）
  key: string;
  label: string;
  tabs: TabState[];
}

function groupTabsByDirectory(tabs: Record<string, TabState>, order: string[]): DirectoryGroup[] {
  const map = new Map<string, DirectoryGroup>();
  for (const id of order) {
    const tab = tabs[id];
    if (!tab) continue;
    const key = tab.projectPath ?? NO_DIR_KEY;
    const label =
      tab.projectPath === null ? "未选择目录" : basename(tab.projectPath) || tab.projectPath;
    if (!map.has(key)) map.set(key, { key, label, tabs: [] });
    map.get(key)!.tabs.push(tab);
  }
  // 每组内按 lastActiveAt 倒序：最近活动的项目排最上
  for (const group of map.values()) {
    group.tabs.sort((a, b) => (b.lastActiveAt || b.createdAt) - (a.lastActiveAt || a.createdAt));
  }
  // 组之间也按"组内最新 lastActiveAt"倒序
  return Array.from(map.values()).sort((a, b) => {
    const aMax = Math.max(...a.tabs.map((t) => t.lastActiveAt || t.createdAt));
    const bMax = Math.max(...b.tabs.map((t) => t.lastActiveAt || t.createdAt));
    return bMax - aMax;
  });
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

function relativeTime(ms: number, now: number): string {
  if (!ms) return "—";
  const diff = now - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function isTabRunning(tab: TabState): boolean {
  return (
    tab.uiState === "running" ||
    tab.agentStatus === "running" ||
    tab.agentStatus === "thinking" ||
    tab.agentStatus === "processing"
  );
}

interface ProjectCardProps {
  tab: TabState;
  isActive: boolean;
  now: number;
  onSelect: () => void;
  onClose: () => void;
}

function ProjectCard({ tab, isActive, now, onSelect, onClose }: ProjectCardProps): JSX.Element {
  const running = isTabRunning(tab);
  // 摘要标题优先级：lastUserPrompt（最近一次提问）→ task（草稿）→ title → "新会话"
  const summary =
    (tab.lastUserPrompt && tab.lastUserPrompt.trim()) ||
    (tab.task && tab.task.trim().slice(0, 80)) ||
    tab.title ||
    "新会话";

  return (
    <div
      onClick={onSelect}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      className={`group relative cursor-pointer rounded-lg border px-3 py-3 text-[14px] transition-all ${
        isActive
          ? "border-sky-400/45 bg-sky-400/15 text-zinc-800 shadow-sm dark:border-sky-300/40 dark:bg-sky-400/15 dark:text-zinc-100"
          : "border-white/40 bg-white/45 text-zinc-700 hover:bg-white/70 dark:border-white/10 dark:bg-zinc-800/45 dark:text-zinc-300 dark:hover:bg-zinc-800/65"
      }`}
      role="button"
      aria-current={isActive}
    >
      {/* 状态点 */}
      <div className="flex items-start gap-2.5">
        {running ? (
          <span className="mt-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-sky-400 shadow-[0_0_4px_rgba(56,189,248,0.6)]" />
        ) : tab.hasUnread ? (
          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-rose-400 shadow-[0_0_4px_rgba(251,113,133,0.6)]" />
        ) : (
          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-600" />
        )}
        <div className="min-w-0 flex-1 pr-7">
          <div className="truncate font-medium leading-tight" title={summary}>
            {summary}
          </div>
          <div className="mt-1 text-[12px] tracking-wide text-zinc-400 dark:text-zinc-500">
            {tab.agent} · {relativeTime(tab.lastActiveAt || tab.createdAt, now)}
          </div>
        </div>
      </div>

      {/* 关闭按钮：移动端常驻显示 + 加大触控区；桌面端 hover 才出现 */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="关闭项目"
        className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded text-zinc-400 opacity-100 transition-opacity hover:bg-rose-400/20 hover:text-rose-500 sm:opacity-0 sm:group-hover:opacity-100 dark:text-zinc-500 dark:hover:text-rose-400"
      >
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-2.5 w-2.5">
          <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

export function ProjectTree(): JSX.Element {
  const tabs = useTabsStore((s) => s.tabs);
  const order = useTabsStore((s) => s.order);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const setActiveTab = useTabsStore((s) => s.setActiveTab);
  const removeTab = useTabsStore((s) => s.removeTab);
  const createTab = useTabsStore((s) => s.createTab);
  const selectedAgent = useAppStore((s) => s.selectedAgent);
  const setIsStarted = useAppStore((s) => s.setIsStarted);
  const addLogEntry = useAppStore((s) => s.addLogEntry);

  const groups = useMemo(() => groupTabsByDirectory(tabs, order), [tabs, order]);
  // 订阅墙上时钟，让"X 分钟前"在窗口长期闲置时也按 30s 自动刷新（不靠用户点击触发）
  const now = useNow();

  const handleCloseTab = async (id: string): Promise<void> => {
    const tab = tabs[id];
    if (!tab) return;
    const running = isTabRunning(tab);
    const isLast = order.length === 1;
    if (running) {
      const msg = isLast
        ? "任务还在进行中。关闭这个项目会停止当前任务并返回欢迎页，确定吗？"
        : "任务还在进行中。关闭这个项目会停止该任务，确定吗？";
      if (!window.confirm(msg)) return;
    }
    if (tab.sessionId || running) {
      try {
        await invoke("stop_agent", { runId: id, sessionId: tab.sessionId });
      } catch (err) {
        addLogEntry({
          timestamp: Date.now(),
          level: "warn",
          message: `关闭项目时 stop_agent 失败: ${String(err)}`,
        });
      }
    }
    removeTab(id);
    if (useTabsStore.getState().order.length === 0) setIsStarted(false);
  };

  const createInDirectory = (projectPath: string | null): void => {
    const id = createTab({
      title: projectPath ? basename(projectPath) : "新会话",
      agent: selectedAgent,
      projectPath,
    });
    setActiveTab(id);
  };

  const pickAndCreate = async (): Promise<void> => {
    try {
      const path = await pickFolder({ title: "选择项目目录" });
      if (!path) return;
      createInDirectory(path);
    } catch (err) {
      addLogEntry({
        timestamp: Date.now(),
        level: "warn",
        message: `选目录失败: ${String(err)}`,
      });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-3">
      {groups.map((group) => (
        <div key={group.key} className="flex flex-col gap-1">
          <div className="flex items-center justify-between px-1">
            <span
              className="truncate text-[12px] font-semibold uppercase tracking-[0.12em] text-zinc-400 dark:text-zinc-500"
              title={group.key === NO_DIR_KEY ? "未选择目录" : group.key}
            >
              {group.label}
            </span>
            {group.key !== NO_DIR_KEY && (
              <button
                type="button"
                onClick={() => createInDirectory(group.key)}
                aria-label="在该目录下新建项目"
                title="在该目录下新建项目"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-black/5 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-white/5 dark:hover:text-zinc-200"
              >
                <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4">
                  <path d="M6 2v8M2 6h8" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
          <div className="flex flex-col gap-1">
            {group.tabs.map((tab) => (
              <ProjectCard
                key={tab.id}
                tab={tab}
                isActive={activeTabId === tab.id}
                now={now}
                onSelect={() => setActiveTab(tab.id)}
                onClose={() => void handleCloseTab(tab.id)}
              />
            ))}
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={() => void pickAndCreate()}
        className="mt-3 flex min-h-[50px] items-center justify-center gap-2.5 rounded-lg border border-dashed border-zinc-300/70 bg-transparent px-3 py-3 text-[14px] font-semibold text-zinc-500 transition-all hover:border-sky-400/50 hover:bg-sky-400/5 hover:text-sky-600 dark:border-zinc-700/70 dark:text-zinc-400 dark:hover:border-sky-300/40 dark:hover:bg-sky-300/5 dark:hover:text-sky-300"
      >
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4">
          <path d="M6 2v8M2 6h8" strokeLinecap="round" />
        </svg>
        在新目录中开始
      </button>
    </div>
  );
}
