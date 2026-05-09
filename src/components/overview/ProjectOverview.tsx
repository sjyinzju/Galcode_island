// 项目概览：当前 tab 已选目录但流式区还没有任何 block 时填充中栏上半部分。
// 替代原来的 spacer，让"刚开新会话 / 关闭后空 tab"的场景不再是一片空白。
//
// 设计参照 Claude 桌面客户端的 project overview：
//   - 顶部一行项目身份（名称 / agent / 路径）
//   - 上次结果摘要卡（来自 tab.summaryTranslation）
//   - 该目录下的历史会话快列（从 useTabsStore.history 按 projectPath 过滤）
//   - 几个静态提示卡，作为 InputBubble 的引导
//
// 不在这里渲染输入气泡：InputBubble 由 MainView 在底部继续挂；
// Overview 只负责"上半部分"的内容。

import { motion } from "framer-motion";
import { useMemo } from "react";
import { pickFolder } from "../../lib/bridge";
import { useNow } from "../../hooks/useNow";
import { useActiveTab, useActiveTabActions } from "../../hooks/useActiveTab";
import { useTabsStore } from "../../stores/useTabsStore";
import { useUiStore } from "../../stores/useUiStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { AGENT_LABEL, basename, relativeTime } from "./overviewUtils";
import { ActivityHeatmap } from "./ActivityHeatmap";

