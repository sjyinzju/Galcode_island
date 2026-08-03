export interface LaunchMessage {
  visibleText: string;
  agentInput: string;
}

const ATTACHMENT_ONLY_AGENT_INPUT =
  "Please inspect the attached files and respond to this attachment-only message.";

export function resolveLaunchMessage(
  task: string,
  attachmentCount: number,
): LaunchMessage | null {
  const visibleText = task.trim();
  if (visibleText) return { visibleText, agentInput: visibleText };
  if (attachmentCount > 0) {
    return { visibleText: "", agentInput: ATTACHMENT_ONLY_AGENT_INPUT };
  }
  return null;
}
