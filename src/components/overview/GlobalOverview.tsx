// 全局概览：没有任何活动 tab 时填进中栏，替代原来的整屏 WelcomeView。
// 让"未启动 / 关掉最后一个项目"的状态也保持三栏布局，不再切到独立画面。
//
// 内容：
//   - 顶部：手写体动画大标题 + 一句副标题（沿用 WelcomeView 的视觉骨架）
//   - 中部：两栏栅格——左主 CTA（选目录 + 选 agent）、右概览统计 + 最近项目
//   - 底部：历史会话简列 + PetCharacter
//
// 选目录 / 启动逻辑跟旧 WelcomeView 等价：创建第一个 tab 后 setIsStarted(true)。

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useMemo, useState } from "react";
import { pickFolder } from "../../lib/bridge";
import { useNow } from "../../hooks/useNow";
import { useAppStore } from "../../stores/useAppStore";
import { useTabsStore } from "../../stores/useTabsStore";
import { useUiStore } from "../../stores/useUiStore";
import { PetCharacter } from "../pet-character/PetCharacter";
import type { AgentType } from "../../types/agent";
import { AGENT_LABEL, basename, relativeTime } from "./overviewUtils";
import { ActivityHeatmap } from "./ActivityHeatmap";

const agentOptions: { value: AgentType; label: string }[] = [
  { value: "claude-code", label: "Claude Code" },
  { value: "opencode", label: "OpenCode" },
  { value: "codex", label: "Codex" },
];

const titleChars = "Galcode Island".split("");

const titleVariants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.05, delayChildren: 0.18 },
  },
};

const charVariants = {
  hidden: { opacity: 0, y: 14, rotate: -6, filter: "blur(3px)" },
  visible: {
    opacity: 1,
    y: 0,
    rotate: 0,
    filter: "blur(0px)",
    transition: { type: "spring" as const, damping: 12, stiffness: 200, mass: 0.6 },
  },
};

