import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ImportedAssetDownloadButton,
  ImportedImage,
} from "../status-monitor/ImportedImage";
import { invoke } from "../../lib/bridge";
import { SafeMarkdownLink, safeMarkdownUrlTransform } from "../SafeMarkdownLink";
import {
  dedupeImportedConversationMessages,
  formatImportedThinking,
  isActualUserPromptMessage,
  isOpaqueThinkingEvent,
} from "../../lib/importedConversation";
import { PagedImportedValue } from "../status-monitor/PagedImportedValue";
import {
  sourceLabel,
  type ImportedConversation,
  type ImportedTranscriptMessage,
  type ImportedTranscriptPart,
} from "../../types/externalHistory";

interface ImportedConversationDialogProps {
  conversationId: string;
  onClose: () => void;
}

const DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const INITIAL_TRANSCRIPT_COUNT = 80;
const TRANSCRIPT_BATCH_SIZE = 100;
const TRANSCRIPT_MARKDOWN_COMPONENTS: Parameters<typeof ReactMarkdown>[0]["components"] = {
  a: ({ href, children }) => (
    <SafeMarkdownLink
      href={href}
      className="break-all text-sky-600 underline hover:text-sky-700 dark:text-sky-400 dark:hover:text-sky-300"
    >
      {children}
    </SafeMarkdownLink>
  ),
  img: ({ src, alt }) => src ? (
    <ImportedImage
      source={src}
      alt={alt ?? null}
      className="my-2 max-h-[520px] max-w-full rounded-xl border border-black/10 object-contain dark:border-white/10"
    />
  ) : null,
};

function formatDate(timestamp: number): string {
  if (!timestamp) return "未知时间";
  return DATE_FORMATTER.format(timestamp);
}

export function nextTranscriptRenderCount(current: number, total: number): number {
  if (current <= 0) return Math.min(INITIAL_TRANSCRIPT_COUNT, total);
  return Math.min(current + TRANSCRIPT_BATCH_SIZE, total);
}

export function claimTranscriptRenderBatch(
  current: number,
  total: number,
  pending: { current: boolean },
): number | null {
  if (pending.current) return null;
  const next = nextTranscriptRenderCount(current, total);
  if (next === current) return null;
  pending.current = true;
  return next;
}

export function transcriptVirtualItemCount(renderedMessages: number, total: number): number {
  return renderedMessages + (renderedMessages < total ? 1 : 0);
}

export function transcriptVirtualItemKey(
  messages: ReadonlyArray<Pick<ImportedTranscriptMessage, "id">>,
  index: number,
): string {
  const message = messages[index];
  return message ? `${message.id}:${index}` : "load-more";
}

export function taskNotificationSummary(message: ImportedTranscriptMessage): string | null {
  const content = message.content.trim();
  if (!content.startsWith("<task-notification>")) return null;
  return content.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1]?.trim() || "后台任务状态已更新";
}

function roleLabel(message: ImportedTranscriptMessage, source: ImportedConversation["source"]): string {
  if (isActualUserPromptMessage(message)) return "You";
  if (taskNotificationSummary(message)) return "Tool";
  if (message.role === "assistant") return sourceLabel(source);
  if (message.role === "tool" || message.parts?.some((part) => part.type === "toolResult")) {
    return "Tool";
  }
  if (message.role === "user") return "Context";
  return message.role;
}

function DeferredValueDetails({
  label,
  value,
  summaryClassName,
  containerClassName,
}: {
  label: string;
  value: unknown;
  summaryClassName: string;
  containerClassName: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <details
      className={containerClassName}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className={`min-h-9 cursor-pointer py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${summaryClassName}`}>
        {label}
      </summary>
      {open && (
        <PagedImportedValue
          value={value}
          fileName="imported-transcript-value.txt"
          className="pb-2"
        />
      )}
    </details>
  );
}

export function DeferredTranscriptContent({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="min-h-9 cursor-pointer py-2 text-[11px] font-medium text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-zinc-300">
        {label}
      </summary>
      {open ? <div className="pb-1">{children}</div> : null}
    </details>
  );
}

