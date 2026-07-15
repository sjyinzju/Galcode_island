import { describe, expect, it, vi } from "vitest";
import { runExclusive } from "./runExclusive";

describe("runExclusive", () => {
  it("ignores a second action while the first action is waiting", async () => {
    let finishFirst: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const operation = vi.fn(() => pending);
    const lock = { current: false };

    const first = runExclusive(lock, operation);
    const second = runExclusive(lock, operation);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(lock.current).toBe(true);
    await second;
    finishFirst?.();
    await first;
    expect(lock.current).toBe(false);

    await runExclusive(lock, operation);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("releases the action after an error", async () => {
    const lock = { current: false };

    await expect(runExclusive(lock, async () => {
      throw new Error("failed");
    })).rejects.toThrow("failed");

    expect(lock.current).toBe(false);
  });
});
