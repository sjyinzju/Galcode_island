// 单张桌宠图的详情 / prompt 编辑弹窗。
//
// 触发：在 PetCharacterSection 里点击预设下的某张缩略图。
//
// 字段：
//   - 文件名 / 体积 / 来源（本地 / 社区）/ 关联的社区图 id（如有）
//   - 大图预览
//   - 团长文案风格 prompt（textarea）：source=mine 的预设可编辑；
//     default / community 来源置灰显示，并提示先"复制为我的副本"再来改。
//
// 设计意图：
//   - 上传时已经能填 prompt（UploadPromptDialog），但之前没有"事后查看/修改"入口；
//     很多用户会希望先把图加进来、用过几次再回来调风格 —— 本组件补齐这条路径。
//   - 同时给缩略图加上"有 prompt"的视觉提示（在父组件里）。

import { useEffect, useState } from "react";
import {
  PET_CATEGORY_LABEL,
  type PetAssetMeta,
  type PetCategory,
  type Preset,
} from "../../stores/usePetAssetsStore";
import { usePetAssetsStore } from "../../stores/usePetAssetsStore";

const MAX_PROMPT_LEN = 2000;

/// 各类别在桌宠流程里"会读取这张图的 prompt"的场景描述。
/// null 表示当前没有 LLM 文案接进来，用户填了也暂时不会被读，但保留以备将来扩展。
/// 跟实际消费侧（lib/petPromptOverride.ts / InputBubble welcome / PetCharacter 戳戳）
/// 一一对应，改了消费侧记得同步这里。
const PROMPT_USE_BY_CATEGORY: Record<PetCategory, string | null> = {
  welcome: "生成开场欢迎语",
  complete: "生成任务完成总结",
  others: "生成被戳的互动台词",
  thinking: null,
  waiting: null,
  error: null,
};

export interface AssetDetailDialogProps {
  preset: Preset;
  category: PetCategory;
  asset: PetAssetMeta;
  onClose: () => void;
}

