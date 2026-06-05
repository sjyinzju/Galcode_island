// 引导式配置向导（必要引导项）。
//
// 入口：overview 上的「必要引导项未配置」卡片（GlobalOverview / ProjectOverview）。
// 四步：
//   1. 代理与端口 —— 确认是否走出站代理，填协议/主机/端口，拼成 URL 写进三个 backend。
//   2. 选择 Agent —— 三选一（Claude Code / Codex / OpenCode），写 useAppStore.selectedAgent。
//   3. 登录与设置 —— 按所选 agent 分叉：Claude/Codex 开终端登录，OpenCode 起服务+选服务商+填 key/OAuth。
//   4. 角色扮演 Key —— 填自己的 OpenAI 兼容 LLM key，凉宫春日总结/翻译才能跑。
//
// 弹窗脚手架照搬 SettingsModal（AnimatePresence + z-[200] 背景 + z-[210] 居中层 +
// 弹簧动画玻璃面板 + header/pills/body/footer 三段）。所有 IPC 走 lib/bridge 的 invoke，
// 桌面端走 Tauri、局域网端走 HTTP。重活只在弹窗打开时挂载（GuidedSetupContent 仅在 isOpen
// 时渲染），避免应用启动就 spawn CLI。

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { invoke, isBrowserLan } from "../../lib/bridge";
import {
  PROVIDER_PRESETS,
  getProviderPreset,
  useSettingsStore,
  type BackendKey,
  type LlmProvider,
} from "../../stores/useSettingsStore";
import { useProfileStore } from "../../stores/useProfileStore";
import { useAppStore } from "../../stores/useAppStore";
import { useBackendStatus } from "../../hooks/useBackendStatus";
import { useSetupStore } from "../../stores/useSetupStore";
import { syncBackendPrefsToRust } from "../../lib/backendPrefs";
import type { ClaudeStatus, CodexStatus, OpencodeStatus, VerifyResult } from "../../types/backend";

// 与 SettingsModal 共用的输入框样式（那边是模块内私有常量，这里照抄一份）。
const inputCls =
  "rounded-lg border border-black/5 bg-white/50 px-3 py-2.5 text-base text-zinc-800 outline-none transition-all focus:border-sky-400/50 focus:bg-white/80 focus:ring-2 focus:ring-sky-400/15 sm:py-2 sm:text-sm dark:border-white/5 dark:bg-slate-800/50 dark:text-zinc-100 dark:focus:border-sky-400/40 dark:focus:bg-slate-800/70 dark:focus:ring-sky-400/10";

const STEPS = ["代理与端口", "选择 Agent", "登录与设置", "角色扮演 Key"] as const;
const BACKENDS: readonly BackendKey[] = ["claude-code", "codex", "opencode"];

const AGENT_CHOICES: { key: BackendKey; label: string; desc: string }[] = [
  {
    key: "claude-code",
    label: "Claude Code",
    desc: "Anthropic 官方 CLI，长驻 stream-json 进程。登录在系统终端里走交互式 OAuth。",
  },
  {
    key: "codex",
    label: "Codex",
    desc: "共享 app-server。支持浏览器登录，或在无图形环境下用设备码登录。",
  },
  {
    key: "opencode",
    label: "OpenCode",
    desc: "本地 serve 进程。按服务商分别填 API Key 或走 OAuth，再选模型。",
  },
];

// OpenCode 服务商目录条目（Rust 端归一化后的形态，与 AgentBackendsSection 一致）。
interface OpencodeAuthMethodInfo {
  kind: string; // "oauth" | "api"
  label: string;
}
interface OpencodeModelInfo {
  id: string;
  name: string;
}
interface OpencodeProviderInfo {
  id: string;
  name: string;
  authenticated: boolean;
  authType: string | null;
  authMethods: OpencodeAuthMethodInfo[];
  models: OpencodeModelInfo[];
  defaultModelId: string | null;
  envKeys: string[];
}

// 把已存的 proxy URL 解析回表单初值（如 http://127.0.0.1:7890 → {use,protocol,host,port}）。
function parseProxy(raw: string): {
  use: boolean;
  protocol: "http" | "socks5";
  host: string;
  port: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) return { use: false, protocol: "http", host: "127.0.0.1", port: "7890" };
  const m = trimmed.match(/^(\w+):\/\/([^:/]+)(?::(\d+))?/);
  if (!m) return { use: true, protocol: "http", host: "127.0.0.1", port: "" };
  return {
    use: true,
    protocol: m[1] === "socks5" ? "socks5" : "http",
    host: m[2] || "127.0.0.1",
    port: m[3] ?? "",
  };
}

