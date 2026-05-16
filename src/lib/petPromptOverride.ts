// 计算本次任务 finalize 时该交给 LLM 的"人设替换 prompt"。
//
// 任务结束后桌宠会显示 "complete" 类别的图；这张图带的 communityPrompt 决定
// 团长（默认凉宫春日）的文案风格。由于图是 finalize 后才随机挑的，前端无法严格
// 预测会展示哪张图——这里在 start_agent 时**任意**挑一张 complete 类带 prompt
// 的图，把它的 prompt 当本次 finalize 的 override。
//
// 设计妥协：
//   - 若 complete 类多张图各自有不同 prompt：取第一张找到的非空 prompt（用户上传顺序）。
//     用户若希望每张图都精确控制风格，应该让所有 complete 图共享同一段 prompt。
//   - 自定义桌宠未启用（usePetAssetsStore.enabled=false）→ 返回 null（凉宫风）
//   - 启用但 complete 类无图 / 无 prompt → 返回 null

import { usePetAssetsStore } from "../stores/usePetAssetsStore";

export function getActivePromptOverride(): string | null {
  const state = usePetAssetsStore.getState();
  if (!state.enabled) return null;
  const list = state.assets.complete ?? [];
  for (const meta of list) {
    const p = meta.communityPrompt?.trim();
    if (p) return p;
  }
  return null;
}
