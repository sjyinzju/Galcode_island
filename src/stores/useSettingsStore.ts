import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSharedStorage, onStorageExternalChange } from "../lib/sharedStorage";
import type { PermissionMode } from "../types/agent";

export type BackendKey = "claude-code" | "codex" | "opencode";
export type AppFontSize = "small" | "default" | "large";

export const APP_FONT_SIZE_LABELS: Record<AppFontSize, string> = {
  small: "小",
  default: "默认",
  large: "大",
};

export const APP_FONT_SIZE_ROOT_PX: Record<AppFontSize, string> = {
  small: "14px",
  default: "16px",
  large: "18px",
};

export function normalizeAppFontSize(value: unknown): AppFontSize {
  return value === "small" || value === "large" || value === "default"
    ? value
    : "default";
}

export interface BackendPrefs {
  model: string;
  effort: string;
  proxy: string;
  binary: string;
  /// 仅 OpenCode 使用：服务商 id（如 "anthropic"/"openai"/"deepseek"/"openrouter"…）
  /// 其它 backend 写空。launch_opencode_agent 读到非空就把 providerID/modelID
  /// 注入到 POST /session/{id}/message 请求体里，让 OpenCode 用这个组合发请求。
  provider: string;
  /// 仅 OpenCode 使用：用户自填的 API Key（authMode === "key" 时生效）。
  /// 不持久化到 Rust 内存——通过 opencode_set_auth 命令直接写到 ~/.config/opencode/auth.json，
  /// 后续 OpenCode 服务自己读那个文件做认证。前端 zustand persist 保留方便回填表单。
  apiKey: string;
  /// "" = 未选 / "oauth" = 走 `opencode auth login` / "key" = 自填 API Key。
  authMode: "" | "oauth" | "key";
  /// 仅 Claude Code 使用：新开 tab 的默认 permission mode；空串/缺省 = "default"。
  /// 已存在 tab 不会因这里改动而被覆盖（避免吞掉用户当前的临时切换）。
  defaultPermissionMode: PermissionMode | "";
}

const emptyBackendPrefs = (): BackendPrefs => ({
  model: "",
  effort: "",
  proxy: "",
  binary: "",
  provider: "",
  apiKey: "",
  authMode: "",
  defaultPermissionMode: "",
});

/// 服务商预设 —— 选定后自动填 base_url 和默认 model id。
/// "custom" 让用户自己填 base_url。
export type LlmProvider =
  | "deepseek"
  | "openai"
  | "moonshot"
  | "qwen"
  | "zhipu"
  | "openrouter"
  | "custom";

export interface ProviderPreset {
  id: LlmProvider;
  label: string;
  baseUrl: string;
  /// 该服务商上"思考模式 = ON" 时建议的 model id（可与默认 model 不同）
  thinkingModel?: string;
  /// 默认 model（思考关闭时用）
  defaultModel: string;
  /// 在思考模式开关上额外说明（如 "DeepSeek 用 deepseek-reasoner"）
  thinkingHint?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek V4",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-v4-flash",
    thinkingHint: "V4 Flash/Pro 双模：思考开关通过 enable_thinking 参数切（同 model id）",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.5",
    thinkingModel: "o4-mini",
    thinkingHint: "开启后切到 o4-mini 推理模型",
  },
  {
    id: "moonshot",
    label: "Moonshot Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "kimi-k2.6",
    thinkingHint: "K2 系列支持 enable_thinking 参数切",
  },
  {
    id: "qwen",
    label: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3.6-flash",
    thinkingModel: "qwen3.6-plus",
    thinkingHint: "qwen3.6-plus 思考 + Web 搜索 + Code 工具",
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-5",
    thinkingModel: "glm-5.1",
    thinkingHint: "GLM-5.1 智能体优化版",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "deepseek/deepseek-v4-flash",
  },
  {
    id: "custom",
    label: "自定义",
    baseUrl: "",
    defaultModel: "",
  },
];

export function getProviderPreset(id: LlmProvider): ProviderPreset {
  return PROVIDER_PRESETS.find((p) => p.id === id) ?? PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];
}

interface SettingsState {
  // nickname 已搬到 useProfileStore，不再放这里
  systemPrompt: string;
  apiKey: string;
  apiBaseUrl: string;
  provider: LlmProvider;
  model: string;
  thinking: boolean;
  /// 转换为英文输入：默认关。开启时把用户中文 prompt 翻成英文喂给 agent，
  /// agent 英文输出再翻回中文。关闭时全程中文不走翻译。
  translateInput: boolean;
  /// 缓存上次拉到的模型列表，避免每次 SettingsModal 打开都拉
  availableModels: string[];
  /// 桌宠图社区后端地址（如 https://community.example.com）。空字符串 = 未启用，
  /// "看看大家的图"按钮变灰；上传图片时跳过社区同步只落本地。
  communityBaseUrl: string;
  fontSize: AppFontSize;

