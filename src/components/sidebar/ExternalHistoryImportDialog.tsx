import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "../../lib/bridge";
import {
  externalSessionKey,
  sourceLabel,
  type ExternalHistorySource,
  type ExternalSessionPreview,
  type ExternalSessionRef,
  type ImportExternalSessionsResult,
} from "../../types/externalHistory";

interface ExternalHistoryImportDialogProps {
  importedIds: ReadonlySet<string>;
  onClose: () => void;
  onImported: () => void;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

type ImportState =
  | { kind: "idle" }
  | { kind: "importing" }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

function formatDate(timestamp: number): string {
  if (!timestamp) return "Unknown date";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function basename(path: string | null): string {
  if (!path) return "未选择项目";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

export function ExternalHistoryImportDialog({
  importedIds,
  onClose,
  onImported,
}: ExternalHistoryImportDialogProps): JSX.Element {
  const [sessions, setSessions] = useState<ExternalSessionPreview[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [source, setSource] = useState<"all" | ExternalHistorySource>("all");
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [importState, setImportState] = useState<ImportState>({ kind: "idle" });

  useEffect(() => {
    let active = true;
    const load = async (): Promise<void> => {
      try {
        const result = await invoke<ExternalSessionPreview[]>("scan_external_sessions");
        if (!active) return;
        setSessions(result);
        setLoadState({ kind: "ready" });
      } catch (error) {
        if (!active) return;
        setLoadState({ kind: "error", message: String(error) });
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && importState.kind !== "importing") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [importState.kind, onClose]);

  const visibleSessions = useMemo(
    () => (source === "all" ? sessions : sessions.filter((session) => session.source === source)),
    [sessions, source],
  );
  const allVisibleSelected = visibleSessions.length > 0
    && visibleSessions.every((session) => selected.has(externalSessionKey(session)));

  const toggleSession = (session: ExternalSessionPreview): void => {
    const key = externalSessionKey(session);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAllVisible = (): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const session of visibleSessions) next.delete(externalSessionKey(session));
      } else {
        for (const session of visibleSessions) next.add(externalSessionKey(session));
      }
      return next;
    });
  };

  const importSelected = async (): Promise<void> => {
    if (selected.size === 0 || importState.kind === "importing") return;
    const selections: ExternalSessionRef[] = sessions
      .filter((session) => selected.has(externalSessionKey(session)))
      .map((session) => ({
        source: session.source,
        nativeSessionId: session.nativeSessionId,
      }));
    setImportState({ kind: "importing" });
    try {
      const result = await invoke<ImportExternalSessionsResult>("import_external_sessions", { selections });
      onImported();
      const skippedText = result.skipped.length > 0 ? `，跳过 ${result.skipped.length} 条` : "";
      setImportState({ kind: "done", message: `已导入 ${result.imported.length} 个完整对话${skippedText}` });
      setSelected(new Set());
    } catch (error) {
      setImportState({ kind: "error", message: String(error) });
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/45 p-3 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget && importState.kind !== "importing") onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="导入本机聊天记录"
    >
      <section className="flex max-h-[min(760px,92dvh)] w-[min(760px,96vw)] flex-col overflow-hidden rounded-2xl border border-white/40 bg-white/90 shadow-2xl backdrop-blur-2xl dark:border-white/10 dark:bg-slate-900/90">
        <div className="h-1 bg-gradient-to-r from-sky-400 via-indigo-400 to-amber-400" />
        <header className="flex items-start justify-between gap-4 border-b border-black/5 px-5 py-4 dark:border-white/10">
          <div>
            <h2 className="text-base font-semibold text-zinc-800 dark:text-zinc-100">导入本机聊天记录</h2>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
              扫描 Codex 与 Claude Code 的本地记录。导入会复制文本、图片、思考和工具记录，不会修改原始记录。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={importState.kind === "importing"}
            aria-label="关闭导入窗口"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-black/5 hover:text-zinc-800 disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-100"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3.5 w-3.5">
              <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        {loadState.kind === "loading" ? (
          <div className="flex min-h-[260px] flex-1 items-center justify-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-sky-400/30 border-t-sky-500" />
            正在扫描本机记录...
          </div>
        ) : loadState.kind === "error" ? (
          <div className="m-5 rounded-xl border border-rose-300/50 bg-rose-50/70 p-4 text-sm text-rose-700 dark:border-rose-300/20 dark:bg-rose-400/10 dark:text-rose-200">
            无法读取本机记录：{loadState.message}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-black/5 px-5 py-3 dark:border-white/10">
              {([
                ["all", "全部"],
                ["codex", "Codex"],
                ["claude-code", "Claude Code"],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setSource(value)}
                  className={`rounded-full px-3 py-1 text-[11px] font-medium transition-colors ${
                    source === value
                      ? "bg-sky-500 text-white shadow-sm shadow-sky-400/25"
                      : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-white/5 dark:text-zinc-300 dark:hover:bg-white/10"
                  }`}
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                onClick={toggleAllVisible}
                disabled={visibleSessions.length === 0}
                className="ml-auto rounded-md border border-black/10 bg-white/60 px-2.5 py-1 text-[11px] text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-white/10 dark:bg-white/5 dark:text-zinc-300 dark:hover:bg-white/10"
              >
                {allVisibleSelected ? "取消全选" : "一键全选"}
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
              {visibleSessions.length === 0 ? (
                <div className="flex min-h-[220px] items-center justify-center px-6 text-center text-sm text-zinc-400 dark:text-zinc-500">
                  未找到可导入的本机对话记录。
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {visibleSessions.map((session) => {
                    const key = externalSessionKey(session);
                    const checked = selected.has(key);
                    const imported = importedIds.has(`external:${session.source}:${session.nativeSessionId}`);
                    return (
                      <label
                        key={key}
                        className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
                          checked
                            ? "border-sky-400/50 bg-sky-400/10"
                            : "border-black/5 bg-white/50 hover:bg-zinc-50 dark:border-white/5 dark:bg-white/[0.03] dark:hover:bg-white/[0.06]"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSession(session)}
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-sky-500"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[13px] font-medium text-zinc-800 dark:text-zinc-100">{session.title}</span>
                            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium ${
                              session.source === "codex"
                                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                : "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                            }`}>
                              {sourceLabel(session.source)}
                            </span>
                            {imported && (
                              <span className="shrink-0 text-[10px] text-sky-600 dark:text-sky-300">已导入</span>
                            )}
                          </div>
                          <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-zinc-400 dark:text-zinc-500">
                            <span>{basename(session.projectPath)}</span>
                            <span>{session.messageCount} 条消息</span>
                            <span>{formatDate(session.updatedAt)}</span>
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}

        <footer className="flex items-center justify-between gap-3 border-t border-black/5 px-5 py-3 dark:border-white/10">
          <div className={`min-w-0 text-[11px] ${
            importState.kind === "error"
              ? "text-rose-600 dark:text-rose-300"
              : importState.kind === "done"
                ? "text-emerald-600 dark:text-emerald-300"
                : "text-zinc-500 dark:text-zinc-400"
          }`}>
            {importState.kind === "importing"
              ? "正在复制完整对话..."
              : importState.kind === "done" || importState.kind === "error"
                ? importState.message
                : `已选择 ${selected.size} 个对话`}
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={importState.kind === "importing"}
              className="rounded-md border border-black/10 bg-white/60 px-3 py-1.5 text-[12px] text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-white/10 dark:bg-white/5 dark:text-zinc-200 dark:hover:bg-white/10"
            >
              关闭
            </button>
            <button
              type="button"
              onClick={() => void importSelected()}
              disabled={selected.size === 0 || loadState.kind !== "ready" || importState.kind === "importing"}
              className="flex items-center gap-1.5 rounded-md border border-sky-400/60 bg-sky-500 px-3 py-1.5 text-[12px] font-medium text-white shadow-sm shadow-sky-400/25 transition-colors hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {importState.kind === "importing" && <span className="h-3 w-3 animate-spin rounded-full border border-white/40 border-t-white" />}
              导入所选
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
