import type { CliBlock } from "../types/blocks";
import type {
  ImportedConversation,
  ImportedTranscriptMessage,
  ImportedTranscriptPart,
} from "../types/externalHistory";

const INTERRUPTED_MESSAGE_PATTERN =
  /^\[Request interrupted by user(?: for tool use)?\]$/i;
const CONTEXT_ONLY_PREFIXES = [
  "# AGENTS.md",
  "# CLAUDE.md",
  "<recommended_plugins",
  "<codex_internal_context",
  "<turn_aborted",
  "<subagent_notification",
  "<environment_context",
  "<permissions instructions",
  "<local-command-caveat",
  "<local-command-name",
  "<local-command-stdout",
  "<task-notification>",
] as const;

const OPAQUE_THINKING_KINDS = new Set(["thinking", "reasoning"]);

const IMAGE_DATA_PLACEHOLDER = "[Image data omitted]";
const TOOL_DETAIL_PREVIEW_LENGTH = 4_000;
const IMPORTED_PREVIEW_MAX_NODES = 512;
const IMPORTED_PREVIEW_MAX_DEPTH = 12;
const IMPORTED_PREVIEW_MAX_COLLECTION_ITEMS = 64;

export function formatImportedValue(value: unknown, maxLength = Number.POSITIVE_INFINITY): string {
  let serialized: string;
  if (typeof value === "string") {
    serialized = value.startsWith("data:image/") ? IMAGE_DATA_PLACEHOLDER : value;
  } else {
    try {
      serialized = JSON.stringify(value, function replaceImageData(key, nestedValue) {
        if (typeof nestedValue !== "string") return nestedValue;
        const container = this as Record<string, unknown>;
        return nestedValue.startsWith("data:image/") ||
          (key === "data" && container.type === "base64")
          ? IMAGE_DATA_PLACEHOLDER
          : nestedValue;
      }, 2) ?? "";
      if (!serialized) return "";
    } catch {
      serialized = String(value);
    }
  }
  return serialized.length > maxLength
    ? `${serialized.slice(0, maxLength)}...`
    : serialized;
}

interface ImportedPreviewBudget {
  remaining: number;
  nodes: number;
}

function boundedImportedValue(
  value: unknown,
  budget: ImportedPreviewBudget,
  seen: WeakSet<object>,
  depth = 0,
): unknown {
  if (budget.remaining <= 0 || budget.nodes <= 0 || depth >= IMPORTED_PREVIEW_MAX_DEPTH) {
    return "...";
  }
  budget.nodes -= 1;
  if (typeof value === "string") {
    if (value.startsWith("data:image/")) return IMAGE_DATA_PLACEHOLDER;
    const length = Math.min(value.length, budget.remaining);
    budget.remaining -= length;
    return length < value.length ? `${value.slice(0, length)}...` : value;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    budget.remaining -= String(value).length;
    return value;
  }
  if (typeof value === "bigint") {
    const text = `${value.toString()}n`;
    budget.remaining -= Math.min(text.length, budget.remaining);
    return text;
  }
  if (typeof value !== "object") {
    const text = String(value);
    budget.remaining -= Math.min(text.length, budget.remaining);
    return text;
  }
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    const count = Math.min(value.length, IMPORTED_PREVIEW_MAX_COLLECTION_ITEMS);
    for (let index = 0; index < count; index += 1) {
      if (budget.remaining <= 0 || budget.nodes <= 0) break;
      result.push(boundedImportedValue(value[index], budget, seen, depth + 1));
    }
    if (count < value.length || result.length < count) result.push("...");
    return result;
  }

  const result: Record<string, unknown> = {};
  let keyCount = 0;
  let truncated = false;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (
      budget.remaining <= 0 ||
      budget.nodes <= 0 ||
      keyCount >= IMPORTED_PREVIEW_MAX_COLLECTION_ITEMS
    ) {
      truncated = true;
      break;
    }
    keyCount += 1;
    const keyLength = Math.min(key.length, budget.remaining, 512);
    const displayKey = keyLength < key.length ? `${key.slice(0, keyLength)}...` : key;
    budget.remaining -= keyLength;
    result[displayKey] = boundedImportedValue(
      (value as Record<string, unknown>)[key],
      budget,
      seen,
      depth + 1,
    );
  }
  if (truncated) result["..."] = "...";
  return result;
}

