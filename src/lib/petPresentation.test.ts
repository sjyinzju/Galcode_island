import { describe, expect, it } from "vitest";
import type { AgentStatus } from "../types/agent";
import {
  COMPLETE_HOLD_MS,
  buildPetSnapshot,
  mapAgentStatusToPetVisualState,
  type PetTaskPresentationInput,
} from "./petPresentation";

function task(
  id: string,
  agentStatus: AgentStatus,
  lastActiveAt: number,
  patch: Partial<PetTaskPresentationInput> = {},
): PetTaskPresentationInput {
  return {
    id,
    agentStatus,
    lastActiveAt,
    ...patch,
  };
}

function snapshot(tabs: PetTaskPresentationInput[], now = 10_000) {
  return buildPetSnapshot({
    seq: 1,
    modelId: "haruhi",
    reducedMotion: false,
    tabs: Object.fromEntries(tabs.map((item) => [item.id, item])),
    now,
  });
}

describe("pet presentation", () => {
  it.each([
    ["idle", "idle"],
    ["starting", "starting"],
    ["running", "working"],
    ["thinking", "thinking"],
    ["processing", "working"],
    ["waitingApproval", "waiting"],
    ["completed", "complete"],
    ["error", "error"],
  ] satisfies [AgentStatus, string][])('%s maps to %s', (status, expected) => {
    expect(mapAgentStatusToPetVisualState(status)).toBe(expected);
  });

  it("enforces waiting > error > working > completed > idle", () => {
    const result = snapshot([
      task("idle", "idle", 9_999),
      task("done", "completed", 9_998),
      task("work", "running", 9_997),
      task("error", "error", 9_996),
      task("approval", "waitingApproval", 9_000),
    ]);
    expect(result.activeTaskId).toBe("approval");
    expect(result.visualState).toBe("waiting");
  });

  it("uses the most recently updated task for equal priority", () => {
    const result = snapshot([
      task("older", "processing", 8_000),
      task("newer", "thinking", 9_000),
    ]);
    expect(result.activeTaskId).toBe("newer");
    expect(result.visualState).toBe("thinking");
  });

  it("counts all active tasks including approvals", () => {
    const result = snapshot([
      task("one", "starting", 1),
      task("two", "running", 2),
      task("three", "waitingApproval", 3),
      task("done", "completed", 4),
    ]);
    expect(result.runningCount).toBe(3);
  });

  it("lets completed presentation fall back after the hold time", () => {
    const completedAt = 1_000;
    expect(snapshot([task("done", "completed", completedAt)], completedAt + COMPLETE_HOLD_MS).visualState)
      .toBe("complete");
    expect(snapshot([task("done", "completed", completedAt)], completedAt + COMPLETE_HOLD_MS + 1).visualState)
      .toBe("idle");
  });

  it.each([
    ["idle", null],
    ["starting", "正在启动任务"],
    ["thinking", "正在思考"],
    ["running", "正在处理任务"],
    ["processing", "正在处理任务"],
    ["waitingApproval", "有任务正在等待你的批准"],
    ["completed", "任务完成啦"],
    ["error", "任务遇到错误了"],
  ] satisfies [AgentStatus, string | null][])(
    "%s uses a fixed status phrase",
    (status, expected) => {
      expect(snapshot([task("safe-id", status, 9_000)]).speech).toBe(expected);
    },
  );

  it.each([
    ["thinking", "正在思考"],
    ["running", "正在处理任务"],
    ["completed", "任务完成啦"],
    ["error", "任务遇到错误了"],
  ] satisfies [AgentStatus, string][])(
    "does not forward task, tool, error, or LLM text for %s",
    (status, expectedSpeech) => {
      const secret = `PRIVATE_${status}_TOKEN`;
      const unsafeTask = {
        ...task("safe-id", status, 9_000),
        title: `${secret}_TITLE`,
        bubble: `${secret}_TOOL_OR_ERROR`,
        emotionText: `${secret}_LLM_EMOTION`,
      };
      const result = snapshot([unsafeTask]);

      expect(result.activeTaskId).toBe("safe-id");
      expect(result.activeTaskTitle).toBeNull();
      expect(result.speech).toBe(expectedSpeech);
      expect(JSON.stringify(result)).not.toContain(secret);
    },
  );
});
