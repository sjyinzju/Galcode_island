interface PetSpeechBubbleProps {
  speech: string | null;
  taskTitle: string | null;
  runningCount: number;
  onOpenTask: (() => void) | null;
}

export function PetSpeechBubble({
  speech,
  taskTitle,
  runningCount,
  onOpenTask,
}: PetSpeechBubbleProps): JSX.Element | null {
  if (!speech && !taskTitle && runningCount === 0) return null;

  const content = speech ?? taskTitle ?? "";
  const body = (
    <>
      {runningCount > 1 && (
        <span className="pet-speech__count">{runningCount} 个任务</span>
      )}
      <span className="pet-speech__text">{content}</span>
      {taskTitle && speech && (
        <span className="pet-speech__task">{taskTitle}</span>
      )}
    </>
  );

  return onOpenTask ? (
    <button
      type="button"
      className="pet-speech pet-speech--interactive"
      onClick={onOpenTask}
      aria-label={`打开任务：${taskTitle ?? content}`}
    >
      {body}
    </button>
  ) : (
    <div className="pet-speech" role="status" aria-live="polite">
      {body}
    </div>
  );
}