export function TranscriptPart({ part }: { part: ImportedTranscriptPart }): JSX.Element {
  if (part.type === "text") {
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={TRANSCRIPT_MARKDOWN_COMPONENTS}
        urlTransform={safeMarkdownUrlTransform}
      >
        {part.text}
      </ReactMarkdown>
    );
  }
  if (part.type === "image") {
    return (
      <ImportedImage
        source={part.dataUrl}
        assetId={part.assetId}
        alt={part.alt ?? "导入对话中的图片"}
        className="max-h-[520px] max-w-full rounded-xl border border-black/10 object-contain dark:border-white/10"
      />
    );
  }
  if (part.type === "thinking") {
    return (
      <details className="rounded-lg border border-violet-300/30 bg-violet-500/[0.06] px-3 py-2">
        <summary className="cursor-pointer text-[11px] font-medium text-violet-600 dark:text-violet-300">
          思考过程
        </summary>
        <div className="mt-2 text-zinc-600 dark:text-zinc-300">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={TRANSCRIPT_MARKDOWN_COMPONENTS}
            urlTransform={safeMarkdownUrlTransform}
          >
            {formatImportedThinking(part.text)}
          </ReactMarkdown>
        </div>
      </details>
    );
  }
  if (part.type === "toolCall") {
    return (
      <DeferredValueDetails
        label={`工具调用 · ${part.name}`}
        value={part.input}
        containerClassName="rounded-lg border border-amber-300/35 bg-amber-500/[0.07] px-3"
        summaryClassName="text-[11px] font-semibold text-amber-700 dark:text-amber-300"
      />
    );
  }
  if (part.type === "attachment") {
    const name = part.name?.trim() || "未命名附件";
    const source = part.dataUrl ?? part.url;
    return (
      <div className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg border border-zinc-300/60 bg-zinc-100/60 px-3 py-2 text-[11px] text-zinc-700 dark:border-zinc-600/60 dark:bg-zinc-800/60 dark:text-zinc-200">
        <span aria-hidden="true">▤</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{name}</span>
          <span className="block truncate text-[9px] text-zinc-500 dark:text-zinc-400">
            {part.mediaType || "未知类型"}
          </span>
        </span>
        {part.dataUrl ? (
          <a
            href={part.dataUrl}
            download={name}
            rel="noreferrer noopener"
            className="flex min-h-9 shrink-0 items-center rounded-md px-2 font-medium text-sky-700 hover:bg-sky-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-300"
          >
            保存
          </a>
        ) : part.assetId ? (
          <ImportedAssetDownloadButton
            assetId={part.assetId}
            fileName={name}
            className="flex min-h-9 shrink-0 items-center rounded-md px-2 font-medium text-sky-700 hover:bg-sky-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:opacity-60 dark:text-sky-300"
          />
        ) : source ? (
          <SafeMarkdownLink
            href={source}
            className="flex min-h-9 shrink-0 items-center rounded-md px-2 font-medium text-sky-700 hover:bg-sky-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-300"
          >
            打开
          </SafeMarkdownLink>
        ) : (
          <span className="text-[9px] text-zinc-400">仅元数据</span>
        )}
      </div>
    );
  }
  if (part.type === "toolResult") {
    return (
      <DeferredValueDetails
        label={`工具结果${part.isError ? " · 失败" : ""}`}
        value={part.output}
        containerClassName={`rounded-lg border px-3 ${
        part.isError
          ? "border-rose-300/35 bg-rose-500/[0.07]"
          : "border-emerald-300/35 bg-emerald-500/[0.06]"
        }`}
        summaryClassName={`text-[11px] font-semibold ${
          part.isError ? "text-rose-700 dark:text-rose-300" : "text-emerald-700 dark:text-emerald-300"
        }`}
      />
    );
  }
  if (isOpaqueThinkingEvent(part)) {
    return (
      <div className="text-[11px] italic text-zinc-500 dark:text-zinc-400">
        Thinking
      </div>
    );
  }
  return (
    <DeferredValueDetails
      label={part.kind}
      value={part.data}
      containerClassName="rounded-lg border border-zinc-300/40 bg-zinc-500/[0.05] px-3"
      summaryClassName="text-[11px] font-medium text-zinc-600 dark:text-zinc-300"
    />
  );
}

