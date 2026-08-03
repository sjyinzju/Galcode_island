// Tauri / 浏览器双模式桥接层。
//
// 桌面端（Tauri webview）：直接透传给 @tauri-apps/api，invoke 是 IPC 直连，
// listen 是 Tauri 事件总线。
//
// 移动端 / 局域网浏览器：没有 Tauri 注入的全局，所有调用走 HTTP / 长轮询：
//   - invoke(cmd, args) → POST /api/cmd/<cmd>，Authorization: Bearer <lanToken>
//     响应体形如 { value: <result> }，已剥壳后返回；4xx / 5xx 抛 Error
//   - listen(event, cb) → 单例长轮询循环（GET /api/events/poll?since=N）
//     收到事件后按 event 名 dispatch 给所有 listener；timeout / 网络错重试
//   - pickFolder() → 桌面端弹原生 dialog；浏览器端 prompt（移动端没目录选择器）
//
// 这样所有现有 store / hook / 组件只要把 `from "@tauri-apps/api/core"` 换成
// `from "../lib/bridge"`，业务逻辑无感知运行环境。

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import {
  listen as tauriListen,
  type UnlistenFn as TauriUnlistenFn,
} from "@tauri-apps/api/event";
import { open as tauriOpen } from "@tauri-apps/plugin-dialog";

/// 全局是否在 Tauri 环境内（注入了 __TAURI_INTERNALS__ 即视为 Tauri webview）。
export const isTauri: boolean = (() => {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
})();

export const isBrowserLan: boolean = !isTauri;

// ---------------------------------------------------------------------------
// LAN token
// ---------------------------------------------------------------------------

const TOKEN_STORAGE_KEY = "galcode_lan_token";

let lanToken: string | null = null;
const tokenChangeListeners = new Set<(token: string | null) => void>();

if (typeof localStorage !== "undefined") {
  lanToken = localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function getLanToken(): string | null {
  return lanToken;
}

export function setLanToken(token: string | null): void {
  lanToken = token;
  if (typeof localStorage !== "undefined") {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
  // token 变化要重启轮询循环（带新 token 重新 fetch）
  if (token) startPollLoop();
  else stopPollLoop();
  for (const fn of tokenChangeListeners) fn(token);
}

export function onLanTokenChange(fn: (token: string | null) => void): () => void {
  tokenChangeListeners.add(fn);
  return () => tokenChangeListeners.delete(fn);
}

// ---------------------------------------------------------------------------
// invoke
// ---------------------------------------------------------------------------

export class BridgeUnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "BridgeUnauthorizedError";
  }
}

export async function invoke<T = unknown>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (isTauri) {
    return tauriInvoke<T>(cmd, args);
  }
  if (!lanToken) {
    throw new BridgeUnauthorizedError();
  }
  let resp: Response;
  try {
    resp = await fetch(`/api/cmd/${encodeURIComponent(cmd)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lanToken}`,
      },
      body: JSON.stringify(args ?? {}),
    });
  } catch (err) {
    throw new Error(`network error: ${(err as Error).message}`);
  }
  if (resp.status === 401) {
    setLanToken(null);
    throw new BridgeUnauthorizedError();
  }
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const data = (await resp.json()) as { error?: string };
      if (data.error) msg = data.error;
    } catch {
      /* 非 JSON 错误就用状态码 */
    }
    throw new Error(msg);
  }
  // 后端返回 { value: <T> }
  if (resp.status === 204) return undefined as T;
  const data = (await resp.json().catch(() => null)) as { value?: T } | null;
  return (data?.value ?? (undefined as T)) as T;
}

// ---------------------------------------------------------------------------
// listen：浏览器端走长轮询
// ---------------------------------------------------------------------------

export type UnlistenFn = TauriUnlistenFn;

interface PollEvent {
  seq: number;
  event: string;
  payload: unknown;
}

interface PollResponse {
  events: PollEvent[];
  maxSeq: number;
}

const lanListeners = new Map<string, Set<(env: { payload: unknown }) => void>>();
let pollAbortController: AbortController | null = null;
let pollLoopRunning = false;
let lastSeq = 0;
let initialSeqFetched = false;

function startPollLoop(): void {
  if (isTauri) return;
  if (!lanToken) return;
  if (pollLoopRunning) return;
  pollLoopRunning = true;
  initialSeqFetched = false;
  void runPollLoop();
}

function stopPollLoop(): void {
  pollLoopRunning = false;
  if (pollAbortController) {
    pollAbortController.abort();
    pollAbortController = null;
  }
}

