// 计算本次任务 finalize 时该交给 LLM 的"人设替换 prompt"。
//
// 选图策略：
//   - 自定义桌宠未启用 → 返回 null（凉宫风）
//   - 启用 → 从 complete 类的所有图里 **随机** 选一张
//     - 若该图带 communityPrompt 非空：用它替换 LLM 人设
//     - 若该图无 prompt：override = null（用默认凉宫风）
//   每次调用独立 random：连续多轮任务可能用到不同图的 prompt，让每张图都有"上场"机会。
//
// 返回 PromptOverrideSelection（即使 prompt 为 null 也带 sourceImageId/sourceFileName）。
// sourceImageId / sourceFileName 字段保留用作 console.log 调试，UI 不再展示。
//
// 单元测试覆盖：见 petPromptOverride.test.ts。

import { usePetAssetsStore, type PetAssetMeta } from "../stores/usePetAssetsStore";

export interface PromptOverrideSelection {
  /// 实际传给后端的 prompt 字符串（null = 不替换人设，用默认凉宫风）
  prompt: string | null;
  /// 选中那张图的本地 id（用于 UI 关联展示）
  sourceImageId: string;
  /// 选中那张图的本地文件名（用于 UI chip 展示）
  sourceFileName: string;
}

/// 纯函数版本，方便单测。`rand` 默认 Math.random，测试可注入。
export function pickPromptOverride(
  enabled: boolean,
  completeAssets: PetAssetMeta[],
  rand: () => number = Math.random,
): PromptOverrideSelection | null {
  if (!enabled) return null;
  if (completeAssets.length === 0) return null;
  const idx = Math.min(
    completeAssets.length - 1,
    Math.max(0, Math.floor(rand() * completeAssets.length)),
  );
  const meta = completeAssets[idx]!;
  const p = meta.communityPrompt?.trim();
  return {
    prompt: p && p.length > 0 ? p : null,
    sourceImageId: meta.id,
    sourceFileName: meta.fileName,
  };
}

/// 读 store 当前状态做一次选择。InputBubble / ResultCard 在 invoke 前调一次。
export function selectPromptOverride(): PromptOverrideSelection | null {
  const state = usePetAssetsStore.getState();
  return pickPromptOverride(state.enabled, state.assets.complete ?? []);
}

/// 兼容老调用方：单纯拿 prompt string（不需要 source info）
export function getActivePromptOverride(): string | null {
  const sel = selectPromptOverride();
  return sel?.prompt ?? null;
}
