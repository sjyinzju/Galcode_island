import type { PetModelId } from "../types/pet";

export interface PetPointerDelta {
  readonly deltaX: number;
  readonly deltaY: number;
}

export interface PetFocusPoint {
  readonly x: number;
  readonly y: number;
}

export type PetFocusApplier = (x: number, y: number) => void;

function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}

function isValidDelta(delta: PetPointerDelta): boolean {
  return Number.isFinite(delta.deltaX)
    && Number.isInteger(delta.deltaX)
    && Number.isFinite(delta.deltaY)
    && Number.isInteger(delta.deltaY);
}

export class PetPointerFocusController {
  private accumulatedX = 0;
  private accumulatedY = 0;

  constructor(
    private readonly modelId: PetModelId,
    private readonly applyFocus: PetFocusApplier,
  ) {}

  handle(delta: PetPointerDelta, mirrored: boolean): PetFocusPoint | null {
    if (!isValidDelta(delta)) return null;

    if (this.modelId === "yuki") {
      this.accumulatedX = clamp(this.accumulatedX + 0.4 * delta.deltaX, 300);
      this.accumulatedY = clamp(this.accumulatedY + 0.4 * delta.deltaY, 300);
    } else {
      this.accumulatedX = clamp(this.accumulatedX + 0.4 * delta.deltaX, 360);
      this.accumulatedY = clamp(this.accumulatedY + 0.6 * delta.deltaY, 360);
    }

    return this.applyCurrent(mirrored);
  }

  applyCurrent(mirrored: boolean): PetFocusPoint {
    const point = this.current(mirrored);
    this.applyFocus(point.x, point.y);
    return point;
  }

  reset(mirrored: boolean): PetFocusPoint {
    this.accumulatedX = 0;
    this.accumulatedY = 0;
    return this.applyCurrent(mirrored);
  }

  private current(mirrored: boolean): PetFocusPoint {
    if (this.modelId === "yuki") {
      // Retain the original bundle's [-300, 300] accumulator and direction,
      // but keep magnitude continuous instead of routing through its fixed
      // 560x400 canvas and a transform-dependent public focus helper.
      return {
        x: this.accumulatedX === 0
          ? 0
          : (mirrored ? -1 : 1) * this.accumulatedX / 300,
        y: this.accumulatedY === 0 ? 0 : -this.accumulatedY / 300,
      };
    }

    return {
      x: this.accumulatedX === 0
        ? 0
        : (mirrored ? -1 : 1) * this.accumulatedX / 360,
      y: this.accumulatedY === 0 ? 0 : -this.accumulatedY / 360,
    };
  }
}
