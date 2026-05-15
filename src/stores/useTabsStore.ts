// 多 tab store —— 每个 tab 一份独立的会话状态（项目路径 / 输入框 / agent 状态 /
// 流式 blocks / 总结结果），互不干扰。
//
// 设计参考 designcode 的 `composables/useTabs.js`：
//   - tabs 用 Record<id, slice>（不是 Map）方便 zustand selector 浅比较
//   - order 单独存一个数组，TabBar 按 order 渲染
//   - activeTabId 是当前显示哪个 tab；切 tab 用 setActiveTab(id)
//   - createTab 返回新 id，调用方拿到后立即 setActiveTab
//
// run_id 跟 tab_id 是同一个标识：前端创建 tab 时生成 UUID，传给后端
// `start_agent({ runId })`，后端所有事件 payload 也带 runId，前端按它路由
// 到对应 tab slice。

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSharedStorage, onStorageExternalChange } from "../lib/sharedStorage";
import { useSettingsStore } from "./useSettingsStore";
import type {
  AgentStatus,
  AgentType,
  LastStage,
  PermissionMode,
  UiState,
} from "../types/agent";
import type { CliBlock } from "../types/blocks";

const PERMISSION_MODE_VALUES: readonly PermissionMode[] = [
  "default",
  "auto",
  "acceptEdits",
  "plan",
  "bypassPermissions",
];

function sanitizePermissionMode(value: unknown): PermissionMode {
  return typeof value === "string" &&
    (PERMISSION_MODE_VALUES as readonly string[]).includes(value)
    ? (value as PermissionMode)
    : "acceptEdits";
}

/// 从 useSettingsStore 读 Claude Code 的全局默认 permission mode。
/// settings store 不反向 import tabs store，所以这里 top-level import 不会形成循环。
function resolveDefaultPermissionModeFromSettings(): PermissionMode | undefined {
  const value = useSettingsStore.getState().backends["claude-code"]?.defaultPermissionMode;
  if (typeof value === "string" && value.length > 0) {
    return sanitizePermissionMode(value);
  }
  return undefined;
}

const MAX_BLOCKS = 200;
const TRIM_TARGET = 180;

/// 单个 tab 的完整状态。每个字段都是会话级 —— tab 之间完全隔离。
export interface TabState {
  id: string;
  /// 显示在 TabBar 的标题；用户可重命名；默认从 task / projectPath basename 推
  title: string;
  /// 该 tab 下次启动时用哪个 backend；可单独切换不影响其他 tab
  agent: AgentType;
  /// 该 tab 的工作目录；为 null 表示还没选
  projectPath: string | null;
  /// 输入框文本
  task: string;
  /// 后端最近 emit 的 agentStatus（idle/running/thinking/...）
  agentStatus: AgentStatus;
  /// UI 阶段（idle/running/done/error/suggesting）
  uiState: UiState;
  /// 桌宠/总结 mode（idle/working/thinking/complete/suggestion/error）
  mode: string;
  /// RunningBubble 显示的当前提示（来自工具描述 / 进度文案）
  bubble: string;
  /// 进度条百分比
  percent: number;
  /// 后端 session_id（前端 AgentSession UUID）—— 跟下面的 agentNativeSessionId
  /// 不一样：这个是每轮新生成的，仅作 IPC 事件 fallback 路由。
  sessionId: string | null;
  /// **真正能用于 resume 的 backend native session id**：Claude CLI session id /
  /// Codex thread id / OpenCode session id。每轮 turn 完成时由
  /// session-complete.agentNativeSessionId 更新；持久化后下次 launch 传给后端
  /// 当 resume hint，--resume 才能真正续上 conversation。
  agentNativeSessionId: string | null;
  /// 完成后的中文翻译输出
  resultZh: string;
  /// 凉宫春日总结
  summaryTranslation: string;
  /// 凉宫春日的语气短句
  emotionText: string;
  /// 完成后给的下一步选项按钮
  suggestionOptions: string[];
  /// 影响 PetCharacter GIF 选择的最终阶段
  lastStage: LastStage;
  /// 流式 blocks（BlockStream 渲染源）
  cliBlocks: CliBlock[];
  /// 非活动 tab 完成后置 true，TabBar/项目卡 显示小红点；切到自动清掉
  hasUnread: boolean;
  /// agent turn 完成、finalize（翻译+总结）跑到一半时退出 app 用：后端在
  /// finalize 之前 emit `agent://result-raw`，前端写入这两个字段并持久化；
  /// 重启时 useTabsReattach 检测到非空就调 finalize_pending 自动接续，
  /// session-complete 到来时清空。null 表示当前没有 pending finalize。
  pendingResultRaw: string | null;
  pendingUserZh: string | null;
  /// 创建时间戳，用来排序 / 关闭时回退到上一个
  createdAt: number;
  /// 最后活跃时间（毫秒）：每次有 IPC 事件 / 用户启动 / 流式 block 写入都刷新；
  /// 左栏项目卡按这个排序，让"刚动过的"项目浮上来。
  lastActiveAt: number;
  /// 最近一次启动用的中文 prompt（截断），左栏项目卡作为摘要标题展示。
  /// 没启动过的 tab 为 null —— 显示 fallback "新会话"或 projectPath basename。
  lastUserPrompt: string | null;
  /// Claude Code permission mode：default / acceptEdits / plan / bypassPermissions。
  /// start_agent 时作为 `--permission-mode` 传给 Claude CLI；Shift+Tab 在 tab 内循环切换。
  /// 顶部模式徽章读这个字段。仅对 claude-code backend 生效，其它 backend 忽略。
  permissionMode: PermissionMode;
  /// 用户在 PermissionCard 上点过"Always allow this tool"的工具名列表。
  /// 下次 Claude 通过 permission-prompt-tool 桥过来同名工具时，前端直接 auto-allow，
  /// 不再弹卡片。生命周期跟 tab 走（持久化），关 tab 后清掉。
  autoApprovedTools: string[];
}

