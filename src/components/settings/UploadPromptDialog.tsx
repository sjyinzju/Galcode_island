// 上传桌宠图前的"填提示词向导"。
//
// 触发：PetCharacterSection 里某个类别的"+ 添加图片"按钮 → 选完文件后挂载本组件。
// 形态：modal（半透明背景遮罩 + 居中卡片 + 毛玻璃 + 暗色适配）。
// 字段：
//   - 类别（只读展示，提醒用户当前是给哪个状态加图）
//   - 文件预览缩略图 + 文件名 + 体积
//   - 团长文案风格 prompt（textarea，0 / 2000 字数计数，可选）
//   - "分享到社区" checkbox（默认 ON；社区未启用时禁用并展示提示）
//   - 确定 / 取消按钮
//
// 提交：onConfirm({ prompt, shareToCommunity })；prompt 为 trim 后字符串或 null。
// 取消：onCancel()——调用方负责清空 input.value，让用户能重新选同一个文件。
//
// 设计：与现有 SettingsModal 风格一致（圆角、阴影、毛玻璃）。

import { useEffect, useMemo, useState } from "react";
import { PET_CATEGORY_LABEL, type PetCategory } from "../../stores/usePetAssetsStore";
import { isCommunityEnabled } from "../../lib/communityClient";

const MAX_PROMPT_LEN = 2000;

export interface UploadPromptDialogProps {
  file: File;
  category: PetCategory;
  /// 默认昵称（不可改；改昵称去 Profile 面板）
  defaultUploaderName?: string;
  onConfirm: (input: {
    prompt: string | null;
    shareToCommunity: boolean;
    uploaderName: string | null;
  }) => void;
  onCancel: () => void;
}

export function UploadPromptDialog({
  file,
  category,
  defaultUploaderName,
  onConfirm,
  onCancel,
}: UploadPromptDialogProps): JSX.Element {
  const communityEnabled = isCommunityEnabled();
  const [prompt, setPrompt] = useState<string>("");
  const [share, setShare] = useState<boolean>(communityEnabled);

  // 文件 ObjectURL：组件卸载时 revoke，避免 webview 长期持有
  const previewUrl = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => {
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const charCount = prompt.length;
  const overLimit = charCount > MAX_PROMPT_LEN;
  const canSubmit = !overLimit;

  const handleSubmit = (): void => {
    if (!canSubmit) return;
    const trimmed = prompt.trim();
    onConfirm({
      prompt: trimmed.length > 0 ? trimmed : null,
      shareToCommunity: communityEnabled && share,
      uploaderName: defaultUploaderName?.trim() ? defaultUploaderName.trim() : null,
    });
  };

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="桌宠图上传向导"
    >
      <div
        className="relative w-[min(540px,92vw)] overflow-hidden rounded-2xl border border-white/30 bg-white/85 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/85"
      >
        {/* 顶部装饰条 */}
        <div className="h-1 bg-gradient-to-r from-sky-400 via-fuchsia-400 to-amber-400" />

        <div className="flex flex-col gap-4 px-5 py-4">
          <header className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-zinc-800 dark:text-zinc-100">
                上传桌宠图
              </h2>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                类别：
                <span className="ml-0.5 rounded bg-sky-500/10 px-1.5 py-0.5 text-sky-700 dark:text-sky-300">
                  {PET_CATEGORY_LABEL[category]}
                </span>
              </p>
            </div>
            <button
              type="button"
              onClick={onCancel}
              aria-label="关闭"
              className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-black/5 hover:text-zinc-800 dark:hover:bg-white/10 dark:hover:text-zinc-100"
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
              </svg>
            </button>
          </header>

          {/* 预览 */}
          <div className="flex items-center gap-3 rounded-lg border border-black/5 bg-zinc-50/70 p-3 dark:border-white/5 dark:bg-slate-800/40">
            <div className="h-16 w-16 shrink-0 overflow-hidden rounded border border-black/10 bg-white dark:border-white/10 dark:bg-slate-900">
              <img src={previewUrl} alt="" className="h-full w-full object-cover" draggable={false} />
            </div>
            <div className="flex min-w-0 flex-col gap-0.5">
              <div className="truncate text-[12px] font-medium text-zinc-800 dark:text-zinc-100">
                {file.name}
              </div>
              <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
                {file.type || "未知类型"} · {(file.size / 1024).toFixed(1)} KB
              </div>
            </div>
          </div>

          {/* prompt */}
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center justify-between text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
              <span>
                团长文案风格 prompt
                <span className="ml-1 rounded bg-zinc-200/70 px-1 text-[9px] text-zinc-500 dark:bg-zinc-700/60 dark:text-zinc-400">
                  可选
                </span>
              </span>
              <span
                className={`text-[10px] ${
                  overLimit ? "text-rose-600" : "text-zinc-400 dark:text-zinc-500"
                }`}
              >
                {charCount} / {MAX_PROMPT_LEN}
              </span>
            </label>
            <p className="text-[10px] leading-relaxed text-zinc-500 dark:text-zinc-400">
              这段文字会在使用这张图作为桌宠时，
              <span className="font-medium text-amber-700 dark:text-amber-400">完全替换团长（凉宫春日）人设</span>
              ，用你写的风格生成任务总结。留空就保持默认凉宫春日风。
            </p>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="例：你是温柔的姐姐，说话轻声细语，会用「呢」「哦」等语气词..."
              rows={4}
              className="w-full resize-y rounded-md border border-black/10 bg-white/80 px-2.5 py-2 text-[12px] text-zinc-800 outline-none transition-colors placeholder:text-zinc-400 focus:border-sky-400 focus:bg-white dark:border-white/10 dark:bg-slate-800/60 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:bg-slate-800/80"
            />
          </div>

          {/* 分享开关 */}
          <label
            className={`flex items-start gap-2.5 rounded-lg border p-2.5 text-[11px] transition-colors ${
              communityEnabled
                ? "cursor-pointer border-emerald-300/40 bg-emerald-50/60 hover:bg-emerald-100/60 dark:border-emerald-300/20 dark:bg-emerald-400/10"
                : "cursor-not-allowed border-zinc-200/60 bg-zinc-100/40 opacity-70 dark:border-white/5 dark:bg-slate-800/30"
            }`}
          >
            <input
              type="checkbox"
              disabled={!communityEnabled}
              checked={share && communityEnabled}
              onChange={(e) => setShare(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-emerald-500"
            />
            <div className="flex flex-col gap-0.5">
              <span className="font-medium text-zinc-800 dark:text-zinc-100">
                {communityEnabled ? "分享到社区" : "未配置社区服务地址"}
              </span>
              <span className="text-zinc-500 dark:text-zinc-400">
                {communityEnabled
                  ? "上传到 Galcode 桌宠图社区，让大家都能用上你的图（默认开启）。"
                  : "去 设置 → 桌宠社区 配置后端地址，才能把图分享给其他人。本次仅保存到本机。"}
              </span>
            </div>
          </label>

          {/* 按钮 */}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md border border-black/10 bg-white/60 px-4 py-1.5 text-[12px] text-zinc-700 transition-colors hover:bg-zinc-100/80 dark:border-white/10 dark:bg-slate-800/60 dark:text-zinc-200 dark:hover:bg-slate-800"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="rounded-md border border-sky-400/60 bg-sky-500 px-4 py-1.5 text-[12px] font-medium text-white shadow-sm transition-colors hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              确定
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
