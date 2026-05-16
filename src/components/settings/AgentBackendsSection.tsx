// 三个 backend 的状态面板：装没装 / 登录情况 / 默认模型 + 验证连接 / 打开登录终端
// / OpenCode 启停。SettingsModal 打开时自动 refresh 一次。
//
// 状态条 chip 颜色：installed 绿、loggedIn 绿、未登录黄、未装红、loading 蓝。
// verify/login/start 之类操作完成后内联显示 toast（成功提示 / 错误信息）。

import { invoke } from "../../lib/bridge";
import { Component, useCallback, useEffect, useState, type ErrorInfo, type ReactNode } from "react";
import { useBackendStatus } from "../../hooks/useBackendStatus";
import {
  useSettingsStore,
  type BackendKey,
  type BackendPrefs,
} from "../../stores/useSettingsStore";

// 防止 OpencodeAuthEditor 内部抛出运行时错误把整个 Settings Modal（乃至 App 树）拽白屏。
// 用最小 ErrorBoundary 兜底——React 没有 hook 形式的 errorboundary，必须 class 组件。
class SectionErrorBoundary extends Component<{ children: ReactNode; fallbackTitle: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[SectionErrorBoundary]", this.props.fallbackTitle, error, info);
  }
  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="rounded-md border border-rose-300/50 bg-rose-50/50 p-3 text-xs text-rose-700 dark:border-rose-400/30 dark:bg-rose-900/20 dark:text-rose-300">
          <div className="font-semibold">{this.props.fallbackTitle} 渲染异常</div>
          <pre className="mt-1 overflow-auto whitespace-pre-wrap break-words text-[11px] opacity-80">
            {this.state.error.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

/// 经 Rust 端归一化后回来的 provider 目录条目（来自 OpenCode 的 GET /provider + /provider/auth）
interface OpencodeAuthMethodInfo {
  /// "oauth" | "api"
  kind: string;
  label: string;
}

interface OpencodeModelInfo {
  id: string;
  name: string;
}

interface OpencodeProviderInfo {
  id: string;
  name: string;
  /// 本地 auth.json 里有该 provider 的条目，或在 /provider.connected 里
  authenticated: boolean;
  /// auth.json 记录的类型（"api" / "oauth"）
  authType: string | null;
  /// 该 provider 在 OpenCode 注册表声明的可用认证方式（用来决定 UI 显示哪些按钮）
  authMethods: OpencodeAuthMethodInfo[];
  models: OpencodeModelInfo[];
  /// 注册表里给该 provider 的默认模型 id（用户没主动选时的兜底）
  defaultModelId: string | null;
  /// 可走的环境变量名（如 ["DEEPSEEK_API_KEY"]），UI 用作 placeholder 提示
  envKeys: string[];
}

interface ChipProps {
  ok: boolean | null; // null = unknown / loading
  label: string;
  warn?: boolean;
}

function StatusChip({ ok, label, warn }: ChipProps): JSX.Element {
  const color =
    ok === true
      ? "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-400/20 dark:text-emerald-300"
      : ok === false
        ? warn
          ? "bg-amber-500/15 text-amber-700 dark:bg-amber-400/20 dark:text-amber-300"
          : "bg-rose-500/15 text-rose-700 dark:bg-rose-400/20 dark:text-rose-300"
        : "bg-zinc-200/70 text-zinc-500 dark:bg-slate-700/50 dark:text-zinc-400";
  const symbol = ok === true ? "✓" : ok === false ? (warn ? "○" : "✗") : "…";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${color}`}
    >
      <span>{symbol}</span>
      <span>{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// 偏好输入面板（model / effort / proxy / binary）
// ---------------------------------------------------------------------------

interface PrefsEditorProps {
  backend: BackendKey;
  /// 哪些字段对该 backend 有意义。OpenCode 没有 model/effort 概念，只显示 binary/proxy。
  fields: ReadonlyArray<keyof BackendPrefs>;
}

// PrefsEditor 只渲染调用方在 `fields` 里显式列出的字段；这里不必为 BackendPrefs
// 的每个 key 都给标签（provider/apiKey/authMode 走 OpencodeAuthEditor）。
const FIELD_LABEL: Partial<Record<keyof BackendPrefs, string>> = {
  model: "Model",
  effort: "Effort",
  proxy: "Proxy",
  binary: "Binary 路径",
  defaultPermissionMode: "默认 Permission Mode",
  // 下面三个在 PrefsEditor 里不会被用到（fields 数组里没传），保留作防御：
  // 万一未来有人改 fields 加这些字段，至少有可读 label 不是空串。
  provider: "Provider",
  apiKey: "API Key",
  authMode: "Auth Mode",
};

const FIELD_PLACEHOLDER: Partial<Record<keyof BackendPrefs, string>> = {
  model: "默认（settings.json / config.toml / env）",
  effort: "low | medium | high | max",
  proxy: "http://127.0.0.1:7890 或 socks5://...",
  binary: "默认（PATH / bundled runtime）",
  defaultPermissionMode: "default | acceptEdits | plan | bypassPermissions",
  provider: "anthropic / openai / openrouter / ...",
  apiKey: "sk-...",
  authMode: "oauth | key",
};

const PERMISSION_MODE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "acceptEdits（推荐默认，自动接受编辑）" },
  { value: "acceptEdits", label: "acceptEdits（推荐，自动接受编辑）" },
  { value: "auto", label: "auto（Auto Mode，桌面版同名档位）" },
  { value: "plan", label: "plan（Plan Mode，先列计划）" },
  { value: "bypassPermissions", label: "bypassPermissions（完全跳过审批，慎用）" },
  { value: "default", label: "default（⚠ stream-json 下工具调用会被拒绝）" },
];

function PrefsEditor({ backend, fields }: PrefsEditorProps): JSX.Element {
  const prefs = useSettingsStore((s) => s.backends[backend]);
  const setBackendPref = useSettingsStore((s) => s.setBackendPref);

  /// onBlur 时一次性同步整个 backend 的偏好给 Rust 端，避免每个字符都 invoke。
  const sync = useCallback(() => {
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
      defaultPermissionMode: current.defaultPermissionMode || null,
    }).catch(console.error);
  }, [backend]);

  return (
    <div className="mt-3 grid grid-cols-2 gap-2">
      {fields.map((field) => {
        const label = FIELD_LABEL[field] ?? field;
        const placeholder = FIELD_PLACEHOLDER[field] ?? "";
        if (field === "defaultPermissionMode") {
          return (
            <label key={field} className="flex flex-col gap-1">
              <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                {label}
              </span>
              <select
                value={prefs[field] ?? ""}
                onChange={(e) => {
                  setBackendPref(backend, field, e.target.value);
                  // select 没有 blur 语义；立即 sync
                  setTimeout(sync, 0);
                }}
                className="rounded-md border border-black/5 bg-white/40 px-2 py-1 text-xs text-zinc-800 outline-none transition-all focus:border-sky-400/50 focus:bg-white/70 focus:ring-1 focus:ring-sky-400/15 dark:border-white/5 dark:bg-slate-800/40 dark:text-zinc-100 dark:focus:bg-slate-800/70"
              >
                {PERMISSION_MODE_OPTIONS.filter(
                  (o, idx, arr) =>
                    // 去掉重复的 "" 与 "default"，只保留一个 default 项
                    !(o.value === "default" && arr[idx - 1]?.value === "")
                ).map((o) => (
                  <option key={o.value || "_empty"} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          );
        }
        return (
          <label key={field} className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
              {label}
            </span>
            <input
              type="text"
              value={prefs[field] ?? ""}
              onChange={(e) => setBackendPref(backend, field, e.target.value)}
              onBlur={sync}
              placeholder={placeholder}
              className="rounded-md border border-black/5 bg-white/40 px-2 py-1 text-xs text-zinc-800 outline-none transition-all focus:border-sky-400/50 focus:bg-white/70 focus:ring-1 focus:ring-sky-400/15 dark:border-white/5 dark:bg-slate-800/40 dark:text-zinc-100 dark:focus:bg-slate-800/70"
            />
          </label>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OpenCode 专属：服务商 + 认证方式 + 模型选择
// ---------------------------------------------------------------------------
//
// 数据源 = 运行中的 `opencode serve`：
//   - GET /provider       → {all: [{id, name, models: {<id>: {name, ...}}}], default}
//                            完整服务商目录（来自 models.dev，200+ 家），含每家所有模型
//   - GET /provider/auth  → {<providerId>: [{label, type:"oauth"|"api"}]}
//                            每家声明的认证途径（决定 UI 显示"登录"还是"填 key"按钮）
//
// Rust 端 list_opencode_providers 已经把这两个端点合并 + 跟本地 auth.json 做了 join，
// 所以前端拿到的 OpencodeProviderInfo 就是 "上货架的全集 + 认证状态" 一份完整对象。
//
// 没启动 serve 时 Rust 直接报错；UI 在那种情况下显示提示让用户先启动服务，避免
// 拿一份残缺的硬编码列表把"自定义服务商"伪装成可选。

interface OpencodeAuthEditorProps {
  installed: boolean;
  serverRunning: boolean;
  /// 让"打开登录终端"成功后调用方可以做 toast
  onLoginOpened: (message: string) => void;
  /// 让"启动服务"按钮可以从子组件触发主面板上的启动逻辑
  onRequestStartServer: () => void;
}

function OpencodeAuthEditor({
  installed,
  serverRunning,
  onLoginOpened,
  onRequestStartServer,
}: OpencodeAuthEditorProps): JSX.Element {
  const rawPrefs = useSettingsStore((s) => s.backends.opencode);
  const setBackendPref = useSettingsStore((s) => s.setBackendPref);
  const setBackendPrefs = useSettingsStore((s) => s.setBackendPrefs);
  // 历史 persist 数据可能缺新加的字段（旧 BackendPrefs 没有 provider/apiKey/authMode）。
  // useSettingsStore 的 merge 已经做了兜底，这里再 normalize 一层绝不让任何字段
  // 漏成 undefined —— 防 `<select value={undefined}>` 之类的边角情况搞崩 React。
  const prefs: BackendPrefs = {
    model: rawPrefs?.model ?? "",
    effort: rawPrefs?.effort ?? "",
    proxy: rawPrefs?.proxy ?? "",
    binary: rawPrefs?.binary ?? "",
    provider: rawPrefs?.provider ?? "",
    apiKey: rawPrefs?.apiKey ?? "",
    authMode: (rawPrefs?.authMode ?? "") as BackendPrefs["authMode"],
    defaultPermissionMode:
      (rawPrefs?.defaultPermissionMode ?? "") as BackendPrefs["defaultPermissionMode"],
  };
  const [providers, setProviders] = useState<OpencodeProviderInfo[]>([]);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [keySaveState, setKeySaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [keySaveError, setKeySaveError] = useState<string | null>(null);

  /// 把 prefs 同步到 Rust 内存（Rust 在每次 turn 启动时读这份偏好）。
  const syncPrefs = useCallback(() => {
    const current = useSettingsStore.getState().backends.opencode;
    void invoke("update_backend_preferences", {
      backend: "opencode",
      model: current?.model || null,
      effort: current?.effort || null,
      proxy: current?.proxy || null,
      binary: current?.binary || null,
      provider: current?.provider || null,
      apiKey: current?.apiKey || null,
      authMode: current?.authMode || null,
      defaultPermissionMode: current?.defaultPermissionMode || null,
    });
  }, []);

  const refreshProviders = useCallback(async () => {
    setLoadingProviders(true);
    setProviderError(null);
    try {
      const list = await invoke<OpencodeProviderInfo[]>("opencode_list_providers", {});
      setProviders(Array.isArray(list) ? list : []);
    } catch (error) {
      setProviderError(String(error));
      setProviders([]);
    } finally {
      setLoadingProviders(false);
    }
  }, []);

  // serve 起来后自动拉一次完整目录；停掉就清空 providers，UI 会切到"先启动"提示
  useEffect(() => {
    if (installed && serverRunning) {
      void refreshProviders();
    } else {
      setProviders([]);
      setProviderError(null);
    }
  }, [installed, serverRunning, refreshProviders]);

  const currentProvider = providers.find((p) => p.id === prefs.provider) ?? null;
  const currentModels: OpencodeModelInfo[] = Array.isArray(currentProvider?.models)
    ? currentProvider!.models
    : [];
  const currentAuthMethods: OpencodeAuthMethodInfo[] = Array.isArray(currentProvider?.authMethods)
    ? currentProvider!.authMethods
    : [];

  const supportsOauth = currentAuthMethods.some((m) => m.kind === "oauth");

  const handleProviderChange = (value: string): void => {
    // 切 provider 时清空 model（避免 stale modelId）和 apiKey（每家的 key 不能复用）
    setBackendPrefs("opencode", { provider: value, model: "", apiKey: "", authMode: "" });
    setKeySaveState("idle");
    setKeySaveError(null);
    syncPrefs();
  };

  const handleKeyChange = (value: string): void => {
    setBackendPref("opencode", "apiKey", value);
    if (keySaveState === "saved") setKeySaveState("idle");
  };

  const handleSaveKey = async (): Promise<void> => {
    if (!prefs.provider) {
      setKeySaveError("请先选择服务商");
      setKeySaveState("error");
      return;
    }
    if (!prefs.apiKey.trim()) {
      setKeySaveError("API Key 不能为空");
      setKeySaveState("error");
      return;
    }
    setKeySaveState("saving");
    setKeySaveError(null);
    try {
      await invoke("opencode_set_auth", {
        provider: prefs.provider,
        mode: "key",
        apiKey: prefs.apiKey,
      });
      // authMode 标记为 "key"，让 launch_opencode_agent 启动 turn 前重写 auth.json
      setBackendPref("opencode", "authMode", "key");
      syncPrefs();
      if (serverRunning) void refreshProviders();
      setKeySaveState("saved");
    } catch (error) {
      setKeySaveError(String(error));
      setKeySaveState("error");
    }
  };

  const handleOpenLogin = async (): Promise<void> => {
    try {
      const message = await invoke<string>("opencode_login_open", {
        provider: prefs.provider || null,
        binary: prefs.binary || null,
        proxy: prefs.proxy || null,
      });
      onLoginOpened(message);
    } catch (error) {
      onLoginOpened(`打开登录终端失败：${String(error)}`);
    }
  };

  const handleModelChange = (value: string): void => {
    setBackendPref("opencode", "model", value);
    syncPrefs();
  };

  // serve 没起 → 仅一个启动按钮，主面板上方已经有完整状态条
  if (!serverRunning) {
    return (
      <div className="mt-3">
        <button
          type="button"
          disabled={!installed}
          onClick={onRequestStartServer}
          className="rounded-md border border-emerald-400/50 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 transition-all hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-300/40 dark:text-emerald-300"
        >
          启动服务
        </button>
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-3">
      {/* Provider */}
      <label className="flex flex-col gap-1">
        <span className="flex items-center justify-between text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
          <span>
            服务商
            {providerError ? (
              <span className="ml-2 text-rose-600 dark:text-rose-300">· {providerError}</span>
            ) : null}
          </span>
          <button
            type="button"
            disabled={loadingProviders}
            onClick={() => void refreshProviders()}
            className="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 transition-colors hover:bg-black/5 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-white/5"
          >
            {loadingProviders ? "拉取中…" : "刷新"}
          </button>
        </span>
        <select
          value={prefs.provider}
          onChange={(e) => handleProviderChange(e.target.value)}
          disabled={loadingProviders || providers.length === 0}
          className="rounded-md border border-black/5 bg-white/40 px-2 py-1 text-xs text-zinc-800 outline-none transition-all focus:border-sky-400/50 focus:bg-white/70 focus:ring-1 focus:ring-sky-400/15 disabled:opacity-60 dark:border-white/5 dark:bg-slate-800/40 dark:text-zinc-100 dark:focus:bg-slate-800/70"
        >
          <option value="">{loadingProviders ? "加载中…" : "选择服务商"}</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name || p.id}
              {p.authenticated ? " ✓" : ""}
            </option>
          ))}
        </select>
      </label>

      {/* API Key 输入 —— 选了 provider 就显示。OAuth（如有）旁路另起一行。 */}
      {currentProvider && (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="flex flex-wrap items-center gap-1 text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
              <span>API Key</span>
              {currentProvider.authenticated ? (
                <span className="text-emerald-600 dark:text-emerald-300">· 已配置</span>
              ) : null}
            </span>
            <div className="flex gap-2">
              <input
                type="password"
                value={prefs.apiKey}
                onChange={(e) => handleKeyChange(e.target.value)}
                onBlur={syncPrefs}
                placeholder={currentProvider.authenticated ? "已保存，重新输入可覆盖" : "粘贴 API Key"}
                className="flex-1 rounded-md border border-black/5 bg-white/40 px-2 py-1 font-mono text-xs text-zinc-800 outline-none transition-all focus:border-sky-400/50 focus:bg-white/70 focus:ring-1 focus:ring-sky-400/15 dark:border-white/5 dark:bg-slate-800/40 dark:text-zinc-100 dark:focus:bg-slate-800/70"
              />
              <button
                type="button"
                disabled={keySaveState === "saving" || !prefs.provider || !prefs.apiKey.trim()}
                onClick={() => void handleSaveKey()}
                className="rounded-md border border-emerald-400/50 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 transition-all hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-300/40 dark:text-emerald-300"
              >
                {keySaveState === "saving"
                  ? "保存中…"
                  : keySaveState === "saved"
                    ? "已保存 ✓"
                    : "保存"}
              </button>
            </div>
            {keySaveError ? (
              <span className="text-xs text-rose-600 dark:text-rose-300">{keySaveError}</span>
            ) : null}
          </label>

          {/* OAuth 旁路：只在该 provider 声明支持 OAuth 时显示 */}
          {supportsOauth && (
            <div>
              <button
                type="button"
                disabled={!installed}
                onClick={() => void handleOpenLogin()}
                className="rounded-md border border-sky-400/50 bg-sky-500/10 px-2.5 py-1 text-xs font-medium text-sky-700 transition-all hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-sky-300/40 dark:text-sky-300"
              >
                使用 OAuth 登录
              </button>
            </div>
          )}
        </div>
      )}

      {/* Model */}
      {currentProvider && (
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">模型</span>
          {currentModels.length > 0 ? (
            <select
              value={prefs.model}
              onChange={(e) => handleModelChange(e.target.value)}
              className="rounded-md border border-black/5 bg-white/40 px-2 py-1 text-xs text-zinc-800 outline-none transition-all focus:border-sky-400/50 focus:bg-white/70 focus:ring-1 focus:ring-sky-400/15 dark:border-white/5 dark:bg-slate-800/40 dark:text-zinc-100 dark:focus:bg-slate-800/70"
            >
              <option value="">
                {currentProvider.defaultModelId ? `默认（${currentProvider.defaultModelId}）` : "默认"}
              </option>
              {currentModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={prefs.model}
              onChange={(e) => setBackendPref("opencode", "model", e.target.value)}
              onBlur={syncPrefs}
              placeholder="模型 id"
              className="rounded-md border border-black/5 bg-white/40 px-2 py-1 text-xs text-zinc-800 outline-none transition-all focus:border-sky-400/50 focus:bg-white/70 focus:ring-1 focus:ring-sky-400/15 dark:border-white/5 dark:bg-slate-800/40 dark:text-zinc-100 dark:focus:bg-slate-800/70"
            />
          )}
        </label>
      )}
    </div>
  );
}

interface BackendCardProps {
  title: string;
  loading: boolean;
  children: React.ReactNode;
}

function BackendCard({ title, loading, children }: BackendCardProps): JSX.Element {
  return (
    <div className="rounded-xl border border-black/5 bg-white/40 p-4 dark:border-white/5 dark:bg-slate-800/40">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{title}</h3>
        {loading ? (
          <span className="text-xs text-sky-600 dark:text-sky-400">刷新中…</span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

interface ToastState {
  kind: "success" | "error";
  message: string;
}

function Toast({ toast }: { toast: ToastState | null }): JSX.Element | null {
  if (!toast) return null;
  const color =
    toast.kind === "success"
      ? "text-emerald-700 dark:text-emerald-300"
      : "text-rose-700 dark:text-rose-300";
  return (
    <p className={`mt-2 text-xs leading-relaxed ${color}`}>
      {toast.message.length > 360 ? `${toast.message.slice(0, 360)}…` : toast.message}
    </p>
  );
}

export function AgentBackendsSection({
  isVisible,
}: {
  isVisible: boolean;
}): JSX.Element {
  const status = useBackendStatus(isVisible);
  const [toasts, setToasts] = useState<{
    claude?: ToastState;
    codex?: ToastState;
    opencode?: ToastState;
  }>({});
  const [busy, setBusy] = useState<{ claude?: boolean; codex?: boolean; opencode?: boolean }>({});

  const setBackendBusy = (k: "claude" | "codex" | "opencode", v: boolean) =>
    setBusy((b) => ({ ...b, [k]: v }));
  const setBackendToast = (k: "claude" | "codex" | "opencode", t: ToastState | undefined) =>
    setToasts((s) => ({ ...s, [k]: t }));

  const runOp = useCallback(
    async (
      backend: "claude" | "codex" | "opencode",
      op: () => Promise<string | { ok?: boolean; message?: string } | unknown>
    ) => {
      setBackendBusy(backend, true);
      setBackendToast(backend, undefined);
      try {
        const result = await op();
        const msg =
          typeof result === "string"
            ? result
            : result && typeof result === "object" && "message" in result
              ? String((result as { message: string }).message ?? "操作完成")
              : "操作完成";
        setBackendToast(backend, { kind: "success", message: msg });
      } catch (error) {
        setBackendToast(backend, { kind: "error", message: String(error) });
      } finally {
        setBackendBusy(backend, false);
      }
    },
    []
  );

  const claudeNode = (() => {
    const c = status.claude;
    return (
      <BackendCard title="Claude Code" loading={status.loading.claude}>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusChip
            ok={c ? c.installed : null}
            label={c?.installed ? `已安装${c.version ? ` ${c.version}` : ""}` : "未检测到"}
          />
          {c?.installed ? (
            <StatusChip
              ok={c.loggedIn}
              warn={!c.loggedIn}
              label={c.loggedIn ? `已登录${c.authMethod ? ` · ${c.authMethod}` : ""}` : "未登录"}
            />
          ) : null}
          {c?.defaultModel ? (
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              默认模型：{c.defaultModel}
            </span>
          ) : null}
        </div>
        {status.errors.claude ? (
          <p className="mt-2 text-xs text-rose-700 dark:text-rose-300">{status.errors.claude}</p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy.claude || !c?.installed}
            onClick={() =>
              runOp("claude", async () => {
                const r = await status.verifyClaude();
                return r.message ?? "OK";
              })
            }
            className="rounded-md border border-sky-400/50 bg-sky-500/10 px-2.5 py-1 text-xs font-medium text-sky-700 transition-all hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-sky-300/40 dark:text-sky-300"
          >
            {busy.claude ? "验证中…" : "验证连接"}
          </button>
          <button
            type="button"
            disabled={busy.claude}
            onClick={() => runOp("claude", () => status.openClaudeLogin())}
            className="rounded-md border border-zinc-300/60 bg-white/40 px-2.5 py-1 text-xs font-medium text-zinc-700 transition-all hover:bg-white/70 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-slate-800/40 dark:text-zinc-200 dark:hover:bg-slate-800/70"
          >
            打开登录终端
          </button>
          <button
            type="button"
            disabled={status.loading.claude}
            onClick={() => status.refreshClaude()}
            className="rounded-md px-2.5 py-1 text-xs text-zinc-500 transition-colors hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            刷新状态
          </button>
        </div>
        <PrefsEditor
          backend="claude-code"
          fields={["model", "effort", "binary", "proxy", "defaultPermissionMode"]}
        />
        <Toast toast={toasts.claude ?? null} />
      </BackendCard>
    );
  })();

  const codexNode = (() => {
    const c = status.codex;
    return (
      <BackendCard title="Codex" loading={status.loading.codex}>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusChip
            ok={c ? c.installed : null}
            label={c?.installed ? `已安装${c.version ? ` ${c.version}` : ""}` : "未检测到"}
          />
          {c?.installed ? (
            <StatusChip
              ok={c.loggedIn}
              warn={!c.loggedIn}
              label={c.loggedIn ? `已登录${c.authMethod ? ` · ${c.authMethod}` : ""}` : "未登录"}
            />
          ) : null}
          {c?.defaultModel ? (
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              默认模型：{c.defaultModel}
              {c.defaultReasoningEffort ? ` · effort=${c.defaultReasoningEffort}` : ""}
            </span>
          ) : null}
        </div>
        {status.errors.codex ? (
          <p className="mt-2 text-xs text-rose-700 dark:text-rose-300">{status.errors.codex}</p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy.codex || !c?.installed}
            onClick={() =>
              runOp("codex", async () => {
                const r = await status.verifyCodex();
                return r.message ?? "OK";
              })
            }
            className="rounded-md border border-sky-400/50 bg-sky-500/10 px-2.5 py-1 text-xs font-medium text-sky-700 transition-all hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-sky-300/40 dark:text-sky-300"
          >
            {busy.codex ? "验证中…" : "验证连接"}
          </button>
          <button
            type="button"
            disabled={busy.codex}
            onClick={() => runOp("codex", () => status.openCodexLogin(false))}
            className="rounded-md border border-zinc-300/60 bg-white/40 px-2.5 py-1 text-xs font-medium text-zinc-700 transition-all hover:bg-white/70 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-slate-800/40 dark:text-zinc-200 dark:hover:bg-slate-800/70"
          >
            打开登录终端
          </button>
          <button
            type="button"
            disabled={busy.codex}
            onClick={() => runOp("codex", () => status.openCodexLogin(true))}
            className="rounded-md border border-zinc-300/60 bg-white/40 px-2.5 py-1 text-xs font-medium text-zinc-700 transition-all hover:bg-white/70 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-slate-800/40 dark:text-zinc-200 dark:hover:bg-slate-800/70"
          >
            设备码登录
          </button>
          <button
            type="button"
            disabled={status.loading.codex}
            onClick={() => status.refreshCodex()}
            className="rounded-md px-2.5 py-1 text-xs text-zinc-500 transition-colors hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            刷新状态
          </button>
        </div>
        <PrefsEditor backend="codex" fields={["model", "effort", "binary", "proxy"]} />
        <Toast toast={toasts.codex ?? null} />
      </BackendCard>
    );
  })();

  const opencodeNode = (() => {
    const o = status.opencode;
    return (
      <BackendCard title="OpenCode" loading={status.loading.opencode}>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusChip
            ok={o ? o.installed : null}
            label={o?.installed ? `已安装${o.version ? ` ${o.version}` : ""}` : "未检测到"}
          />
          {o?.installed ? (
            <StatusChip
              ok={o.running}
              warn={!o.running}
              label={o.running ? `运行中 · :${o.port}` : `未启动 · 端口 ${o.port}`}
            />
          ) : null}
          {o?.sessionId ? (
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              session：{o.sessionId.slice(0, 12)}…
            </span>
          ) : null}
        </div>
        {status.errors.opencode ? (
          <p className="mt-2 text-xs text-rose-700 dark:text-rose-300">{status.errors.opencode}</p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          {o?.running ? (
            <button
              type="button"
              disabled={busy.opencode}
              onClick={() => runOp("opencode", async () => {
                await status.stopOpencode();
                return "已停止";
              })}
              className="rounded-md border border-rose-400/50 bg-rose-500/10 px-2.5 py-1 text-xs font-medium text-rose-700 transition-all hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-300/40 dark:text-rose-300"
            >
              {busy.opencode ? "处理中…" : "停止服务"}
            </button>
          ) : (
            <button
              type="button"
              disabled={busy.opencode || !o?.installed}
              onClick={() => runOp("opencode", async () => {
                const r = await status.startOpencode();
                return `已启动 · :${r.port}`;
              })}
              className="rounded-md border border-emerald-400/50 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 transition-all hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-300/40 dark:text-emerald-300"
            >
              {busy.opencode ? "处理中…" : "启动服务"}
            </button>
          )}
          <button
            type="button"
            disabled={status.loading.opencode}
            onClick={() => status.refreshOpencode()}
            className="rounded-md px-2.5 py-1 text-xs text-zinc-500 transition-colors hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            刷新状态
          </button>
        </div>
        <SectionErrorBoundary fallbackTitle="OpenCode 认证 / 模型设置">
          <OpencodeAuthEditor
            installed={!!o?.installed}
            serverRunning={!!o?.running}
            onLoginOpened={(message) =>
              setBackendToast("opencode", { kind: "success", message })
            }
            onRequestStartServer={() => {
              void runOp("opencode", async () => {
                const r = await status.startOpencode();
                return `已启动 · :${r.port}`;
              });
            }}
          />
        </SectionErrorBoundary>
        <PrefsEditor backend="opencode" fields={["binary", "proxy"]} />
        <Toast toast={toasts.opencode ?? null} />
      </BackendCard>
    );
  })();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">Agent 后端</h3>
        <button
          type="button"
          onClick={() => status.refreshAll()}
          className="rounded-md px-2 py-0.5 text-xs text-zinc-500 transition-colors hover:bg-zinc-100/70 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-slate-800/70 dark:hover:text-zinc-200"
        >
          全部刷新
        </button>
      </div>
      {claudeNode}
      {codexNode}
      {opencodeNode}
    </div>
  );
}
