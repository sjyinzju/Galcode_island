// 跨设备共享的 zustand persist storage adapter。
//
// 桌面端是唯一权威：
//   - Tauri 模式：走本地 localStorage（保持桌面端启动时同步可用）；setItem 后
//     **额外**把 JSON 推到 Rust 镜像（lan_set_storage），让移动端能拉到。
//   - 浏览器（LAN）模式：没有桌面端的 localStorage（手机本地是空的），所以
//     getItem 直接调 lan_get_storage 拿桌面端推上来的 JSON 做 hydrate，
//     setItem 直接 invoke 推回去并广播事件。
//
// 双向同步靠 storage://changed 事件广播：
//   - 任一客户端写入后端镜像后，所有其它客户端收到事件 → 调 onExternalChange 回调
//     → 触发 zustand 的 useStore.persist.rehydrate() → 重新 getItem → setState
//   - 写入方自己也会收到事件（Tauri 自己 emit 的 listener 也会监听到），用 source
//     clientId 比对跳过自己的回声，避免无限 rehydrate 循环
//
// 防回环关键点：
//   - 客户端启动时生成 32 位随机 clientId
//   - setItem / removeItem 时把 clientId 作为 source 一起发给后端
//   - 后端原样把 source 放进事件 payload
//   - 客户端 listener 收到 source === self.clientId 时直接 ignore

import type { PersistStorage, StorageValue } from "zustand/middleware";
import { invoke, isTauri, listen } from "./bridge";

const CLIENT_ID = generateClientId();

function generateClientId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getClientId(): string {
  return CLIENT_ID;
}

// ---------------------------------------------------------------------------
// 外部变化 dispatch：每个 store 用 createSharedStorage 时注册自己的 onExternalChange
// 回调。后端事件到达时按 key 路由到对应 store 的回调。
// ---------------------------------------------------------------------------

type ExternalListener = (rawValue: string | null, source: string) => void;
const externalListeners = new Map<string, Set<ExternalListener>>();
type ExternalReconciler = (key: string, rawValue: string | null) => void;
const externalReconcilers = new Set<ExternalReconciler>();

function ensureListener(key: string): Set<ExternalListener> {
  let set = externalListeners.get(key);
  if (!set) {
    set = new Set();
    externalListeners.set(key, set);
  }
  return set;
}

export function onStorageExternalChange(key: string, cb: ExternalListener): () => void {
  const set = ensureListener(key);
  set.add(cb);
  return () => set.delete(cb);
}

let globalListenerInstalled = false;

function installGlobalListener(): void {
  if (globalListenerInstalled) return;
  globalListenerInstalled = true;
  void listen<{ key: string; value: string; source: string }>(
    "storage://changed",
    (e) => {
      const { key, value, source } = e.payload;
      if (source === CLIENT_ID) return;
      for (const reconcile of externalReconcilers) reconcile(key, value);
      // 关键：把远端写入同步到**本端 localStorage**，让后续 rehydrate 调 getItem
      // 时拿到最新 value（Tauri 桌面端 getItem 同步读 localStorage，不读后端镜像；
      // 没有这步就会用本地旧值反向覆盖后端，对方的更新就丢了）
      if (typeof localStorage !== "undefined") {
        try {
          localStorage.setItem(key, value);
        } catch {
          /* quota，忽略 */
        }
      }
      const handlers = externalListeners.get(key);
      if (!handlers || handlers.size === 0) return;
      for (const h of handlers) h(value, source);
    },
  );
  void listen<{ key: string; source: string }>("storage://removed", (e) => {
    const { key, source } = e.payload;
    if (source === CLIENT_ID) return;
    for (const reconcile of externalReconcilers) reconcile(key, null);
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }
    const handlers = externalListeners.get(key);
    if (!handlers || handlers.size === 0) return;
    for (const h of handlers) h(null, source);
  });
}

// ---------------------------------------------------------------------------
// PersistStorage 实现
// ---------------------------------------------------------------------------

export interface SharedStorageOptions {
  /// 写 localStorage 失败（多半是 QuotaExceededError）时调用。返回 true 表示
  /// 已经处理（外层 setItem 不再重试）；返回 false / 抛错表示放弃。
  /// 默认：直接吞掉错误（已经写到后端镜像，本地丢失也能从远端恢复）。
  onLocalQuotaError?: (key: string, raw: string, err: unknown) => boolean | void;
  /// 合并短时间内的连续写入。流式输出等高频状态只保留最新快照，避免每个
  /// 增量都 stringify 整个 store、同步写 localStorage 并发送 IPC。
  writeDelayMs?: number;
}

