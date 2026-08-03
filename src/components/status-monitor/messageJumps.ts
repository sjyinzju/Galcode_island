import type { CliBlock } from "../../types/blocks";

const PROMPT_LIMIT = 180;
const RESPONSE_LIMIT = 320;
const VISIBLE_FILE_LIMIT = 2;

export interface MessageJumpItem {
  blockId: string;
  blockIndex: number;
  prompt: string;
  responsePreview: string;
  files: string[];
  extraFileCount: number;
}

type ScrollToIndex = (
  index: number,
  options: { align: "center"; behavior: "auto" | "smooth" },
) => void;

type PendingMessageJump = Omit<MessageJumpItem, "extraFileCount">;

function compactText(value: string | undefined, limit: number): string {
  const text = value?.replace(/\s+/g, " ").trim() ?? "";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

export function buildMessageJumps(blocks: CliBlock[]): MessageJumpItem[] {
  return buildMessageJumpsFrom(blocks, 0);
}

function buildMessageJumpsFrom(blocks: CliBlock[], startIndex: number): MessageJumpItem[] {
  const jumps: PendingMessageJump[] = [];
  let current: PendingMessageJump | null = null;

  for (let blockIndex = startIndex; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex]!;
    if (block.type === "user-prompt" && (!block.sourceRole || block.sourceRole === "user")) {
      current = null;
      const prompt = compactText(block.content, PROMPT_LIMIT) ||
        compactText(block.images?.[0]?.alt ?? "", PROMPT_LIMIT) ||
        (block.images?.length ? "图片" : "") ||
        compactText(block.attachments?.[0]?.name, PROMPT_LIMIT);
      if (!prompt) continue;
      current = {
        blockId: block.id,
        blockIndex,
        prompt,
        responsePreview: "",
        files: [],
      };
      jumps.push(current);
      continue;
    }

    if (!current) continue;
    if (
      !current.responsePreview &&
      block.type === "text" &&
      block.sourceRole !== "developer" &&
      block.sourceRole !== "system"
    ) {
      current.responsePreview = compactText(block.content, RESPONSE_LIMIT);
    }
    if (block.path) {
      const file = basename(block.path);
      if (file && !current.files.includes(file)) current.files.push(file);
    }
  }

  return jumps.map((jump) => ({
    ...jump,
    files: jump.files.slice(0, VISIBLE_FILE_LIMIT),
    extraFileCount: Math.max(0, jump.files.length - VISIBLE_FILE_LIMIT),
  }));
}

export function updateMessageJumps(
  previousBlocks: CliBlock[],
  previousItems: MessageJumpItem[],
  blocks: CliBlock[],
): MessageJumpItem[] {
  if (blocks === previousBlocks) return previousItems;
  if (previousBlocks.length === 0 || blocks.length === 0 || blocks.length < previousBlocks.length) {
    return buildMessageJumps(blocks);
  }

  const appendedToStableTail = blocks.length > previousBlocks.length &&
    previousBlocks.at(-1) === blocks[previousBlocks.length - 1];
  const replacedOnlyLast = blocks.length === previousBlocks.length &&
    blocks.at(-1)?.id === previousBlocks.at(-1)?.id &&
    (blocks.length === 1 || blocks.at(-2) === previousBlocks.at(-2));

  if (!appendedToStableTail && !replacedOnlyLast) return buildMessageJumps(blocks);

  const rebuildFrom = previousItems.at(-1)?.blockIndex ?? 0;
  const preserved = previousItems.filter((item) => item.blockIndex < rebuildFrom);
  return [...preserved, ...buildMessageJumpsFrom(blocks, rebuildFrom)];
}

export function findActiveMessageJump(
  items: readonly MessageJumpItem[],
  blockIndex: number,
): string | null {
  if (items.length === 0) return null;
  let low = 0;
  let high = items.length - 1;
  let active = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (items[middle]!.blockIndex <= blockIndex) {
      active = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return items[active]!.blockId;
}

export function jumpToMessage(
  blocks: readonly Pick<CliBlock, "id">[],
  blockId: string,
  scrollToIndex: ScrollToIndex,
  stickToBottom: { current: boolean },
  behavior: "auto" | "smooth",
): boolean {
  const index = blocks.findIndex((block) => block.id === blockId);
  if (index < 0) return false;
  stickToBottom.current = false;
  scrollToIndex(index, { align: "center", behavior });
  return true;
}
