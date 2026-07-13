export type ExternalHistorySource = "codex" | "claude-code";

export interface ExternalSessionPreview {
  source: ExternalHistorySource;
  nativeSessionId: string;
  title: string;
  projectPath: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface ExternalSessionRef {
  source: ExternalHistorySource;
  nativeSessionId: string;
}

export type ImportedTranscriptPart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "image"; dataUrl: string; alt: string | null }
  | { type: "toolCall"; toolCallId: string | null; name: string; input: unknown }
  | { type: "toolResult"; toolCallId: string | null; output: unknown; isError: boolean }
  | { type: "event"; kind: string; data: unknown };

export interface ImportedTranscriptMessage {
  id: string;
  role: "user" | "assistant" | "developer" | "system" | "tool";
  content: string;
  parts?: ImportedTranscriptPart[];
  timestamp: number;
}

export interface ImportedConversationSummary {
  id: string;
  source: ExternalHistorySource;
  nativeSessionId: string;
  title: string;
  projectPath: string | null;
  createdAt: number;
  updatedAt: number;
  importedAt: number;
  messageCount: number;
}

export interface ImportedConversation extends ImportedConversationSummary {
  messages: ImportedTranscriptMessage[];
}

export interface ImportExternalSessionsResult {
  imported: ImportedConversationSummary[];
  skipped: string[];
  warnings: string[];
}

export function externalSessionKey(session: Pick<ExternalSessionRef, "source" | "nativeSessionId">): string {
  return `${session.source}:${session.nativeSessionId}`;
}

export function sourceLabel(source: ExternalHistorySource): string {
  return source === "codex" ? "Codex" : "Claude Code";
}
