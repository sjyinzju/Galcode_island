// 左栏“历史会话”视图：导入记录按 updatedAt、本地归档按 closedAt 统一倒序展示。
// 点击归档项会恢复为可继续的 tab；点击导入项会打开或复用正常对话 tab 继续会话。
// 导入项的“查看”按钮只打开完整记录查看器，删除导入项不会改动原始 Codex / Claude Code 记录。

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useTabsStore, type ArchivedSession } from "../../stores/useTabsStore";
import { useUiStore } from "../../stores/useUiStore";
import { useAppStore } from "../../stores/useAppStore";
import { useImportedConversationsStore } from "../../stores/useImportedConversationsStore";
import { useNow } from "../../hooks/useNow";
import { invoke, isTauri, pickFolder } from "../../lib/bridge";
import {
  importedHistoryErrorBlock,
  mergeImportedConversationTimeline,
} from "../../lib/importedConversation";
import { lazyNamed } from "../../lib/lazyNamed";
import {
  sourceLabel,
  type ImportedConversation,
  type ImportedConversationSummary,
} from "../../types/externalHistory";

const ExternalHistoryImportDialog = lazyNamed(
  () => import("./ExternalHistoryImportDialog"),
  "ExternalHistoryImportDialog",
);
const ImportedConversationDialog = lazyNamed(
  () => import("./ImportedConversationDialog"),
  "ImportedConversationDialog",
);

function basename(path: string | null): string {
  if (!path) return "未选择项目";
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function relativeTime(timestamp: number, now: number): string {
  if (!timestamp) return "未知时间";
  const difference = Math.max(0, now - timestamp);
  if (difference < 60_000) return "刚刚";
  if (difference < 3_600_000) return `${Math.floor(difference / 60_000)} 分钟前`;
  if (difference < 86_400_000) return `${Math.floor(difference / 3_600_000)} 小时前`;
  return `${Math.floor(difference / 86_400_000)} 天前`;
}

export type HistoryListEntry =
  | { kind: "imported"; item: ImportedConversationSummary; timestamp: number }
  | { kind: "archived"; item: ArchivedSession; timestamp: number };

export function mergeHistoryEntries(
  importedConversations: readonly ImportedConversationSummary[],
  archivedSessions: readonly ArchivedSession[],
): HistoryListEntry[] {
  return [
    ...importedConversations.map((item) => ({
      kind: "imported" as const,
      item,
      timestamp: item.updatedAt,
    })),
    ...archivedSessions.map((item) => ({
      kind: "archived" as const,
      item,
      timestamp: item.closedAt,
    })),
  ].sort((first, second) => second.timestamp - first.timestamp);
}

interface HistoryRowProps {
  item: ArchivedSession;
  now: number;
  onRestore: () => void;
  onDelete: () => void;
}

function HistoryRow({ item, now, onRestore, onDelete }: HistoryRowProps): JSX.Element {
  return (
    <div
      onClick={onRestore}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          onDelete();
        }
      }}
      className="group relative cursor-pointer rounded-lg border border-white/40 bg-white/40 px-3 py-2.5 text-[13px] text-zinc-700 transition-all hover:bg-white/70 sm:px-2.5 sm:py-2 sm:text-[11px] dark:border-white/10 dark:bg-zinc-800/40 dark:text-zinc-300 dark:hover:bg-zinc-800/65"
      role="button"
      title="恢复此历史会话"
    >
      <div className="flex items-start gap-2 sm:gap-1.5">
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-zinc-300 sm:mt-1 sm:h-1.5 sm:w-1.5 dark:bg-zinc-600" />
        <div className="min-w-0 flex-1 pr-7 sm:pr-0">
          <div className="truncate font-medium leading-tight" title={item.summary}>
            {item.summary}
          </div>
          <div className="mt-0.5 truncate text-[11px] tracking-wide text-zinc-400 sm:text-[10px] dark:text-zinc-500">
            {basename(item.projectPath)} · {item.agent} · {relativeTime(item.closedAt, now)}
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
        aria-label="删除历史会话"
        className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded text-zinc-400 opacity-100 transition-opacity hover:bg-rose-400/20 hover:text-rose-500 sm:h-4 sm:w-4 sm:opacity-0 sm:group-hover:opacity-100 dark:text-zinc-500 dark:hover:text-rose-400"
      >
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-2.5 w-2.5">
          <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

interface ImportedHistoryRowProps {
  item: ImportedConversationSummary;
  now: number;
  onOpen: () => void;
  onView: () => void;
  onDelete: () => void;
}

