import { useEffect, useMemo, useState } from "react";
import { useTabsStore, type ArchivedSession } from "../../stores/useTabsStore";
import { useUiStore } from "../../stores/useUiStore";
import { useAppStore } from "../../stores/useAppStore";
import { useImportedConversationsStore } from "../../stores/useImportedConversationsStore";
import { useNow } from "../../hooks/useNow";
import { isTauri } from "../../lib/bridge";
import { sourceLabel, type ImportedConversationSummary } from "../../types/externalHistory";
import { ExternalHistoryImportDialog } from "./ExternalHistoryImportDialog";
import { ImportedConversationDialog } from "./ImportedConversationDialog";

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
  onDelete: () => void;
}

function ImportedHistoryRow({ item, now, onOpen, onDelete }: ImportedHistoryRowProps): JSX.Element {
  return (
    <div
      onClick={onOpen}
      className="group relative cursor-pointer rounded-lg border border-sky-400/20 bg-sky-400/[0.06] px-3 py-2.5 text-[13px] text-zinc-700 transition-all hover:bg-sky-400/[0.12] sm:px-2.5 sm:py-2 dark:border-sky-300/15 dark:bg-sky-400/[0.07] dark:text-zinc-300 dark:hover:bg-sky-400/[0.12]"
      role="button"
      title="查看已导入的完整对话"
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
  const setActiveTab = useTabsStore((state) => state.setActiveTab);
  const setLeftSidebarView = useUiStore((state) => state.setLeftSidebarView);
  const setIsStarted = useAppStore((state) => state.setIsStarted);
  const importedConversations = useImportedConversationsStore((state) => state.conversations);
  const importedLoaded = useImportedConversationsStore((state) => state.loaded);
  const refreshImportedConversations = useImportedConversationsStore((state) => state.refresh);
  const removeImportedConversation = useImportedConversationsStore((state) => state.remove);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [openImportedConversationId, setOpenImportedConversationId] = useState<string | null>(null);

  const archivedSessions = useMemo(
    () => history.slice().sort((first, second) => second.closedAt - first.closedAt),
    [history],
  );
  const importedIds = useMemo(
    () => new Set(importedConversations.map((conversation) => conversation.id)),
    [importedConversations],
  );
  const now = useNow();

  useEffect(() => {
    if (!importedLoaded) void refreshImportedConversations();
  }, [importedLoaded, refreshImportedConversations]);

  const handleRestore = (id: string): void => {
    const newId = restoreFromHistory(id);
    if (!newId) return;
    setActiveTab(newId);
    setLeftSidebarView("projects");
    setIsStarted(true);
  };

  const handleDeleteImported = (id: string): void => {
    if (!window.confirm("删除这条已导入的完整对话？原始 Codex / Claude Code 记录不会受影响。")) {
      return;
    }
    void removeImportedConversation(id).catch((error) => {
      console.error("Failed to delete imported conversation", error);
    });
  };

  const importDialog = isImportOpen ? (
    <ExternalHistoryImportDialog
      importedIds={importedIds}
      onClose={() => setIsImportOpen(false)}
      onImported={() => void refreshImportedConversations()}
    />
  ) : null;

  const conversationDialog = openImportedConversationId ? (
    <ImportedConversationDialog
      conversationId={openImportedConversationId}
      onClose={() => setOpenImportedConversationId(null)}
    />
  ) : null;

  if (archivedSessions.length === 0 && importedConversations.length === 0) {
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
        {importDialog}
        {conversationDialog}
      </>
    );
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
        <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400 dark:text-zinc-500">
            历史会话 {archivedSessions.length + importedConversations.length}
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
            {archivedSessions.length > 0 && (
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
          {importedConversations.map((item) => (
            <ImportedHistoryRow
              key={item.id}
              item={item}
              now={now}
              onOpen={() => setOpenImportedConversationId(item.id)}
              onDelete={() => handleDeleteImported(item.id)}
            />
          ))}
          {archivedSessions.map((item) => (
            <HistoryRow
              key={item.id}
              item={item}
              now={now}
              onRestore={() => handleRestore(item.id)}
              onDelete={() => removeFromHistory(item.id)}
            />
          ))}
        </div>
      </div>
      {importDialog}
      {conversationDialog}
    </>
  );
}
