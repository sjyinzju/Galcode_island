import type {
  PetInputEvent,
  PetInputKey,
  PetModelId,
  PetMouseButton,
} from "../types/pet";
import type { PetInputSource } from "./petInput";

type KeyPosition = readonly [x: number, y: number];
type KeyPositions = Readonly<Partial<Record<PetInputKey, KeyPosition>>>;

const KEY_POSITIONS: Readonly<Record<PetModelId, KeyPositions>> = Object.freeze({
  haruhi: {
    "1": [12, 17], "2": [6, 14], "3": [-3, 18], "4": [-26, 26],
    Q: [20, -2], W: [15, -1], E: [8, -2], R: [1, 0], T: [-21, 8],
    A: [23, -18], S: [9, -17], D: [1, -14], F: [-10, -10],
    Z: [17, -30], X: [8, -30], C: [-2, -27], V: [-15, -30],
    Tab: [27, 27], Shift: [30, -5], Ctrl: [30, -24],
    Enter: [-30, 1], Space: [-30, -28],
  },
  mikuru: {
    "1": [14, 30], "2": [6, 30], "3": [-5.5, 30], "4": [-16.5, 21.3], "5": [-26.7, 17],
    Q: [15.5, 0], W: [7, 2.2], E: [-2.2, 4.8], R: [-13, -1], T: [-23, -1],
    A: [17, -14], S: [8, -14], D: [-2, -12], F: [-15, -15],
    Z: [24, -30], X: [10, -30], C: [-2, -26], V: [-13, -30],
    Tab: [26, 20], Shift: [26, -1], Ctrl: [30, -17],
    Enter: [-30, -18], Space: [-30, -28],
  },
  yuki: {
    W: [-9, 30], A: [2, 8], S: [-16, 6], D: [-30, 4],
    Enter: [30, 24], Ctrl: [30, -4], Z: [18, 2], Space: [-28, -28],
  },
});

export interface PetParameterWriter {
  setParameterValueById(parameterId: string, value: number): void;
}

export class PetInputParameterController {
  private readonly keysBySource: Record<PetInputSource, Set<PetInputKey>> = {
    main: new Set(),
    pet: new Set(),
    global: new Set(),
  };
  private readonly mouseBySource: Record<PetInputSource, Set<PetMouseButton>> = {
    main: new Set(),
    pet: new Set(),
    global: new Set(),
  };
  private readonly keyTimers = new Map<PetInputKey, ReturnType<typeof setTimeout>>();
  private readonly heldWrites = new Map<string, number>();
  private readonly pendingWrites = new Map<string, number>();
  private readonly positions: KeyPositions;
  private disposed = false;

  constructor(
    modelId: PetModelId,
    private readonly writer: PetParameterWriter,
    private readonly onChange: () => void = () => undefined,
  ) {
    this.positions = KEY_POSITIONS[modelId];
  }

  handle(source: PetInputSource, event: PetInputEvent): void {
    if (this.disposed) return;
    switch (event.type) {
      case "key-down":
        this.keyDown(source, event.key);
        break;
      case "key-up":
        this.keyUp(source, event.key);
        break;
      case "mouse-down":
        this.mouseDown(source, event.button);
        break;
      case "mouse-up":
        this.mouseUp(source, event.button);
        break;
      case "mouse-move":
        break;
      case "reset":
        this.resetSource(source);
        break;
    }
    this.onChange();
  }

  flush(): void {
    if (this.disposed) return;
    for (const [parameterId, value] of this.heldWrites) {
      this.writer.setParameterValueById(parameterId, value);
    }
    for (const [parameterId, value] of this.pendingWrites) {
      this.writer.setParameterValueById(parameterId, value);
    }
    this.pendingWrites.clear();
  }

  resetAll(): void {
    if (this.disposed) return;
    this.clearTimers();
    this.heldWrites.clear();
    this.pendingWrites.clear();
    this.keysBySource.main.clear();
    this.keysBySource.pet.clear();
    this.keysBySource.global.clear();
    this.mouseBySource.main.clear();
    this.mouseBySource.pet.clear();
    this.mouseBySource.global.clear();
    for (const key of Object.keys(this.positions) as PetInputKey[]) {
      this.writeOnce(`ParamKey${key}`, 0);
    }
    this.writeOnce("ParamMouse0", 0);
    this.writeOnce("ParamMouse2", 0);
    this.writeOnce("ParamKeyboardX", 0);
    this.writeOnce("ParamKeyboardY", 0);
    this.onChange();
  }

  dispose(): void {
    if (this.disposed) return;
    this.resetAll();
    this.disposed = true;
  }

