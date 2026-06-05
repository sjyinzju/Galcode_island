// 把 backend 偏好（model / effort / proxy / binary / provider / apiKey / authMode /
// defaultPermissionMode）从前端 zustand 推到 Rust 端的内存单例。
//
// 为什么要单独推一次：zustand persist 是真相之源，但 Rust 端用 OnceLock<Mutex<>> 存，
// 进程重启就空，每次 turn 启动时读这份偏好。只调 store setter 不推 Rust 的话，改动
// 要等下次应用重启（App.tsx 启动同步）才生效。
//
// 这段 invoke 以前在 App.tsx / AgentBackendsSection / ProjectOverview / 引导向导里各抄了
// 一份（字段顺序、value || null 规则必须完全一致，否则 Rust 端从不同入口更新会不一致或漏字段）。
// 统一收口到这里，所有需要"改完 pref 立刻让 Rust 生效"的地方都调它。
//
// 注意：不在这里加 isTauri 守卫——组件里（设置页 / 向导）本就期望走 bridge 在桌面或局域网
// 两种模式下都能推到桌面主机；只有 App.tsx 启动时的"无脑全量回灌"才需要在调用处用 isTauri
// 拦住浏览器客户端（避免空表覆盖）。

import { invoke } from "./bridge";
import { useSettingsStore, type BackendKey } from "../stores/useSettingsStore";

const ALL_BACKENDS: readonly BackendKey[] = ["claude-code", "codex", "opencode"];

/// 把单个 backend 当前在 store 里的整份偏好推给 Rust。失败只 console.error，不抛。
export function syncBackendPrefsToRust(backend: BackendKey): void {
  const current = useSettingsStore.getState().backends[backend];
  void invoke("update_backend_preferences", {
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
}

/// 三个 backend 全部推一遍（App 启动回灌时用）。
export function syncAllBackendPrefsToRust(): void {
  for (const backend of ALL_BACKENDS) syncBackendPrefsToRust(backend);
}
