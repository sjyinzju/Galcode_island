// 心形点赞按钮 + 数字 + 当日剩余配额 chip。
//
// 受控行为：父组件持有当前 likes 数 + 当日剩余配额（首次为 null = 未知）。
// 点击 → 调 onLike()（异步，调用方决定具体 endpoint），inflight 期间 disable。
// 收到 429 时父组件传 dailyRemaining=0，按钮变灰显示 "今日已满"。

import { useState } from "react";

export interface LikeButtonProps {
  likes: number;
  /// 当日剩余配额；null = 还没点过 / 还没拿到信息（按 10 显示但不阻止点击）
  dailyRemaining: number | null;
  onLike: () => Promise<void>;
  /// 紧凑模式（卡片右下角小按钮 vs album 顶栏大按钮）
  size?: "sm" | "md";
}

export function LikeButton({
  likes,
  dailyRemaining,
  onLike,
  size = "sm",
}: LikeButtonProps): JSX.Element {
  const [busy, setBusy] = useState<boolean>(false);
  const exhausted = dailyRemaining === 0;
  const disabled = busy || exhausted;

  const handleClick = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation();
    if (disabled) return;
    setBusy(true);
    try {
      await onLike();
    } finally {
      setBusy(false);
    }
  };

  const sizeCls =
    size === "md"
      ? "px-3 py-1.5 text-[12px]"
      : "px-1.5 py-0.5 text-[10px]";

  return (
    <button
      type="button"
      onClick={(e) => void handleClick(e)}
      disabled={disabled}
      title={
        exhausted
          ? "今日点赞配额已用完（每日 UTC 0 点重置）"
          : dailyRemaining != null
            ? `今日还剩 ${dailyRemaining} 次`
            : "点赞这张图"
      }
      aria-label="点赞"
      className={`inline-flex items-center gap-1 rounded-full border ${sizeCls} transition-all ${
        exhausted
          ? "border-zinc-300/40 bg-zinc-200/40 text-zinc-400 dark:border-white/5 dark:bg-slate-700/40 dark:text-zinc-500"
          : "border-rose-300/40 bg-rose-50/70 text-rose-600 hover:bg-rose-100/70 dark:border-rose-300/30 dark:bg-rose-500/15 dark:text-rose-300 dark:hover:bg-rose-500/25"
      } ${busy ? "opacity-70" : ""}`}
    >
      <svg viewBox="0 0 16 16" className={size === "md" ? "h-3.5 w-3.5" : "h-2.5 w-2.5"} fill="currentColor">
        <path d="M8 14s-5-3.2-5-7a3 3 0 015-2.236A3 3 0 0113 7c0 3.8-5 7-5 7z" />
      </svg>
      <span>{likes}</span>
    </button>
  );
}