function ImportedHistoryRow({
  item,
  now,
  onOpen,
  onView,
  onDelete,
}: ImportedHistoryRowProps): JSX.Element {
  return (
    <div
      onClick={onOpen}
      className="group relative cursor-pointer rounded-lg border border-sky-400/20 bg-sky-400/[0.06] px-3 py-2.5 text-[13px] text-zinc-700 transition-all hover:bg-sky-400/[0.12] sm:px-2.5 sm:py-2 dark:border-sky-300/15 dark:bg-sky-400/[0.07] dark:text-zinc-300 dark:hover:bg-sky-400/[0.12]"
      role="button"
      title="在对话框中继续"
    >
      <div className="flex items-start gap-2 sm:gap-1.5">
        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-sky-400 sm:mt-1 sm:h-1.5 sm:w-1.5" />
        <div className="min-w-0 flex-1 pr-7 sm:pr-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <div className="min-w-0 truncate font-medium leading-tight" title={item.title}>
              {item.title}
            </div>
            <span className="shrink-0 rounded bg-sky-400/15 px-1 py-0.5 text-[9px] font-medium text-sky-700 dark:text-sky-300">
              {sourceLabel(item.source)}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[11px] tracking-wide text-zinc-400 sm:text-[10px] dark:text-zinc-500">
            {basename(item.projectPath)} · {item.messageCount} 条消息 · {relativeTime(item.updatedAt, now)}
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onView();
        }}
        aria-label="查看完整导入记录"
        title="查看完整导入记录"
        className="absolute right-8 top-1 flex h-7 w-7 items-center justify-center rounded text-zinc-400 opacity-100 transition-opacity hover:bg-sky-400/15 hover:text-sky-600 sm:h-4 sm:w-4 sm:opacity-0 sm:group-hover:opacity-100 dark:text-zinc-500 dark:hover:text-sky-300"
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="h-3 w-3">
          <path d="M1.5 8s2.2-4 6.5-4 6.5 4 6.5 4-2.2 4-6.5 4-6.5-4-6.5-4Z" />
          <circle cx="8" cy="8" r="1.8" />
        </svg>
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
        aria-label="删除已导入对话"
        className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded text-zinc-400 opacity-100 transition-opacity hover:bg-rose-400/20 hover:text-rose-500 sm:h-4 sm:w-4 sm:opacity-0 sm:group-hover:opacity-100 dark:text-zinc-500 dark:hover:text-rose-400"
      >
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-2.5 w-2.5">
          <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

