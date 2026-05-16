// 个性化弹窗的主体：本地预设库（两列布局）。
//
// 左列：
//   - 默认预设：凉宫春日（不可编辑，可选中/启用）
//   - 我的预设：用户本地创建 / auto-fork 出来的；可改名 / 上传社区 / 删除
//   - 已下载：从社区下载下来的整套；只读，编辑会自动 fork 出新副本
//   - 底部入口：新建空白预设 / 看看大家的预设
//
// 右列：
//   - 标题区：预设名 + 来源徽标 + 应用按钮 + 操作（改名、上传、复制、删除）
//   - 描述（可编辑）
//   - 6 个类别卡片，列出该预设各类资源；
//     · mine：可 + 添加 / × 删除
//     · default / community：只读 + 顶部 CTA "复制为我的副本以编辑"
//   - "看看大家的图"按钮在每个类别卡片上保留（针对单类找图的场景）
//
// 操作-写策略：addAsset / removeAsset / addCommunityImageToActive 命中非 mine
// 时 store 内部会 auto-fork；本组件用返回的 activePresetId 同步左列选中态。

import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_PRESET,
  DEFAULT_PRESET_ID,
  PET_CATEGORIES,
  PET_CATEGORY_LABEL,
  getPresetById,
  usePetAssetsStore,
  type PetCategory,
  type Preset,
} from "../../stores/usePetAssetsStore";
import { useProfileStore } from "../../stores/useProfileStore";
import { isCommunityEnabled } from "../../lib/communityClient";
import { UploadPromptDialog } from "./UploadPromptDialog";
import { UploadAlbumDialog } from "./UploadAlbumDialog";
import { CommunityPickerModal } from "./CommunityPickerModal";
import { AssetDetailDialog } from "./AssetDetailDialog";
import type { PetAssetMeta } from "../../stores/usePetAssetsStore";

const ACCEPTED_MIME = "image/gif,image/png,image/jpeg,image/webp,image/apng";

// ---------------------------------------------------------------------------
// 顶层
// ---------------------------------------------------------------------------