export function ImportedConversationDialog({
  conversationId,
  onClose,
}: ImportedConversationDialogProps): JSX.Element {
  const [conversation, setConversation] = useState<ImportedConversation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renderCount, setRenderCount] = useState(0);
  const dialogRef = useRef<HTMLElement | null>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const renderBatchPendingRef = useRef(false);

  useLayoutEffect(() => {
    renderBatchPendingRef.current = false;
  }, [renderCount]);

  useEffect(() => {
    let active = true;
    setConversation(null);
    setError(null);
    setRenderCount(0);
    const load = async (): Promise<void> => {
      try {
        const result = await invoke<ImportedConversation>("load_imported_conversation", { id: conversationId });
        if (active) {
          setConversation(result);
          setRenderCount(nextTranscriptRenderCount(0, result.messages.length));
        }
      } catch (loadError) {
        if (active) setError(String(loadError));
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [conversationId]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeButtonRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        if (document.querySelector("[data-imported-image-viewer]")) return;
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), a[href], summary, [tabindex]:not([tabindex='-1'])",
      ) ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [onClose]);

  const displayMessages = useMemo(
    () => conversation ? dedupeImportedConversationMessages(conversation.messages) : [],
    [conversation],
  );
  const visibleMessages = useMemo(
    () => displayMessages.slice(0, renderCount),
    [displayMessages, renderCount],
  );
  const totalMessages = displayMessages.length;
  const transcriptVirtualizer = useVirtualizer({
    count: conversation
      ? transcriptVirtualItemCount(visibleMessages.length, totalMessages)
      : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 160,
    getItemKey: (index) => transcriptVirtualItemKey(visibleMessages, index),
    overscan: 6,
  });

  const loadNextBatch = (): void => {
    if (!conversation) return;
    const next = claimTranscriptRenderBatch(
      renderCount,
      totalMessages,
      renderBatchPendingRef,
    );
    if (next !== null) setRenderCount(next);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[230] flex items-center justify-center bg-black/50 p-3 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="imported-conversation-title"
    >
      <section
        ref={dialogRef}
        className="flex h-[min(820px,94dvh)] w-[min(920px,97vw)] flex-col overflow-hidden rounded-2xl border border-white/40 bg-white/90 shadow-2xl backdrop-blur-2xl dark:border-white/10 dark:bg-slate-900/90"
      >
        <div className="h-1 bg-gradient-to-r from-sky-400 via-indigo-400 to-amber-400" />
        <header className="flex items-start justify-between gap-4 border-b border-black/5 px-5 py-4 dark:border-white/10">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 id="imported-conversation-title" className="truncate text-base font-semibold text-zinc-800 dark:text-zinc-100">
                {conversation?.title ?? "正在加载对话"}
              </h2>
              {conversation && (
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium ${
                  conversation.source === "codex"
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                }`}>
                  {sourceLabel(conversation.source)}
                </span>
              )}
            </div>
            {conversation && (
              <p className="mt-1 truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                {conversation.projectPath ?? "未选择项目"} · {totalMessages} 条消息 · {formatDate(conversation.updatedAt)}
              </p>
            )}
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="关闭对话"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-black/5 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-100"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3.5 w-3.5">
              <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <main
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6"
          onScroll={(event) => {
            const element = event.currentTarget;
            if (element.scrollHeight - element.scrollTop - element.clientHeight < 480) {
              loadNextBatch();
            }
          }}
        >
          {!conversation && !error && (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-sky-400/30 border-t-sky-500 motion-reduce:animate-none" />
              正在加载完整对话...
            </div>
          )}
          {error && (
            <div className="rounded-xl border border-rose-300/50 bg-rose-50/70 p-4 text-sm text-rose-700 dark:border-rose-300/20 dark:bg-rose-400/10 dark:text-rose-200">
              无法加载已导入的对话：{error}
            </div>
          )}
          {conversation && (
            <div
              className="relative mx-auto w-full max-w-3xl"
              style={{ height: `${transcriptVirtualizer.getTotalSize()}px` }}
            >
              {transcriptVirtualizer.getVirtualItems().map((virtualItem) => {
                const message = visibleMessages[virtualItem.index];
                if (!message) {
                  return (
                    <div
                      key="load-more"
                      ref={transcriptVirtualizer.measureElement}
                      data-index={virtualItem.index}
                      className="absolute left-0 top-0 flex w-full justify-center pb-4"
                      style={{ transform: `translateY(${virtualItem.start}px)` }}
                    >
                      <button
                        type="button"
                        onClick={loadNextBatch}
                        className="min-h-11 rounded-md px-4 text-[11px] font-medium text-sky-700 hover:bg-sky-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-300"
                      >
                        加载更多（已显示 {renderCount}/{totalMessages}）
                      </button>
                    </div>
                  );
                }
                const isUser = isActualUserPromptMessage(message);
                const virtualKey = transcriptVirtualItemKey(
                  visibleMessages,
                  virtualItem.index,
                );
                const notification = taskNotificationSummary(message);
                const isTool = Boolean(
                  notification ||
                  message.role === "tool" ||
                  message.parts?.some((part) => part.type === "toolCall" || part.type === "toolResult")
                );
                const isContext = !isUser && !isTool &&
                  ["user", "developer", "system"].includes(message.role);
                const collapsedLabel = message.isApiError === true ||
                    /^API Error(?:\s*:|$)/i.test(message.content.trim())
                  ? "API 错误"
                  : isContext
                    ? "内部上下文"
                    : null;
                const parts = message.parts?.length
                  ? message.parts
                  : [{ type: "text", text: message.content } satisfies ImportedTranscriptPart];
                const messageContent = (
                  <div className="external-conversation-markdown flex flex-col gap-2 break-words">
                    {notification ? (
                      <div className="whitespace-pre-wrap text-[12px] text-zinc-600 dark:text-zinc-300">
                        {notification}
                      </div>
                    ) : parts.map((part, index) => (
                      <TranscriptPart key={`${virtualKey}:${index}`} part={part} />
                      ))}
                  </div>
                );
                return (
                  <div
                    key={virtualKey}
                    ref={transcriptVirtualizer.measureElement}
                    data-index={virtualItem.index}
                    className="absolute left-0 top-0 w-full pb-4"
                    style={{ transform: `translateY(${virtualItem.start}px)` }}
                  >
                    <article className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[92%] px-3.5 py-2.5 text-[13px] leading-relaxed sm:max-w-[82%] ${
                        isUser
                          ? "rounded-tr-sm border border-sky-400/35 bg-sky-400/15 text-zinc-800 dark:border-sky-300/30 dark:bg-sky-400/15 dark:text-zinc-100"
                          : isTool
                            ? "rounded-lg border border-zinc-300/50 bg-zinc-100/50 text-zinc-700 dark:border-zinc-700/60 dark:bg-zinc-800/35 dark:text-zinc-200"
                            : isContext
                              ? "rounded-lg border border-dashed border-zinc-300/60 bg-transparent text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
                              : "rounded-tl-sm border border-black/5 bg-zinc-100/70 text-zinc-800 dark:border-white/10 dark:bg-white/[0.06] dark:text-zinc-100"
                      }`}>
                        <div className={`mb-1 flex items-center gap-2 text-[9px] font-semibold uppercase tracking-[0.12em] ${
                          isUser ? "text-sky-600 dark:text-sky-300" : "text-zinc-400 dark:text-zinc-500"
                        }`}>
                          <span>{roleLabel(message, conversation.source)}</span>
                          <time dateTime={message.timestamp ? new Date(message.timestamp).toISOString() : undefined}>
                            {formatDate(message.timestamp)}
                          </time>
                        </div>
                        {collapsedLabel
                          ? (
                              <DeferredTranscriptContent label={collapsedLabel}>
                                {messageContent}
                              </DeferredTranscriptContent>
                            )
                          : messageContent}
                      </div>
                    </article>
                  </div>
                );
              })}
            </div>
          )}
        </main>
      </section>
    </div>,
    document.body,
  );
}