  private keyDown(source: PetInputSource, key: PetInputKey): void {
    const sourceKeys = this.keysBySource[source];
    if (sourceKeys.has(key)) return;
    const alreadyHeld = this.isKeyHeld(key);
    sourceKeys.add(key);
    if (alreadyHeld) return;

    const position = this.positions[key];
    if (!position) {
      this.writeCursor(0, 0);
      return;
    }

    const [x, y] = position;
    this.writeHeld("ParamKeyboardX", x - 2);
    this.writeHeld("ParamKeyboardY", y - 4);
    this.clearKeyTimer(key);
    const timer = setTimeout(() => {
      this.keyTimers.delete(key);
      if (this.disposed || !this.isKeyHeld(key)) return;
      this.writeHeld("ParamKeyboardX", x);
      this.writeHeld("ParamKeyboardY", y);
      this.writeHeld(`ParamKey${key}`, 1);
      this.onChange();
    }, 50);
    this.keyTimers.set(key, timer);
  }

  private keyUp(source: PetInputSource, key: PetInputKey): void {
    const sourceKeys = this.keysBySource[source];
    if (!sourceKeys.delete(key) || this.isKeyHeld(key)) return;
    this.releaseKey(key, true);
  }

  private releaseKey(key: PetInputKey, applyOffset: boolean): void {
    this.clearKeyTimer(key);
    const position = this.positions[key];
    if (!position) return;
    this.writeOnce(`ParamKey${key}`, 0);
    if (applyOffset) {
      this.writeCursor(position[0] - 2, position[1] - 4);
    }
  }

  private mouseDown(source: PetInputSource, button: PetMouseButton): void {
    const sourceButtons = this.mouseBySource[source];
    if (sourceButtons.has(button)) return;
    const alreadyHeld = this.isMouseHeld(button);
    sourceButtons.add(button);
    if (!alreadyHeld) this.writeHeld(`ParamMouse${button}`, 1);
  }

  private mouseUp(source: PetInputSource, button: PetMouseButton): void {
    if (!this.mouseBySource[source].delete(button) || this.isMouseHeld(button)) return;
    this.writeOnce(`ParamMouse${button}`, 0);
  }

  private resetSource(source: PetInputSource): void {
    const keys = [...this.keysBySource[source]];
    this.keysBySource[source].clear();
    for (const key of keys) {
      if (!this.isKeyHeld(key)) this.releaseKey(key, false);
    }

    const buttons = [...this.mouseBySource[source]];
    this.mouseBySource[source].clear();
    for (const button of buttons) {
      if (!this.isMouseHeld(button)) {
        this.writeOnce(`ParamMouse${button}`, 0);
      }
    }

    if (!this.hasMappedHeldKeys()) {
      this.writeOnce("ParamKeyboardX", 0);
      this.writeOnce("ParamKeyboardY", 0);
    }
  }

  private isKeyHeld(key: PetInputKey): boolean {
    return this.keysBySource.main.has(key)
      || this.keysBySource.pet.has(key)
      || this.keysBySource.global.has(key);
  }

  private isMouseHeld(button: PetMouseButton): boolean {
    return this.mouseBySource.main.has(button)
      || this.mouseBySource.pet.has(button)
      || this.mouseBySource.global.has(button);
  }

  private hasMappedHeldKeys(): boolean {
    return ([
      ...this.keysBySource.main,
      ...this.keysBySource.pet,
      ...this.keysBySource.global,
    ] as PetInputKey[])
      .some((key) => this.positions[key] !== undefined);
  }

  private writeCursor(x: number, y: number): void {
    if (this.hasMappedHeldKeys()) {
      this.writeHeld("ParamKeyboardX", x);
      this.writeHeld("ParamKeyboardY", y);
    } else {
      this.writeOnce("ParamKeyboardX", x);
      this.writeOnce("ParamKeyboardY", y);
    }
  }

  private writeHeld(parameterId: string, value: number): void {
    this.pendingWrites.delete(parameterId);
    this.heldWrites.set(parameterId, value);
    this.writer.setParameterValueById(parameterId, value);
  }

  private writeOnce(parameterId: string, value: number): void {
    this.heldWrites.delete(parameterId);
    this.pendingWrites.set(parameterId, value);
    this.writer.setParameterValueById(parameterId, value);
  }

  private clearKeyTimer(key: PetInputKey): void {
    const timer = this.keyTimers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.keyTimers.delete(key);
  }

  private clearTimers(): void {
    for (const timer of this.keyTimers.values()) clearTimeout(timer);
    this.keyTimers.clear();
  }
}