// ---------------------------------------------------------------------------
// 小组件：状态徽标
// ---------------------------------------------------------------------------
function Chip({ ok, label }: { ok: boolean | null; label: string }): JSX.Element {
  const color =
    ok === true
      ? "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-400/20 dark:text-emerald-300"
      : ok === false
        ? "bg-rose-500/15 text-rose-700 dark:bg-rose-400/20 dark:text-rose-300"
        : "bg-zinc-200/70 text-zinc-500 dark:bg-slate-700/50 dark:text-zinc-400";
  const symbol = ok === true ? "✓" : ok === false ? "✗" : "…";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${color}`}
    >
      <span>{symbol}</span>
      <span>{label}</span>
    </span>
  );
}

const sectionLabelCls =
  "text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-500";
const fieldLabelCls = "text-[12px] font-medium text-zinc-600 dark:text-zinc-400";
const secondaryBtnCls =
  "rounded-lg border border-black/5 bg-white/50 px-3 py-1.5 text-[12px] font-medium text-zinc-700 transition-colors hover:bg-white/80 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-slate-800/50 dark:text-zinc-200 dark:hover:bg-slate-800/80";
const primarySmallBtnCls =
  "rounded-lg bg-sky-500 px-3 py-1.5 text-[12px] font-medium text-white shadow-sm shadow-sky-400/25 transition-all hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50";

// ---------------------------------------------------------------------------
// 步骤 3：Claude / Codex 登录面板（两者流程几乎一样，codex 多一个设备码登录）
// ---------------------------------------------------------------------------
interface CliLoginPanelProps {
  kind: "claude" | "codex";
  status: ClaudeStatus | CodexStatus | null;
  loading: boolean;
  error?: string;
  binary: string;
  proxyArg: string | null;
  onRefresh: () => void;
  onVerify: () => Promise<VerifyResult>;
}

function CliLoginPanel({
  kind,
  status,
  loading,
  error,
  binary,
  proxyArg,
  onRefresh,
  onVerify,
}: CliLoginPanelProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const label = kind === "claude" ? "Claude Code" : "Codex";

  const openLogin = useCallback(
    async (deviceAuth: boolean) => {
      setBusy(true);
      setMessage(null);
      try {
        const cmd = kind === "claude" ? "claude_login_open" : "codex_login_open";
        const args =
          kind === "claude"
            ? { binary: binary || null, proxy: proxyArg }
            : { deviceAuth, binary: binary || null, proxy: proxyArg };
        const msg = await invoke<string>(cmd, args);
        setMessage(msg || "已打开登录终端，完成后点「重新检测」。");
      } catch (e) {
        setMessage(`打开登录终端失败：${String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [kind, binary, proxyArg],
  );

  const handleVerify = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await onVerify();
      setMessage((r.ok ? "✓ " : "✗ ") + r.message);
    } catch (e) {
      setMessage(`验证失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [onVerify]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip ok={status ? status.installed : null} label={status?.installed ? "已安装 CLI" : "未检测到 CLI"} />
        <Chip ok={status ? status.loggedIn : null} label={status?.loggedIn ? "已登录" : "未登录"} />
        {status?.version && (
          <span className="text-[11px] text-zinc-400 dark:text-zinc-500">v{status.version}</span>
        )}
        {loading && <span className="text-[11px] text-zinc-400 dark:text-zinc-500">检测中…</span>}
      </div>

      {error && <p className="text-[12px] text-rose-500 dark:text-rose-300">{error}</p>}

      {status && !status.installed ? (
        <p className="rounded-lg border border-amber-300/40 bg-amber-50/70 px-3 py-2 text-[12px] leading-relaxed text-amber-700 dark:border-amber-300/20 dark:bg-amber-300/5 dark:text-amber-200">
          没检测到 {label} CLI。请先在系统里安装它（或在「设置 → Agent」里填自定义 binary 路径），再回来登录。
        </p>
      ) : status?.loggedIn ? (
        <p className="rounded-lg border border-emerald-300/40 bg-emerald-50/70 px-3 py-2 text-[12px] leading-relaxed text-emerald-700 dark:border-emerald-300/20 dark:bg-emerald-300/5 dark:text-emerald-200">
          {label} 已登录{status.authMethod ? `（${status.authMethod}）` : ""}，可以进入下一步了。
        </p>
      ) : (
        <p className="text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400">
          点击下面的按钮会打开一个系统终端运行登录命令。
          {isBrowserLan
            ? " 注意：你正从局域网/移动端访问，终端登录必须在桌面主机上完成。"
            : " 在终端里完成 OAuth 后，回到这里点「重新检测」确认。"}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || isBrowserLan}
          onClick={() => void openLogin(false)}
          className={primarySmallBtnCls}
          title={isBrowserLan ? "请在桌面主机上完成登录" : undefined}
        >
          打开登录终端
        </button>
        {kind === "codex" && (
          <button
            type="button"
            disabled={busy || isBrowserLan}
            onClick={() => void openLogin(true)}
            className={secondaryBtnCls}
            title="无图形环境时使用设备码登录"
          >
            设备码登录
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => void handleVerify()} className={secondaryBtnCls}>
          验证连接
        </button>
        <button type="button" disabled={busy || loading} onClick={onRefresh} className={secondaryBtnCls}>
          重新检测
        </button>
      </div>

      {message && (
        <p className="break-words rounded-lg border border-black/5 bg-white/50 px-3 py-2 text-[12px] text-zinc-600 dark:border-white/10 dark:bg-slate-800/50 dark:text-zinc-300">
          {message}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 步骤 3：OpenCode 登录面板（起服务 → 列服务商 → 选 → key/OAuth → 选模型）
// ---------------------------------------------------------------------------
interface OpencodeLoginPanelProps {
  status: OpencodeStatus | null;
  loading: boolean;
  error?: string;
  binary: string;
  proxyArg: string | null;
  onRefresh: () => void;
}

function OpencodeLoginPanel({
  status,
  loading,
  error,
  binary,
  proxyArg,
  onRefresh,
}: OpencodeLoginPanelProps): JSX.Element {
  const prefs = useSettingsStore((s) => s.backends.opencode);
  const setBackendPref = useSettingsStore((s) => s.setBackendPref);
  const setBackendPrefs = useSettingsStore((s) => s.setBackendPrefs);

  const [providers, setProviders] = useState<OpencodeProviderInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState(prefs.apiKey);

  const running = Boolean(status?.running);
  const selectedProvider = providers.find((p) => p.id === prefs.provider) ?? null;
  const authMethods = Array.isArray(selectedProvider?.authMethods) ? selectedProvider!.authMethods : [];
  const hasApiMethod = authMethods.some((m) => m.kind === "api");
  const hasOauthMethod = authMethods.some((m) => m.kind === "oauth");

  const startServer = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      await invoke<OpencodeStatus>("opencode_start", {
        binary: binary || null,
        proxy: proxyArg,
      });
      onRefresh();
      setMessage("OpenCode 服务已启动。");
    } catch (e) {
      setMessage(`启动服务失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [binary, proxyArg, onRefresh]);

  const loadProviders = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const list = await invoke<OpencodeProviderInfo[]>("opencode_list_providers", {});
      setProviders(list);
      if (list.length === 0) setMessage("没拉到服务商列表，确认服务已启动。");
    } catch (e) {
      setMessage(`拉取服务商失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const handlePickProvider = useCallback(
    (id: string) => {
      setBackendPrefs("opencode", { provider: id, model: "" });
      syncBackendPrefsToRust("opencode");
    },
    [setBackendPrefs],
  );

  const saveApiKey = useCallback(async () => {
    if (!prefs.provider) {
      setMessage("请先选择服务商。");
      return;
    }
    if (!apiKeyInput.trim()) {
      setMessage("请填入 API Key。");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await invoke("opencode_set_auth", {
        provider: prefs.provider,
        mode: "key",
        apiKey: apiKeyInput,
      });
      // apiKey 写进 ~/.config/opencode/auth.json（由 opencode_set_auth 负责），
      // zustand 这边留一份用于回填表单 + 标记 authMode。
      setBackendPrefs("opencode", { apiKey: apiKeyInput, authMode: "key" });
      syncBackendPrefsToRust("opencode");
      setMessage("✓ API Key 已保存。");
      void loadProviders();
    } catch (e) {
      setMessage(`保存 API Key 失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [prefs.provider, apiKeyInput, setBackendPrefs, loadProviders]);

  const openOauth = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const msg = await invoke<string>("opencode_login_open", {
        provider: prefs.provider || null,
        binary: binary || null,
        proxy: proxyArg,
      });
      setBackendPref("opencode", "authMode", "oauth");
      syncBackendPrefsToRust("opencode");
      setMessage(msg || "已打开 OAuth 登录终端，完成后回来刷新。");
    } catch (e) {
      setMessage(`打开 OAuth 登录失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [prefs.provider, binary, proxyArg, setBackendPref]);

  const pickModel = useCallback(
    (modelId: string) => {
      setBackendPref("opencode", "model", modelId);
      syncBackendPrefsToRust("opencode");
    },
    [setBackendPref],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip ok={status ? status.installed : null} label={status?.installed ? "已安装 CLI" : "未检测到 CLI"} />
        <Chip ok={status ? status.running : null} label={status?.running ? "服务运行中" : "服务未启动"} />
        {status?.running && status.port > 0 && (
          <span className="text-[11px] text-zinc-400 dark:text-zinc-500">:{status.port}</span>
        )}
        {loading && <span className="text-[11px] text-zinc-400 dark:text-zinc-500">检测中…</span>}
      </div>

      {error && <p className="text-[12px] text-rose-500 dark:text-rose-300">{error}</p>}

      {status && !status.installed ? (
        <p className="rounded-lg border border-amber-300/40 bg-amber-50/70 px-3 py-2 text-[12px] leading-relaxed text-amber-700 dark:border-amber-300/20 dark:bg-amber-300/5 dark:text-amber-200">
          没检测到 OpenCode CLI。请先安装它（或在「设置 → Agent」里填 binary 路径）再回来配置。
        </p>
      ) : (
        <p className="text-[12px] leading-relaxed text-zinc-600 dark:text-zinc-400">
          OpenCode 没有统一登录：先启动本地服务，再选一个服务商，按它支持的方式填 API Key 或走 OAuth，最后选模型。
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy || running} onClick={() => void startServer()} className={primarySmallBtnCls}>
          {running ? "服务已启动" : "启动服务"}
        </button>
        <button type="button" disabled={busy || !running} onClick={() => void loadProviders()} className={secondaryBtnCls}>
          加载服务商
        </button>
        <button type="button" disabled={busy || loading} onClick={onRefresh} className={secondaryBtnCls}>
          重新检测
        </button>
      </div>

      {providers.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-black/5 bg-white/40 p-3 dark:border-white/10 dark:bg-slate-800/40">
          <label className={fieldLabelCls}>服务商</label>
          <select
            value={prefs.provider}
            onChange={(e) => handlePickProvider(e.target.value)}
            className={inputCls}
          >
            <option value="">— 请选择 —</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.authenticated ? " ✓" : ""}
              </option>
            ))}
          </select>

          {selectedProvider && (
            <>
              {hasApiMethod && (
                <div className="flex flex-col gap-2">
                  <label className={fieldLabelCls}>
                    API Key
                    {selectedProvider.envKeys.length > 0 ? `（${selectedProvider.envKeys.join(" / ")}）` : ""}
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={apiKeyInput}
                      onChange={(e) => setApiKeyInput(e.target.value)}
                      placeholder="sk-..."
                      autoComplete="off"
                      className={`${inputCls} flex-1`}
                    />
                    <button type="button" disabled={busy} onClick={() => void saveApiKey()} className={primarySmallBtnCls}>
                      保存
                    </button>
                  </div>
                </div>
              )}

              {hasOauthMethod && (
                <button
                  type="button"
                  disabled={busy || isBrowserLan}
                  onClick={() => void openOauth()}
                  className={secondaryBtnCls}
                  title={isBrowserLan ? "请在桌面主机上完成登录" : undefined}
                >
                  使用 OAuth 登录（打开终端）
                </button>
              )}

              {selectedProvider.models.length > 0 && (
                <div className="flex flex-col gap-2">
                  <label className={fieldLabelCls}>模型</label>
                  <select value={prefs.model} onChange={(e) => pickModel(e.target.value)} className={inputCls}>
                    <option value="">
                      {selectedProvider.defaultModelId ? `默认（${selectedProvider.defaultModelId}）` : "默认模型"}
                    </option>
                    {selectedProvider.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {message && (
        <p className="break-words rounded-lg border border-black/5 bg-white/50 px-3 py-2 text-[12px] text-zinc-600 dark:border-white/10 dark:bg-slate-800/50 dark:text-zinc-300">
          {message}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 向导主体（仅在 isOpen 时挂载，避免应用启动就跑 useBackendStatus 探测）
// ---------------------------------------------------------------------------
function GuidedSetupContent(): JSX.Element {
  const close = useSetupStore((s) => s.close);
  const probeAgents = useSetupStore((s) => s.probeAgents);

  const setSelectedAgent = useAppStore((s) => s.setSelectedAgent);
  const backends = useSettingsStore((s) => s.backends);

  // 弹窗打开时自动拉一次三个 backend 状态（autoRefreshOn=true）
  const status = useBackendStatus(true);

  const [step, setStep] = useState(0);

  // —— 步骤 1：代理 —— 初值从已存的 claude-code.proxy 解析回来
  const initialProxy = useMemo(() => parseProxy(backends["claude-code"].proxy), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [useProxy, setUseProxy] = useState(initialProxy.use);
  const [proxyProtocol, setProxyProtocol] = useState<"http" | "socks5">(initialProxy.protocol);
  const [proxyHost, setProxyHost] = useState(initialProxy.host);
  const [proxyPort, setProxyPort] = useState(initialProxy.port);

  const portNum = Number(proxyPort);
  const portValid =
    !useProxy ||
    (proxyPort.trim() !== "" && Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535);
  const proxyArg =
    useProxy && portValid
      ? `${proxyProtocol}://${proxyHost.trim() || "127.0.0.1"}:${proxyPort.trim()}`
      : null;

  // —— 步骤 2：选 agent —— 初值取 selectedAgent（若已是三选一之一）
  const initialBackend = useMemo<BackendKey>(() => {
    const cur = useAppStore.getState().selectedAgent;
    return (BACKENDS as readonly string[]).includes(cur) ? (cur as BackendKey) : "claude-code";
  }, []);
  const [selectedBackend, setSelectedBackend] = useState<BackendKey>(initialBackend);

  // —— 步骤 4：角色扮演 LLM —— 初值从 settings 读
  const [llmProvider, setLlmProvider] = useState<LlmProvider>(useSettingsStore.getState().provider);
  const [llmBaseUrl, setLlmBaseUrl] = useState(useSettingsStore.getState().apiBaseUrl);
  const [llmApiKey, setLlmApiKey] = useState(useSettingsStore.getState().apiKey);
  const [llmModel, setLlmModel] = useState(useSettingsStore.getState().model);
  const [llmThinking, setLlmThinking] = useState(useSettingsStore.getState().thinking);
  const [llmTranslate, setLlmTranslate] = useState(useSettingsStore.getState().translateInput);
  const [llmModels, setLlmModels] = useState<string[]>(useSettingsStore.getState().availableModels);
  const [fetchState, setFetchState] = useState<
    { kind: "idle" } | { kind: "loading" } | { kind: "ok"; count: number } | { kind: "err"; msg: string }
  >({ kind: "idle" });

  // 弹窗关闭（组件卸载）时强制重探一次，让 overview 的 CTA 反映最新配置结果
  useEffect(() => {
    return () => {
      void probeAgents(true);
    };
  }, [probeAgents]);

  // —— 各步持久化 ——
  const persistProxy = useCallback(() => {
    const url = proxyArg ?? "";
    for (const k of BACKENDS) {
      useSettingsStore.getState().setBackendPref(k, "proxy", url);
      syncBackendPrefsToRust(k);
    }
  }, [proxyArg]);

  const onProviderChange = useCallback(
    (id: LlmProvider) => {
      setLlmProvider(id);
      if (id !== "custom") {
        const preset = getProviderPreset(id);
        setLlmBaseUrl(preset.baseUrl);
        setLlmModel(llmThinking && preset.thinkingModel ? preset.thinkingModel : preset.defaultModel);
      }
    },
    [llmThinking],
  );

  const fetchModels = useCallback(async () => {
    if (!llmBaseUrl.trim() || !llmApiKey.trim()) {
      setFetchState({ kind: "err", msg: "请先填 Base URL 和 API Key" });
      return;
    }
    setFetchState({ kind: "loading" });
    try {
      const list = await invoke<string[]>("list_llm_models", { baseUrl: llmBaseUrl, apiKey: llmApiKey });
      setLlmModels(list);
      setFetchState({ kind: "ok", count: list.length });
    } catch (e) {
      setFetchState({ kind: "err", msg: String(e) });
    }
  }, [llmBaseUrl, llmApiKey]);

  const persistLlm = useCallback(() => {
    const s = useSettingsStore.getState();
    s.setProvider(llmProvider);
    s.setApiBaseUrl(llmBaseUrl);
    s.setApiKey(llmApiKey);
    s.setModel(llmModel);
    s.setThinking(llmThinking);
    s.setTranslateInput(llmTranslate);
    s.setAvailableModels(llmModels);
    void invoke("update_llm_settings", {
      baseUrl: llmBaseUrl,
      apiKey: llmApiKey,
      nickname: useProfileStore.getState().nickname,
      systemPrompt: s.systemPrompt,
      provider: llmProvider,
      model: llmModel,
      thinking: llmThinking,
      translateInput: llmTranslate,
    }).catch(console.error);
  }, [llmProvider, llmBaseUrl, llmApiKey, llmModel, llmThinking, llmTranslate, llmModels]);

  // —— 导航 ——
  const isLast = step === STEPS.length - 1;
  const canNext = step === 0 ? portValid : true;

  const handleNext = useCallback(() => {
    if (step === 0) {
      persistProxy();
      setStep(1);
    } else if (step === 1) {
      setSelectedAgent(selectedBackend);
      setStep(2);
    } else if (step === 2) {
      setStep(3);
    } else {
      // 完成
      persistLlm();
      void probeAgents(true);
      close();
    }
  }, [step, persistProxy, selectedBackend, setSelectedAgent, persistLlm, probeAgents, close]);

  const llmPreset = getProviderPreset(llmProvider);

  return (
    <>
      {/* header */}
      <div className="flex items-center justify-between border-b border-black/5 px-5 py-4 sm:px-6 dark:border-white/5">
        <h2 className="text-lg font-bold text-zinc-800 sm:text-xl dark:text-zinc-100">引导式配置</h2>
        <button
          type="button"
          onClick={close}
          aria-label="关闭"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-black/5 dark:text-zinc-400 dark:hover:bg-white/5"
        >
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5">
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* 步骤指示 pills */}
      <div className="flex shrink-0 flex-wrap gap-1 border-b border-black/5 px-5 py-2 sm:px-6 dark:border-white/5">
        {STEPS.map((label, i) => (
          <span
            key={label}
            className={`shrink-0 rounded-full px-3 py-1 text-[12px] transition-all ${
              i === step
                ? "bg-sky-500 text-white shadow-sm"
                : i < step
                  ? "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-400/20 dark:text-emerald-300"
                  : "bg-black/5 text-zinc-500 dark:bg-white/10 dark:text-zinc-400"
            }`}
          >
            {i + 1}. {label}
          </span>
        ))}
      </div>

      {/* 滚动 body */}
      <div className="flex flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
        {/* ---- 步骤 1：代理与端口 ---- */}
        {step === 0 && (
          <div className="flex flex-col gap-4">
            <div className={sectionLabelCls}>第 1 步 · 出站网络代理</div>
            <p className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
              如果你的网络需要代理才能访问 Anthropic / OpenAI 等服务，在这里打开它。配置会写进三个 Agent
              的代理项，登录和运行时都会通过它出网。不需要就保持关闭。
            </p>

            <label className="flex cursor-pointer items-center gap-2.5">
              <input
                type="checkbox"
                checked={useProxy}
                onChange={(e) => setUseProxy(e.target.checked)}
                className="h-4 w-4 accent-sky-500"
              />
              <span className="text-[13px] font-medium text-zinc-700 dark:text-zinc-200">
                我需要代理才能访问网络
              </span>
            </label>

            {useProxy && (
              <div className="flex flex-col gap-3 rounded-lg border border-black/5 bg-white/40 p-3 dark:border-white/10 dark:bg-slate-800/40">
                <div className="flex flex-wrap gap-3">
                  <div className="flex min-w-[110px] flex-col gap-1.5">
                    <label className={fieldLabelCls}>协议</label>
                    <select
                      value={proxyProtocol}
                      onChange={(e) => setProxyProtocol(e.target.value as "http" | "socks5")}
                      className={inputCls}
                    >
                      <option value="http">http</option>
                      <option value="socks5">socks5</option>
                    </select>
                  </div>
                  <div className="flex flex-1 flex-col gap-1.5">
                    <label className={fieldLabelCls}>主机</label>
                    <input
                      type="text"
                      value={proxyHost}
                      onChange={(e) => setProxyHost(e.target.value)}
                      placeholder="127.0.0.1"
                      className={inputCls}
                    />
                  </div>
                  <div className="flex min-w-[110px] flex-col gap-1.5">
                    <label className={fieldLabelCls}>端口</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={proxyPort}
                      onChange={(e) => setProxyPort(e.target.value)}
                      placeholder="7890"
                      className={inputCls}
                    />
                  </div>
                </div>
                {!portValid && (
                  <p className="text-[12px] text-rose-500 dark:text-rose-300">端口需为 1–65535 的整数。</p>
                )}
                <p className="break-all text-[12px] text-zinc-400 dark:text-zinc-500">
                  将使用：<span className="font-mono">{proxyArg ?? "（端口无效）"}</span>
                </p>
              </div>
            )}
          </div>
        )}

        {/* ---- 步骤 2：选择 Agent ---- */}
        {step === 1 && (
          <div className="flex flex-col gap-4">
            <div className={sectionLabelCls}>第 2 步 · 选择一个 Agent</div>
            <p className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
              选一个你想先配置的编码 Agent。下一步会带你完成它的登录 / 设置。之后随时能在设置里再加另外两个。
            </p>
            <div className="flex flex-col gap-2.5">
              {AGENT_CHOICES.map((opt) => {
                const st =
                  opt.key === "claude-code"
                    ? status.claude
                    : opt.key === "codex"
                      ? status.codex
                      : status.opencode;
                const installed = st?.installed ?? null;
                const active = selectedBackend === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setSelectedBackend(opt.key)}
                    className={`flex flex-col gap-1 rounded-xl border px-4 py-3 text-left transition-all ${
                      active
                        ? "border-sky-400/60 bg-sky-400/10 dark:border-sky-400/50 dark:bg-sky-500/15"
                        : "border-black/5 bg-white/40 hover:bg-white/70 dark:border-white/10 dark:bg-slate-800/40 dark:hover:bg-slate-800/70"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`flex h-4 w-4 items-center justify-center rounded-full border ${
                          active
                            ? "border-sky-500 bg-sky-500"
                            : "border-zinc-300 dark:border-zinc-600"
                        }`}
                      >
                        {active && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                      </span>
                      <span className="text-[14px] font-semibold text-zinc-800 dark:text-zinc-100">
                        {opt.label}
                      </span>
                      <Chip ok={installed} label={installed ? "已安装" : installed === false ? "未检测到" : "检测中"} />
                    </div>
                    <span className="pl-6 text-[12px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                      {opt.desc}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ---- 步骤 3：登录与设置 ---- */}
        {step === 2 && (
          <div className="flex flex-col gap-4">
            <div className={sectionLabelCls}>
              第 3 步 · {AGENT_CHOICES.find((o) => o.key === selectedBackend)?.label} 登录与设置
            </div>
            {selectedBackend === "claude-code" && (
              <CliLoginPanel
                kind="claude"
                status={status.claude}
                loading={status.loading.claude}
                error={status.errors.claude}
                binary={backends["claude-code"].binary}
                proxyArg={proxyArg}
                onRefresh={() => void status.refreshClaude()}
                onVerify={status.verifyClaude}
              />
            )}
            {selectedBackend === "codex" && (
              <CliLoginPanel
                kind="codex"
                status={status.codex}
                loading={status.loading.codex}
                error={status.errors.codex}
                binary={backends.codex.binary}
                proxyArg={proxyArg}
                onRefresh={() => void status.refreshCodex()}
                onVerify={status.verifyCodex}
              />
            )}
            {selectedBackend === "opencode" && (
              <OpencodeLoginPanel
                status={status.opencode}
                loading={status.loading.opencode}
                error={status.errors.opencode}
                binary={backends.opencode.binary}
                proxyArg={proxyArg}
                onRefresh={() => void status.refreshOpencode()}
              />
            )}
            <p className="text-[12px] leading-relaxed text-zinc-400 dark:text-zinc-500">
              登录是异步的——在终端里完成后回来「重新检测 / 验证」即可。没装好也能先跳到下一步，之后再回设置里补。
            </p>
          </div>
        )}

        {/* ---- 步骤 4：角色扮演 Key ---- */}
        {step === 3 && (
          <div className="flex flex-col gap-4">
            <div className={sectionLabelCls}>第 4 步 · 角色扮演 / 总结用的 LLM</div>
            <p className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-400">
              这一项配的是你自己的 OpenAI 兼容大模型 key，用来驱动凉宫春日风格的总结、反馈和可选的中英翻译。
              和上面的 Agent 登录完全独立。不填也能用（会退回内置 persona），但建议填上体验更完整。
            </p>

            <div className="flex flex-col gap-1.5">
              <label className={fieldLabelCls}>服务商</label>
              <select
                value={llmProvider}
                onChange={(e) => onProviderChange(e.target.value as LlmProvider)}
                className={inputCls}
              >
                {PROVIDER_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className={fieldLabelCls}>Base URL</label>
              <input
                type="text"
                value={llmBaseUrl}
                onChange={(e) => setLlmBaseUrl(e.target.value)}
                placeholder="https://api.deepseek.com/v1"
                className={inputCls}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className={fieldLabelCls}>API Key</label>
              <input
                type="password"
                value={llmApiKey}
                onChange={(e) => setLlmApiKey(e.target.value)}
                placeholder="sk-..."
                autoComplete="off"
                className={inputCls}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className={fieldLabelCls}>模型 ID</label>
                <button type="button" onClick={() => void fetchModels()} className={secondaryBtnCls}>
                  {fetchState.kind === "loading" ? "拉取中…" : "拉取最新列表"}
                </button>
              </div>
              <input
                type="text"
                list="setup-llm-model-list"
                value={llmModel}
                onChange={(e) => setLlmModel(e.target.value)}
                placeholder="deepseek-v4-flash / gpt-5.5 / 自定义..."
                className={inputCls}
              />
              <datalist id="setup-llm-model-list">
                {llmModels.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              {fetchState.kind === "ok" && (
                <span className="text-[11px] text-emerald-600 dark:text-emerald-400">
                  拉到 {fetchState.count} 个模型
                </span>
              )}
              {fetchState.kind === "err" && (
                <span className="break-words text-[11px] text-rose-500 dark:text-rose-300">{fetchState.msg}</span>
              )}
            </div>

            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={llmThinking}
                onChange={(e) => {
                  const on = e.target.checked;
                  setLlmThinking(on);
                  // 切到 / 离开思考模型（与 SettingsModal 一致）
                  if (llmProvider !== "custom") {
                    const preset = getProviderPreset(llmProvider);
                    setLlmModel(on && preset.thinkingModel ? preset.thinkingModel : preset.defaultModel);
                  }
                }}
                className="mt-0.5 h-4 w-4 accent-sky-500"
              />
              <span className="text-[13px] text-zinc-700 dark:text-zinc-200">
                思考模式
                {llmPreset.thinkingHint && (
                  <span className="ml-1 text-[11px] text-zinc-400 dark:text-zinc-500">（{llmPreset.thinkingHint}）</span>
                )}
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={llmTranslate}
                onChange={(e) => setLlmTranslate(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-sky-500"
              />
              <span className="text-[13px] text-zinc-700 dark:text-zinc-200">
                把中文输入翻成英文喂给 Agent（输出再翻回中文）
              </span>
            </label>
          </div>
        )}
      </div>

      {/* footer */}
      <div
        className="flex items-center justify-between gap-3 border-t border-black/5 px-5 py-3 sm:px-6 sm:py-4 dark:border-white/5"
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      >
        <button
          type="button"
          onClick={close}
          className="min-h-[44px] rounded-lg px-3 py-2.5 text-sm font-medium text-zinc-400 transition-colors hover:bg-zinc-100/70 sm:min-h-0 sm:px-3 sm:py-2 dark:text-zinc-500 dark:hover:bg-slate-800/70"
        >
          稍后再说
        </button>
        <div className="flex gap-3">
          {step > 0 && (
            <button
              type="button"
              onClick={() => setStep((s) => s - 1)}
              className="min-h-[44px] rounded-lg px-5 py-2.5 text-sm font-medium text-zinc-500 transition-colors hover:bg-zinc-100/70 sm:min-h-0 sm:px-4 sm:py-2 dark:text-zinc-400 dark:hover:bg-slate-800/70"
            >
              上一步
            </button>
          )}
          <button
            type="button"
            disabled={!canNext}
            onClick={handleNext}
            className="min-h-[44px] rounded-lg bg-sky-500 px-5 py-2.5 text-sm font-medium text-white shadow-md shadow-sky-400/25 transition-all hover:bg-sky-600 hover:shadow-sky-400/40 active:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:px-4 sm:py-2"
          >
            {isLast ? "完成" : "下一步"}
          </button>
        </div>
      </div>
    </>
  );
}

export function GuidedSetupModal(): JSX.Element {
  const isOpen = useSetupStore((s) => s.isOpen);
  const close = useSetupStore((s) => s.close);

  return (
    <AnimatePresence>
      {isOpen && (
        <React.Fragment>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[200] bg-black/30 backdrop-blur-sm"
            onClick={close}
          />
          <div className="fixed inset-0 z-[210] flex items-end justify-center pointer-events-none sm:items-center">
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ type: "spring", damping: 25, stiffness: 300 }}
              className="pointer-events-auto flex h-[92dvh] w-full flex-col rounded-t-2xl border border-white/60 bg-white/85 shadow-[0_-10px_40px_rgba(0,0,0,0.12)] backdrop-blur-2xl sm:h-auto sm:max-h-[85vh] sm:w-[92%] sm:max-w-2xl sm:rounded-2xl sm:bg-white/70 sm:shadow-[0_20px_60px_rgba(0,0,0,0.12)] dark:border-white/10 dark:bg-slate-800/85 sm:dark:bg-slate-800/60 dark:shadow-none"
            >
              <GuidedSetupContent />
            </motion.div>
          </div>
        </React.Fragment>
      )}
    </AnimatePresence>
  );
}
