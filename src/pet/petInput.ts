import type {
  PetInputEvent,
  PetInputKey,
  PetMouseButton,
} from "../types/pet";

export type PetInputSource = "main" | "pet" | "global";

export interface PetInputMessage {
  source: PetInputSource;
  event: PetInputEvent;
}

type PetInputListener = (message: PetInputMessage) => void;

const KEY_BY_CODE: Readonly<Record<string, PetInputKey>> = Object.freeze({
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  KeyQ: "Q",
  KeyW: "W",
  KeyE: "E",
  KeyR: "R",
  KeyT: "T",
  KeyA: "A",
  KeyS: "S",
  KeyD: "D",
  KeyF: "F",
  KeyZ: "Z",
  KeyX: "X",
  KeyC: "C",
  KeyV: "V",
  Tab: "Tab",
  ShiftLeft: "Shift",
  ShiftRight: "Shift",
  ControlLeft: "Ctrl",
  ControlRight: "Ctrl",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Space: "Space",
});

const listeners = new Set<PetInputListener>();

function mouseButton(button: number): PetMouseButton | null {
  if (button === 0 || button === 1) return 0;
  return button === 2 ? 2 : null;
}

export class PetInputTracker {
  private readonly physicalKeys = new Map<string, PetInputKey>();
  private readonly logicalKeyCounts = new Map<PetInputKey, number>();
  private readonly physicalMouseButtons = new Map<number, PetMouseButton>();
  private readonly logicalMouseCounts = new Map<PetMouseButton, number>();

  keyDown(code: string, repeat = false): PetInputEvent | null {
    if (repeat || this.physicalKeys.has(code)) return null;
    const key = KEY_BY_CODE[code];
    if (!key) return null;
    this.physicalKeys.set(code, key);
    const count = this.logicalKeyCounts.get(key) ?? 0;
    this.logicalKeyCounts.set(key, count + 1);
    return count === 0 ? { type: "key-down", key } : null;
  }

  keyUp(code: string): PetInputEvent | null {
    const key = this.physicalKeys.get(code);
    if (!key) return null;
    this.physicalKeys.delete(code);
    const count = this.logicalKeyCounts.get(key) ?? 0;
    if (count > 1) {
      this.logicalKeyCounts.set(key, count - 1);
      return null;
    }
    this.logicalKeyCounts.delete(key);
    return { type: "key-up", key };
  }

  pointerDown(button: number, pointerType: string): PetInputEvent | null {
    if (pointerType !== "mouse" || this.physicalMouseButtons.has(button)) return null;
    const logicalButton = mouseButton(button);
    if (logicalButton === null) return null;
    this.physicalMouseButtons.set(button, logicalButton);
    const count = this.logicalMouseCounts.get(logicalButton) ?? 0;
    this.logicalMouseCounts.set(logicalButton, count + 1);
    return count === 0 ? { type: "mouse-down", button: logicalButton } : null;
  }

  pointerUp(button: number, pointerType: string): PetInputEvent | null {
    if (pointerType !== "mouse") return null;
    const logicalButton = this.physicalMouseButtons.get(button);
    if (logicalButton === undefined) return null;
    this.physicalMouseButtons.delete(button);
    const count = this.logicalMouseCounts.get(logicalButton) ?? 0;
    if (count > 1) {
      this.logicalMouseCounts.set(logicalButton, count - 1);
      return null;
    }
    this.logicalMouseCounts.delete(logicalButton);
    return { type: "mouse-up", button: logicalButton };
  }

  releaseMouse(): PetInputEvent[] {
    const events = Array.from(this.logicalMouseCounts.keys(), (button): PetInputEvent => ({
      type: "mouse-up",
      button,
    }));
    this.physicalMouseButtons.clear();
    this.logicalMouseCounts.clear();
    return events;
  }

  reset(): PetInputEvent {
    this.physicalKeys.clear();
    this.logicalKeyCounts.clear();
    this.physicalMouseButtons.clear();
    this.logicalMouseCounts.clear();
    return { type: "reset" };
  }
}

export function subscribePetInput(listener: PetInputListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishPetInput(source: PetInputSource, event: PetInputEvent): void {
  const message = { source, event } satisfies PetInputMessage;
  for (const listener of [...listeners]) listener(message);
}

export function publishPetInputResetAll(): void {
  publishPetInput("main", { type: "reset" });
  publishPetInput("pet", { type: "reset" });
  publishPetInput("global", { type: "reset" });
}

export function listenForWindowPetInput(dispatch: (event: PetInputEvent) => void): () => void {
  const tracker = new PetInputTracker();
  const emit = (event: PetInputEvent | null) => {
    if (event) dispatch(event);
  };
  const releaseMouse = () => {
    for (const event of tracker.releaseMouse()) dispatch(event);
  };
  const reset = () => dispatch(tracker.reset());
  const onKeyDown = (event: KeyboardEvent) => emit(tracker.keyDown(event.code, event.repeat));
  const onKeyUp = (event: KeyboardEvent) => emit(tracker.keyUp(event.code));
  const onPointerDown = (event: PointerEvent) => {
    emit(tracker.pointerDown(event.button, event.pointerType));
  };
  const onPointerUp = (event: PointerEvent) => {
    emit(tracker.pointerUp(event.button, event.pointerType));
  };
  const onPointerCancel = (event: PointerEvent) => {
    if (event.pointerType === "mouse") releaseMouse();
  };
  const onPointerOut = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.relatedTarget === null) releaseMouse();
  };
  const onPointerOver = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.buttons === 0) releaseMouse();
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") reset();
  };

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointerup", onPointerUp, true);
  window.addEventListener("pointercancel", onPointerCancel, true);
  window.addEventListener("pointerout", onPointerOut, true);
  window.addEventListener("pointerover", onPointerOver, true);
  window.addEventListener("lostpointercapture", releaseMouse, true);
  window.addEventListener("blur", reset);
  window.addEventListener("pagehide", reset);
  document.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointercancel", onPointerCancel, true);
    window.removeEventListener("pointerout", onPointerOut, true);
    window.removeEventListener("pointerover", onPointerOver, true);
    window.removeEventListener("lostpointercapture", releaseMouse, true);
    window.removeEventListener("blur", reset);
    window.removeEventListener("pagehide", reset);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    reset();
  };
}