export function PetCharacterSection(): JSX.Element {
  const presets = usePetAssetsStore((s) => s.presets);
  const activePresetId = usePetAssetsStore((s) => s.activePresetId);
  const setActivePreset = usePetAssetsStore((s) => s.setActivePreset);
  const createBlankPreset = usePetAssetsStore((s) => s.createBlankPreset);
  const forkActive = usePetAssetsStore((s) => s.forkActive);

  // 选中态独立于"启用态"——浏览不等于切换
  const [selectedId, setSelectedId] = useState<string>(activePresetId);
  // 当外部 active 变化（比如刚 auto-fork）→ 把选中态同步过去，让 UI 紧贴新预设
  useEffect(() => {
    setSelectedId(activePresetId);
  }, [activePresetId]);

  const selected = usePetAssetsStore((s) => getPresetById(s, selectedId))
    ?? DEFAULT_PRESET;

  const minePresets = presets.filter((p) => p.source === "mine");
  const downloadedPresets = presets.filter((p) => p.source === "community");

  const [communityPickerOpen, setCommunityPickerOpen] = useState<boolean>(false);

  const handleCreateBlank = (): void => {
    const id = createBlankPreset("新预设");
    setSelectedId(id);
  };

  const handleFork = async (newName?: string): Promise<void> => {
    const id = await forkActive(newName);
    setSelectedId(id);
  };

  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
          桌宠预设
        </h3>
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
          一个预设 = 一整套 6 个状态的图。默认是「凉宫春日」，你可以下载社区里别人做的预设，
          或者自己上传图编辑出独属于你的版本。
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-[200px_1fr]">
        <PresetSidebar
          activeId={activePresetId}
          selectedId={selectedId}
          onSelect={setSelectedId}
          minePresets={minePresets}
          downloadedPresets={downloadedPresets}
          onCreateBlank={handleCreateBlank}
          onOpenCommunity={() => setCommunityPickerOpen(true)}
        />
        <PresetDetail
          preset={selected}
          isActive={selected.id === activePresetId}
          onActivate={() => setActivePreset(selected.id)}
          onFork={handleFork}
        />
      </div>

      {communityPickerOpen ? (
        <CommunityPickerModal
          initialCategory="welcome"
          onClose={() => setCommunityPickerOpen(false)}
        />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 左列：预设列表
// ---------------------------------------------------------------------------

interface PresetSidebarProps {
  activeId: string;
  selectedId: string;
  onSelect: (id: string) => void;
  minePresets: Preset[];
  downloadedPresets: Preset[];
  onCreateBlank: () => void;
  onOpenCommunity: () => void;
}

function PresetSidebar({
  activeId,
  selectedId,
  onSelect,
  minePresets,
  downloadedPresets,
  onCreateBlank,
  onOpenCommunity,
}: PresetSidebarProps): JSX.Element {
  const communityReady = isCommunityEnabled();
  return (
    <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto rounded-lg border border-black/5 bg-white/40 p-2 dark:border-white/5 dark:bg-slate-800/40 md:max-h-none">
      <SidebarGroup label="默认">
        <PresetRow
          preset={DEFAULT_PRESET}
          isSelected={selectedId === DEFAULT_PRESET_ID}
          isActive={activeId === DEFAULT_PRESET_ID}
          onClick={() => onSelect(DEFAULT_PRESET_ID)}
        />
      </SidebarGroup>

      <SidebarGroup
        label={`我的预设 (${minePresets.length})`}
        // 有预设时小入口跟其它分组对齐；零预设时把 CTA 让位给下面的大按钮
        action={
          minePresets.length > 0
            ? { label: "+ 新建", title: "新建一份空白预设", onClick: onCreateBlank }
            : undefined
        }
      >
        {minePresets.length === 0 ? (
          // 空状态主入口：横排 + 单标签，比表头小按钮显眼但又不喧宾夺主
          <button
            type="button"
            onClick={onCreateBlank}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-sky-400/60 bg-sky-500/5 px-3 py-2 text-sky-700 transition-all hover:border-sky-400 hover:bg-sky-500/10 dark:border-sky-300/40 dark:text-sky-300 dark:hover:border-sky-300 dark:hover:bg-sky-500/15"
            title="新建一份空白预设"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-3.5 w-3.5">
              <path d="M8 3v10M3 8h10" strokeLinecap="round" />
            </svg>
            <span className="text-[12px] font-semibold">新建预设</span>
          </button>
        ) : (
          minePresets.map((p) => (
            <PresetRow
              key={p.id}
              preset={p}
              isSelected={selectedId === p.id}
              isActive={activeId === p.id}
              onClick={() => onSelect(p.id)}
            />
          ))
        )}
      </SidebarGroup>

      <SidebarGroup label={`已下载 (${downloadedPresets.length})`}>
        {downloadedPresets.length === 0 ? (
          <p className="px-2 py-1 text-[10px] text-zinc-400 dark:text-zinc-500">
            没有下载过别人的预设。
          </p>
        ) : (
          downloadedPresets.map((p) => (
            <PresetRow
              key={p.id}
              preset={p}
              isSelected={selectedId === p.id}
              isActive={activeId === p.id}
              onClick={() => onSelect(p.id)}
            />
          ))
        )}
      </SidebarGroup>

      <div className="mt-auto pt-2">
        <button
          type="button"
          onClick={onOpenCommunity}
          disabled={!communityReady}
          title={communityReady ? "浏览社区里大家发布的预设" : "去设置配置社区地址后可用"}
          className="flex w-full items-center justify-center gap-1 rounded-md border border-fuchsia-400/50 bg-fuchsia-500/10 px-2 py-1.5 text-[11px] font-medium text-fuchsia-700 transition-all hover:bg-fuchsia-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-fuchsia-300/40 dark:text-fuchsia-300"
        >
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3 w-3">
            <circle cx="7" cy="7" r="2" />
            <path d="M1.5 7s2-4 5.5-4 5.5 4 5.5 4-2 4-5.5 4S1.5 7 1.5 7z" strokeLinecap="round" />
          </svg>
          看看大家的预设
        </button>
      </div>
    </div>
  );
}

function SidebarGroup({
  label,
  action,
  children,
}: {
  label: string;
  action?: { label: string; title?: string; onClick: () => void };
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between px-1">
        <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          {label}
        </span>
        {action ? (
          <button
            type="button"
            onClick={action.onClick}
            title={action.title}
            className="rounded px-1.5 py-0.5 text-[10px] font-medium text-sky-600 hover:bg-sky-500/10 dark:text-sky-300 dark:hover:bg-sky-500/20"
          >
            {action.label}
          </button>
        ) : null}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

interface PresetRowProps {
  preset: Preset;
  isSelected: boolean;
  isActive: boolean;
  onClick: () => void;
}

function PresetRow({
  preset,
  isSelected,
  isActive,
  onClick,
}: PresetRowProps): JSX.Element {
  const sourceTag = SOURCE_TAGS[preset.source];
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors ${
        isSelected
          ? "bg-sky-500/15 ring-1 ring-sky-400/40"
          : "hover:bg-black/5 dark:hover:bg-white/5"
      }`}
    >
      <div className="flex w-full items-center gap-1.5">
        <span className="truncate text-[12px] font-medium text-zinc-800 dark:text-zinc-100">
          {preset.name}
        </span>
        {isActive ? (
          <span className="ml-auto shrink-0 rounded bg-emerald-500/20 px-1 text-[9px] font-medium text-emerald-700 dark:text-emerald-300">
            正在使用
          </span>
        ) : null}
      </div>
      <div className="flex w-full items-center gap-1 text-[10px] text-zinc-500 dark:text-zinc-400">
        <span className={`rounded px-1 ${sourceTag.cls}`}>{sourceTag.label}</span>
        {preset.authorName ? (
          <span className="truncate">· {preset.authorName}</span>
        ) : null}
      </div>
    </button>
  );
}

const SOURCE_TAGS: Record<Preset["source"], { label: string; cls: string }> = {
  default: {
    label: "内置",
    cls: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300",
  },
  mine: {
    label: "我的",
    cls: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  },
  community: {
    label: "来自社区",
    cls: "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300",
  },
};

// ---------------------------------------------------------------------------
// 右列：选中预设的详情
// ---------------------------------------------------------------------------

interface PresetDetailProps {
  preset: Preset;
  isActive: boolean;
  onActivate: () => void;
  onFork: (newName?: string) => Promise<void>;
}

function PresetDetail({
  preset,
  isActive,
  onActivate,
  onFork,
}: PresetDetailProps): JSX.Element {
  const renamePreset = usePetAssetsStore((s) => s.renamePreset);
  const updatePresetDescription = usePetAssetsStore(
    (s) => s.updatePresetDescription,
  );
  const deletePreset = usePetAssetsStore((s) => s.deletePreset);

  const [renaming, setRenaming] = useState<boolean>(false);
  const [nameDraft, setNameDraft] = useState<string>(preset.name);
  const [descDraft, setDescDraft] = useState<string>(preset.description);
  const [uploadDialogOpen, setUploadDialogOpen] = useState<boolean>(false);

  // preset 改变（如左列切换、auto-fork）时把草稿同步过来
  useEffect(() => {
    setRenaming(false);
    setNameDraft(preset.name);
    setDescDraft(preset.description);
  }, [preset.id]);

  const editable = preset.source === "mine";
  const sourceTag = SOURCE_TAGS[preset.source];
  const totalCount = PET_CATEGORIES.reduce(
    (n, c) => n + preset.categories[c].length,
    0,
  );

  const handleRenameCommit = (): void => {
    const trimmed = nameDraft.trim();
    if (trimmed && trimmed !== preset.name) {
      renamePreset(preset.id, trimmed);
    } else {
      setNameDraft(preset.name);
    }
    setRenaming(false);
  };

  const handleDescBlur = (): void => {
    if (descDraft !== preset.description) {
      updatePresetDescription(preset.id, descDraft);
    }
  };

  const handleDelete = (): void => {
    if (!editable && preset.source !== "community") return;
    if (preset.source === "default") return;
    if (!window.confirm(`确定要删除预设「${preset.name}」吗？该操作不可撤销。`)) return;
    void deletePreset(preset.id);
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-black/5 bg-white/40 p-3 dark:border-white/5 dark:bg-slate-800/40">
      {/* 标题区 */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            {renaming ? (
              <input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={handleRenameCommit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleRenameCommit();
                  if (e.key === "Escape") {
                    setNameDraft(preset.name);
                    setRenaming(false);
                  }
                }}
                autoFocus
                className="min-w-0 flex-1 rounded border border-sky-400/60 bg-white/90 px-2 py-0.5 text-[14px] font-semibold text-zinc-800 outline-none focus:ring-2 focus:ring-sky-400/20 dark:bg-slate-800 dark:text-zinc-100"
              />
            ) : (
              <h4 className="truncate text-[14px] font-semibold text-zinc-800 dark:text-zinc-100">
                {preset.name}
              </h4>
            )}
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${sourceTag.cls}`}>
              {sourceTag.label}
            </span>
            {preset.communityAlbumId ? (
              <span
                className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300"
                title={`关联社区图集 ${preset.communityAlbumId}`}
              >
                已发布
              </span>
            ) : null}
          </div>
          <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
            {preset.authorName ? `作者：${preset.authorName} · ` : ""}
            共 {totalCount} 张图
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {isActive ? (
            <span className="rounded-md border border-emerald-400/60 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              正在使用
            </span>
          ) : (
            <button
              type="button"
              onClick={onActivate}
              className="rounded-md border border-sky-400/60 bg-sky-500 px-2.5 py-1 text-[11px] font-medium text-white shadow-sm transition-colors hover:bg-sky-600"
            >
              应用
            </button>
          )}
          {editable ? (
            <>
              <button
                type="button"
                onClick={() => setRenaming(true)}
                className="rounded-md border border-black/10 bg-white/70 px-2 py-1 text-[11px] text-zinc-700 hover:bg-zinc-50 dark:border-white/10 dark:bg-slate-800/60 dark:text-zinc-200 dark:hover:bg-slate-800"
              >
                改名
              </button>
              <button
                type="button"
                onClick={() => setUploadDialogOpen(true)}
                disabled={!isCommunityEnabled() || totalCount === 0}
                title={
                  !isCommunityEnabled()
                    ? "社区服务未配置"
                    : totalCount === 0
                      ? "至少需要 1 张图"
                      : preset.communityAlbumId
                        ? "重新发布一份新版本"
                        : "上传这份预设到社区"
                }
                className="rounded-md border border-emerald-400/50 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-300/40 dark:text-emerald-300"
              >
                {preset.communityAlbumId ? "再次上传" : "上传到社区"}
              </button>
              <button
                type="button"
                onClick={handleDelete}
                className="rounded-md border border-rose-300/40 bg-rose-50/70 px-2 py-1 text-[11px] text-rose-700 hover:bg-rose-100/70 dark:border-rose-300/20 dark:bg-rose-500/10 dark:text-rose-300"
              >
                删除
              </button>
            </>
          ) : preset.source === "community" ? (
            <>
              <button
                type="button"
                onClick={() => void onFork()}
                className="rounded-md border border-sky-300/60 bg-sky-500/10 px-2 py-1 text-[11px] font-medium text-sky-700 hover:bg-sky-500/20 dark:border-sky-300/40 dark:text-sky-300"
                title="复制一份到「我的预设」开始编辑"
              >
                复制为我的
              </button>
              <button
                type="button"
                onClick={handleDelete}
                className="rounded-md border border-rose-300/40 bg-rose-50/70 px-2 py-1 text-[11px] text-rose-700 hover:bg-rose-100/70 dark:border-rose-300/20 dark:bg-rose-500/10 dark:text-rose-300"
              >
                删除
              </button>
            </>
          ) : null /* default：只读、不允许复制；想自定义请用左栏"新建预设" */}
        </div>
      </div>

      {/* 描述 */}
      {editable ? (
        <textarea
          value={descDraft}
          onChange={(e) => setDescDraft(e.target.value)}
          onBlur={handleDescBlur}
          rows={2}
          placeholder="简单描述这份预设的风格（可选）"
          className="w-full resize-y rounded-md border border-black/10 bg-white/70 px-2 py-1.5 text-[11px] text-zinc-700 outline-none transition-colors placeholder:text-zinc-400 focus:border-sky-400 dark:border-white/10 dark:bg-slate-800/60 dark:text-zinc-200"
        />
      ) : preset.description ? (
        <p className="rounded-md bg-white/30 px-2 py-1.5 text-[11px] text-zinc-600 dark:bg-slate-800/40 dark:text-zinc-300">
          {preset.description}
        </p>
      ) : null}

      {/* 6 类资源卡片 */}
      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
        {PET_CATEGORIES.map((cat) => (
          <CategoryCard
            key={cat}
            preset={preset}
            category={cat}
            editable={editable}
          />
        ))}
      </div>

      {uploadDialogOpen ? (
        <UploadAlbumDialog
          presetId={preset.id}
          onClose={() => setUploadDialogOpen(false)}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 单个类别的资源卡片
// ---------------------------------------------------------------------------

interface CategoryCardProps {
  preset: Preset;
  category: PetCategory;
  /// preset.source === "mine" 时为 true：直接 + 删；source=community 时 + 添加会触发
  /// auto-fork；source=default 时整组写入入口隐藏（用户必须先"复制为我的"或"新建预设"）
  editable: boolean;
}

function CategoryCard({
  preset,
  category,
  editable,
}: CategoryCardProps): JSX.Element {
  const list = preset.categories[category];
  const blobUrls = usePetAssetsStore((s) => s.blobUrls);
  const addAsset = usePetAssetsStore((s) => s.addAsset);
  const removeAsset = usePetAssetsStore((s) => s.removeAsset);
  const nickname = useProfileStore((s) => s.nickname);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [communityOpen, setCommunityOpen] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  /// 当前打开详情 / prompt 编辑的图（null = 没打开）
  const [detailAsset, setDetailAsset] = useState<PetAssetMeta | null>(null);

  // error 自动 3s 消失
  useEffect(() => {
    if (!error) return;
    const id = window.setTimeout(() => setError(""), 3000);
    return () => window.clearTimeout(id);
  }, [error]);

  const handleAddClick = (): void => {
    inputRef.current?.click();
  };

  const handleFiles = (files: FileList | null): void => {
    if (!files || files.length === 0) return;
    setPendingFiles(Array.from(files));
    if (inputRef.current) inputRef.current.value = "";
  };

  const currentPending = pendingFiles[0] ?? null;

  const handleDialogConfirm = async (input: {
    prompt: string | null;
    shareToCommunity: boolean;
    uploaderName: string | null;
  }): Promise<void> => {
    const file = pendingFiles[0];
    if (!file) return;
    setBusy(true);
    try {
      const result = await addAsset(category, file, {
        prompt: input.prompt,
        shareToCommunity: input.shareToCommunity,
        uploaderName: input.uploaderName,
      });
      if (result.uploadError) {
        setError(`已存本地，社区同步失败：${result.uploadError.message}`);
      } else {
        setError("");
      }
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
      setPendingFiles((prev) => prev.slice(1));
    }
  };

  const handleDialogCancel = (): void => setPendingFiles([]);

  // 内置预设走只读路径——任何"会触发 auto-fork"的入口都不该出现在这里，
  // 用户想动这些图请走右上角的"复制为我的"或左栏"新建预设"。
  const isDefault = preset.source === "default";

  return (
    <div className="flex flex-col gap-2 rounded-md border border-black/5 bg-white/60 p-2 dark:border-white/5 dark:bg-slate-900/40">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
          {PET_CATEGORY_LABEL[category]}
          <span className="ml-1.5 text-[10px] text-zinc-400 dark:text-zinc-500">
            {list.length} 张
          </span>
        </span>
        {isDefault ? null : (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setCommunityOpen(true)}
              disabled={!isCommunityEnabled()}
              title={
                isCommunityEnabled()
                  ? "在社区里找一张这个类别的图加进来（非 mine 会自动复制副本后再加）"
                  : "去设置配置社区地址后可用"
              }
              className="flex items-center gap-1 rounded border border-fuchsia-400/50 bg-fuchsia-500/10 px-1.5 py-0.5 text-[10px] font-medium text-fuchsia-700 transition-all hover:bg-fuchsia-500/20 disabled:cursor-not-allowed disabled:opacity-40 dark:border-fuchsia-300/40 dark:text-fuchsia-300"
            >
              <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-2.5 w-2.5">
                <circle cx="7" cy="7" r="2" />
                <path d="M1.5 7s2-4 5.5-4 5.5 4 5.5 4-2 4-5.5 4S1.5 7 1.5 7z" strokeLinecap="round" />
              </svg>
              社区
            </button>
            <button
              type="button"
              onClick={handleAddClick}
              disabled={busy}
              title={
                preset.source === "community"
                  ? "添加图片会自动复制一份副本到「我的预设」"
                  : "添加图片"
              }
              className="flex items-center gap-1 rounded border border-sky-400/50 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 transition-all hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-sky-300/40 dark:text-sky-300"
            >
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-2.5 w-2.5">
                <path d="M6 2v8M2 6h8" strokeLinecap="round" />
              </svg>
              {busy ? "处理中…" : "添加"}
            </button>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_MIME}
          multiple
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {/* 多文件 FIFO 上传向导 */}
      {currentPending ? (
        <UploadPromptDialog
          file={currentPending}
          category={category}
          defaultUploaderName={nickname}
          onConfirm={(v) => void handleDialogConfirm(v)}
          onCancel={handleDialogCancel}
        />
      ) : null}

      {communityOpen ? (
        <CommunityPickerModal
          initialCategory={category}
          onClose={() => setCommunityOpen(false)}
        />
      ) : null}

      {list.length === 0 ? (
        <div className="rounded border border-dashed border-zinc-300/60 px-3 py-2 text-center text-[10px] text-zinc-400 dark:border-zinc-700/60 dark:text-zinc-500">
          {preset.source === "default"
            ? "使用内置 GIF"
            : "暂无图片 — 当前类别会回退默认 GIF"}
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {list.map((meta) => {
            /// 默认预设的 meta 走 staticUrl（public/pet/...）；其它走 IDB blob 转出来的 URL
            const url = meta.staticUrl ?? blobUrls[meta.id];
            const hasPrompt = !!meta.communityPrompt?.trim();
            const tooltip = hasPrompt
              ? `${meta.fileName} · ${(meta.sizeBytes / 1024).toFixed(1)} KB\n人设 prompt：${meta.communityPrompt!.trim().slice(0, 80)}${meta.communityPrompt!.trim().length > 80 ? "…" : ""}\n点击查看 / 编辑`
              : `${meta.fileName} · ${(meta.sizeBytes / 1024).toFixed(1)} KB\n点击查看详情${editable ? " / 添加人设 prompt" : ""}`;
            return (
              <div
                key={meta.id}
                className="group relative h-12 w-12 shrink-0 overflow-hidden rounded border border-black/10 bg-white/50 dark:border-white/10 dark:bg-slate-900/50"
                title={tooltip}
              >
                {/* 整个缩略图可点：打开详情 / prompt 编辑对话框 */}
                <button
                  type="button"
                  onClick={() => setDetailAsset(meta)}
                  className="block h-full w-full"
                  aria-label={`查看图片 ${meta.fileName} 的详情`}
                >
                  {url ? (
                    <img src={url} alt="" className="h-full w-full object-cover" draggable={false} />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-[9px] text-zinc-400 dark:text-zinc-500">
                      加载中
                    </div>
                  )}
                </button>
                {/* 有 prompt 时左下角小角标：让用户一眼看出"这张已经绑了人设" */}
                {hasPrompt ? (
                  <span
                    className="pointer-events-none absolute bottom-0.5 left-0.5 flex h-3 w-3 items-center justify-center rounded-sm bg-amber-400/90 text-[7px] font-bold text-amber-900 shadow"
                    aria-label="已绑定人设 prompt"
                  >
                    P
                  </span>
                ) : null}
                {editable ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void removeAsset(category, meta.id);
                    }}
                    aria-label="删除"
                    className="absolute right-0.5 top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity hover:bg-rose-500/80 group-hover:opacity-100"
                  >
                    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-1.5 w-1.5">
                      <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" strokeLinecap="round" />
                    </svg>
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {error ? (
        <div className="text-[10px] text-rose-600 dark:text-rose-400">{error}</div>
      ) : null}

      {detailAsset ? (
        <AssetDetailDialog
          preset={preset}
          category={category}
          asset={detailAsset}
          onClose={() => setDetailAsset(null)}
        />
      ) : null}
    </div>
  );
}
