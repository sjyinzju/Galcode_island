import { Channel, invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type {
  PetAction,
  PetSettingsSnapshot,
  PetSnapshot,
} from "../types/pet";
import {
  PetSnapshotReceiver,
  parsePetAction,
  parsePetBridgeEvent,
  parsePetSettingsSnapshot,
} from "./protocol";
import {
  publishPetInput,
  publishPetInputResetAll,
} from "./petInput";

export interface PetBridgeState {
  settings: PetSettingsSnapshot | null;
  snapshot: PetSnapshot | null;
  nativeVisible: boolean;
  error: string | null;
}

export interface PetBridgeApi extends PetBridgeState {
  retry: () => Promise<void>;
  sendAction: (action: PetAction) => Promise<void>;
  setClickThrough: (enabled: boolean) => Promise<void>;
}

type PetBridgeListener = () => void;

const listeners = new Set<PetBridgeListener>();
const snapshotReceiver = new PetSnapshotReceiver();

let bridgeState: PetBridgeState = {
  settings: null,
  snapshot: null,
  nativeVisible: false,
  error: null,
};
let activeChannel: Channel<unknown> | null = null;
let activeGeneration = 0;
let connected = false;
let connectionPromise: Promise<void> | null = null;
let attachmentQueue: Promise<void> = Promise.resolve();

function subscribePetBridge(listener: PetBridgeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getPetBridgeState(): PetBridgeState {
  return bridgeState;
}

function updatePetBridgeState(patch: Partial<PetBridgeState>): void {
  const next = { ...bridgeState, ...patch };
  if (
    next.settings === bridgeState.settings
    && next.snapshot === bridgeState.snapshot
    && next.nativeVisible === bridgeState.nativeVisible
    && next.error === bridgeState.error
  ) {
    return;
  }
  bridgeState = next;
  listeners.forEach((listener) => listener());
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : String(error).trim();
  if (message && /[\u3400-\u9fff]/u.test(message)) return message;
  console.error("[pet] bridge error", error);
  return message ? "桌宠桥接失败，请重试" : "桌宠桥接失败";
}

function synchronizeSnapshot(
  snapshot: PetSnapshot,
  settings: PetSettingsSnapshot | null,
): PetSnapshot {
  if (
    !settings
    || (snapshot.modelId === settings.modelId
      && snapshot.reducedMotion === settings.reducedMotion)
  ) {
    return snapshot;
  }
  return {
    ...snapshot,
    modelId: settings.modelId,
    reducedMotion: settings.reducedMotion,
  };
}

function applySettings(settings: PetSettingsSnapshot): void {
  if (bridgeState.settings && settings.revision < bridgeState.settings.revision) return;
  if (!settings.enabled) publishPetInputResetAll();
  updatePetBridgeState({
    settings,
    snapshot: bridgeState.snapshot
      ? synchronizeSnapshot(bridgeState.snapshot, settings)
      : null,
    error: null,
  });
}

function handleBridgeMessage(value: unknown, generation: number): void {
  if (generation !== activeGeneration) return;
  const event = parsePetBridgeEvent(value);
  if (!event) {
    publishPetInputResetAll();
    updatePetBridgeState({ error: "无效的桌宠桥接事件" });
    return;
  }
  switch (event.type) {
    case "reset":
      publishPetInput("main", { type: "reset" });
      snapshotReceiver.reset();
      updatePetBridgeState({ snapshot: null, error: null });
      break;
    case "settings":
      applySettings(event.payload);
      break;
    case "snapshot": {
      const snapshot = snapshotReceiver.accept(event.payload);
      if (snapshot) {
        updatePetBridgeState({
          snapshot: synchronizeSnapshot(snapshot, bridgeState.settings),
          error: null,
        });
      }
      break;
    }
    case "visibility":
      if (!event.payload) publishPetInputResetAll();
      updatePetBridgeState({ nativeVisible: event.payload, error: null });
      break;
    case "input":
      if (bridgeState.settings?.enabled && bridgeState.nativeVisible) {
        publishPetInput(event.payload.source, event.payload.event);
      }
      break;
  }
}

function startPetBridge(force: boolean): Promise<void> {
  if (!force && connected && activeChannel) return Promise.resolve();
  if (!force && connectionPromise) return connectionPromise;

  const generation = activeGeneration + 1;
  activeGeneration = generation;
  connected = false;
  publishPetInputResetAll();
  snapshotReceiver.reset();
  updatePetBridgeState({ snapshot: null, error: null });

  if (activeChannel) activeChannel.onmessage = () => {};
  const channel = new Channel<unknown>((message) => handleBridgeMessage(message, generation));
  activeChannel = channel;

  const pending = attachmentQueue.then(async () => {
    if (generation !== activeGeneration) return;
    try {
      await invoke<void>("pet_ready", { onEvent: channel });
      if (generation === activeGeneration) {
        connected = true;
        updatePetBridgeState({ error: null });
      }
    } catch (error) {
      if (generation === activeGeneration) {
        connected = false;
        publishPetInputResetAll();
        updatePetBridgeState({ error: errorMessage(error) });
      }
    }
  });
  attachmentQueue = pending;
  connectionPromise = pending.finally(() => {
    if (generation === activeGeneration) connectionPromise = null;
  });
  return connectionPromise;
}

async function sendAction(action: PetAction): Promise<void> {
  const validated = parsePetAction(action);
  if (!validated) {
    const error = new Error("无效的桌宠操作");
    updatePetBridgeState({ error: error.message });
    throw error;
  }
  try {
    await invoke<void>("pet_action", { action: validated });
    updatePetBridgeState({ error: null });
  } catch (error) {
    updatePetBridgeState({ error: errorMessage(error) });
    throw error;
  }
}

async function setClickThrough(enabled: boolean): Promise<void> {
  try {
    const value = await invoke<unknown>("set_pet_click_through", { enabled });
    const settings = parsePetSettingsSnapshot(value);
    if (!settings) throw new Error("无效的桌宠设置响应");
    applySettings(settings);
  } catch (error) {
    updatePetBridgeState({ error: errorMessage(error) });
    throw error;
  }
}

function retry(): Promise<void> {
  return startPetBridge(true);
}

export function usePetBridge(): PetBridgeApi {
  useEffect(() => {
    void startPetBridge(false);
  }, []);
  const state = useSyncExternalStore(
    subscribePetBridge,
    getPetBridgeState,
    getPetBridgeState,
  );
  return useMemo(() => ({
    ...state,
    retry,
    sendAction,
    setClickThrough,
  }), [state]);
}
