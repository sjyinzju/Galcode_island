import { clampPetScale } from "./protocol";

export const PET_DRAG_THRESHOLD_PX = 5;
export const PET_POKE_COOLDOWN_MS = 5_000;
export const PET_SCALE_STEP = 0.1;

export interface PointerPoint {
  x: number;
  y: number;
}

export type PointerGesture = "poke" | "drag";

export function pointerDistance(start: PointerPoint, current: PointerPoint): number {
  return Math.hypot(current.x - start.x, current.y - start.y);
}

export function shouldStartPetDrag(
  start: PointerPoint,
  current: PointerPoint,
  threshold = PET_DRAG_THRESHOLD_PX,
): boolean {
  return pointerDistance(start, current) >= threshold;
}

export function classifyPetPointerGesture(
  start: PointerPoint,
  end: PointerPoint,
  nativeDragStarted: boolean,
): PointerGesture {
  return nativeDragStarted || shouldStartPetDrag(start, end) ? "drag" : "poke";
}

export function nextPetScale(current: number, wheelDeltaY: number): number {
  if (wheelDeltaY === 0) return clampPetScale(current);
  const direction = wheelDeltaY < 0 ? 1 : -1;
  return clampPetScale(current + direction * PET_SCALE_STEP);
}

export class PokeRequestGate {
  private lastStartedAt = Number.NEGATIVE_INFINITY;
  private latestToken = 0;

  constructor(private readonly cooldownMs = PET_POKE_COOLDOWN_MS) {}

  begin(now: number): number | null {
    if (now - this.lastStartedAt < this.cooldownMs) return null;
    this.lastStartedAt = now;
    this.latestToken += 1;
    return this.latestToken;
  }

  isCurrent(token: number): boolean {
    return token === this.latestToken;
  }

  invalidate(): void {
    this.latestToken += 1;
  }
}
