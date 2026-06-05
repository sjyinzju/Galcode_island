// 引导式配置（必要引导项）的弹窗开合 + 会话级 agent 可用性探测。
//
// 为什么单独开一个 store 而不复用 useUiStore：
//   - 弹窗开合是瞬态，不需要持久化（参照 useAboutStore 的约定，一个弹窗一个 store）。
//   - agentReady 是"会话级缓存"：overview 在没有活动 tab 时频繁挂载（启动、关掉所有
//     tab 都会回到 GlobalOverview），如果每次挂载都 spawn 三个 CLI 拿状态会很重
//     （claude_status / codex_status 首调要 4–8s）。这里用 hasProbed 兜一次，整个
//     会话只探测一次；向导里登录/验证成功后再 probeAgents(true) 强制刷新。

import { create } from "zustand";
import { invoke } from "../lib/bridge";
import type { ClaudeStatus, CodexStatus, OpencodeStatus } from "../types/backend";

interface SetupState {
  // 向导弹窗开合（瞬态，不持久化）
  isOpen: boolean;
  // 三个 backend 是否至少有一个"已就绪"。null = 本会话尚未探测。
  agentReady: boolean | null;
  // 正在探测
  probing: boolean;
  // 本会话已探测过（避免重复 spawn CLI）
  hasProbed: boolean;

  open: () => void;
  close: () => void;
  // 探测三个 backend 是否就绪。默认幂等（已探测过就跳过）；force=true 强制重探。
  probeAgents: (force?: boolean) => Promise<void>;
}

export const useSetupStore = create<SetupState>((set, get) => ({
  isOpen: false,
  agentReady: null,
  probing: false,
  hasProbed: false,

  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),

  probeAgents: async (force) => {
    const { probing, hasProbed } = get();
    if (probing) return;
    if (hasProbed && !force) return;
    set({ probing: true });
    // Promise.allSettled：任一 CLI 缺失/超时不影响其它判定
    const results = await Promise.allSettled([
      invoke<ClaudeStatus>("claude_status", {}),
      invoke<CodexStatus>("codex_status", {}),
      invoke<OpencodeStatus>("opencode_status", {}),
    ]);
    const [claude, codex, opencode] = results;
    // Claude / Codex：装上了 + 登录了才算就绪
    const claudeOk =
      claude.status === "fulfilled" && claude.value.installed && claude.value.loggedIn;
    const codexOk =
      codex.status === "fulfilled" && codex.value.installed && codex.value.loggedIn;
    // OpenCode 没有"登录"概念：装上了 + 服务在跑就算就绪（鉴权是 per-provider）
    const opencodeOk =
      opencode.status === "fulfilled" && opencode.value.installed && opencode.value.running;
    set({
      agentReady: claudeOk || codexOk || opencodeOk,
      probing: false,
      hasProbed: true,
    });
  },
}));
