import type { CliBlock } from "../types/blocks";

export function limitCliBlocks(
  blocks: CliBlock[],
  recentLimit: number,
  preserveAll: boolean,
): CliBlock[] {
  if (preserveAll || blocks.length <= recentLimit) return blocks;
  if (recentLimit <= 0) return [];
  return blocks.slice(-recentLimit);
}