export function formatImportedValuePreview(
  value: unknown,
  maxLength = TOOL_DETAIL_PREVIEW_LENGTH,
): string {
  if (typeof value === "string") return formatImportedValue(value, maxLength);
  const bounded = boundedImportedValue(value, {
    remaining: maxLength,
    nodes: IMPORTED_PREVIEW_MAX_NODES,
  }, new WeakSet());
  return formatImportedValue(bounded, maxLength);
}

function compactEventValue(value: unknown): string {
  return formatImportedValuePreview(value, 4_000);
}

export function formatImportedThinking(text: string): string {
  const normalized = text.trim().replace(/^thinking:\s*/i, "");
  if (!normalized.startsWith("{")) return text;
  try {
    const parsed = JSON.parse(normalized) as unknown;
    const readable = readableThinkingValue(parsed);
    if (readable) return readable;
  } catch {
    // Fall through to the signature check for truncated legacy payloads.
  }
  return normalized.includes('"signature"') ? "Thinking" : text;
}

export function isOpaqueThinkingEvent(part: ImportedTranscriptPart): boolean {
  return part.type === "event" &&
    OPAQUE_THINKING_KINDS.has(part.kind.toLowerCase()) &&
    readableThinkingEventText(part) === null;
}

function readableThinkingValue(value: unknown, depth = 0): string | null {
  if (depth > 3 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || (text.startsWith("{") && text.includes('"signature"'))) return null;
    return text;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = readableThinkingValue(item, depth + 1);
      if (text) return text;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["reasoning", "thinking", "text", "summary", "content"]) {
    const text = readableThinkingValue(record[key], depth + 1);
    if (text) return text;
  }
  return null;
}

function readableThinkingEventText(part: ImportedTranscriptPart): string | null {
  return part.type === "event" && OPAQUE_THINKING_KINDS.has(part.kind.toLowerCase())
    ? readableThinkingValue(part.data)
    : null;
}

interface ImportedBlockContext {
  conversationId: string;
  message: ImportedTranscriptMessage;
  turnId: string;
}

function withImportedSource(block: CliBlock, context: ImportedBlockContext): CliBlock {
  return {
    ...block,
    sourceMessageId: context.message.id,
    sourceTimestamp: context.message.timestamp,
    sourceRole: context.message.role,
    sourceTurnId: context.turnId,
    importedConversationId: context.conversationId,
  };
}

function taskNotificationBlock(
  context: ImportedBlockContext,
): CliBlock | null {
  const { conversationId, message } = context;
  const content = message.content.trim();
  if (message.isUserPrompt === true) return null;
  if (!content.startsWith("<task-notification>")) return null;
  const status = content.match(/<status>([\s\S]*?)<\/status>/i)?.[1]?.trim();
  const summary = content.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1]?.trim();
  const detailValue = summary || "Background task update";
  return withImportedSource({
    id: `imported-${conversationId}-${message.id}-task-notification`,
    type: "tool",
    tool: "Task notification",
    detail: formatImportedValuePreview(detailValue),
    ...(detailValue.length > TOOL_DETAIL_PREVIEW_LENGTH ? { detailValue } : {}),
    status: status && /^(stopped|failed|error)$/i.test(status) ? "error" : status,
  }, context);
}

export function isActualUserPromptMessage(message: ImportedTranscriptMessage): boolean {
  if (typeof message.isUserPrompt === "boolean") return message.isUserPrompt;
  if (message.role !== "user") return false;
  const content = message.content.trimStart();
  if (INTERRUPTED_MESSAGE_PATTERN.test(content.trim())) return false;
  if (CONTEXT_ONLY_PREFIXES.some((prefix) => content.startsWith(prefix))) return false;
  const parts = message.parts ?? [];
  if (parts.some((part) => part.type === "text")) return true;
  if (parts.some((part) => part.type === "toolResult")) return false;
  return content.trim().toLowerCase() !== "[tool result]";
}

function messageTextBlock(
  id: string,
  message: ImportedTranscriptMessage,
  content: string,
): CliBlock {
  if (isActualUserPromptMessage(message)) return { id, type: "user-prompt", content };
  if (message.role === "assistant") return { id, type: "text", content };
  return { id, type: "status", message: content };
}