export function ProjectOverview(): JSX.Element {
  const tab = useActiveTab();
  const { activeTabId, update } = useActiveTabActions();
  const restoreFromHistory = useTabsStore((s) => s.restoreFromHistory);
  const setActiveTab = useTabsStore((s) => s.setActiveTab);
  const setLeftSidebarView = useUiStore((s) => s.setLeftSidebarView);
  const history = useTabsStore((s) => s.history);
  const backends = useSettingsStore((s) => s.backends);
  const now = useNow();

  const projectPath = tab.projectPath;
  const projectName = projectPath ? basename(projectPath) : "未选择项目";
  const agentLabel = AGENT_LABEL[tab.agent] ?? tab.agent;
  const backendPrefs = backends[tab.agent as keyof typeof backends];
  const modelHint = backendPrefs?.model?.trim() || "默认模型";

  // 该目录下已归档的历史；找不到就退化展示该 agent 的最近 5 条
  const localHistory = useMemo(() => {
    if (!projectPath) return [];
    return history
      .filter((h) => h.projectPath === projectPath)
      .sort((a, b) => b.closedAt - a.closedAt)
      .slice(0, 5);
  }, [history, projectPath]);

  const fallbackHistory = useMemo(() => {
    if (projectPath) return [];
    return history.slice().sort((a, b) => b.closedAt - a.closedAt).slice(0, 5);
  }, [history, projectPath]);

  const summary = tab.summaryTranslation?.trim() || tab.resultZh?.trim() || "";
  const lastUserPrompt = tab.lastUserPrompt?.trim() || "";
  const suggestionOptions = tab.suggestionOptions;

  const handleRestore = (id: string): void => {
    const newId = restoreFromHistory(id);
    if (newId) {
      setActiveTab(newId);
      setLeftSidebarView("projects");
    }
  };

  const handlePickFolder = async (): Promise<void> => {
    if (!activeTabId) return;
    const path = await pickFolder({ title: "选择项目目录" });
    if (!path) return;
    update({ projectPath: path, title: basename(path) });
  };

  const handleQuickPrompt = (prompt: string): void => {
    if (!activeTabId) return;
    update({ task: prompt });
  };

  // 进入项目但还没选目录的场景，给一个温和的"先选目录"卡，避免误以为应用卡住
  if (!projectPath) {
    return (
      <motion.div
        key="project-overview-empty-path"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.32, ease: "easeOut" }}
        className="flex min-h-0 w-full flex-1 items-center justify-center px-3 pb-3"
      >
        <div className="w-full max-w-md rounded-2xl border border-amber-300/40 bg-amber-50/70 px-5 py-6 text-center backdrop-blur-md dark:border-amber-300/20 dark:bg-amber-300/5">
          <div className="text-[15px] font-semibold text-amber-700 dark:text-amber-200">
            还没选择项目目录
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-amber-700/80 dark:text-amber-200/70">
            选好目录后才能让 {agentLabel} 在那里读写文件 / 跑命令。
          </p>
          <button
            type="button"
            onClick={() => void handlePickFolder()}
            className="mt-4 rounded-xl bg-amber-500 px-5 py-2 text-[13px] font-medium text-white shadow-md shadow-amber-400/20 transition-all hover:-translate-y-0.5 hover:bg-amber-600"
          >
            选择项目目录
          </button>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      key="project-overview"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: "easeOut" }}
      className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto px-1 pb-2"
    >
      {/* 项目身份卡：名字 + agent + 路径 */}
      <div className="rounded-2xl border border-white/60 bg-white/70 p-4 shadow-sm backdrop-blur-md sm:p-5 dark:border-white/10 dark:bg-slate-800/55">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="truncate text-[18px] font-semibold tracking-tight text-zinc-800 sm:text-[20px] dark:text-zinc-100">
            {projectName}
          </h2>
          <span className="rounded-full border border-sky-300/40 bg-sky-400/10 px-2 py-0.5 text-[11px] font-medium tracking-wide text-sky-700 dark:border-sky-300/30 dark:bg-sky-400/15 dark:text-sky-200">
            {agentLabel}
          </span>
          <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
            · {modelHint}
          </span>
        </div>
        <div
          className="mt-1.5 break-all text-[12px] text-zinc-500 dark:text-zinc-400"
          title={projectPath}
        >
          {projectPath}
        </div>
        <div className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
          {tab.lastActiveAt
            ? `上次活动 ${relativeTime(tab.lastActiveAt, now)}`
            : "还没启动过任何任务"}
          {tab.agentNativeSessionId && (
            <span className="ml-2 rounded-full bg-emerald-400/10 px-1.5 py-0.5 text-[10px] tracking-wide text-emerald-700 dark:text-emerald-300">
              可续会话
            </span>
          )}
        </div>
      </div>

      {/* 上次结果摘要 + 快速继续按钮 */}
      {(summary || lastUserPrompt || suggestionOptions.length > 0) && (
        <div className="mt-3 rounded-2xl border border-white/60 bg-white/55 p-4 backdrop-blur-md sm:p-5 dark:border-white/10 dark:bg-slate-800/45">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
            上次任务回顾
          </div>
          {lastUserPrompt && (
            <div className="mt-2 line-clamp-2 text-[13px] text-zinc-600 dark:text-zinc-300">
              <span className="text-zinc-400 dark:text-zinc-500">问：</span>
              {lastUserPrompt}
            </div>
          )}
          {summary && (
            <div className="mt-1.5 line-clamp-3 text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-200">
              {summary}
            </div>
          )}
          {suggestionOptions.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {suggestionOptions.slice(0, 4).map((opt, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => handleQuickPrompt(opt)}
                  title="把建议填进输入框"
                  className="rounded-full border border-sky-300/40 bg-sky-400/10 px-3 py-1 text-[11px] text-sky-700 transition-all hover:-translate-y-0.5 hover:bg-sky-400/20 dark:border-sky-300/30 dark:bg-sky-400/15 dark:text-sky-200"
                >
                  {opt.length > 22 ? `${opt.slice(0, 22)}…` : opt}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 该目录历史会话快列 */}
      {localHistory.length > 0 ? (
        <div className="mt-3 rounded-2xl border border-white/60 bg-white/55 p-4 backdrop-blur-md sm:p-5 dark:border-white/10 dark:bg-slate-800/45">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
              该项目的历史会话
            </span>
            <button
              type="button"
              onClick={() => setLeftSidebarView("history")}
              className="text-[10px] text-zinc-400 transition-colors hover:text-sky-500 dark:text-zinc-500 dark:hover:text-sky-300"
            >
              全部 →
            </button>
          </div>
          <div className="flex flex-col gap-1">
            {localHistory.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => handleRestore(item.id)}
                className="group flex items-start gap-2 rounded-lg border border-white/40 bg-white/40 px-3 py-2 text-left text-[12px] text-zinc-700 transition-all hover:-translate-y-0.5 hover:bg-white/70 dark:border-white/10 dark:bg-zinc-800/40 dark:text-zinc-300 dark:hover:bg-zinc-800/65"
              >
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-600" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium" title={item.summary}>
                    {item.summary}
                  </div>
                  <div className="mt-0.5 truncate text-[10px] tracking-wide text-zinc-400 dark:text-zinc-500">
                    {(AGENT_LABEL[item.agent] ?? item.agent)} · {relativeTime(item.closedAt, now)}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : fallbackHistory.length > 0 ? (
        <div className="mt-3 rounded-2xl border border-white/60 bg-white/55 p-4 backdrop-blur-md dark:border-white/10 dark:bg-slate-800/45">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500">
            该目录还没有历史会话
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            和团长说点什么，开始第一轮工作吧。
          </p>
        </div>
      ) : null}

      {/* 活跃热图：跟 GlobalOverview 同款瓷砖，让进入项目的用户也能看到整体节奏 */}
      <div className="mt-3">
        <ActivityHeatmap />
      </div>

      {/* 静态使用提示 —— 让用户知道还有什么操作可以做 */}
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Hint
          title="键盘快捷键"
          body="Enter 发送，Shift+Enter 换行；Cmd/Ctrl+F 在当前 tab 内搜索。"
        />
        <Hint
          title="多 tab 工作"
          body="左栏「+ 在新目录中开始」可以同时跑多个项目，每个 tab 互不干扰。"
        />
      </div>
    </motion.div>
  );
}

function Hint({ title, body }: { title: string; body: string }): JSX.Element {
  return (
    <div className="rounded-xl border border-white/50 bg-white/45 p-3 text-[12px] backdrop-blur-md dark:border-white/10 dark:bg-slate-800/35">
      <div className="text-[11px] font-semibold tracking-wide text-zinc-600 dark:text-zinc-200">
        {title}
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
        {body}
      </p>
    </div>
  );
}