/// 创建一份"双端共享、桌面权威"的 zustand persist storage。
///
/// 这里返回 PersistStorage<any> 是有意为之：zustand persist 的 storage option
/// 期望 `PersistStorage<PersistedState>`（即 partialize 输出类型），不同 store
/// partialize 不一样很难抽公共类型 —— 让 `any` 当 type-erasure 通道，由 zustand
/// 内部按 store 的 PersistedState 自动对齐 setItem/getItem。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createSharedStorage(
  options: SharedStorageOptions = {},
): PersistStorage<any> {
  installGlobalListener();
  // T 已被擦除；adapter 内部按 unknown JSON value 处理
  type AnyValue = StorageValue<unknown>;
  type RemoteOperation =
    | { kind: "set"; raw: string }
    | { kind: "remove" };

  const writeDelayMs = Math.max(0, options.writeDelayMs ?? 0);
  const pendingWrites = new Map<string, AnyValue>();
  const pendingRemote = new Map<string, RemoteOperation>();
  const activeRemote = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const writeLocal = (name: string, raw: string): void => {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(name, raw);
    } catch (err) {
      if (options.onLocalQuotaError) {
        try { options.onLocalQuotaError(name, raw, err); } catch { /* ignore */ }
      }
    }
  };

  const cancelPendingWrite = (name: string): void => {
    pendingWrites.delete(name);
    if (pendingWrites.size === 0 && flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  // An external event is authoritative over snapshots created before it. An
  // operation already sent cannot be cancelled, so replay the external state
  // after it finishes to keep the backend from ending on the stale value.
  externalReconcilers.add((name, rawValue) => {
    cancelPendingWrite(name);
    pendingRemote.delete(name);
    if (!activeRemote.has(name)) return;
    pendingRemote.set(name, rawValue === null
      ? { kind: "remove" }
      : { kind: "set", raw: rawValue });
  });

  // 同一个 key 的远端写只允许一个在途；期间产生的新快照只保留最后一个。
  // 这既减少 IPC，也避免多个异步命令完成顺序颠倒后旧值覆盖新值。
  const drainRemote = async (name: string): Promise<void> => {
    while (pendingRemote.has(name)) {
      const next = pendingRemote.get(name)!;
      pendingRemote.delete(name);
      try {
        await (next.kind === "set"
          ? invoke("lan_set_storage", {
              key: name,
              value: next.raw,
              source: CLIENT_ID,
              notifyWebview: !isTauri,
            })
          : invoke("lan_remove_storage", {
              key: name,
              source: CLIENT_ID,
              notifyWebview: !isTauri,
            }));
      } catch (err) {
        console.warn(`[shared-storage] ${next.kind} backend failed`, err);
      }
    }
    activeRemote.delete(name);
  };

  const enqueueRemote = (name: string, operation: RemoteOperation): void => {
    pendingRemote.set(name, operation);
    if (activeRemote.has(name)) return;
    activeRemote.add(name);
    void drainRemote(name);
  };

  const persistNow = (name: string, value: AnyValue): void => {
    const raw = JSON.stringify(value);
    writeLocal(name, raw);
    enqueueRemote(name, { kind: "set", raw });
  };

  const flush = (): void => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const writes = Array.from(pendingWrites.entries());
    pendingWrites.clear();
    for (const [name, value] of writes) persistNow(name, value);
  };

  const scheduleWrite = (name: string, value: AnyValue): void => {
    if (writeDelayMs === 0) {
      persistNow(name, value);
      return;
    }
    pendingWrites.set(name, value);
    if (flushTimer === null) {
      flushTimer = setTimeout(flush, writeDelayMs);
    }
  };

  if (writeDelayMs > 0 && typeof window !== "undefined") {
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
  }

  const adapter: PersistStorage<unknown> = {
    // Tauri 桌面端：同步从 localStorage 读 —— 这一步必须同步！否则 zustand persist
    // 在 store 创建时启动 hydrate，hydrate 是 await getItem 后 setState；用户刚启动
    // 就切 tab / 改设置时，setState 发生在 hydrate 之前，等 hydrate 拿到旧 JSON
    // 再 setState 会把用户刚做的修改回滚（"切 tab 切回原状态"、"流式区 cliBlocks
    // 被 persisted 老快照覆盖"等 bug 都源于此）。
    //
    // 浏览器（LAN 客户端）：没有桌面端 localStorage，必须 await invoke 拉后端镜像。
    // 但浏览器刚加载时用户还没机会交互，hydrate 完成后 setState 不会冲突。
    getItem: (name: string): AnyValue | null | Promise<AnyValue | null> => {
      if (isTauri && typeof localStorage !== "undefined") {
        const local = localStorage.getItem(name);
        return local !== null ? parseStorageValue(local) : null;
      }
      return (async (): Promise<AnyValue | null> => {
        try {
          const raw = await invoke<string | null>("lan_get_storage", { key: name });
          if (raw === null || raw === undefined) return null;
          return parseStorageValue(raw);
        } catch {
          return null;
        }
      })();
    },

    setItem: scheduleWrite,

    removeItem: (name) => {
      cancelPendingWrite(name);
      if (typeof localStorage !== "undefined") {
        try { localStorage.removeItem(name); } catch { /* ignore */ }
      }
      enqueueRemote(name, { kind: "remove" });
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return adapter as PersistStorage<any>;
}

function parseStorageValue(raw: string): StorageValue<unknown> | null {
  try {
    return JSON.parse(raw) as StorageValue<unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 对外辅助：让 store rehydrate / 直接 push 到后端
// ---------------------------------------------------------------------------

/// 显式把当前 localStorage 里某个 key 的值同步推到后端。桌面端启动时如果用户
/// 从老 localStorage 升级而来（还没有触发任何 setItem），可以调这个让镜像立刻
/// 包含老数据。一般 createSharedStorage.getItem 已经走过这条路；这里作为兜底。
export async function pushLocalToRemote(key: string): Promise<void> {
  if (!isTauri || typeof localStorage === "undefined") return;
  const raw = localStorage.getItem(key);
  if (raw === null) return;
  try {
    await invoke("lan_set_storage", { key, value: raw, source: CLIENT_ID });
  } catch (err) {
    console.warn(`[shared-storage] push ${key} failed`, err);
  }
}

/// 仅浏览器模式：启动时一次性拉所有镜像 key/value，写入本地（虚拟）storage。
/// 主要用于 LanLoginGate 完成登录后让所有 zustand store 第一时间拿到桌面端数据。
/// 实际上各 store 自己调 persist.rehydrate() 也能拿到，这里是备用接口。
export async function fetchAllStorageEntries(): Promise<[string, string][]> {
  if (isTauri) return [];
  try {
    return await invoke<[string, string][]>("lan_list_storage");
  } catch {
    return [];
  }
}