function legacyPartContent(part: ImportedTranscriptPart): string {
  switch (part.type) {
    case "text":
    case "thinking":
      return part.text;
    case "image":
      return "[Image]";
    case "attachment":
      return `[Attachment: ${part.name || "file"}]`;
    case "toolCall":
      return `[Tool call: ${part.name}]`;
    case "toolResult":
      return "[Tool result]";
    case "event":
      return `[${part.kind}]`;
  }
}

function partToBlock(
  context: ImportedBlockContext,
  part: ImportedTranscriptPart,
  index: number,
): CliBlock {
  const { conversationId, message } = context;
  const id = `imported-${conversationId}-${message.id}-${index}`;
  let block: CliBlock;
  switch (part.type) {
    case "text":
      block = messageTextBlock(id, message, part.text);
      break;
    case "thinking":
      block = { id, type: "thought", content: formatImportedThinking(part.text) };
      break;
    case "image":
      block = {
        id,
        type: "image",
        images: [{
          ...(part.dataUrl ? { dataUrl: part.dataUrl } : {}),
          ...(part.assetId ? { assetId: part.assetId } : {}),
          alt: part.alt,
        }],
      };
      break;
    case "attachment":
      block = {
        id,
        type: "image",
        attachments: [{
          name: part.name?.trim() || "Imported attachment",
          mediaType: part.mediaType?.trim() || "application/octet-stream",
          ...(part.dataUrl ? { dataUrl: part.dataUrl } : {}),
          ...(part.assetId ? { assetId: part.assetId } : {}),
          ...(part.url ? { url: part.url } : {}),
        }],
      };
      break;
    case "toolCall":
      block = {
        id,
        type: "tool",
        tool: part.name,
        detail: formatImportedValuePreview(part.input),
        detailValue: part.input,
        status: "completed",
      };
      break;
    case "toolResult":
      block = {
        id,
        type: "tool",
        tool: "Tool result",
        detail: formatImportedValuePreview(part.output),
        detailValue: part.output,
        status: part.isError ? "error" : "completed",
      };
      break;
    case "event":
      if (OPAQUE_THINKING_KINDS.has(part.kind.toLowerCase())) {
        block = {
          id,
          type: "thought",
          content: readableThinkingEventText(part) ?? "Thinking",
        };
        break;
      }
      block = {
        id,
        type: "status",
        message: `${part.kind}${part.data === null || part.data === undefined ? "" : `: ${compactEventValue(part.data)}`}`,
      };
      break;
  }
  return withImportedSource(block, context);
}

function messageToBlocks(context: ImportedBlockContext): CliBlock[] {
  const { conversationId, message } = context;
  const taskNotification = taskNotificationBlock(context);
  if (taskNotification) return [taskNotification];

  const interruptedMessage = message.isUserPrompt === true
    ? undefined
    : message.content.trim().match(INTERRUPTED_MESSAGE_PATTERN)?.[0];
  if (interruptedMessage) {
    return [withImportedSource({
      id: `imported-${conversationId}-${message.id}-interrupted`,
      type: "status",
      message: interruptedMessage.slice(1, -1),
    }, context)];
  }

  const parts = message.parts ?? [];
  if (parts.length > 0 && isActualUserPromptMessage(message)) {
    const promptPartIndexes = parts.flatMap((part, index) =>
      part.type === "text" || part.type === "image" || part.type === "attachment"
        ? [index]
        : []
    );
    if (promptPartIndexes.length > 0) {
      const promptContent = parts
        .flatMap((part) => part.type === "text" ? [part.text] : [])
        .join("\n\n");
      const images = parts.flatMap((part) => part.type === "image"
        ? [{
            ...(part.dataUrl ? { dataUrl: part.dataUrl } : {}),
            ...(part.assetId ? { assetId: part.assetId } : {}),
            alt: part.alt,
          }]
        : []
      );
      const attachments = parts.flatMap((part) => part.type === "attachment"
        ? [{
            name: part.name?.trim() || "Imported attachment",
            mediaType: part.mediaType?.trim() || "application/octet-stream",
            ...(part.dataUrl ? { dataUrl: part.dataUrl } : {}),
            ...(part.assetId ? { assetId: part.assetId } : {}),
            ...(part.url ? { url: part.url } : {}),
          }]
        : []
      );
      const firstPromptPartIndex = promptPartIndexes[0]!;
      const promptPartIndexSet = new Set(promptPartIndexes);
      return parts.flatMap((part, index) => {
        if (index === firstPromptPartIndex) {
          return [withImportedSource({
            id: `imported-${conversationId}-${message.id}-${index}`,
            type: "user-prompt" as const,
            content: promptContent || message.content,
            images: images.length > 0 ? images : undefined,
            attachments: attachments.length > 0 ? attachments : undefined,
          }, context)];
        }
        return promptPartIndexSet.has(index)
          ? []
          : [partToBlock(context, part, index)];
      });
    }
  }
  if (parts.length > 0) {
    const blocks = parts.map((part, index) => partToBlock(context, part, index));
    // Some legacy records keep text only in content while parts hold rich metadata.
    const content = message.content.trim();
    const projectedContent = parts.map(legacyPartContent).join("\n\n").trim();
    if (!parts.some((part) => part.type === "text") && content && content !== projectedContent) {
      blocks.unshift(withImportedSource(
        messageTextBlock(`imported-${conversationId}-${message.id}-content`, message, content),
        context,
      ));
    }
    return blocks;
  }
  if (!message.content.trim()) return [];
  return [
    withImportedSource(
      messageTextBlock(`imported-${conversationId}-${message.id}`, message, message.content),
      context,
    ),
  ];
}

