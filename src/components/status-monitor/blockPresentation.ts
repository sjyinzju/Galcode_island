import type { CliBlock } from "../../types/blocks";

export type PromptCopyMode = "text" | "image" | "none";

export function getPromptCopyMode(block: CliBlock): PromptCopyMode {
  if (block.content?.trim()) return "text";
  if (block.images?.length) return "image";
  return "none";
}

export function requiresAttachmentEditWarning(block: CliBlock): boolean {
  return Boolean(block.images?.length || block.attachments?.length);
}

export function getTurnSpacing(current: CliBlock, next: CliBlock | undefined): number {
  if (!next) return 8;
  if (current.sourceTurnId && next.sourceTurnId) {
    return current.sourceTurnId === next.sourceTurnId ? 4 : 16;
  }
  if (current.sourceMessageId && next.sourceMessageId) {
    return current.sourceMessageId === next.sourceMessageId ? 4 : 12;
  }
  return 8;
}

export function sourceRoleLabel(role: string | undefined): string | null {
  switch (role?.toLowerCase()) {
    case "user":
      return "用户";
    case "assistant":
      return "助手";
    case "developer":
    case "system":
      return "内部上下文";
    case "tool":
      return "工具";
    default:
      return null;
  }
}

const SOURCE_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export function formatSourceTime(timestamp: number | undefined): string | null {
  if (!timestamp || !Number.isFinite(timestamp)) return null;
  return SOURCE_TIME_FORMATTER.format(timestamp);
}