export function HistoryList(): JSX.Element {
  const history = useTabsStore((state) => state.history);
  const restoreFromHistory = useTabsStore((state) => state.restoreFromHistory);
  const removeFromHistory = useTabsStore((state) => state.removeFromHistory);
  const clearHistory = useTabsStore((state) => state.clearHistory);
  const createTab = useTabsStore((state) => state.createTab);
  const updateTab = useTabsStore((state) => state.updateTab);
  const setActiveTab = useTabsStore((state) => state.setActiveTab);
  const setLeftSidebarView = useUiStore((state) => state.setLeftSidebarView);
  const setIsStarted = useAppStore((state) => state.setIsStarted);
  const importedConversations = useImportedConversationsStore((state) => state.conversations);
  const importedLoaded = useImportedConversationsStore((state) => state.loaded);
  const refreshImportedConversations = useImportedConversationsStore((state) => state.refresh);
  const mergeImportedConversations = useImportedConversationsStore((state) => state.merge);
  const removeImportedConversation = useImportedConversationsStore((state) => state.remove);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [openImportedConversationId, setOpenImportedConversationId] = useState<string | null>(null);
  const openingImportedConversation = useRef(false);

  const historyEntries = useMemo(
    () => mergeHistoryEntries(importedConversations, history),
    [history, importedConversations],
  );
  const importedIds = useMemo(
    () => new Set(importedConversations.map((conversation) => conversation.id)),
    [importedConversations],
  );
  const now = useNow();

  useEffect(() => {
    if (!importedLoaded) void refreshImportedConversations();
  }, [importedLoaded, refreshImportedConversations]);

  const activateTab = (id: string): void => {
    setActiveTab(id);
    setLeftSidebarView("projects");
    setIsStarted(true);
  };

  const handleRestore = (id: string): void => {
    const newId = restoreFromHistory(id);
    if (newId) activateTab(newId);
  };

  const handleOpenImported = async (summary: ImportedConversationSummary): Promise<void> => {
    if (openingImportedConversation.current) return;
    const existingTab = Object.values(useTabsStore.getState().tabs).find(
      (tab) =>
        tab.importedConversationId === summary.id ||
        (tab.agent === summary.source &&
          tab.agentNativeSessionId === summary.nativeSessionId),
    );
    if (
      existingTab?.importedConversationId === summary.id &&
      existingTab.hasFullImportedHistory
    ) {
      try {
        if (!existingTab.projectPath) throw new Error("Missing project directory");
        await invoke("validate_directory", { path: existingTab.projectPath });
        activateTab(existingTab.id);
        return;
      } catch {
        // Continue below so the user can replace a missing or moved directory.
      }
    }
    openingImportedConversation.current = true;
    try {
      let projectPath = existingTab?.projectPath ?? summary.projectPath;
      if (projectPath) {
        try {
          await invoke("validate_directory", { path: projectPath });
        } catch {
          projectPath = null;
        }
      }
      if (!projectPath) {
        projectPath = await pickFolder({
          defaultPath: summary.projectPath ?? undefined,
          title: "选择用于继续此会话的有效项目目录",
        });
        if (!projectPath) {
          return;
        }
      }
      const conversation = await invoke<ImportedConversation>("load_imported_conversation", {
        id: summary.id,
      });
      const importedTab = mergeImportedConversationTimeline(
        conversation,
        existingTab?.cliBlocks ?? [],
        {
          deletedImportedBlockIds: existingTab?.deletedImportedBlockIds,
          projectPath,
        },
      );
      if (existingTab) {
        updateTab(existingTab.id, {
          projectPath,
          importedConversationId: summary.id,
          hasFullImportedHistory: true,
          importedHistoryError: null,
          cliBlocks: importedTab.cliBlocks,
          lastUserPrompt: importedTab.lastUserPrompt,
        });
        activateTab(existingTab.id);
        return;
      }
      const tabId = createTab(importedTab);
      activateTab(tabId);
    } catch (error) {
      console.error("Failed to open imported conversation", error);
      const message = "导入历史文件不可用，请重新导入该会话后重试。";
      if (existingTab) {
        useTabsStore.getState().upsertCliBlock(
          existingTab.id,
          importedHistoryErrorBlock(summary.id, message),
        );
        updateTab(existingTab.id, { importedHistoryError: message });
        activateTab(existingTab.id);
      } else {
        const tabId = createTab({
          title: summary.title,
          agent: summary.source,
          projectPath: summary.projectPath,
          agentNativeSessionId: summary.nativeSessionId,
          importedConversationId: summary.id,
          importedHistoryError: message,
          cliBlocks: [importedHistoryErrorBlock(summary.id, message)],
        });
        activateTab(tabId);
      }
    } finally {
      openingImportedConversation.current = false;
    }
  };

  const handleDeleteImported = (id: string): void => {
    if (!window.confirm("删除这条已导入的完整对话？原始 Codex / Claude Code 记录不会受影响。")) {
      return;
    }
    void removeImportedConversation(id).catch((error) => {
      console.error("Failed to delete imported conversation", error);
    });
  };

  const dialogs = (
    <Suspense fallback={null}>
      {isImportOpen && (
        <ExternalHistoryImportDialog
          importedIds={importedIds}
          onClose={() => setIsImportOpen(false)}
          onImported={(result) => mergeImportedConversations(result.imported)}
        />
      )}
      {openImportedConversationId && (
        <ImportedConversationDialog
          conversationId={openImportedConversationId}
          onClose={() => setOpenImportedConversationId(null)}
        />
      )}
    </Suspense>
  );

  if (history.length === 0 && importedConversations.length === 0) {
    return (
      <>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 text-center text-[11px] text-zinc-400 dark:text-zinc-500">
          <span>还没有历史会话。</span>
          {isTauri && (
            <button
              type="button"
              onClick={() => setIsImportOpen(true)}
              className="rounded-md border border-sky-400/40 bg-sky-400/10 px-3 py-1.5 text-[11px] font-medium text-sky-700 transition-colors hover:bg-sky-400/15 dark:text-sky-300"
            >
              导入 Codex / Claude Code 记录
            </button>
          )}
        </div>
        {dialogs}
      </>
    );
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
        <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400 dark:text-zinc-500">
            历史会话 {historyEntries.length}
          </span>
          <div className="flex items-center gap-2">
            {isTauri && (
              <button
                type="button"
                onClick={() => setIsImportOpen(true)}
                className="text-[10px] font-medium text-sky-600 transition-colors hover:text-sky-700 dark:text-sky-300 dark:hover:text-sky-200"
              >
                导入记录
              </button>
            )}
            {history.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm("确定清空所有本地历史会话？此操作无法撤销。")) clearHistory();
                }}
                className="text-[10px] text-zinc-400 transition-colors hover:text-rose-500 dark:text-zinc-500 dark:hover:text-rose-400"
              >
                清空
              </button>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          {historyEntries.map((entry) => entry.kind === "imported" ? (
            <ImportedHistoryRow
              key={`imported:${entry.item.id}`}
              item={entry.item}
              now={now}
              onOpen={() => void handleOpenImported(entry.item)}
              onView={() => setOpenImportedConversationId(entry.item.id)}
              onDelete={() => handleDeleteImported(entry.item.id)}
            />
          ) : (
            <HistoryRow
              key={`archived:${entry.item.id}`}
              item={entry.item}
              now={now}
              onRestore={() => handleRestore(entry.item.id)}
              onDelete={() => removeFromHistory(entry.item.id)}
            />
          ))}
        </div>
      </div>
      {dialogs}
    </>
  );
}