export function importedConversationToTabInit(
  conversation: ImportedConversation,
  projectPath = conversation.projectPath,
) {
  const blocks: CliBlock[] = [];
  let lastUserPrompt: string | null = null;
  let turn = 0;
  let currentTurnId = `${conversation.id}:turn:0`;

  for (const message of conversation.messages) {
    if (isActualUserPromptMessage(message)) {
      turn += 1;
      currentTurnId = message.sourceTurnId?.trim() || `${conversation.id}:turn:${turn}`;
      if (message.content.trim()) lastUserPrompt = message.content.trim();
    } else if (message.sourceTurnId?.trim()) {
      currentTurnId = message.sourceTurnId.trim();
    }
    blocks.push(...messageToBlocks({
      conversationId: conversation.id,
      message,
      turnId: currentTurnId,
    }));
  }

  return {
    title: conversation.title || "Imported conversation",
    agent: conversation.source,
    projectPath,
    agentNativeSessionId: conversation.nativeSessionId,
    importedConversationId: conversation.id,
    hasFullImportedHistory: true,
    cliBlocks: blocks,
    lastUserPrompt,
  };
}

function isBlockFromConversation(block: CliBlock, conversationId: string): boolean {
  return block.importedConversationId === conversationId ||
    block.id.startsWith(`imported-${conversationId}-`);
}

