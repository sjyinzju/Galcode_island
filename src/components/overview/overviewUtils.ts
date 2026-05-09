// 给 ProjectOverview / GlobalOverview 共用的小工具：路径 basename、相对时间。
// 跟 ProjectTree / HistoryList 同款实现，复制一份避免跨目录互引。

export function basename(p: string | null | undefined): string {
  if (!p) return "未选择目录";
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

export function relativeTime(ms: number, now: number): string {
  if (!ms) return "—";
  const diff = now - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export const AGENT_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  gemini: "Gemini",
  cursor: "Cursor",
};
