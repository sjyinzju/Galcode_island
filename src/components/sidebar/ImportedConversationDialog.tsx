import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { invoke } from "../../lib/bridge";
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

function formatDate(timestamp: number): string {
  if (!timestamp) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function roleLabel(role: ImportedTranscriptMessage["role"], source: ImportedConversation["source"]): string {
  if (role === "user") return "You";
  if (role === "assistant") return sourceLabel(source);
  if (role === "tool") return "Tool";
  return role;
}

function TranscriptPart({ part }: { part: ImportedTranscriptPart }): JSX.Element {
  if (part.type === "text") {
    return <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>;
  }
  if (part.type === "image") {
    return (
      <img
        src={part.dataUrl}
        alt={part.alt ?? "Imported conversation image"}
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
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
        </div>
      </details>
    );
  }
  if (part.type === "toolCall") {
    return (
      <details className="rounded-lg border border-amber-300/35 bg-amber-500/[0.07] px-3 py-2" open>
        <summary className="cursor-pointer text-[11px] font-semibold text-amber-700 dark:text-amber-300">
          工具调用 · {part.name}
        </summary>
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-[11px] text-zinc-700 dark:text-zinc-300">
          {formatValue(part.input)}
        </pre>
      </details>
    );
  }
  if (part.type === "toolResult") {
    return (
      <details className={`rounded-lg border px-3 py-2 ${
        part.isError
          ? "border-rose-300/35 bg-rose-500/[0.07]"
          : "border-emerald-300/35 bg-emerald-500/[0.06]"
      }`}>
        <summary className={`cursor-pointer text-[11px] font-semibold ${
          part.isError ? "text-rose-700 dark:text-rose-300" : "text-emerald-700 dark:text-emerald-300"
        }`}>
          工具结果{part.isError ? " · 失败" : ""}
        </summary>
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-[11px] text-zinc-700 dark:text-zinc-300">
          {formatValue(part.output)}
        </pre>
      </details>
    );
  }
  return (
    <details className="rounded-lg border border-zinc-300/40 bg-zinc-500/[0.05] px-3 py-2">
      <summary className="cursor-pointer text-[11px] font-medium text-zinc-600 dark:text-zinc-300">
        {part.kind}
      </summary>
      <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-[11px] text-zinc-600 dark:text-zinc-400">
        {formatValue(part.data)}
      </pre>
    </details>
  );
}

export function ImportedConversationDialog({
  conversationId,
  onClose,
}: ImportedConversationDialogProps): JSX.Element {
  const [conversation, setConversation] = useState<ImportedConversation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async (): Promise<void> => {
      try {
        const result = await invoke<ImportedConversation>("load_imported_conversation", { id: conversationId });
        if (active) setConversation(result);
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
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[230] flex items-center justify-center bg-black/50 p-3 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="已导入对话"
    >
      <section className="flex h-[min(820px,94dvh)] w-[min(920px,97vw)] flex-col overflow-hidden rounded-2xl border border-white/40 bg-white/90 shadow-2xl backdrop-blur-2xl dark:border-white/10 dark:bg-slate-900/90">
        <div className="h-1 bg-gradient-to-r from-sky-400 via-indigo-400 to-amber-400" />
        <header className="flex items-start justify-between gap-4 border-b border-black/5 px-5 py-4 dark:border-white/10">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-base font-semibold text-zinc-800 dark:text-zinc-100">
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
                {conversation.projectPath ?? "未选择项目"} · {conversation.messages.length} 条消息 · {formatDate(conversation.updatedAt)}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭对话"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-black/5 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-100"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-3.5 w-3.5">
              <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          {!conversation && !error && (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-sky-400/30 border-t-sky-500" />
              正在加载完整对话...
            </div>
          )}
          {error && (
            <div className="rounded-xl border border-rose-300/50 bg-rose-50/70 p-4 text-sm text-rose-700 dark:border-rose-300/20 dark:bg-rose-400/10 dark:text-rose-200">
              无法加载已导入的对话：{error}
            </div>
          )}
          {conversation && (
            <div className="mx-auto flex max-w-3xl flex-col gap-4">
              {conversation.messages.map((message) => {
                const isUser = message.role === "user";
                const parts = message.parts?.length
                  ? message.parts
                  : [{ type: "text", text: message.content } satisfies ImportedTranscriptPart];
                return (
                  <article key={message.id} className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[92%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed sm:max-w-[82%] ${
                      isUser
                        ? "rounded-tr-sm border border-sky-400/35 bg-sky-400/15 text-zinc-800 dark:border-sky-300/30 dark:bg-sky-400/15 dark:text-zinc-100"
                        : "rounded-tl-sm border border-black/5 bg-zinc-100/70 text-zinc-800 dark:border-white/10 dark:bg-white/[0.06] dark:text-zinc-100"
                    }`}>
                      <div className={`mb-1 text-[9px] font-semibold uppercase tracking-[0.12em] ${
                        isUser ? "text-sky-600 dark:text-sky-300" : "text-zinc-400 dark:text-zinc-500"
                      }`}>
                        {roleLabel(message.role, conversation.source)}
                      </div>
                      <div className="external-conversation-markdown flex flex-col gap-2 break-words">
                        {parts.map((part, index) => (
                          <TranscriptPart key={`${message.id}:${index}`} part={part} />
                        ))}
                      </div>
                    </div>
                  </article>
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
