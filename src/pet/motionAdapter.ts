import type { PetSemanticAction } from "../types/pet";
import type { PetModelDefinition, PetMotionFallback } from "./modelDefinitions";

export interface ResolvedPetMotion {
  action: PetSemanticAction;
  enterGroup: string | null;
  loopGroup: string | null;
  exitGroup: string | null;
  fallback: PetMotionFallback;
}

export interface ResolvedPetMotionStep {
  phase: "exit" | "enter" | "loop";
  group: string;
}

export type PetTickerPhase = "steady" | "action";

export const PET_STEADY_MAX_FPS = 24;
export const PET_ACTION_MAX_FPS = 60;

function pickGroup(groups: readonly string[] | undefined, sample: number): string | null {
  if (!groups || groups.length === 0) return null;
  const normalized = Number.isFinite(sample) ? Math.min(0.999_999, Math.max(0, sample)) : 0;
  return groups[Math.floor(normalized * groups.length)] ?? groups[0] ?? null;
}

export function resolvePetMotion(
  definition: PetModelDefinition,
  action: PetSemanticAction,
  sample = 0,
): ResolvedPetMotion {
  const motion = definition.motions[action];
  return {
    action,
    enterGroup: pickGroup(motion?.enter, sample),
    loopGroup: pickGroup(motion?.loop, sample),
    exitGroup: pickGroup(motion?.exit, sample),
    fallback: motion?.fallback ?? "idle",
  };
}

export function resolvePetMotionSteps(
  previous: ResolvedPetMotion | null,
  current: ResolvedPetMotion,
): ResolvedPetMotionStep[] {
  const steps: ResolvedPetMotionStep[] = [];
  if (previous?.exitGroup) steps.push({ phase: "exit", group: previous.exitGroup });
  if (current.enterGroup) steps.push({ phase: "enter", group: current.enterGroup });
  if (current.loopGroup) steps.push({ phase: "loop", group: current.loopGroup });
  return steps;
}

export function resolvePetTickerPolicy(options: {
  nativeVisible: boolean;
  pageVisible: boolean;
  hasModel: boolean;
  reducedMotion: boolean;
  phase: PetTickerPhase;
}): { running: boolean; maxFPS: number } {
  return {
    running: options.nativeVisible
      && options.pageVisible
      && options.hasModel
      && !options.reducedMotion,
    maxFPS: options.phase === "action" ? PET_ACTION_MAX_FPS : PET_STEADY_MAX_FPS,
  };
}
