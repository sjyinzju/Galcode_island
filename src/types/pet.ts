export const PET_MODEL_IDS = ["haruhi", "mikuru", "yuki"] as const;
export type PetModelId = (typeof PET_MODEL_IDS)[number];

export const PET_VISUAL_STATES = [
  "idle",
  "starting",
  "thinking",
  "working",
  "waiting",
  "complete",
  "error",
] as const;
export type PetVisualState = (typeof PET_VISUAL_STATES)[number];

export const PET_SEMANTIC_ACTIONS = [
  "idle",
  "hello",
  "thinking",
  "working",
  "waiting",
  "complete",
  "error",
  "poke",
  "hide",
  "flip",
] as const;
export type PetSemanticAction = (typeof PET_SEMANTIC_ACTIONS)[number];

export interface DesktopPetSettings {
  enabled: boolean;
  modelId: PetModelId;
  showOnStartup: boolean;
  alwaysOnTop: boolean;
  clickThrough: boolean;
  scale: number;
  reducedMotion: boolean;
  mirror: boolean;
}

export const DEFAULT_DESKTOP_PET_SETTINGS: Readonly<DesktopPetSettings> = Object.freeze({
  enabled: true,
  modelId: "haruhi",
  showOnStartup: true,
  alwaysOnTop: true,
  clickThrough: false,
  scale: 1,
  reducedMotion: false,
  mirror: false,
});

export interface PetSnapshot {
  version: 1;
  seq: number;
  modelId: PetModelId;
  visualState: PetVisualState;
  activeTaskId: string | null;
  activeTaskTitle: string | null;
  runningCount: number;
  speech: string | null;
  reducedMotion: boolean;
}

export interface PetSettingsSnapshot extends DesktopPetSettings {
  version: 1;
  revision: number;
}

export type PetAction =
  | { type: "ready" }
  | { type: "poke" }
  | { type: "open-task"; taskId: string | null }
  | { type: "drag-ended" }
  | { type: "show-main" }
  | { type: "hide" }
  | { type: "reset-position" }
  | { type: "set-enabled"; enabled: boolean }
  | { type: "set-model"; modelId: PetModelId }
  | { type: "set-scale"; scale: number }
  | { type: "set-always-on-top"; enabled: boolean }
  | { type: "set-click-through"; enabled: boolean }
  | { type: "set-mirror"; enabled: boolean };

export const PET_INPUT_KEYS = [
  "1", "2", "3", "4", "5",
  "Q", "W", "E", "R", "T",
  "A", "S", "D", "F",
  "Z", "X", "C", "V",
  "Tab", "Shift", "Ctrl", "Enter", "Space",
] as const;
export type PetInputKey = (typeof PET_INPUT_KEYS)[number];

export type PetMouseButton = 0 | 2;

export type PetInputEvent =
  | { type: "key-down"; key: PetInputKey }
  | { type: "key-up"; key: PetInputKey }
  | { type: "mouse-down"; button: PetMouseButton }
  | { type: "mouse-up"; button: PetMouseButton }
  | { type: "mouse-move"; deltaX: number; deltaY: number }
  | { type: "reset" };

export type PetBridgeInputSource = "main" | "global";

export interface PetBridgeInput {
  source: PetBridgeInputSource;
  event: PetInputEvent;
}

export type PetBridgeEvent =
  | { type: "reset" }
  | { type: "settings"; payload: PetSettingsSnapshot }
  | { type: "snapshot"; payload: PetSnapshot }
  | { type: "visibility"; payload: boolean }
  | { type: "input"; payload: PetBridgeInput };

export const PET_EVENTS = Object.freeze({
  action: "pet://action",
} as const);