  /// 三个 backend 各自的 model / effort / proxy / binary。空字符串表示用默认。
  /// 启动时由 App.tsx 同步到 Rust 端 update_backend_preferences；保存时也同步。
  backends: Record<BackendKey, BackendPrefs>;

  // Modal state
  isSettingsModalOpen: boolean;

  // Actions
  setSystemPrompt: (systemPrompt: string) => void;
  setApiKey: (apiKey: string) => void;
  setApiBaseUrl: (apiBaseUrl: string) => void;
  setProvider: (provider: LlmProvider) => void;
  setModel: (model: string) => void;
  setThinking: (thinking: boolean) => void;
  setTranslateInput: (translateInput: boolean) => void;
  setAvailableModels: (models: string[]) => void;
  setCommunityBaseUrl: (url: string) => void;
  setFontSize: (fontSize: AppFontSize) => void;
  setBackendPref: (backend: BackendKey, field: keyof BackendPrefs, value: string) => void;
  setBackendPrefs: (backend: BackendKey, prefs: Partial<BackendPrefs>) => void;
  openSettingsModal: () => void;
  closeSettingsModal: () => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      systemPrompt: "",
      apiKey: "",
      apiBaseUrl: "https://api.deepseek.com/v1",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      thinking: false,
      translateInput: false,
      availableModels: [],
      communityBaseUrl: "",
      fontSize: "default",
      backends: {
        "claude-code": emptyBackendPrefs(),
        codex: emptyBackendPrefs(),
        opencode: emptyBackendPrefs(),
      },
      isSettingsModalOpen: false,

      setSystemPrompt: (systemPrompt) => set({ systemPrompt }),
      setApiKey: (apiKey) => set({ apiKey }),
      setApiBaseUrl: (apiBaseUrl) => set({ apiBaseUrl }),
      setProvider: (provider) => set({ provider }),
      setModel: (model) => set({ model }),
      setThinking: (thinking) => set({ thinking }),
      setTranslateInput: (translateInput) => set({ translateInput }),
      setAvailableModels: (availableModels) => set({ availableModels }),
      setCommunityBaseUrl: (communityBaseUrl) => set({ communityBaseUrl }),
      setFontSize: (fontSize) => set({ fontSize }),
      setBackendPref: (backend, field, value) =>
        set((state) => ({
          backends: {
            ...state.backends,
            [backend]: { ...state.backends[backend], [field]: value },
          },
        })),
      setBackendPrefs: (backend, prefs) =>
        set((state) => ({
          backends: {
            ...state.backends,
            [backend]: { ...state.backends[backend], ...prefs },
          },
        })),
      openSettingsModal: () => set({ isSettingsModalOpen: true }),
      closeSettingsModal: () => set({ isSettingsModalOpen: false }),
    }),
    {
      name: "agent-settings-storage",
      storage: createSharedStorage(),
      // 兼容老版本 persist：之前的 BackendPrefs 只有 model/effort/proxy/binary 四个字段，
      // 现在加了 provider/apiKey/authMode 后，旧的 localStorage 数据还原回来时会缺这三个，
      // 后续访问 prefs.X 时是 undefined，碰到 .trim() / `<select value={undefined}>` 会让
      // React 报错甚至白屏。merge 时用 emptyBackendPrefs() 兜底所有缺失字段。
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<SettingsState>;
        const mergedBackends: Record<BackendKey, BackendPrefs> = {
          "claude-code": { ...emptyBackendPrefs(), ...(persisted.backends?.["claude-code"] ?? {}) },
          codex: { ...emptyBackendPrefs(), ...(persisted.backends?.codex ?? {}) },
          opencode: { ...emptyBackendPrefs(), ...(persisted.backends?.opencode ?? {}) },
        };
        return {
          ...currentState,
          ...persisted,
          fontSize: normalizeAppFontSize(persisted.fontSize),
          backends: mergedBackends,
        };
      },
      partialize: (state) => ({
        systemPrompt: state.systemPrompt,
        apiKey: state.apiKey,
        apiBaseUrl: state.apiBaseUrl,
        provider: state.provider,
        model: state.model,
        thinking: state.thinking,
        translateInput: state.translateInput,
        availableModels: state.availableModels,
        communityBaseUrl: state.communityBaseUrl,
        fontSize: state.fontSize,
        backends: state.backends,
      }),
    }
  )
);

// 跨设备同步：其它客户端改了 settings 后，后端 broadcast storage://changed →
// 自动 rehydrate 让 UI 反映最新值
onStorageExternalChange("agent-settings-storage", () => {
  void useSettingsStore.persist.rehydrate();
});