/// 已关闭项目的归档摘要 —— 关闭 tab 时把核心元数据塞进 history 里，
/// "历史会话"菜单按 closedAt 倒序展示；用户点回去能 restore 出新 tab
/// （沿用 projectPath / agent，sessionId 作为 resume hint）。
///
/// **不持久化** cliBlocks/pending* 等大字段，避免 history 列表撑爆 localStorage。
export interface ArchivedSession {
  /// 归档项 id（=== 原 tab.id；防止同一 tab 被关闭两次产生重复条目）
  id: string;
  /// 关闭时刻（ms）；用作排序键
  closedAt: number;
  /// 创建时刻（保留作展示）
  createdAt: number;
  agent: AgentType;
  projectPath: string | null;
  /// 摘要标题：lastUserPrompt > task > title
  summary: string;
  /// 前端 sessionId：恢复 tab 时仅用于 IPC fallback；真正续 conversation 看
  /// agentNativeSessionId 字段
  sessionId: string | null;
  /// backend native session id —— 真正能让 Claude `--resume` / Codex `thread/resume`
  /// / OpenCode 复用 session 续上对话的那个 ID
  agentNativeSessionId: string | null;
  /// 上次的 ResultCard 内容，恢复 tab 时回填，让用户能快速看到上次的结果
  summaryTranslation: string;
  emotionText: string;
  resultZh: string;
  suggestionOptions: string[];
}

const HISTORY_LIMIT = 100;

export interface TabsStoreState {
  tabs: Record<string, TabState>;
  /// TabBar 显示顺序；新建的追加到末尾；关闭时从这里 splice
  order: string[];
  activeTabId: string | null;
  /// 历史会话归档；按 closedAt 倒序由 selector 处理，store 内顺序不保证
  history: ArchivedSession[];

  /// 创建一个新 tab。init 可指定初始字段（agent / projectPath / 标题等），
  /// 返回新 tab 的 id；不会自动切到新 tab，调用方如需切换显式调 setActiveTab。
  ///
  /// `id` 可选：默认生成 UUID；reattach 场景下可指定后端 runId 当 id，
  /// 让前端 tab.id ↔ 后端 runId 绑定（已存在的 id 会被忽略，返回原 id）。
  createTab: (init?: Partial<Omit<TabState, "createdAt">>) => string;
  /// 关闭 tab；如果是当前 active 会自动切到相邻 tab；最后一个 tab 关闭后
  /// activeTabId 变成 null（调用方应处理这种状态，比如回 WelcomeView）。
  removeTab: (id: string) => void;
  /// 切换当前活动 tab；切到时自动清 hasUnread 标记。
  setActiveTab: (id: string) => void;
  /// 局部更新指定 tab 字段。不存在的 tab 直接忽略（不 throw，避免 IPC 事件
  /// 撞到刚关闭的 tab 时把 store 弄坏）。
  updateTab: (id: string, patch: Partial<TabState>) => void;
  /// 重置某个 tab 的会话级字段（保留 projectPath / agent / title / id），
  /// 用于"清屏"或开始新一轮 turn 前的清理。
  resetTabSession: (id: string) => void;

