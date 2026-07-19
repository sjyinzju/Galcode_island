import {
  DEFAULT_DESKTOP_PET_SETTINGS,
  PET_INPUT_KEYS,
  PET_MODEL_IDS,
  PET_VISUAL_STATES,
  type DesktopPetSettings,
  type PetAction,
  type PetBridgeInput,
  type PetBridgeEvent,
  type PetInputEvent,
  type PetInputKey,
  type PetModelId,
  type PetSettingsSnapshot,
  type PetSnapshot,
  type PetVisualState,
} from "../types/pet";

export const PET_PROTOCOL_VERSION = 1 as const;
export const PET_SCALE_MIN = 0.6;
export const PET_SCALE_MAX = 1.8;
export const PET_TASK_ID_MAX_LENGTH = 128;
export const PET_TASK_TITLE_MAX_LENGTH = 80;
export const PET_SPEECH_MAX_LENGTH = 160;

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isSafeSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isI32(value: unknown): value is number {
  return Number.isInteger(value)
    && (value as number) >= -2_147_483_648
    && (value as number) <= 2_147_483_647;
}

function isOptionalBoundedString(value: unknown, maxLength: number): value is string | null {
  return value === null || (typeof value === "string" && value.length <= maxLength);
}

export function isPetModelId(value: unknown): value is PetModelId {
  return typeof value === "string" && (PET_MODEL_IDS as readonly string[]).includes(value);
}

export function isPetVisualState(value: unknown): value is PetVisualState {
  return typeof value === "string" && (PET_VISUAL_STATES as readonly string[]).includes(value);
}

export function isPetInputKey(value: unknown): value is PetInputKey {
  return typeof value === "string" && (PET_INPUT_KEYS as readonly string[]).includes(value);
}

export function parsePetInputEvent(value: unknown): PetInputEvent | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "key-down":
    case "key-up":
      return hasOnlyKeys(value, ["type", "key"]) && isPetInputKey(value.key)
        ? { type: value.type, key: value.key }
        : null;
    case "mouse-down":
    case "mouse-up":
      return hasOnlyKeys(value, ["type", "button"]) && (value.button === 0 || value.button === 2)
        ? { type: value.type, button: value.button }
        : null;
    case "mouse-move":
      return hasOnlyKeys(value, ["type", "deltaX", "deltaY"])
        && isI32(value.deltaX)
        && isI32(value.deltaY)
        ? { type: value.type, deltaX: value.deltaX, deltaY: value.deltaY }
        : null;
    case "reset":
      return hasOnlyKeys(value, ["type"]) ? { type: "reset" } : null;
    default:
      return null;
  }
}

function parsePetBridgeInput(value: unknown): PetBridgeInput | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["source", "event"])) return null;
  if (value.source !== "main" && value.source !== "global") return null;
  const event = parsePetInputEvent(value.event);
  return event ? { source: value.source, event } : null;
}

export function isPetTaskId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= PET_TASK_ID_MAX_LENGTH
    && TASK_ID_PATTERN.test(value);
}

export function clampPetScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DESKTOP_PET_SETTINGS.scale;
  return Math.round(Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, value)) * 100) / 100;
}

export function normalizeDesktopPetSettings(value: unknown): DesktopPetSettings {
  const input = isRecord(value) ? value : {};
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULT_DESKTOP_PET_SETTINGS.enabled,
    modelId: isPetModelId(input.modelId) ? input.modelId : DEFAULT_DESKTOP_PET_SETTINGS.modelId,
    showOnStartup: typeof input.showOnStartup === "boolean"
      ? input.showOnStartup
      : DEFAULT_DESKTOP_PET_SETTINGS.showOnStartup,
    alwaysOnTop: typeof input.alwaysOnTop === "boolean"
      ? input.alwaysOnTop
      : DEFAULT_DESKTOP_PET_SETTINGS.alwaysOnTop,
    clickThrough: typeof input.clickThrough === "boolean"
      ? input.clickThrough
      : DEFAULT_DESKTOP_PET_SETTINGS.clickThrough,
    scale: typeof input.scale === "number"
      ? clampPetScale(input.scale)
      : DEFAULT_DESKTOP_PET_SETTINGS.scale,
    reducedMotion: typeof input.reducedMotion === "boolean"
      ? input.reducedMotion
      : DEFAULT_DESKTOP_PET_SETTINGS.reducedMotion,
    mirror: typeof input.mirror === "boolean" ? input.mirror : DEFAULT_DESKTOP_PET_SETTINGS.mirror,
  };
}