async function fetchInitialSeq(): Promise<void> {
  // 首次连接时先以一次空 poll 拿当前 maxSeq 作为基准，避免拿到全部 backlog。
  // 后端 since=0 时会立刻返回历史事件 → 我们丢弃，只取它的 maxSeq 当 since。
  if (!lanToken) return;
  try {
    const resp = await fetch(`/api/events/poll?since=0`, {
      headers: { Authorization: `Bearer ${lanToken}` },
    });
    if (!resp.ok) return;
    const data = (await resp.json()) as PollResponse;
    lastSeq = data.maxSeq ?? 0;
  } catch {
    /* 拉不到就算了，下面循环会兜底 */
  }
  initialSeqFetched = true;
}

async function runPollLoop(): Promise<void> {
  while (pollLoopRunning && lanToken) {
    if (!initialSeqFetched) {
      await fetchInitialSeq();
      if (!pollLoopRunning) return;
    }
    pollAbortController = new AbortController();
    let resp: Response;
    try {
      resp = await fetch(`/api/events/poll?since=${lastSeq}`, {
        headers: { Authorization: `Bearer ${lanToken}` },
        signal: pollAbortController.signal,
      });
    } catch (e) {
      // 网络错 / abort：等 1.5s 重试，避免 token 失效时撞死循环
      if ((e as Error).name === "AbortError") {
        if (!pollLoopRunning) return;
      }
      await sleep(1500);
      continue;
    }
    pollAbortController = null;
    if (resp.status === 401) {
      // token 失效；停止循环并清 token —— UI 会重定向到登录
      setLanToken(null);
      return;
    }
    if (!resp.ok) {
      await sleep(1500);
      continue;
    }
    let data: PollResponse;
    try {
      data = (await resp.json()) as PollResponse;
    } catch {
      await sleep(500);
      continue;
    }
    if (data.events && data.events.length > 0) {
      for (const ev of data.events) {
        dispatchToListeners(ev.event, ev.payload);
      }
    }
    if (typeof data.maxSeq === "number" && data.maxSeq > lastSeq) {
      lastSeq = data.maxSeq;
    }
    // 立刻发下一轮（fetch keep-alive 接 idle 状态等待事件 → 25s 心跳超时返回）
  }
}

function dispatchToListeners(event: string, payload: unknown): void {
  const handlers = lanListeners.get(event);
  if (!handlers || handlers.size === 0) return;
  const env = { payload };
  for (const h of handlers) h(env);
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export async function listen<T = unknown>(
  event: string,
  cb: (e: { payload: T }) => void,
): Promise<UnlistenFn> {
  if (isTauri) {
    return tauriListen<T>(event, cb);
  }
  let handlers = lanListeners.get(event);
  if (!handlers) {
    handlers = new Set();
    lanListeners.set(event, handlers);
  }
  const wrapped = (env: { payload: unknown }) => cb(env as { payload: T });
  handlers.add(wrapped);
  // 第一次登录后 setLanToken 会拉起 pollLoop；如果用户先 listen 再 login 也兜得住
  startPollLoop();
  return () => {
    handlers!.delete(wrapped);
  };
}

// ---------------------------------------------------------------------------
// 文件 / 目录选择
// ---------------------------------------------------------------------------

export interface PickFolderOptions {
  defaultPath?: string;
  title?: string;
}

export interface PickFilesOptions {
  defaultPath?: string;
  title?: string;
}

export async function pickFiles(opts: PickFilesOptions = {}): Promise<string[]> {
  if (!isTauri) return [];
  const result = await tauriOpen({
    directory: false,
    multiple: true,
    defaultPath: opts.defaultPath,
    title: opts.title,
  });
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

/// 选目录。
///   - Tauri 桌面端：走原生 dialog
///   - 浏览器（移动端 / LAN 客户端）：调 useFolderPickerStore.show() 弹自绘
///     的目录浏览 modal（后端 list_directory 命令驱动）。该 store 必须在 React
///     根挂载 <MobileFolderPicker />，否则 Promise 永远 pending —— 兜底用
///     window.prompt。
export async function pickFolder(opts: PickFolderOptions = {}): Promise<string | null> {
  if (isTauri) {
    const res = await tauriOpen({
      directory: true,
      multiple: false,
      defaultPath: opts.defaultPath,
      title: opts.title,
    });
    if (!res) return null;
    return Array.isArray(res) ? (res[0] ?? null) : res;
  }
  // 动态 import 避免在 Tauri 模式下也加载 store（store 只服务浏览器路径）
  try {
    const mod = await import("../stores/useFolderPickerStore");
    return await mod.useFolderPickerStore.getState().show(opts.defaultPath ?? null);
  } catch {
    // store 没装 / 加载失败 → fallback 到原始 prompt
    const input = window.prompt(
      opts.title ?? "请输入项目目录的绝对路径",
      opts.defaultPath ?? "",
    );
    if (input === null) return null;
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
}

// 启动时如果有 token，立刻把轮询循环跑起来（让组件 listen 之前就开始接收事件）
if (isBrowserLan && lanToken) {
  startPollLoop();
}
