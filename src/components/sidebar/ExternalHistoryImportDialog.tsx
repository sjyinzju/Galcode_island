import { useEffect, useMemo, useRef, useState } from "react";
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
  onImported: (result: ImportExternalSessionsResult) => void;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

type ImportState =
  | { kind: "idle" }
  | {
      kind: "importing";
      completedBatches: number;
      totalBatches: number;
      importedCount: number;
    }
  | { kind: "done"; message: string; warnings: string[] }
  | { kind: "error"; message: string; warnings: string[] };

export const IMPORT_BATCH_TARGET_BYTES = 480 * 1024 * 1024;
export const IMPORT_HARD_LIMIT_BYTES = 512 * 1024 * 1024;

export interface ImportBatch {
  source: ExternalHistorySource;
  sourceBytes: number;
  selections: ExternalSessionRef[];
}

function normalizedSourceBytes(session: ExternalSessionPreview): number | null {
  const sourceBytes: unknown = session.sourceBytes;
  if (typeof sourceBytes !== "number" || !Number.isFinite(sourceBytes)) return null;
  const normalized = Math.floor(sourceBytes);
  return normalized > 0 ? normalized : null;
}

export function sessionImportBlockReason(session: ExternalSessionPreview): string | null {
  const sourceBytes = normalizedSourceBytes(session);
  return sourceBytes !== null && sourceBytes > IMPORT_HARD_LIMIT_BYTES
    ? "超过 512 MiB 上限，无法导入"
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isImportedConversationSummary(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && (value.source === "codex" || value.source === "claude-code")
    && typeof value.nativeSessionId === "string"
    && typeof value.title === "string"
    && (value.projectPath === null || typeof value.projectPath === "string")
    && typeof value.createdAt === "number"
    && Number.isFinite(value.createdAt)
    && typeof value.updatedAt === "number"
    && Number.isFinite(value.updatedAt)
    && typeof value.importedAt === "number"
    && Number.isFinite(value.importedAt)
    && typeof value.messageCount === "number"
    && Number.isFinite(value.messageCount);
}

export function validateImportResult(value: unknown): ImportExternalSessionsResult {
  if (
    !isRecord(value)
    || !Array.isArray(value.imported)
    || !value.imported.every(isImportedConversationSummary)
    || !Array.isArray(value.skipped)
    || !value.skipped.every((item) => typeof item === "string")
    || !Array.isArray(value.warnings)
    || !value.warnings.every((item) => typeof item === "string")
  ) {
    throw new Error("导入服务返回了无效结果");
  }
  return value as unknown as ImportExternalSessionsResult;
}

export function notifyImportedSafely(
  onImported: (result: ImportExternalSessionsResult) => void,
  result: ImportExternalSessionsResult,
): string | null {
  if (result.imported.length === 0) return null;
  try {
    onImported(result);
    return null;
  } catch (error) {
    return `已导入的对话无法刷新到历史列表：${String(error)}`;
  }
}

export function dialogFocusTarget<T>(
  focusable: readonly T[],
  activeElement: T | null,
  shiftKey: boolean,
): T | null {
  if (focusable.length === 0) return null;
  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  if (!activeElement || !focusable.includes(activeElement)) return shiftKey ? last : first;
  if (shiftKey && activeElement === first) return last;
  if (!shiftKey && activeElement === last) return first;
  return null;
}

export function planImportBatches(
  sessions: readonly ExternalSessionPreview[],
  selected: ReadonlySet<string>,
  targetBytes = IMPORT_BATCH_TARGET_BYTES,
): ImportBatch[] {
  const batches: ImportBatch[] = [];
  const safeTarget = Math.max(1, Math.floor(targetBytes));

  for (const source of ["codex", "claude-code"] as const) {
    let current: ImportBatch | null = null;
    for (const session of sessions) {
      if (session.source !== source || !selected.has(externalSessionKey(session))) continue;
      if (sessionImportBlockReason(session)) continue;
      const sourceBytes = normalizedSourceBytes(session);
      const selection = {
        source: session.source,
        nativeSessionId: session.nativeSessionId,
      };
      if (sourceBytes === null) {
        if (current?.selections.length) batches.push(current);
        current = null;
        batches.push({ source, sourceBytes: 0, selections: [selection] });
        continue;
      }
      if (current && current.selections.length > 0 && current.sourceBytes + sourceBytes > safeTarget) {
        batches.push(current);
        current = null;
      }
      current ??= { source, sourceBytes: 0, selections: [] };
      current.sourceBytes += sourceBytes;
      current.selections.push(selection);
    }
    if (current?.selections.length) batches.push(current);
  }

  return batches;
}

export function aggregateImportResults(
  results: readonly ImportExternalSessionsResult[],
  additionalWarnings: readonly string[] = [],
): ImportExternalSessionsResult {
  const imported: ImportExternalSessionsResult["imported"] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  const importedKeys = new Set<string>();
  const skippedValues = new Set<string>();
  const warningValues = new Set<string>();

  for (const result of results) {
    for (const conversation of result.imported) {
      const key = externalSessionKey(conversation);
      if (importedKeys.has(key)) continue;
      importedKeys.add(key);
      imported.push(conversation);
    }
    for (const value of result.skipped) {
      if (skippedValues.has(value)) continue;
      skippedValues.add(value);
      skipped.push(value);
    }
    for (const value of result.warnings) {
      if (warningValues.has(value)) continue;
      warningValues.add(value);
      warnings.push(value);
    }
  }
  for (const value of additionalWarnings) {
    if (warningValues.has(value)) continue;
    warningValues.add(value);
    warnings.push(value);
  }

  return { imported, skipped, warnings };
}

export function remainingSelectedSessionKeys(
  selected: ReadonlySet<string>,
  result: ImportExternalSessionsResult,
): Set<string> {
  const importedKeys = new Set(result.imported.map(externalSessionKey));
  return new Set([...selected].filter((key) => !importedKeys.has(key)));
}

export function summarizeImportResult(
  result: ImportExternalSessionsResult,
  remainingCount?: number,
): {
  kind: "done" | "error";
  message: string;
  warnings: string[];
} {
  const retainedCount = remainingCount ?? result.skipped.length;
  const importLimitExceeded = result.warnings.some((warning) =>
    /complete import (?:byte )?limit/i.test(warning)
  );
  if (result.imported.length === 0) {
    if (importLimitExceeded) {
      return {
        kind: "error",
        message: "未导入任何对话，历史记录体积已变化，请重新打开导入窗口后重试",
        warnings: result.warnings,
      };
    }
    const retainedText = retainedCount > 0 ? `，${retainedCount} 个对话已保留，可重试` : "，请重试";
    return {
      kind: "error",
      message: `未导入任何对话${retainedText}`,
      warnings: result.warnings,
    };
  }
  const retainedText = retainedCount > 0
    ? importLimitExceeded
      ? "，剩余记录体积已变化，请重新打开导入窗口后重试"
      : `，${retainedCount} 个未完成，已保留可重试`
    : "";
  const warningText = result.warnings.length > 0
    ? `，${result.warnings.length} 条记录需要注意`
    : "";
  return {
    kind: retainedCount > 0 ? "error" : "done",
    message: `已导入 ${result.imported.length} 个完整对话${retainedText}${warningText}`,
    warnings: result.warnings,
  };
}

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
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const importInProgressRef = useRef(false);
  const onCloseRef = useRef(onClose);
  importInProgressRef.current = importState.kind === "importing";
  onCloseRef.current = onClose;

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
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeButtonRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !importInProgressRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), a[href], summary, [tabindex]:not([tabindex='-1'])",
      ) ?? []);
      const target = dialogFocusTarget(
        focusable,
        document.activeElement instanceof HTMLElement ? document.activeElement : null,
        event.shiftKey,
      );
      if (!target) return;
      event.preventDefault();
      target.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, []);

  const visibleSessions = useMemo(
    () => (source === "all" ? sessions : sessions.filter((session) => session.source === source)),
    [sessions, source],
  );
  const selectableVisibleSessions = useMemo(
    () => visibleSessions.filter((session) => !sessionImportBlockReason(session)),
    [visibleSessions],
  );
  const allVisibleSelected = selectableVisibleSessions.length > 0
    && selectableVisibleSessions.every((session) => selected.has(externalSessionKey(session)));

  const toggleSession = (session: ExternalSessionPreview): void => {
    if (sessionImportBlockReason(session)) return;
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
        for (const session of selectableVisibleSessions) next.delete(externalSessionKey(session));
      } else {
        for (const session of selectableVisibleSessions) next.add(externalSessionKey(session));
      }
      return next;
    });
  };

  const importSelected = async (): Promise<void> => {
    if (selected.size === 0 || importInProgressRef.current) return;
    const batches = planImportBatches(sessions, selected);
    if (batches.length === 0) return;
    const attemptedKeys = new Set(
      batches.flatMap((batch) => batch.selections.map(externalSessionKey)),
    );
    const results: ImportExternalSessionsResult[] = [];
    const failedBatchWarnings: string[] = [];
    let result: ImportExternalSessionsResult = { imported: [], skipped: [], warnings: [] };
    let flowErrorMessage: string | null = null;
    importInProgressRef.current = true;
    setImportState({
      kind: "importing",
      completedBatches: 0,
      totalBatches: batches.length,
      importedCount: 0,
    });

    try {
      for (const [index, batch] of batches.entries()) {
        try {
          const value = await invoke<unknown>("import_external_sessions", {
            selections: batch.selections,
          });
          results.push(validateImportResult(value));
        } catch (error) {
          failedBatchWarnings.push(
            `${sourceLabel(batch.source)} 第 ${index + 1}/${batches.length} 批导入失败：${String(error)}`,
          );
        }
        const progress = aggregateImportResults(results);
        setImportState({
          kind: "importing",
          completedBatches: index + 1,
          totalBatches: batches.length,
          importedCount: progress.imported.length,
        });
      }

      result = aggregateImportResults(results, failedBatchWarnings);
      const callbackWarning = notifyImportedSafely(onImported, result);
      if (callbackWarning) {
        result = aggregateImportResults([result], [callbackWarning]);
        flowErrorMessage = "对话已保存，但历史列表刷新失败";
      }
    } catch (error) {
      result = aggregateImportResults(results, [
        ...failedBatchWarnings,
        `导入流程异常：${String(error)}`,
      ]);
      const callbackWarning = notifyImportedSafely(onImported, result);
      if (callbackWarning) {
        result = aggregateImportResults([result], [callbackWarning]);
      }
      flowErrorMessage = result.imported.length > 0
        ? "部分对话已保存，但导入流程异常"
        : "导入流程异常，请重试";
    } finally {
      setSelected((current) => remainingSelectedSessionKeys(current, result));
      const importedAttemptKeys = new Set(
        result.imported.map(externalSessionKey).filter((key) => attemptedKeys.has(key)),
      );
      const remainingCount = attemptedKeys.size - importedAttemptKeys.size;
      const summary = summarizeImportResult(result, remainingCount);
      importInProgressRef.current = false;
      setImportState(flowErrorMessage
        ? {
            kind: "error",
            message: `${summary.message}，${flowErrorMessage}`,
            warnings: result.warnings,
          }
        : summary);
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
      <section ref={dialogRef} className="flex max-h-[min(760px,92dvh)] w-[min(760px,96vw)] flex-col overflow-hidden rounded-2xl border border-white/40 bg-white/90 shadow-2xl backdrop-blur-2xl dark:border-white/10 dark:bg-slate-900/90">
        <div className="h-1 bg-gradient-to-r from-sky-400 via-indigo-400 to-amber-400" />
        <header className="flex items-start justify-between gap-4 border-b border-black/5 px-5 py-4 dark:border-white/10">
          <div>
            <h2 className="text-base font-semibold text-zinc-800 dark:text-zinc-100">导入本机聊天记录</h2>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
              扫描 Codex 与 Claude Code 的本地记录。导入会复制文本、图片、思考和工具记录，不会修改原始记录。
            </p>
          </div>
          <button
            ref={closeButtonRef}
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
                  disabled={importState.kind === "importing"}
                  className={`rounded-full px-3 py-1 text-[11px] font-medium transition-colors ${
                    source === value
                      ? "bg-sky-500 text-white shadow-sm shadow-sky-400/25"
                      : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-white/5 dark:text-zinc-300 dark:hover:bg-white/10"
                  } disabled:opacity-45`}
                >
                  {label}
                </button>
              ))}
              <button
                type="button"
                onClick={toggleAllVisible}
                disabled={selectableVisibleSessions.length === 0 || importState.kind === "importing"}
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
                    const blockedReason = sessionImportBlockReason(session);
                    const checked = !blockedReason && selected.has(key);
                    const imported = importedIds.has(`external:${session.source}:${session.nativeSessionId}`);
                    return (
                      <label
                        key={key}
                        className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
                          blockedReason
                            ? "cursor-not-allowed border-black/5 bg-zinc-100/60 opacity-65 dark:border-white/5 dark:bg-white/[0.02]"
                            : checked
                            ? "border-sky-400/50 bg-sky-400/10"
                            : "cursor-pointer border-black/5 bg-white/50 hover:bg-zinc-50 dark:border-white/5 dark:bg-white/[0.03] dark:hover:bg-white/[0.06]"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSession(session)}
                          disabled={Boolean(blockedReason) || importState.kind === "importing"}
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
                            {blockedReason && (
                              <span className="font-medium text-rose-600 dark:text-rose-300">
                                {blockedReason}
                              </span>
                            )}
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

        {(importState.kind === "done" || importState.kind === "error") && importState.warnings.length > 0 && (
          <details className="border-t border-amber-400/25 bg-amber-50/80 px-5 py-2 text-[11px] text-amber-800 dark:bg-amber-400/10 dark:text-amber-200">
            <summary className="cursor-pointer font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60">
              查看 {importState.warnings.length} 条导入警告
            </summary>
            <ul className="mt-2 max-h-28 list-disc space-y-1 overflow-y-auto pl-4 [overflow-wrap:anywhere]">
              {importState.warnings.map((warning, index) => (
                <li key={`${index}-${warning}`}>{warning}</li>
              ))}
            </ul>
          </details>
        )}

        <footer className="flex items-center justify-between gap-3 border-t border-black/5 px-5 py-3 dark:border-white/10">
          <div aria-live="polite" className={`min-w-0 text-[11px] ${
            importState.kind === "error"
              ? "text-rose-600 dark:text-rose-300"
              : importState.kind === "done"
                ? "text-emerald-600 dark:text-emerald-300"
                : "text-zinc-500 dark:text-zinc-400"
          }`}>
            {importState.kind === "importing"
              ? `正在分批导入 ${importState.completedBatches}/${importState.totalBatches}，已导入 ${importState.importedCount} 个对话...`
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