  /// 把某个工具名加入 tab 的 auto-approve 白名单（用户点过"Always allow this tool"）。
  /// 重复加幂等。下次 Claude 通过 permission-prompt-tool 桥过来同名工具时，
  /// usePermissionRequests 直接 invoke allow，不再弹卡。
  addAutoApprovedTool: (id: string, toolName: string) => void;

  // CliBlock 操作 —— 跟旧 useAppStore 的语义一致，但每次都按 tab 路由
  appendCliBlock: (id: string, block: CliBlock) => void;
  upsertCliBlock: (id: string, block: CliBlock) => void;
  clearCliBlocks: (id: string) => void;
  /// 从指定 tab 的流式视图里移除单个 block（按 block.id）。
  /// 仅影响前端展示，不会清掉后端 agent 的会话上下文 —— UI 上仅做"我看的视图"层操作。
  removeCliBlock: (id: string, blockId: string) => void;

  /// 多 tab 路由辅助：根据后端事件 payload 的 runId 找到 tab id；
  /// runId 直接对应 tab.id，所以这里其实就是看 tabs[runId] 是否存在。
  hasTab: (runId: string) => boolean;
  /// 通过 sessionId 反查 runId（IPC 事件早期还没回填 runId 时用）。
  findTabBySessionId: (sessionId: string) => string | null;

  /// 从历史归档恢复一个 tab：用归档的 projectPath / agent / sessionId
  /// 创建新 tab，回填上次的 ResultCard 内容；从 history 移除该条目避免重复。
  /// 返回新 tab 的 id；归档不存在时返回 null。
  restoreFromHistory: (archivedId: string) => string | null;
  /// 单条删除归档（用户右键删除）
  removeFromHistory: (archivedId: string) => void;
  /// 清空整个历史
  clearHistory: () => void;
}

function generateTabId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // fallback：足够强的伪随机；只在 SSR / 老环境 fallback
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeDefaultTab(init?: Partial<TabState>): TabState {
  return {
    id: "",
    title: init?.title ?? "新会话",
    agent: init?.agent ?? "claude-code",
    projectPath: init?.projectPath ?? null,
    task: init?.task ?? "",
    agentStatus: init?.agentStatus ?? "idle",
    uiState: init?.uiState ?? "idle",
    mode: init?.mode ?? "idle",
    bubble: init?.bubble ?? "",
    percent: init?.percent ?? 0,
    sessionId: init?.sessionId ?? null,
    agentNativeSessionId: init?.agentNativeSessionId ?? null,
    resultZh: init?.resultZh ?? "",
    summaryTranslation: init?.summaryTranslation ?? "",
    emotionText: init?.emotionText ?? "",
    suggestionOptions: init?.suggestionOptions ?? [],
    lastStage: init?.lastStage ?? "default",
    pendingResultRaw: init?.pendingResultRaw ?? null,
    pendingUserZh: init?.pendingUserZh ?? null,
    cliBlocks: init?.cliBlocks ?? [],
    hasUnread: init?.hasUnread ?? false,
    createdAt: 0,
    lastActiveAt: init?.lastActiveAt ?? 0,
    lastUserPrompt: init?.lastUserPrompt ?? null,
    permissionMode: sanitizePermissionMode(init?.permissionMode),
    autoApprovedTools: Array.isArray(init?.autoApprovedTools)
      ? init.autoApprovedTools.slice()
      : [],
  };
}

/// 持久化时单 tab 最多保留多少个 cliBlocks。
/// localStorage 单 origin 配额一般 5–10MB，几个 tab 各几百个 block 容易撞上限；
/// 限制到 120 块就够回看上次工作过程的关键节点（也是 store 内存里 MAX 的 60%）。
/// 启动后用户可以正常累积新 block，超过 200 时仍按内存里的 trim 策略截断。
const PERSIST_BLOCKS_PER_TAB = 120;