export function AssetDetailDialog({
  preset,
  category,
  asset,
  onClose,
}: AssetDetailDialogProps): JSX.Element {
  // 默认预设的 meta 是运行时常量生成的，没进 IDB，url 走 staticUrl 直连 public/
  const blobUrl = usePetAssetsStore((s) => asset.staticUrl ?? s.blobUrls[asset.id]);
  const updateAssetPrompt = usePetAssetsStore((s) => s.updateAssetPrompt);

  const editable = preset.source === "mine";
  const [prompt, setPrompt] = useState<string>(asset.communityPrompt ?? "");
  /// "已落库的原值"——asset prop 是父级缓存可能跟不上 store；保存后我们手动把它推进，
  /// 让"是否 dirty"在 modal 内自洽，不依赖外部刷新。
  const [savedPrompt, setSavedPrompt] = useState<string>(asset.communityPrompt ?? "");
  const [savedFlash, setSavedFlash] = useState<boolean>(false);

  // 切换查看的图（id 变了）时重新同步草稿
  useEffect(() => {
    setPrompt(asset.communityPrompt ?? "");
    setSavedPrompt(asset.communityPrompt ?? "");
    setSavedFlash(false);
  }, [asset.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const charCount = prompt.length;
  const overLimit = charCount > MAX_PROMPT_LEN;
  const trimmed = prompt.trim();
  const dirty = trimmed !== savedPrompt.trim();

  const handleSave = (): void => {
    if (!editable || overLimit || !dirty) return;
    updateAssetPrompt(preset.id, category, asset.id, prompt);
    setSavedPrompt(prompt);
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 1500);
  };

  return (
    <div
      className="fixed inset-0 z-[140] flex items-center justify-center bg-black/45 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="图片详情"
    >
      <div className="relative w-[min(560px,94vw)] max-h-[90vh] overflow-hidden rounded-2xl border border-white/30 bg-white/85 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/85 flex flex-col">
        <div className="h-1 shrink-0 bg-gradient-to-r from-sky-400 via-fuchsia-400 to-amber-400" />

        <header className="flex items-start justify-between gap-2 px-5 py-3 shrink-0">
          <div className="min-w-0">
            {/* 标题用所属预设的名字 —— 图片本身的 fileName 在社区/批量下载场景下
                基本就是 UUID 噪声，对用户没意义；预设名才是用户实际认得的标签 */}
            <h2
              className="truncate text-base font-semibold text-zinc-800 dark:text-zinc-100"
              title={asset.fileName}
            >
              {preset.name}
            </h2>
            <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-500 dark:text-zinc-400">
              <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-sky-700 dark:text-sky-300">
                {PET_CATEGORY_LABEL[category]}
              </span>
              <span>{asset.mime || "未知类型"}</span>
              <span>·</span>
              <span>{(asset.sizeBytes / 1024).toFixed(1)} KB</span>
              {asset.source === "community" ? (
                <>
                  <span>·</span>
                  <span
                    className="rounded bg-fuchsia-500/10 px-1.5 py-0.5 text-fuchsia-700 dark:text-fuchsia-300"
                    title={
                      asset.communityImageId
                        ? `社区图 ID：${asset.communityImageId}`
                        : "来自社区"
                    }
                  >
                    社区来源
                  </span>
                </>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-black/5 hover:text-zinc-800 dark:hover:bg-white/10 dark:hover:text-zinc-100"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="overflow-y-auto px-5 pb-4 flex flex-col gap-4">
          {/* 预览：长边压到容器宽度，保留 aspect ratio */}
          <div className="flex justify-center rounded-lg border border-black/5 bg-zinc-50/70 p-3 dark:border-white/5 dark:bg-slate-800/40">
            {blobUrl ? (
              <img
                src={blobUrl}
                alt=""
                className="max-h-[40vh] max-w-full rounded object-contain"
                draggable={false}
              />
            ) : (
              <div className="flex h-32 w-full items-center justify-center text-[12px] text-zinc-400 dark:text-zinc-500">
                图片加载中…
              </div>
            )}
          </div>

          {/* prompt 编辑 / 查看 */}
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center justify-between text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
              <span>
                这张图绑定的人设 prompt
                <span className="ml-1 rounded bg-zinc-200/70 px-1 text-[9px] text-zinc-500 dark:bg-zinc-700/60 dark:text-zinc-400">
                  {editable ? "可编辑" : "只读"}
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
              {PROMPT_USE_BY_CATEGORY[category] ? (
                <>
                  桌宠抽中这张「{PET_CATEGORY_LABEL[category]}」类的图、要
                  <span className="font-medium text-amber-700 dark:text-amber-400">
                    {PROMPT_USE_BY_CATEGORY[category]}
                  </span>
                  时，这段文字会替换默认人设说话。留空则沿用默认人设。
                </>
              ) : (
                <>
                  「{PET_CATEGORY_LABEL[category]}」类目前还没有需要 LLM 文案的场景，
                  这里填的 prompt 暂时不会被读取——可以留作以后扩展用。
                </>
              )}
            </p>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={!editable}
              placeholder={
                editable
                  ? "例：你是温柔的姐姐，说话轻声细语，会用「呢」「哦」等语气词…"
                  : "无 prompt"
              }
              rows={5}
              className="w-full resize-y rounded-md border border-black/10 bg-white/80 px-2.5 py-2 text-[12px] text-zinc-800 outline-none transition-colors placeholder:text-zinc-400 focus:border-sky-400 disabled:bg-zinc-100/60 disabled:text-zinc-500 dark:border-white/10 dark:bg-slate-800/60 dark:text-zinc-100 dark:focus:bg-slate-800/80 dark:disabled:bg-slate-800/30 dark:disabled:text-zinc-400"
            />
            {!editable ? (
              <p className="rounded-md border border-amber-300/40 bg-amber-50/70 px-2 py-1 text-[10px] text-amber-800 dark:border-amber-300/30 dark:bg-amber-400/10 dark:text-amber-300">
                {preset.source === "default"
                  ? "默认预设只读哦～想配置自己的预设可以在左栏新建。"
                  : "社区下载的预设不能直接修改，在上一级菜单的右上角点「复制为我的」生成本地副本就能编辑了。"}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-black/5 px-5 py-3 dark:border-white/5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-black/10 bg-white/60 px-4 py-1.5 text-[12px] text-zinc-700 transition-colors hover:bg-zinc-100/80 dark:border-white/10 dark:bg-slate-800/60 dark:text-zinc-200 dark:hover:bg-slate-800"
          >
            关闭
          </button>
          {editable ? (
            <button
              type="button"
              onClick={handleSave}
              disabled={overLimit || !dirty}
              className="rounded-md border border-sky-400/60 bg-sky-500 px-4 py-1.5 text-[12px] font-medium text-white shadow-sm transition-colors hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {savedFlash ? "已保存 ✓" : dirty ? "保存" : "无变动"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
