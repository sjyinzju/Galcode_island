// 项目概览：当前 tab 已选目录但流式区还没有任何 block 时填充中栏上半部分。
// 替代原来的 spacer，让"刚开新会话 / 关闭后空 tab"的场景不再是一片空白。
//
// 设计参照 Claude 桌面客户端的 project overview：
//   - 顶部一行项目身份（名称 / agent / 模型 / 努力程度 下拉配置）
//   - 上次结果摘要卡（来自 tab.summaryTranslation）
//   - 该目录下的历史会话快列（从 useTabsStore.history 按 projectPath 过滤）
//   - 几个静态提示卡，作为 InputBubble 的引导
//
// 不在这里渲染输入气泡：InputBubble 由 MainView 在底部继续挂；
// Overview 只负责"上半部分"的内容。

import { motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke, pickFolder } from "../../lib/bridge";
import { useNow } from "../../hooks/useNow";
import { useActiveTab, useActiveTabActions } from "../../hooks/useActiveTab";
import { useTabsStore } from "../../stores/useTabsStore";
import { useUiStore } from "../../stores/useUiStore";
import { useSettingsStore, type BackendKey } from "../../stores/useSettingsStore";
import type { AgentType } from "../../types/agent";
import type {
  ClaudeModelsResult,
  CodexModelsResult,
} from "../../types/backend";
import { AGENT_LABEL, basename, relativeTime } from "./overviewUtils";
import { ActivityHeatmap } from "./ActivityHeatmap";

// 可在 overview 页快速切换的 agent CLI —— 跟 settings.backends 一一对应。
// AgentType 还有 gemini/cursor，但目前没有完整的 backend prefs/启动链路，
// 所以这里只暴露三个真正能跑的，避免让用户选了之后启动报"backend 未实现"。
const AGENT_OPTIONS: ReadonlyArray<{ value: BackendKey; label: string }> = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "opencode", label: "OpenCode" },
];

// effort 档位的中文标签，只是给下拉显示更友好；
// 字典里没有的（比如 xhigh）就直接显示原 id，再加个"·Effort"前缀。
const EFFORT_LABELS: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "极限",
};

function formatEffortLabel(value: string): string {
  const human = EFFORT_LABELS[value] ?? value;
  return `Effort · ${human}`;
}

// ---------------------------------------------------------------------------
// agent catalog 拉取 —— 走官方 CLI 出口（claude_models / codex_models）
// ---------------------------------------------------------------------------

interface CatalogModel {
  id: string;
  label: string;
  /// Codex 注册表声明的"该模型推荐 effort"；Claude 没有这个概念时为 undefined
  defaultEffort?: string;
  /// 该模型支持的 effort 列表；Claude 用全局列表，此处为 undefined（看 catalog.efforts）
  supportedEfforts?: string[];
}

interface AgentCatalog {
  models: CatalogModel[];
  /// Claude 通过 --help 取到的全局 effort 列表；Codex 走 model.supportedEfforts，
  /// 这个字段就空，UI 渲染时按 currentModel 走
  efforts: string[];
  currentModelId?: string;
}

// 模块级缓存：CLI catalog 一旦拉到就缓存到 app 重启；切回该 agent 不再花 ~1.5s 走 CLI。
// 用户装了新版 CLI 想强制刷新——重启 app 即可；overview 上不提供"刷新"按钮免得让 chip 行变挤。
const catalogCache = new Map<BackendKey, AgentCatalog>();
const catalogInflight = new Map<BackendKey, Promise<AgentCatalog>>();

