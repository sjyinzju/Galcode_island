// 计算本次任务 finalize 时该交给 LLM 的"人设替换 prompt"。
//
// 解析顺序（图 prompt > 预设 persona > 凉宫硬编码）：
//   - 自定义桌宠未启用（active=default）→ 返回 null，让 Rust 走凉宫春日兜底
//   - 自定义启用：
//       1. 从 complete 类随机抽一张图
//       2. 若该图 communityPrompt 非空 → 用图 prompt
//       3. 否则若当前预设 persona 非空 → 用预设 persona
//       4. 都空 → prompt=null（Rust 走凉宫春日）
//   - 自定义启用但 complete 类为空：
//       · 预设 persona 非空 → 用预设 persona（sourceImageId 是占位）
//       · 否则 null
//
// 每次调用独立随机，连续多轮可能用到不同图的 prompt，让多张图都有"上场"机会；
// 预设 persona 是稳定 fallback——图 prompt 设过几张但有些图没设也不会出现"忽然变凉宫"。

import {
  getActiveCategories,
  getActivePreset,
  isCustomPresetActive,
  usePetAssetsStore,
  type PetAssetMeta,
} from "../stores/usePetAssetsStore";

export interface PromptOverrideSelection {
  /// 实际传给后端的 prompt 字符串（null = 不替换人设，用默认凉宫风）
  prompt: string | null;
  /// 选中那张图的本地 id（用于 UI 关联展示）；preset-persona 占位时为 "__preset__"
  sourceImageId: string;
  /// 选中那张图的本地文件名（用于 UI chip 展示）；preset-persona 占位时为 "(preset)"
  sourceFileName: string;
}

/// 纯函数版本，方便单测。`rand` 默认 Math.random，测试可注入。
export function pickPromptOverride(
  enabled: boolean,
  completeAssets: PetAssetMeta[],
  presetPersona: string | null,
  rand: () => number = Math.random,
): PromptOverrideSelection | null {
  if (!enabled) return null;
  const pp = presetPersona?.trim();
  const presetPp = pp && pp.length > 0 ? pp : null;

  if (completeAssets.length === 0) {
    if (presetPp) {
      return {
        prompt: presetPp,
        sourceImageId: "__preset__",
        sourceFileName: "(preset)",
      };
    }
    return null;
  }

  const idx = Math.min(
    completeAssets.length - 1,
    Math.max(0, Math.floor(rand() * completeAssets.length)),
  );
  const meta = completeAssets[idx]!;
  const ip = meta.communityPrompt?.trim();
  const resolved = ip && ip.length > 0 ? ip : presetPp;
  return {
    prompt: resolved,
    sourceImageId: meta.id,
    sourceFileName: meta.fileName,
  };
}

/// 读 store 当前状态做一次选择。InputBubble / ResultCard 在 invoke 前调一次。
export function selectPromptOverride(): PromptOverrideSelection | null {
  const state = usePetAssetsStore.getState();
  return pickPromptOverride(
    isCustomPresetActive(state),
    getActiveCategories(state).complete ?? [],
    getActivePreset(state).persona ?? null,
  );
}

/// 兼容老调用方：单纯拿 prompt string（不需要 source info）
export function getActivePromptOverride(): string | null {
  const sel = selectPromptOverride();
  return sel?.prompt ?? null;
}
