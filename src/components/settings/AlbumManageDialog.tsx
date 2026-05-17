// 用一次性管理密钥管理已上传的预设。
//
// 触发：CommunityPickerModal → "管理上传预设"按钮。
//
// 两段式：
//   - step="enter-key"：输入密钥 → "查询"按钮 → 后端 POST /api/albums/manage
//       · 401 / 404 / 网络错误一律抽象成同一种错误提示，不暴露密钥具体哪里错（避免试探）
//       · 成功后切到 step="manage"
//   - step="manage"：展示 album 名称 / 描述 / 上传者 / 当前可见性
//       · 名称 / 描述 / 上传者可编辑，PATCH /api/albums/:id 保存
//       · "隐藏 / 恢复显示"按钮，PATCH /api/albums/:id/visibility
//       · 这里不直接做"硬删除"——server 端没暴露该路径，只有 admin 能彻底删
//       · 单次会话内密钥保留在 state 里（关掉弹窗就丢，不持久化）
//
// 设计：密钥不在任何地方持久化（不写 store / 不放 cookie），减少泄露面。
//   用户每次"管理"都得手动粘一次——跟 GitHub PAT / AWS access key 的语义一致。

import { useEffect, useState } from "react";
import {
  CommunityError,
  type AlbumDto,
  type CommunityImageDto,
} from "../../types/community";
import {
  manageAlbumByKey,
  setAlbumVisibilityByKey,
  updateAlbum,
} from "../../lib/communityClient";

const MAX_NAME_LEN = 80;
const MAX_DESC_LEN = 500;

export interface AlbumManageDialogProps {
  onClose: () => void;
}

interface LoadedAlbum {
  album: AlbumDto;
  images: CommunityImageDto[];
  /// 用户提供并验证通过的密钥；后续编辑请求都带它
  managementKey: string;
}