async function fetchAgentCatalog(backend: BackendKey): Promise<AgentCatalog> {
  if (backend === "claude-code") {
    const data = await invoke<ClaudeModelsResult>("claude_models", {});
    return {
      models: (data.availableModels ?? []).map((m) => ({
        id: m.id,
        label: m.name || m.id,
      })),
      efforts: data.availableEfforts ?? [],
      currentModelId: data.currentModelId,
    };
  }
  if (backend === "codex") {
    const data = await invoke<CodexModelsResult>("codex_models", {});
    return {
      models: (data.availableModels ?? []).map((m) => ({
        id: m.id,
        label: m.name || m.id,
        defaultEffort: m.defaultEffort,
        supportedEfforts: m.supportedEfforts,
      })),
      // Codex 的 effort 跟着每个 model 走（gpt-5.5 / gpt-5.3-codex 等支持的 level
      // 可能不同），这里留空，UI 按 currentModel.supportedEfforts 渲染
      efforts: [],
      currentModelId: data.currentModelId,
    };
  }
  // OpenCode 的模型 = provider × providerModels 二维矩阵，并且要 serve 起来 + 选定
  // provider 才有意义；overview 上不暴露下拉，直接返回空 catalog，让 UI 退化成"去设置里选"
  return { models: [], efforts: [] };
}

interface CatalogState {
  data: AgentCatalog | null;
  loading: boolean;
  error: string | null;
}