/// `mode` 字段是混合语义：既包含**结果态**（complete / suggestion / error / idle），
/// 也包含**过程态**（thinking / working）。持久化时过程态没有意义（进程已死），
/// 但要保留结果态让 ResultCard 重启后能显示上次完成的总结。
const MODE_RESULT_STATES = new Set(["complete", "suggestion", "error", "idle"]);

/// **写入** persist 时仅做 cliBlocks 裁剪（防 localStorage 配额炸）。
/// **不重置**运行态字段（uiState / agentStatus / mode / percent / bubble / lastStage）
/// —— 跨设备实时同步必须保留这些字段：移动端切到 running，桌面端 rehydrate 也要看到 running。
/// 旧版本在 partialize 把这些重置成 idle，导致 setState({uiState:"running"}) 立即被
/// 自己写入的 storage 反向覆盖回 idle，移动端"启动"按钮按了像没反应。
function compactTabForPersist(tab: TabState): TabState {
  const trimmedBlocks =
    tab.cliBlocks.length > PERSIST_BLOCKS_PER_TAB
      ? tab.cliBlocks.slice(-PERSIST_BLOCKS_PER_TAB)
      : tab.cliBlocks;
  if (trimmedBlocks === tab.cliBlocks) return tab;
  return { ...tab, cliBlocks: trimmedBlocks };
}

/// **首次 hydrate（页面 reload / app 重启）** 时清掉过期的运行态。
/// 后续手动 rehydrate（来自跨设备 storage://changed 事件）**不**调用本函数 ——
/// 那是同步另一端的真实运行态，要原样保留。
///   - percent / bubble：进度文字，进程已死无意义
///   - agentStatus / uiState：运行状态由 reattach + 实际 list_sessions 决定
///   - mode：过程态（thinking/working）一律改 idle，否则重启后 RunningBubble 会
///     误判"还在跑"显示"AGENT 正在全力执行…"；结果态（complete/suggestion/error）
///     保留让 ResultCard 能续显示上次总结
function sanitizeTabOnInitialLoad(tab: TabState): TabState {
  // 过程态的 mode 改 idle；结果态保留
  const sanitizedMode = MODE_RESULT_STATES.has(tab.mode) ? tab.mode : "idle";
  // lastStage 同理：thinking / working / init 都是过程态，重置为 default
  const lastStage =
    tab.lastStage === "thinking" || tab.lastStage === "working" || tab.lastStage === "init"
      ? "default"
      : tab.lastStage;
  return {
    ...tab,
    percent: 0,
    bubble: "",
    agentStatus: "idle",
    uiState: "idle",
    mode: sanitizedMode,
    lastStage,
  };
}

/// module-level flag：第一次 hydrate（store 创建瞬间）= true；
/// 后续 useTabsStore.persist.rehydrate()（跨设备同步触发）= false。
/// 这样首次清运行态、跨设备同步保留运行态。
let isFirstTabsHydration = true;