export function GlobalOverview(): JSX.Element {
  const selectedAgent = useAppStore((s) => s.selectedAgent);
  const setSelectedAgent = useAppStore((s) => s.setSelectedAgent);
  const setIsStarted = useAppStore((s) => s.setIsStarted);
  const createTab = useTabsStore((s) => s.createTab);
  const setActiveTab = useTabsStore((s) => s.setActiveTab);
  const restoreFromHistory = useTabsStore((s) => s.restoreFromHistory);
  const history = useTabsStore((s) => s.history);
  const setLeftSidebarView = useUiStore((s) => s.setLeftSidebarView);
  const now = useNow();

  const [pendingProjectPath, setPendingProjectPath] = useState<string | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [isAgentMenuOpen, setIsAgentMenuOpen] = useState(false);

  const selectedAgentLabel = AGENT_LABEL[selectedAgent] ?? selectedAgent;

  // 历史聚合统计
  const stats = useMemo(() => {
    const total = history.length;
    const SEVEN_DAYS = 7 * 86_400_000;
    const recent = history.filter((h) => now - h.closedAt < SEVEN_DAYS).length;
    const dirs = new Set(history.map((h) => h.projectPath).filter(Boolean));
    return { total, recent, dirs: dirs.size };
  }, [history, now]);

  // 最近活跃的归档目录（聚合后取每个目录最新一条）
  const recentProjects = useMemo(() => {
    const map = new Map<string, { path: string; closedAt: number; agent: string; summary: string }>();
    for (const h of history) {
      if (!h.projectPath) continue;
      const cur = map.get(h.projectPath);
      if (!cur || cur.closedAt < h.closedAt) {
        map.set(h.projectPath, {
          path: h.projectPath,
          closedAt: h.closedAt,
          agent: h.agent,
          summary: h.summary,
        });
      }
    }
    return Array.from(map.values())
      .sort((a, b) => b.closedAt - a.closedAt)
      .slice(0, 6);
  }, [history]);

  const recentSessions = useMemo(
    () => history.slice().sort((a, b) => b.closedAt - a.closedAt).slice(0, 5),
    [history],
  );

  const pickProjectFolder = useCallback(async (): Promise<void> => {
    setIsSelecting(true);
    try {
      const path = await pickFolder({ title: "选择项目目录" });
      if (!path) return;
      setPendingProjectPath(path);
    } finally {
      setIsSelecting(false);
    }
  }, []);

  const handlePrimaryAction = useCallback(async (): Promise<void> => {
    if (!pendingProjectPath) {
      await pickProjectFolder();
      return;
    }
    const id = createTab({
      title: basename(pendingProjectPath),
      agent: selectedAgent,
      projectPath: pendingProjectPath,
    });
    setActiveTab(id);
    setIsStarted(true);
  }, [pendingProjectPath, pickProjectFolder, createTab, selectedAgent, setActiveTab, setIsStarted]);

  const handleOpenRecent = useCallback(
    (path: string, agent: string): void => {
      const id = createTab({
        title: basename(path),
        agent: agent as AgentType,
        projectPath: path,
      });
      setActiveTab(id);
      setIsStarted(true);
    },
    [createTab, setActiveTab, setIsStarted],
  );

  const handleRestoreSession = useCallback(
    (archivedId: string): void => {
      const newId = restoreFromHistory(archivedId);
      if (newId) {
        setActiveTab(newId);
        setIsStarted(true);
        setLeftSidebarView("projects");
      }
    },
    [restoreFromHistory, setActiveTab, setIsStarted, setLeftSidebarView],
  );

  const isReady = Boolean(pendingProjectPath);

  return (
    <motion.div
      key="global-overview"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: "easeOut" }}
      className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto px-1 pb-3"
    >
      {/* 顶部标题 */}
      <div className="flex flex-col items-center gap-2 pt-2 pb-3 sm:pt-4 sm:pb-5">
        <motion.h1
          variants={titleVariants}
          initial="hidden"
          animate="visible"
          className="flex flex-wrap justify-center gap-x-[0.05em] text-center text-2xl font-bold italic tracking-tight font-serif sm:text-3xl lg:text-4xl"
          style={{ fontVariationSettings: "'wght' 700" }}
        >
          {titleChars.map((char, i) => (
            <motion.span
              key={`${char}-${i}`}
              variants={charVariants}
              className="inline-block bg-gradient-to-br from-amber-400 via-orange-500 to-amber-500 bg-clip-text text-transparent dark:from-amber-300 dark:via-orange-400 dark:to-amber-400"
              style={{ minWidth: char === " " ? "0.3em" : undefined }}
            >
              {char === " " ? " " : char}
            </motion.span>
          ))}
        </motion.h1>
        <p className="text-center text-[12px] text-zinc-500 sm:text-[13px] dark:text-zinc-400">
          把 Claude Code、OpenCode、Codex 放进同一个桌面工作台，开始一个新会话吧。
        </p>
      </div>

      {/* 启动行：选目录 + agent + 已选路径。
          relative z-10：下方统计卡 / 热图卡也用 backdrop-blur 创建了 stacking context，
          相同 z-auto 时后写的会覆盖前面的，导致 agent 下拉被盖住。把启动行抬到 z-10
          独立成层后，内部 absolute 定位的下拉菜单（z-20）就能盖住所有 z-auto 兄弟。
          用 z-10 而非更高值是为了让窄屏下 z-30 的左侧抽屉（App.tsx 侧边栏）能正确
          盖住本启动行，避免抽屉展开时被这张卡片穿透遮挡。 */}
      <div className="relative z-10 rounded-2xl border border-white/60 bg-white/65 p-4 shadow-sm backdrop-blur-md sm:p-5 dark:border-white/10 dark:bg-slate-800/55">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
          开始一个新项目
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 sm:gap-3">
          <motion.button
            whileHover={{ y: -1, scale: 1.01 }}
            whileTap={{ scale: 0.985 }}
            type="button"
            onClick={() => void handlePrimaryAction()}
            disabled={isSelecting}
            className={`min-h-[44px] min-w-[120px] rounded-xl border px-4 py-2.5 text-[13px] font-medium backdrop-blur-md transition-all hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-70 sm:min-h-0 sm:py-2 ${
              isReady
                ? "border-sky-400/50 bg-sky-400/25 text-zinc-900 shadow-sky-400/15 dark:border-sky-400/40 dark:bg-sky-500/30 dark:text-zinc-100"
                : "border-white/40 bg-white/40 text-zinc-800 dark:border-white/15 dark:bg-white/10 dark:text-zinc-100"
            }`}
          >
            {isSelecting ? "选择中..." : isReady ? "启动" : "选择项目目录"}
          </motion.button>

          <div className="relative">
            <motion.button
              type="button"
              whileHover={{ y: -1, scale: 1.01 }}
              whileTap={{ scale: 0.985 }}
              onClick={() => setIsAgentMenuOpen((v) => !v)}
              className="min-h-[44px] min-w-[140px] rounded-xl border border-white/40 bg-white/40 px-3 py-2.5 text-[13px] text-zinc-800 backdrop-blur-md transition-all hover:bg-white/55 sm:min-h-0 sm:py-2 dark:border-white/15 dark:bg-white/10 dark:text-zinc-100 dark:hover:bg-white/15"
              aria-haspopup="listbox"
              aria-expanded={isAgentMenuOpen}
            >
              Agent · {selectedAgentLabel}
            </motion.button>

            <AnimatePresence>
              {isAgentMenuOpen ? (
                <motion.ul
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.18 }}
                  className="absolute left-0 top-[calc(100%+6px)] z-20 w-full rounded-xl border border-white/60 bg-white/80 p-1 shadow-lg backdrop-blur-xl dark:border-white/10 dark:bg-slate-800/80"
                  role="listbox"
                >
                  {agentOptions.map((option) => (
                    <li key={option.value}>
                      <button
                        type="button"
                        className={`w-full rounded-lg px-3 py-2 text-left text-[12px] text-zinc-800 transition-all hover:bg-white/55 dark:text-zinc-100 dark:hover:bg-white/10 ${
                          selectedAgent === option.value ? "bg-white/55 dark:bg-white/10" : ""
                        }`}
                        onClick={() => {
                          setSelectedAgent(option.value);
                          setIsAgentMenuOpen(false);
                        }}
                      >
                        {option.label}
                      </button>
                    </li>
                  ))}
                </motion.ul>
              ) : null}
            </AnimatePresence>
          </div>
        </div>

        <AnimatePresence>
          {pendingProjectPath ? (
            <motion.p
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className="mt-3 break-all rounded-lg border border-white/50 bg-white/45 px-3 py-2 text-[11px] text-zinc-700 backdrop-blur-md dark:border-white/10 dark:bg-slate-800/40 dark:text-zinc-300"
            >
              即将启动：{pendingProjectPath}
            </motion.p>
          ) : null}
        </AnimatePresence>
      </div>

      {/* 概览统计 */}
      <div className="mt-3 grid grid-cols-3 gap-2">
        <Stat label="累计会话" value={stats.total} />
        <Stat label="近 7 天" value={stats.recent} />
        <Stat label="项目目录" value={stats.dirs} />
      </div>

      {/* GitHub 风格活跃热图：每天一格按启动 task 次数染色 */}
      <div className="mt-3">
        <ActivityHeatmap />
      </div>

      {/* 最近项目 + 桌宠 */}
      <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_180px]">
        <div className="rounded-2xl border border-white/60 bg-white/55 p-4 backdrop-blur-md dark:border-white/10 dark:bg-slate-800/45">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
              最近项目
            </span>
            {recentProjects.length > 0 && (
              <button
                type="button"
                onClick={() => setLeftSidebarView("history")}
                className="text-[10px] text-zinc-400 transition-colors hover:text-sky-500 dark:text-zinc-500 dark:hover:text-sky-300"
              >
                查看全部 →
              </button>
            )}
          </div>
          {recentProjects.length === 0 ? (
            <p className="text-[12px] text-zinc-500 dark:text-zinc-400">
              还没有归档项目。选一个目录开始第一次会话吧。
            </p>
          ) : (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {recentProjects.map((p) => (
                <button
                  key={p.path}
                  type="button"
                  onClick={() => handleOpenRecent(p.path, p.agent)}
                  className="group flex flex-col items-start gap-0.5 rounded-lg border border-white/40 bg-white/40 px-3 py-2 text-left text-[12px] transition-all hover:-translate-y-0.5 hover:bg-white/70 dark:border-white/10 dark:bg-zinc-800/40 dark:hover:bg-zinc-800/65"
                  title={p.path}
                >
                  <span className="w-full truncate font-medium text-zinc-700 dark:text-zinc-200">
                    {basename(p.path)}
                  </span>
                  <span className="w-full truncate text-[10px] tracking-wide text-zinc-400 dark:text-zinc-500">
                    {(AGENT_LABEL[p.agent] ?? p.agent)} · {relativeTime(p.closedAt, now)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 桌宠：仅桌面端右侧；移动端隐藏，避免抢屏 */}
        <div className="hidden items-end justify-center lg:flex">
          <PetCharacter />
        </div>
      </div>

      {/* 最近会话快列 */}
      {recentSessions.length > 0 && (
        <div className="mt-3 rounded-2xl border border-white/60 bg-white/55 p-4 backdrop-blur-md dark:border-white/10 dark:bg-slate-800/45">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
              最近会话
            </span>
            <button
              type="button"
              onClick={() => setLeftSidebarView("history")}
              className="text-[10px] text-zinc-400 transition-colors hover:text-sky-500 dark:text-zinc-500 dark:hover:text-sky-300"
            >
              历史面板 →
            </button>
          </div>
          <div className="flex flex-col gap-1">
            {recentSessions.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => handleRestoreSession(item.id)}
                className="flex items-start gap-2 rounded-lg border border-white/40 bg-white/40 px-3 py-2 text-left text-[12px] transition-all hover:-translate-y-0.5 hover:bg-white/70 dark:border-white/10 dark:bg-zinc-800/40 dark:hover:bg-zinc-800/65"
              >
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-600" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-zinc-700 dark:text-zinc-200" title={item.summary}>
                    {item.summary}
                  </div>
                  <div className="mt-0.5 truncate text-[10px] tracking-wide text-zinc-400 dark:text-zinc-500">
                    {basename(item.projectPath)} · {(AGENT_LABEL[item.agent] ?? item.agent)} · {relativeTime(item.closedAt, now)}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </motion.div>
  );
}

function Stat({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="rounded-xl border border-white/50 bg-white/45 px-3 py-2.5 text-center backdrop-blur-md dark:border-white/10 dark:bg-slate-800/35">
      <div className="text-[18px] font-semibold leading-tight tracking-tight text-zinc-800 dark:text-zinc-100">
        {value}
      </div>
      <div className="mt-0.5 text-[10px] tracking-wide text-zinc-400 dark:text-zinc-500">
        {label}
      </div>
    </div>
  );
}