function useAgentCatalog(backend: BackendKey | null): CatalogState {
  const [state, setState] = useState<CatalogState>({
    data: null,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!backend) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    if (backend === "opencode") {
      // 不发请求，直接给空 catalog；UI 自己判断为"无下拉"
      setState({ data: { models: [], efforts: [] }, loading: false, error: null });
      return;
    }
    const cached = catalogCache.get(backend);
    if (cached) {
      setState({ data: cached, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    const promise =
      catalogInflight.get(backend) ??
      fetchAgentCatalog(backend).then((value) => {
        catalogCache.set(backend, value);
        catalogInflight.delete(backend);
        return value;
      });
    catalogInflight.set(backend, promise);
    promise.then(
      (data) => {
        if (!cancelled) setState({ data, loading: false, error: null });
      },
      (err) => {
        catalogInflight.delete(backend);
        if (!cancelled) {
          setState({ data: null, loading: false, error: String(err) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [backend]);

  return state;
}

export function ProjectOverview(): JSX.Element {
  const tab = useActiveTab();
  const { activeTabId, update } = useActiveTabActions();
  const restoreFromHistory = useTabsStore((s) => s.restoreFromHistory);
  const setActiveTab = useTabsStore((s) => s.setActiveTab);
  const setLeftSidebarView = useUiStore((s) => s.setLeftSidebarView);
  const history = useTabsStore((s) => s.history);
  const backends = useSettingsStore((s) => s.backends);
  const setBackendPref = useSettingsStore((s) => s.setBackendPref);
  const openSettingsModal = useSettingsStore((s) => s.openSettingsModal);
  const now = useNow();

  const projectPath = tab.projectPath;
  const projectName = projectPath ? basename(projectPath) : "未选择项目";
  const agentLabel = AGENT_LABEL[tab.agent] ?? tab.agent;
  // tab.agent 类型是 AgentType（含 gemini/cursor），但只有 3 个 BackendKey 在 settings.backends 里。
  // 选不到（如老 tab 是 gemini）就当作 claude-code 兜底，避免 UI 抛 undefined。
  const supportedBackend: BackendKey | null = AGENT_OPTIONS.some((o) => o.value === tab.agent)
    ? (tab.agent as BackendKey)
    : null;
  const backendPrefs = supportedBackend ? backends[supportedBackend] : null;

  // 拉该 backend 的官方模型 / effort 目录
  const catalog = useAgentCatalog(supportedBackend);

  // 当前选中的 model（catalog 形态）—— 用于推导 Codex 上的 supportedEfforts
  const currentModelEntry = useMemo(() => {
    if (!catalog.data || !backendPrefs?.model) return null;
    return catalog.data.models.find((m) => m.id === backendPrefs.model) ?? null;
  }, [catalog.data, backendPrefs?.model]);

  // 模型下拉选项：catalog 全集 + 当前 pref 中的"自定义值"补一条（防 pref 存了非目录里的 id 时选不上）
  const modelOptions = useMemo(() => {
    const opts: Array<{ value: string; label: string }> = [];
    const fallbackLabel = catalog.data?.currentModelId
      ? `默认（${catalog.data.currentModelId}）`
      : catalog.loading
        ? "默认（加载中…）"
        : "默认模型";
    opts.push({ value: "", label: fallbackLabel });
    const seen = new Set<string>();
    for (const m of catalog.data?.models ?? []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      opts.push({ value: m.id, label: m.label });
    }
    const pref = backendPrefs?.model?.trim() ?? "";
    if (pref && !seen.has(pref)) {
      opts.push({ value: pref, label: `${pref}（自定义）` });
    }
    return opts;
  }, [catalog.data, catalog.loading, backendPrefs?.model]);

  // effort 下拉选项：
  //   - Codex：跟随当前 model 的 supportedEfforts；没选模型就取所有模型的 effort 并集
  //   - Claude：直接用 catalog.efforts（来自 `claude --help` 解析）
  // 都拿不到的 backend 不展示
  const effortOptions = useMemo(() => {
    if (!supportedBackend || supportedBackend === "opencode") return null;
    let efforts: string[] = [];
    if (supportedBackend === "codex" && catalog.data) {
      if (currentModelEntry?.supportedEfforts?.length) {
        efforts = currentModelEntry.supportedEfforts;
      } else {
        const union = new Set<string>();
        for (const m of catalog.data.models) {
          for (const e of m.supportedEfforts ?? []) union.add(e);
        }
        efforts = Array.from(union);
      }
    } else if (catalog.data) {
      efforts = catalog.data.efforts;
    }
    // pref 里存的值如果不在 catalog 里，也补一条避免选不上
    const pref = backendPrefs?.effort?.trim() ?? "";
    if (pref && !efforts.includes(pref)) {
      efforts = [...efforts, pref];
    }
    if (efforts.length === 0 && !catalog.loading) return null;
    return [
      { value: "", label: catalog.loading ? "默认努力（加载中…）" : "默认努力" },
      ...efforts.map((e) => ({ value: e, label: formatEffortLabel(e) })),
    ];
  }, [supportedBackend, catalog.data, catalog.loading, currentModelEntry, backendPrefs?.effort]);

  // model / effort 改完同步给 Rust，让下次 launch 立刻读到最新偏好；
  // 跟 AgentBackendsSection.PrefsEditor 用同一组参数，避免 Rust 端只能从一处更新。
  const syncBackend = useCallback((backend: BackendKey) => {
    const current = useSettingsStore.getState().backends[backend];
    invoke("update_backend_preferences", {
      backend,
      model: current.model || null,
      effort: current.effort || null,
      proxy: current.proxy || null,
      binary: current.binary || null,
      provider: current.provider || null,
      apiKey: current.apiKey || null,
      authMode: current.authMode || null,
    }).catch(console.error);
  }, []);

  const handleAgentChange = (value: string): void => {
    if (!activeTabId) return;
    if (!AGENT_OPTIONS.some((o) => o.value === value)) return;
    update({ agent: value as AgentType });
  };

  const handleModelChange = (value: string): void => {
    if (!supportedBackend) return;
    setBackendPref(supportedBackend, "model", value);
    syncBackend(supportedBackend);
  };

  const handleEffortChange = (value: string): void => {
    if (!supportedBackend) return;
    setBackendPref(supportedBackend, "effort", value);
    syncBackend(supportedBackend);
  };

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
      {/* 项目身份卡：名字 + agent / 模型 / 努力程度 下拉配置 + 路径 */}
      <div className="rounded-2xl border border-white/60 bg-white/70 p-4 shadow-sm backdrop-blur-md sm:p-5 dark:border-white/10 dark:bg-slate-800/55">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <h2 className="mr-1 truncate text-[18px] font-semibold tracking-tight text-zinc-800 sm:text-[20px] dark:text-zinc-100">
            {projectName}
          </h2>
          {supportedBackend ? (
            <ChipSelect
              tone="primary"
              value={tab.agent}
              onChange={handleAgentChange}
              options={AGENT_OPTIONS}
              title="切换该会话使用的 Agent CLI"
            />
          ) : (
            // 老 tab 用了暂未接入的 backend（gemini / cursor）：先按只读 chip 显示，
            // 用户想换的话点 agent chip 后给一个回退选项把它改成支持的 3 选 1。
            <ChipSelect
              tone="primary"
              value=""
              onChange={handleAgentChange}
              options={[{ value: "", label: `${agentLabel}（未支持配置）` }, ...AGENT_OPTIONS]}
              title="该 backend 暂未接入完整启动链路，请改选下面 3 项之一"
            />
          )}
          {supportedBackend === "opencode" ? (
            // OpenCode 的模型 = provider × providerModels，需要 serve 起来 + 选 provider 才有意义。
            // 在 chip 行上做完整 provider/model 二级下拉太挤；引导到 Settings Modal 里完整配置。
            <button
              type="button"
              onClick={openSettingsModal}
              className="rounded-full border border-zinc-300/50 bg-white/40 px-2.5 py-0.5 text-[11px] font-medium tracking-wide text-zinc-600 transition-colors hover:bg-white/70 dark:border-white/10 dark:bg-slate-800/40 dark:text-zinc-300 dark:hover:bg-slate-800/70"
              title="OpenCode 需要先选服务商再选模型，去设置里配"
            >
              在设置中配置 provider / model →
            </button>
          ) : supportedBackend ? (
            <ChipSelect
              tone="neutral"
              value={backendPrefs?.model ?? ""}
              onChange={handleModelChange}
              options={modelOptions}
              disabled={catalog.loading}
              title={
                catalog.error
                  ? `拉取模型目录失败：${catalog.error}`
                  : `${agentLabel} 当前使用的模型`
              }
            />
          ) : null}
          {effortOptions && (
            <ChipSelect
              tone="neutral"
              value={backendPrefs?.effort ?? ""}
              onChange={handleEffortChange}
              options={effortOptions}
              disabled={catalog.loading}
              title="思考努力程度（reasoning effort）"
            />
          )}
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
          {catalog.error && (
            <span
              className="ml-2 text-[11px] text-rose-500 dark:text-rose-300"
              title={catalog.error}
            >
              · 模型目录拉取失败
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

// chip 形态的 native select：保留原 agent chip 的视觉，但点击能下拉切换。
// tone=primary（sky 色，跟原 agent chip 同款）/ neutral（白/灰，给次要配置用）。
interface ChipSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  tone?: "primary" | "neutral";
  title?: string;
  disabled?: boolean;
}

function ChipSelect({
  value,
  onChange,
  options,
  tone = "neutral",
  title,
  disabled,
}: ChipSelectProps): JSX.Element {
  const toneClass =
    tone === "primary"
      ? "border-sky-300/40 bg-sky-400/10 text-sky-700 hover:bg-sky-400/20 focus-within:ring-sky-400/30 dark:border-sky-300/30 dark:bg-sky-400/15 dark:text-sky-200"
      : "border-zinc-300/50 bg-white/40 text-zinc-600 hover:bg-white/70 focus-within:ring-zinc-400/30 dark:border-white/10 dark:bg-slate-800/40 dark:text-zinc-300 dark:hover:bg-slate-800/70";
  return (
    <span
      className={`relative inline-flex items-center rounded-full border py-0.5 pl-2.5 pr-5 text-[11px] font-medium tracking-wide transition-colors focus-within:ring-2 ${toneClass} ${
        disabled ? "opacity-60" : ""
      }`}
    >
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        title={title}
        disabled={disabled}
        className="cursor-pointer appearance-none bg-transparent pr-0.5 outline-none disabled:cursor-not-allowed"
      >
        {options.map((opt) => (
          <option
            key={opt.value}
            value={opt.value}
            className="bg-white text-zinc-800 dark:bg-slate-800 dark:text-zinc-100"
          >
            {opt.label}
          </option>
        ))}
      </select>
      <svg
        viewBox="0 0 12 12"
        className="pointer-events-none absolute right-1.5 h-3 w-3 opacity-70"
        aria-hidden
      >
        <path
          d="M3 4.5L6 7.5L9 4.5"
          stroke="currentColor"
          strokeWidth="1.4"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
