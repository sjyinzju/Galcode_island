// 用户点击桌宠产生的"被戳/触摸"台词的临时状态。
//
// 用法：
//   - PetCharacter handleClick → 异步调 IPC 拿台词 → setPoke(speech)
//   - PetPokeBubble 子组件订阅 store.speech，非空就渲染气泡
//   - 默认 ~5s 后自动 clear（也可手动 clear）
//
// 不走 persist：这是临时 UI 反馈，重启清空合理。

import { create } from "zustand";

/// 气泡默认显示时长（ms）。LLM 生成 + 用户阅读 + 自然消失。
const DEFAULT_TTL_MS = 5000;

interface PetInteractionState {
  /// 当前气泡台词；null 表示不显示
  speech: string | null;
  /// 触发本次气泡的桌宠图本地 id —— 调试/日志用，UI 不直接展示
  sourceImageId: string | null;
  /// 设台词 + 调度自动 clear。再次调用会重置 timer + 替换内容。
  setPoke: (speech: string, sourceImageId?: string | null, ttlMs?: number) => void;
  /// 手动立即清掉
  clear: () => void;
}

let pendingTimer: ReturnType<typeof setTimeout> | null = null;

export const usePetInteractionStore = create<PetInteractionState>((set) => ({
  speech: null,
  sourceImageId: null,
  setPoke: (speech, sourceImageId = null, ttlMs = DEFAULT_TTL_MS) => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    set({ speech, sourceImageId });
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      set({ speech: null, sourceImageId: null });
    }, ttlMs);
  },
  clear: () => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    set({ speech: null, sourceImageId: null });
  },
}));