export function parsePetSnapshot(value: unknown): PetSnapshot | null {
  if (!isRecord(value)) return null;
  if (value.version !== PET_PROTOCOL_VERSION || !isSafeSequence(value.seq)) return null;
  if (!isPetModelId(value.modelId) || !isPetVisualState(value.visualState)) return null;
  if (!isOptionalBoundedString(value.activeTaskTitle, PET_TASK_TITLE_MAX_LENGTH)) return null;
  if (!isOptionalBoundedString(value.speech, PET_SPEECH_MAX_LENGTH)) return null;
  if (value.activeTaskId !== null && !isPetTaskId(value.activeTaskId)) return null;
  if (value.activeTaskId === null && value.activeTaskTitle !== null) return null;
  if (!Number.isInteger(value.runningCount) || (value.runningCount as number) < 0 || (value.runningCount as number) > 999) {
    return null;
  }
  if (typeof value.reducedMotion !== "boolean") return null;

  return {
    version: PET_PROTOCOL_VERSION,
    seq: value.seq,
    modelId: value.modelId,
    visualState: value.visualState,
    activeTaskId: value.activeTaskId,
    activeTaskTitle: value.activeTaskTitle,
    runningCount: value.runningCount as number,
    speech: value.speech,
    reducedMotion: value.reducedMotion,
  };
}

export function parsePetSettingsSnapshot(value: unknown): PetSettingsSnapshot | null {
  if (!isRecord(value) || value.version !== PET_PROTOCOL_VERSION || !isSafeSequence(value.revision)) {
    return null;
  }
  const normalized = normalizeDesktopPetSettings(value);
  if (
    normalized.enabled !== value.enabled
    || normalized.modelId !== value.modelId
    || normalized.showOnStartup !== value.showOnStartup
    || normalized.alwaysOnTop !== value.alwaysOnTop
    || normalized.clickThrough !== value.clickThrough
    || normalized.scale !== value.scale
    || normalized.reducedMotion !== value.reducedMotion
    || normalized.mirror !== value.mirror
  ) {
    return null;
  }
  return { version: PET_PROTOCOL_VERSION, revision: value.revision, ...normalized };
}

export function parsePetAction(value: unknown): PetAction | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "ready":
    case "poke":
    case "drag-ended":
    case "show-main":
    case "hide":
    case "reset-position":
      return { type: value.type };
    case "open-task":
      return value.taskId === null || isPetTaskId(value.taskId)
        ? { type: value.type, taskId: value.taskId }
        : null;
    case "set-model":
      return isPetModelId(value.modelId) ? { type: value.type, modelId: value.modelId } : null;
    case "set-scale":
      return typeof value.scale === "number" && clampPetScale(value.scale) === value.scale
        ? { type: value.type, scale: value.scale }
        : null;
    case "set-always-on-top":
    case "set-click-through":
    case "set-enabled":
    case "set-mirror":
      return typeof value.enabled === "boolean" ? { type: value.type, enabled: value.enabled } : null;
    default:
      return null;
  }
}

export function parsePetBridgeEvent(value: unknown): PetBridgeEvent | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "reset":
      return "payload" in value ? null : { type: "reset" };
    case "settings": {
      const payload = parsePetSettingsSnapshot(value.payload);
      return payload ? { type: "settings", payload } : null;
    }
    case "snapshot": {
      const payload = parsePetSnapshot(value.payload);
      return payload ? { type: "snapshot", payload } : null;
    }
    case "visibility":
      return typeof value.payload === "boolean"
        ? { type: "visibility", payload: value.payload }
        : null;
    case "input": {
      if (!hasOnlyKeys(value, ["type", "payload"])) return null;
      const payload = parsePetBridgeInput(value.payload);
      return payload ? { type: "input", payload } : null;
    }
    default:
      return null;
  }
}

export class PetSnapshotReceiver {
  private latestSeq = 0;

  accept(value: unknown): PetSnapshot | null {
    const snapshot = parsePetSnapshot(value);
    if (!snapshot || snapshot.seq <= this.latestSeq) return null;
    this.latestSeq = snapshot.seq;
    return snapshot;
  }

  getLatestSeq(): number {
    return this.latestSeq;
  }

  reset(): void {
    this.latestSeq = 0;
  }
}
