import type { AgentStatus } from "../types/agent";
import type { PetModelId, PetSnapshot, PetVisualState } from "../types/pet";

export const COMPLETE_HOLD_MS = 8_000;

const ACTIVE_STATUSES: ReadonlySet<AgentStatus> = new Set([
  "starting",
  "running",
  "thinking",
  "processing",
  "waitingApproval",
]);

export interface PetTaskPresentationInput {
  id: string;
  agentStatus: AgentStatus;
  lastActiveAt: number;
}

interface BuildPetSnapshotInput {
  seq: number;
  modelId: PetModelId;
  reducedMotion: boolean;
  tabs: Record<string, PetTaskPresentationInput>;
  now: number;
}

export function mapAgentStatusToPetVisualState(status: AgentStatus): PetVisualState {
  switch (status) {
    case "starting":
      return "starting";
    case "thinking":
      return "thinking";
    case "running":
    case "processing":
      return "working";
    case "waitingApproval":
      return "waiting";
    case "completed":
      return "complete";
    case "error":
      return "error";
    case "idle":
    default:
      return "idle";
  }
}

function effectiveVisualState(task: PetTaskPresentationInput, now: number): PetVisualState {
  const state = mapAgentStatusToPetVisualState(task.agentStatus);
  if (state === "complete" && now - task.lastActiveAt > COMPLETE_HOLD_MS) return "idle";
  return state;
}

function priorityFor(state: PetVisualState): number {
  switch (state) {
    case "waiting":
      return 5;
    case "error":
      return 4;
    case "starting":
    case "thinking":
    case "working":
      return 3;
    case "complete":
      return 2;
    case "idle":
    default:
      return 1;
  }
}

function speechFor(state: PetVisualState): string | null {
  switch (state) {
    case "waiting":
      return "有任务正在等待你的批准";
    case "error":
      return "任务遇到错误了";
    case "starting":
      return "正在启动任务";
    case "thinking":
      return "正在思考";
    case "working":
      return "正在处理任务";
    case "complete":
      return "任务完成啦";
    case "idle":
    default:
      return null;
  }
}

export function buildPetSnapshot(input: BuildPetSnapshotInput): PetSnapshot {
  const candidates = Object.values(input.tabs).map((task) => ({
    task,
    visualState: effectiveVisualState(task, input.now),
  }));
  candidates.sort((a, b) => {
    const priorityDiff = priorityFor(b.visualState) - priorityFor(a.visualState);
    if (priorityDiff !== 0) return priorityDiff;
    const activityDiff = b.task.lastActiveAt - a.task.lastActiveAt;
    if (activityDiff !== 0) return activityDiff;
    return a.task.id.localeCompare(b.task.id);
  });

  const selected = candidates[0] ?? null;
  const runningCount = candidates.reduce(
    (count, item) => count + (ACTIVE_STATUSES.has(item.task.agentStatus) ? 1 : 0),
    0,
  );

  return {
    version: 1,
    seq: input.seq,
    modelId: input.modelId,
    visualState: selected?.visualState ?? "idle",
    activeTaskId: selected?.task.id ?? null,
    activeTaskTitle: null,
    runningCount,
    speech: selected ? speechFor(selected.visualState) : null,
    reducedMotion: input.reducedMotion,
  };
}