export const useTabsStore = create<TabsStoreState>()(
  persist<TabsStoreState>(
    (set, get) => ({
  tabs: {},
  order: [],
  activeTabId: null,
  history: [],

  createTab: (init) => {
    const requestedId = init?.id;
    if (requestedId && get().tabs[requestedId]) {
      // 已存在则不重建，返回现有 id（reattach 路径幂等）
      return requestedId;
    }
    const id = requestedId ?? generateTabId();
    const now = Date.now();
    // 新 tab 的 permissionMode：调用方显式传 > 全局 Settings 默认 > "default"
    // 用动态 import 避免顶部循环依赖；Settings store 已经在 App.tsx 初始化时
    // 早于任何 createTab 调用，因此 getState() 不会拿到空值。
    const settingsDefault =
      init?.permissionMode ??
      (resolveDefaultPermissionModeFromSettings() as PermissionMode | undefined);
    const tab: TabState = {
      ...makeDefaultTab({
        ...init,
        permissionMode: settingsDefault,
      }),
      id,
      createdAt: now,
      lastActiveAt: init?.lastActiveAt ?? now,
    };
    set((state) => ({
      tabs: { ...state.tabs, [id]: tab },
      order: [...state.order, id],
    }));
    return id;
  },

  removeTab: (id) => {
    set((state) => {
      const tab = state.tabs[id];
      if (!tab) return state;
      const nextTabs = { ...state.tabs };
      delete nextTabs[id];
      const nextOrder = state.order.filter((tid) => tid !== id);
      let nextActive = state.activeTabId;
      if (state.activeTabId === id) {
        // 切到被关闭 tab 在 order 中的前一个；都没了就 null
        const idx = state.order.indexOf(id);
        nextActive = nextOrder[Math.max(0, idx - 1)] ?? nextOrder[0] ?? null;
      }

      // 空会话不归档：从没启动过任务、没流式内容、没结果、没 backend session
      // → 关闭时直接丢弃，避免 history 里堆满"新会话 / 未选择目录"的空壳
      // 让 GlobalOverview / ProjectOverview / 历史面板列表保持有意义。
      const hasContent =
        (tab.lastUserPrompt && tab.lastUserPrompt.trim().length > 0) ||
        tab.cliBlocks.length > 0 ||
        Boolean(tab.summaryTranslation?.trim()) ||
        Boolean(tab.resultZh?.trim()) ||
        Boolean(tab.agentNativeSessionId);

      let nextHistory = state.history;
      if (hasContent) {
        // 归档到 history：保留核心元数据 + 上次结果，丢弃 cliBlocks / pending* 等大字段
        const summary =
          (tab.lastUserPrompt && tab.lastUserPrompt.trim()) ||
          (tab.task && tab.task.trim().slice(0, 80)) ||
          tab.title ||
          "新会话";
        const archived: ArchivedSession = {
          id: tab.id,
          closedAt: Date.now(),
          createdAt: tab.createdAt,
          agent: tab.agent,
          projectPath: tab.projectPath,
          summary,
          sessionId: tab.sessionId,
          agentNativeSessionId: tab.agentNativeSessionId,
          summaryTranslation: tab.summaryTranslation,
          emotionText: tab.emotionText,
          resultZh: tab.resultZh,
          suggestionOptions: tab.suggestionOptions,
        };
        // 同 id 已在 history（极少见，比如 reattach 失败后重 close）→ 替换
        const filtered = state.history.filter((h) => h.id !== archived.id);
        nextHistory = [archived, ...filtered].slice(0, HISTORY_LIMIT);
      }

      return {
        tabs: nextTabs,
        order: nextOrder,
        activeTabId: nextActive,
        history: nextHistory,
      };
    });
  },

  setActiveTab: (id) => {
    set((state) => {
      if (!state.tabs[id]) return state;
      const tab = state.tabs[id];
      // 切过来时自动清未读标记
      const nextTabs = tab.hasUnread
        ? { ...state.tabs, [id]: { ...tab, hasUnread: false } }
        : state.tabs;
      return { activeTabId: id, tabs: nextTabs };
    });
  },

  updateTab: (id, patch) => {
    set((state) => {
      const tab = state.tabs[id];
      if (!tab) return state;
      return { tabs: { ...state.tabs, [id]: { ...tab, ...patch } } };
    });
  },

  addAutoApprovedTool: (id, toolName) => {
    set((state) => {
      const tab = state.tabs[id];
      if (!tab) return state;
      const existing = Array.isArray(tab.autoApprovedTools) ? tab.autoApprovedTools : [];
      if (existing.includes(toolName)) return state;
      return {
        tabs: {
          ...state.tabs,
          [id]: { ...tab, autoApprovedTools: [...existing, toolName] },
        },
      };
    });
  },

  resetTabSession: (id) => {
    set((state) => {
      const tab = state.tabs[id];
      if (!tab) return state;
      return {
        tabs: {
          ...state.tabs,
          [id]: {
            ...tab,
            task: "",
            agentStatus: "idle",
            uiState: "idle",
            mode: "idle",
            bubble: "",
            percent: 0,
            sessionId: null,
            resultZh: "",
            summaryTranslation: "",
            emotionText: "",
            suggestionOptions: [],
            lastStage: "default",
            cliBlocks: [],
            hasUnread: false,
          },
        },
      };
    });
  },

  appendCliBlock: (id, block) => {
    set((state) => {
      const tab = state.tabs[id];
      if (!tab) return state;
      const next = [...tab.cliBlocks, block];
      const trimmed = next.length > MAX_BLOCKS ? next.slice(-TRIM_TARGET) : next;
      return {
        tabs: {
          ...state.tabs,
          [id]: { ...tab, cliBlocks: trimmed, lastActiveAt: Date.now() },
        },
      };
    });
  },

  upsertCliBlock: (id, block) => {
    set((state) => {
      const tab = state.tabs[id];
      if (!tab) return state;
      const idx = tab.cliBlocks.findIndex((b) => b.id === block.id);
      let next: CliBlock[];
      if (idx >= 0) {
        next = tab.cliBlocks.slice();
        next[idx] = { ...next[idx], ...block };
      } else {
        next = [...tab.cliBlocks, block];
      }
      const trimmed = next.length > MAX_BLOCKS ? next.slice(-TRIM_TARGET) : next;
      return {
        tabs: {
          ...state.tabs,
          [id]: { ...tab, cliBlocks: trimmed, lastActiveAt: Date.now() },
        },
      };
    });
  },

  clearCliBlocks: (id) => {
    set((state) => {
      const tab = state.tabs[id];
      if (!tab) return state;
      return { tabs: { ...state.tabs, [id]: { ...tab, cliBlocks: [] } } };
    });
  },

  removeCliBlock: (id, blockId) => {
    set((state) => {
      const tab = state.tabs[id];
      if (!tab) return state;
      const next = tab.cliBlocks.filter((b) => b.id !== blockId);
      // 找不到该 id 时数组引用不变 —— 别走 set 避免无意义 rehydrate / 监听抖动
      if (next.length === tab.cliBlocks.length) return state;
      return { tabs: { ...state.tabs, [id]: { ...tab, cliBlocks: next } } };
    });
  },

  hasTab: (runId) => Boolean(get().tabs[runId]),

  findTabBySessionId: (sessionId) => {
    const { tabs } = get();
    for (const tab of Object.values(tabs)) {
      if (tab.sessionId === sessionId) return tab.id;
    }
    return null;
  },

  restoreFromHistory: (archivedId) => {
    const archived = get().history.find((h) => h.id === archivedId);
    if (!archived) return null;
    // 用归档元数据创建新 tab。**不复用原 id**：原 id 可能跟某个被 reattach
    // 出来的活跃 tab 撞 id；新 UUID 安全。后端 last_session_per_context 会
    // 按 (agent, cwd) 自动 resume，不依赖前端 runId。
    //
    // 合成几条 cliBlock 注入流式区：原始 prompt（用户气泡）+ 中文摘要回应。
    // 这样恢复的 tab 看起来跟"刚跑完的会话"一致 —— MainView 直接走 StatusMonitor +
    // ResultCard，而不会因为 cliBlocks 为空被当成"新空 tab"显示 ProjectOverview。
    // archived 不持久化原始 cliBlocks（防 localStorage 撑爆），合成块只是"回顾"
    // 视觉骨架；用户继续追问时新的真实 block 自然接在后面。
    const synthesizedBlocks: CliBlock[] = [];
    const promptText = archived.summary?.trim();
    if (promptText) {
      synthesizedBlocks.push({
        id: `restored-prompt-${archived.id}`,
        type: "user-prompt",
        content: promptText,
      });
    }
    const responseText =
      (archived.resultZh || archived.summaryTranslation || "").trim();
    if (responseText) {
      synthesizedBlocks.push({
        id: `restored-text-${archived.id}`,
        type: "text",
        content: responseText,
      });
    }

    const newId = get().createTab({
      title: archived.summary.slice(0, 40),
      agent: archived.agent,
      projectPath: archived.projectPath,
      sessionId: archived.sessionId,
      agentNativeSessionId: archived.agentNativeSessionId,
      lastUserPrompt: archived.summary,
      summaryTranslation: archived.summaryTranslation,
      emotionText: archived.emotionText,
      resultZh: archived.resultZh,
      suggestionOptions: archived.suggestionOptions,
      cliBlocks: synthesizedBlocks,
      // 有 summary 就让 ResultCard 直接显示上次结果
      mode: archived.summaryTranslation || archived.emotionText ? "complete" : "idle",
      uiState: archived.summaryTranslation || archived.emotionText ? "done" : "idle",
      lastStage: archived.summaryTranslation || archived.emotionText ? "done" : "default",
    });
    // 从 history 移除避免重复出现
    set((state) => ({
      history: state.history.filter((h) => h.id !== archivedId),
    }));
    return newId;
  },

  removeFromHistory: (archivedId) => {
    set((state) => ({
      history: state.history.filter((h) => h.id !== archivedId),
    }));
  },

  clearHistory: () => {
    set({ history: [] });
  },
    }),
    {
      name: "galcode_tabs",
      version: 2,
      // v1 → v2 迁移：把 permissionMode === "default" 改成 "acceptEdits"。
      //
      // 原因：Claude CLI 的 stream-json 非交互模式下，default mode 把所有工具
      // 调用直接 deny（"no human to ask"）。Galcode Island 暂未实现内联审批 UI，
      // 所以 default mode 实际不可用。在 v2 一次性升级老数据避免用户继续踩坑；
      // 之后用户仍可手动通过 Shift+Tab 切回 default。
      migrate: (persistedState: unknown, version: number) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (persistedState ?? {}) as any;
        if (version < 2 && state && typeof state === "object" && state.tabs) {
          for (const id of Object.keys(state.tabs)) {
            const tab = state.tabs[id];
            if (tab && tab.permissionMode === "default") {
              tab.permissionMode = "acceptEdits";
            }
          }
        }
        return state as TabsStoreState;
      },
      // 共享 storage：桌面端写 localStorage + 同步推 Rust 镜像；移动端纯走 IPC
      // 拿镜像。后端镜像没有配额限制；只有桌面端 localStorage 可能撞 quota，
      // 这种情况下 onLocalQuotaError 砍 cliBlocks 后自己重试 localStorage（IPC 已写）。
      storage: createSharedStorage({
        onLocalQuotaError: (key, raw, err) => {
          if (!isQuotaError(err)) {
            console.warn("[tabs] localStorage write failed", err);
            return false;
          }
          console.warn("[tabs] localStorage 配额不足，砍半 cliBlocks 重试");
          try {
            const parsed = JSON.parse(raw) as {
              state?: { tabs?: Record<string, TabState> };
            };
            if (parsed.state?.tabs) {
              for (const id of Object.keys(parsed.state.tabs)) {
                const blocks = parsed.state.tabs[id].cliBlocks ?? [];
                parsed.state.tabs[id].cliBlocks = blocks.slice(
                  -Math.floor(blocks.length / 2),
                );
              }
              try {
                localStorage.setItem(key, JSON.stringify(parsed));
                return true;
              } catch {
                // 砍半还撞 → 彻底丢 cliBlocks
                for (const id of Object.keys(parsed.state.tabs)) {
                  parsed.state.tabs[id].cliBlocks = [];
                }
                localStorage.setItem(key, JSON.stringify(parsed));
                return true;
              }
            }
          } catch (e) {
            console.error("[tabs] quota fallback parse 失败", e);
          }
          // localStorage 没救出来无所谓 —— Rust 镜像里已经存着完整数据
          return true;
        },
      }),
      partialize: (state) =>
        ({
          tabs: Object.fromEntries(
            Object.entries(state.tabs).map(([id, tab]) => [id, compactTabForPersist(tab)]),
          ),
          order: state.order,
          activeTabId: state.activeTabId,
          history: state.history.slice(0, HISTORY_LIMIT),
        }) as unknown as TabsStoreState,
      // 仅"初次 hydrate"（页面/app 第一次加载）时清运行态。
      // 后续 rehydrate（跨设备 storage://changed 触发的）保留 storage 里的真实
      // 运行态，让多端实时同步 uiState/agentStatus/mode/percent/bubble 等字段。
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        if (isFirstTabsHydration) {
          isFirstTabsHydration = false;
          for (const id of Object.keys(state.tabs)) {
            state.tabs[id] = sanitizeTabOnInitialLoad(state.tabs[id]);
          }
        }
        // 旧版本没有 history 字段，rehydrate 后是 undefined，兜底为空数组
        if (!Array.isArray(state.history)) state.history = [];
      },
    },
  ),
);

// 跨设备同步：其它客户端改了 tabs 后 rehydrate
onStorageExternalChange("galcode_tabs", () => {
  void useTabsStore.persist.rehydrate();
});

function isQuotaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // 不同浏览器报错 name 不一样：QuotaExceededError / NS_ERROR_DOM_QUOTA_REACHED / ...
  return /quota|exceed/i.test(err.name) || /quota|exceed/i.test(err.message);
}