function normalizedText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function splitTurns(blocks: readonly CliBlock[]): CliBlock[][] {
  const turns: CliBlock[][] = [];
  let current: CliBlock[] = [];
  for (const block of blocks) {
    if (block.type === "user-prompt" && current.length > 0) {
      turns.push(current);
      current = [];
    }
    current.push(block);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

function responseTexts(turn: readonly CliBlock[]): string[] {
  return turn.flatMap((block) =>
    block.type === "text" && normalizedText(block.content)
      ? [normalizedText(block.content)]
      : []
  );
}

function duplicateContinuationTurn(
  continuation: readonly CliBlock[],
  importedTurns: readonly CliBlock[][],
): boolean {
  const prompt = continuation.find((block) => block.type === "user-prompt");
  const promptText = normalizedText(prompt?.content);
  if (!prompt || !promptText) return false;
  const responses = responseTexts(continuation);

  return importedTurns.some((turn) => {
    const importedPrompt = turn.find((block) => block.type === "user-prompt");
    if (normalizedText(importedPrompt?.content) !== promptText) return false;
    const timestampsMatch = typeof prompt.sourceTimestamp === "number" &&
      typeof importedPrompt?.sourceTimestamp === "number" &&
      Math.abs(prompt.sourceTimestamp - importedPrompt.sourceTimestamp) <= 5 * 60_000;
    if (!timestampsMatch || responses.length === 0) return false;
    const importedResponses = new Set(responseTexts(turn));
    return importedResponses.size > 0 &&
      responses.every((response) => importedResponses.has(response));
  });
}

export interface MergeImportedTimelineOptions {
  deletedImportedBlockIds?: readonly string[];
  projectPath?: string | null;
}

export function mergeImportedConversationTimeline(
  conversation: ImportedConversation,
  existingBlocks: readonly CliBlock[],
  options: MergeImportedTimelineOptions = {},
) {
  const importedTab = importedConversationToTabInit(
    conversation,
    options.projectPath ?? conversation.projectPath,
  );
  const deleted = new Set(options.deletedImportedBlockIds ?? []);
  const importedBlocks = importedTab.cliBlocks.filter((block) => !deleted.has(block.id));
  const continuationBlocks = existingBlocks.filter(
    (block) =>
      !isBlockFromConversation(block, conversation.id) &&
      block.id !== `imported-history-error-${conversation.id}`,
  );
  const importedTurns = splitTurns(importedBlocks);
  const uniqueContinuation = splitTurns(continuationBlocks).flatMap((turn) =>
    duplicateContinuationTurn(turn, importedTurns) ? [] : turn
  );
  const cliBlocks = [...importedBlocks, ...uniqueContinuation];
  const lastUserPrompt = cliBlocks
    .slice()
    .reverse()
    .find((block) => block.type === "user-prompt" && normalizedText(block.content))
    ?.content?.trim() ?? null;

  return {
    ...importedTab,
    cliBlocks,
    lastUserPrompt,
  };
}

function boundedNormalizedText(value: string | undefined, maxLength: number): string {
  if (!value || maxLength <= 0) return "";
  return value.slice(0, maxLength * 2).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function fallbackLine(block: CliBlock, maxLength: number): string | null {
  if (block.type === "user-prompt") {
    const text = boundedNormalizedText(block.content, maxLength);
    const attachmentLines = [
      ...(block.images ?? []).map((image) => `[Attachment] ${image.alt || "image"}`),
      ...(block.attachments ?? []).map((attachment) => `[Attachment] ${attachment.name}`),
    ];
    return [`[User]${text ? ` ${text}` : ""}`, ...attachmentLines].join("\n");
  }
  if (block.type === "text") {
    const text = boundedNormalizedText(block.content, maxLength);
    if (!text) return null;
    const role = block.sourceRole === "developer"
      ? "Developer"
      : block.sourceRole === "system"
        ? "System"
        : "Assistant";
    return `[${role}] ${text}`;
  }
  if (block.type === "tool") {
    const detail = boundedNormalizedText(block.detail, Math.min(maxLength, 4_000));
    return detail ? `[Tool: ${block.tool || "result"}] ${detail}` : null;
  }
  if (block.type === "status" && block.sourceRole && block.sourceRole !== "assistant") {
    const text = boundedNormalizedText(block.message, maxLength);
    return text ? `[${block.sourceRole}] ${text}` : null;
  }
  return null;
}

export function buildImportedFallbackContext(
  blocks: readonly CliBlock[],
  maxLength = 32_000,
): string {
  if (maxLength <= 0) return "";
  const selected: Array<{ index: number; text: string }> = [];
  const selectedIndexes = new Set<number>();
  let length = 0;

  const collect = (include: (block: CliBlock) => boolean): void => {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index]!;
      if (selectedIndexes.has(index) || !include(block)) continue;
      const separatorLength = selected.length > 0 ? 2 : 0;
      const remaining = maxLength - length - separatorLength;
      if (remaining <= 0) return;
      const line = fallbackLine(block, Math.min(remaining, 8_000));
      if (!line) continue;
      const text = line.slice(0, remaining);
      selected.push({ index, text });
      selectedIndexes.add(index);
      length += separatorLength + text.length;
    }
  };

  // Actual dialogue carries the resumed task. Internal context and tool output
  // are useful only after the latest user/assistant exchange has a place.
  collect((block) => block.type === "user-prompt" || block.type === "text");
  collect((block) => block.type !== "user-prompt" && block.type !== "text" && block.type !== "tool");
  collect((block) => block.type === "tool");

  return selected
    .sort((left, right) => left.index - right.index)
    .map(({ text }) => text)
    .join("\n\n");
}

export function importedHistoryErrorBlock(conversationId: string, message: string): CliBlock {
  return {
    id: `imported-history-error-${conversationId}`,
    type: "error",
    message,
  };
}