export function AlbumManageDialog({ onClose }: AlbumManageDialogProps): JSX.Element {
  const [keyDraft, setKeyDraft] = useState<string>("");
  const [loaded, setLoaded] = useState<LoadedAlbum | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [toast, setToast] = useState<string>("");

  // ESC 关闭——但 busy 时不让走，避免请求中途取消造成 UI 不一致
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  // toast 自动 3s 消失
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(""), 3000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const handleQuery = async (): Promise<void> => {
    const key = keyDraft.trim();
    if (key.length === 0) {
      setError("请输入管理密钥");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await manageAlbumByKey(key);
      setLoaded({ album: res.album, images: res.images, managementKey: key });
    } catch (err) {
      // 不暴露具体错（401 / 403 / 404 / 网络）—— 一律提示"无效"，避免被用来试探有效密钥
      const msg = err instanceof CommunityError ? err.message : String((err as Error).message ?? err);
      console.warn("[manage-album] query failed", msg);
      setError("密钥无效或网络异常，请检查后重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="管理上传预设"
    >
      <div className="relative w-[min(640px,94vw)] max-h-[90vh] overflow-hidden rounded-2xl border border-white/30 bg-white/85 shadow-2xl backdrop-blur-xl dark:border-white/10 dark:bg-slate-900/85 flex flex-col">
        <div className="h-1 shrink-0 bg-gradient-to-r from-amber-400 via-emerald-400 to-sky-400" />

        <header className="flex items-start justify-between gap-2 px-5 py-3 shrink-0">
          <div>
            <h2 className="text-base font-semibold text-zinc-800 dark:text-zinc-100">
              管理上传预设
            </h2>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
              {loaded
                ? "改名、描述或隐藏都会即时生效。"
                : "粘贴上传时拿到的管理密钥，验证通过后即可编辑。"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭"
            className="flex h-7 w-7 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-black/5 hover:text-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/10 dark:hover:text-zinc-100"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        {loaded ? (
          <ManageForm
            loaded={loaded}
            busy={busy}
            setBusy={setBusy}
            setToast={setToast}
            onUpdate={(album) => setLoaded({ ...loaded, album })}
          />
        ) : (
          <KeyEntry
            keyDraft={keyDraft}
            onChange={setKeyDraft}
            busy={busy}
            error={error}
            onSubmit={() => void handleQuery()}
          />
        )}

        {toast ? (
          <div className="pointer-events-none absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-black/80 px-4 py-1.5 text-[11px] text-white shadow-lg backdrop-blur-sm">
            {toast}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 第一段：输入密钥
// ---------------------------------------------------------------------------

function KeyEntry({
  keyDraft,
  onChange,
  busy,
  error,
  onSubmit,
}: {
  keyDraft: string;
  onChange: (v: string) => void;
  busy: boolean;
  error: string;
  onSubmit: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-3 px-5 pb-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
          管理密钥
        </span>
        <input
          type="password"
          value={keyDraft}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) onSubmit();
          }}
          autoComplete="off"
          autoFocus
          placeholder="粘贴 64 位 hex 字符串"
          className="w-full rounded-md border border-black/10 bg-white/80 px-2.5 py-2 font-mono text-[12px] text-zinc-800 outline-none transition-colors placeholder:text-zinc-400 focus:border-amber-400 dark:border-white/10 dark:bg-slate-800/60 dark:text-zinc-100"
        />
        <p className="text-[10px] text-zinc-500 dark:text-zinc-400">
          只有这份密钥能管理对应的预设——本机没存任何副本，每次都得手动粘。
        </p>
      </label>
      {error ? (
        <div className="rounded-md border border-rose-300/40 bg-rose-50/70 px-3 py-2 text-[11px] text-rose-700 dark:border-rose-300/30 dark:bg-rose-400/10 dark:text-rose-300">
          {error}
        </div>
      ) : null}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy || keyDraft.trim().length === 0}
          className="rounded-md border border-amber-400/60 bg-amber-500 px-4 py-1.5 text-[12px] font-medium text-white shadow-sm transition-colors hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "验证中…" : "查询"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 第二段：管理表单
// ---------------------------------------------------------------------------

function ManageForm({
  loaded,
  busy,
  setBusy,
  setToast,
  onUpdate,
}: {
  loaded: LoadedAlbum;
  busy: boolean;
  setBusy: (v: boolean) => void;
  setToast: (v: string) => void;
  onUpdate: (album: AlbumDto) => void;
}): JSX.Element {
  const { album, images, managementKey } = loaded;
  const [name, setName] = useState<string>(album.name);
  const [description, setDescription] = useState<string>(album.description ?? "");
  const [uploaderName, setUploaderName] = useState<string>(album.uploaderName ?? "");

  // 切换 album（理论上同一会话内不会变，但 hook 写法保险）时同步草稿
  useEffect(() => {
    setName(album.name);
    setDescription(album.description ?? "");
    setUploaderName(album.uploaderName ?? "");
  }, [album.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const trimmedName = name.trim();
  const nameValid = trimmedName.length > 0 && trimmedName.length <= MAX_NAME_LEN;
  const descValid = description.length <= MAX_DESC_LEN;
  const dirty =
    trimmedName !== album.name.trim() ||
    description.trim() !== (album.description ?? "").trim() ||
    uploaderName.trim() !== (album.uploaderName ?? "").trim();

  const handleSave = async (): Promise<void> => {
    if (!nameValid || !descValid || !dirty) return;
    setBusy(true);
    try {
      const res = await updateAlbum(album.id, managementKey, {
        name: trimmedName,
        description: description.trim() || null,
        uploaderName: uploaderName.trim() || null,
      });
      onUpdate(res.album);
      setToast("已保存");
    } catch (err) {
      const msg = err instanceof CommunityError ? err.message : String((err as Error).message ?? err);
      setToast(`保存失败：${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const hidden = album.status === "hidden_by_owner";
  const lockedByAdmin = album.status === "hidden_by_admin";

  const handleToggleHidden = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await setAlbumVisibilityByKey(album.id, managementKey, !hidden);
      // 本地同步状态
      onUpdate({ ...album, status: res.status });
      setToast(hidden ? "已恢复显示" : "已隐藏，社区里看不到了");
    } catch (err) {
      const msg = err instanceof CommunityError ? err.message : String((err as Error).message ?? err);
      setToast(`操作失败：${msg}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 overflow-y-auto px-5 pb-4">
      {/* 顶部摘要：图集 id / 状态 / 图数量 */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-black/5 bg-white/40 px-3 py-2 text-[11px] text-zinc-600 dark:border-white/5 dark:bg-slate-800/40 dark:text-zinc-300">
        <span className="font-medium">{album.name}</span>
        <span className="rounded bg-zinc-200/70 px-1.5 py-0.5 text-[10px] text-zinc-600 dark:bg-zinc-700/60 dark:text-zinc-300">
          {images.length} 张
        </span>
        {lockedByAdmin ? (
          <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] text-rose-700 dark:text-rose-300">
            已被管理员锁定
          </span>
        ) : hidden ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
            已隐藏（只有你看得到）
          </span>
        ) : (
          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300">
            社区可见
          </span>
        )}
      </div>

      <label className="flex flex-col gap-1">
        <span className="flex items-center justify-between text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
          图集名称
          <span className={`text-[10px] ${trimmedName.length > MAX_NAME_LEN ? "text-rose-600" : "text-zinc-400 dark:text-zinc-500"}`}>
            {trimmedName.length} / {MAX_NAME_LEN}
          </span>
        </span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy || lockedByAdmin}
          className="w-full rounded-md border border-black/10 bg-white/80 px-2.5 py-2 text-[13px] text-zinc-800 outline-none transition-colors focus:border-emerald-400 disabled:opacity-60 dark:border-white/10 dark:bg-slate-800/60 dark:text-zinc-100"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="flex items-center justify-between text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
          描述
          <span className={`text-[10px] ${description.length > MAX_DESC_LEN ? "text-rose-600" : "text-zinc-400 dark:text-zinc-500"}`}>
            {description.length} / {MAX_DESC_LEN}
          </span>
        </span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          disabled={busy || lockedByAdmin}
          className="w-full resize-y rounded-md border border-black/10 bg-white/80 px-2.5 py-2 text-[12px] text-zinc-800 outline-none transition-colors focus:border-emerald-400 disabled:opacity-60 dark:border-white/10 dark:bg-slate-800/60 dark:text-zinc-100"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
          上传者署名
          <span className="ml-1 text-[10px] text-zinc-400 dark:text-zinc-500">（可空）</span>
        </span>
        <input
          value={uploaderName}
          onChange={(e) => setUploaderName(e.target.value)}
          disabled={busy || lockedByAdmin}
          placeholder="例：阿虚"
          className="w-full rounded-md border border-black/10 bg-white/80 px-2.5 py-2 text-[12px] text-zinc-800 outline-none transition-colors focus:border-emerald-400 disabled:opacity-60 dark:border-white/10 dark:bg-slate-800/60 dark:text-zinc-100"
        />
      </label>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-black/5 bg-white/40 px-3 py-2 dark:border-white/5 dark:bg-slate-800/40">
        <div className="flex flex-col">
          <span className="text-[12px] font-medium text-zinc-700 dark:text-zinc-200">
            社区可见性
          </span>
          <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
            {hidden
              ? "目前隐藏中，社区列表不显示。"
              : "目前公开，社区可下载使用。"}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void handleToggleHidden()}
          disabled={busy || lockedByAdmin}
          className={`rounded-md px-3 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            hidden
              ? "border border-emerald-400/60 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:border-emerald-300/40 dark:text-emerald-300"
              : "border border-rose-400/50 bg-rose-50/70 text-rose-700 hover:bg-rose-100/70 dark:border-rose-300/30 dark:bg-rose-500/10 dark:text-rose-300"
          }`}
        >
          {hidden ? "恢复显示" : "从社区隐藏"}
        </button>
      </div>

      <div className="flex justify-end gap-2 border-t border-black/5 pt-3 dark:border-white/5">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={busy || !dirty || !nameValid || !descValid || lockedByAdmin}
          className="rounded-md border border-amber-400/60 bg-amber-500 px-4 py-1.5 text-[12px] font-medium text-white shadow-sm transition-colors hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "保存中…" : dirty ? "保存修改" : "无变动"}
        </button>
      </div>
    </div>
  );
}
