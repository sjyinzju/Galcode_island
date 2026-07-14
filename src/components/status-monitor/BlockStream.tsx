// 流式渲染三个 backend 通过 `galcode://cli-output` 推过来的 block。
// 不同类型分别渲染：
//   - text     普通文本气泡（Agent 中间消息）
//   - thought  灰色折叠 / 等宽字体（思考过程）
//   - command  黑底等宽（终端样式 + 命令 + 输出）
//   - todo     列表 + 状态图标
//   - confirm  黄色卡片（auto-approve 模式下也会一闪而过）
//   - tool     一行小标签（OpenCode 工具调用）
//   - file     文件路径 + 工具
//   - status   单行小标签
//   - error    红色提示
//
// 用 AnimatePresence 让新增 / 移除带过渡，但避免每次 update 都触发动画
// （update 是同 id，AnimatePresence 不会重放 enter）。

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useActiveTabActions, useActiveTabField, useActiveTabId } from "../../hooks/useActiveTab";
import { useTabsStore } from "../../stores/useTabsStore";
import { useUiStore, type ActiveMatch } from "../../stores/useUiStore";
import type { CliBlock, CliBlockAttachment } from "../../types/blocks";
import { countOccurrences, highlightText } from "./highlight";
import { ErrorDiagnosisCard } from "./ErrorDiagnosisCard";
import {
  ImportedAssetDownloadButton,
  ImportedImage,
  copyImageSource,
  loadImportedAssetSource,
} from "./ImportedImage";
import { MessageJumpRail } from "./MessageJumpRail";
import { PermissionRequestBlock } from "./PermissionRequestBlock";
import { PagedImportedValue } from "./PagedImportedValue";
import { isNearBottom } from "./scrollUtils";
import {
  findActiveMessageJump,
  jumpToMessage,
  updateMessageJumps,
  type MessageJumpItem,
} from "./messageJumps";
import {
  formatSourceTime,
  getPromptCopyMode,
  getTurnSpacing,
  requiresAttachmentEditWarning,
  sourceRoleLabel,
} from "./blockPresentation";

/// 子组件公共的高亮上下文 prop —— 没 query 时所有子组件渲染行为退化为原状。
interface HighlightCtx {
  query: string;
  activeMatch: ActiveMatch | null;
}
const NO_HIGHLIGHT: HighlightCtx = { query: "", activeMatch: null };

/// 哪些类型的块"打开右栏看详情更划算"——长 output / 大 diff / 多行 stderr 等。
/// 这些类型在中栏渲染时缩略，整块可点击 → 右栏展开完整内容。
const DETAIL_TYPES: ReadonlySet<CliBlock["type"]> = new Set(["command", "diff", "stderr"]);
function shouldOpenDetailOnClick(type: CliBlock["type"]): boolean {
  return DETAIL_TYPES.has(type);
}

/// Markdown 渲染——Agent 输出常含 **bold** / `code` / 代码块 / 列表 / 表格 / 链接。
/// 流式中可能 markdown 不闭合（比如 ``` 还没收尾），react-markdown 会自动容错降级。
const MD_COMPONENTS: Parameters<typeof ReactMarkdown>[0]["components"] = {
  h1: ({ children }) => <h1 className="my-1 text-sm font-bold">{children}</h1>,
  h2: ({ children }) => <h2 className="my-1 text-[13px] font-bold">{children}</h2>,
  h3: ({ children }) => <h3 className="my-0.5 text-xs font-semibold">{children}</h3>,
  h4: ({ children }) => <h4 className="my-0.5 text-xs font-semibold">{children}</h4>,
  p: ({ children }) => <p className="my-1">{children}</p>,
  ul: ({ children }) => <ul className="my-1 ml-4 list-disc space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 ml-4 list-decimal space-y-0.5">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  code: ({ className, children, ...props }) => {
    const isInline = !(className && /^language-/.test(className));
    if (isInline) {
      return (
        <code className="break-all rounded bg-zinc-200/60 px-1 py-0.5 font-mono text-[10px] text-rose-700 dark:bg-zinc-800/60 dark:text-rose-300">
          {children}
        </code>
      );
    }
    return (
      <code className={`${className ?? ""} font-mono`} {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-1 overflow-x-auto rounded-md border border-zinc-700/30 bg-zinc-900/95 p-2 font-mono text-[10px] leading-tight text-zinc-200">
      {children}
    </pre>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="break-all text-sky-600 underline hover:text-sky-700 dark:text-sky-400 dark:hover:text-sky-300"
    >
      {children}
    </a>
  ),
  img: ({ src, alt }) => src ? (
    <ImportedImage
      source={src}
      alt={alt ?? null}
      className="my-2 max-h-[420px] max-w-full rounded-lg object-contain"
    />
  ) : null,
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-zinc-300 pl-2 text-zinc-500 dark:border-zinc-600 dark:text-zinc-400">
      {children}
    </blockquote>
  ),
  strong: ({ children }) => <strong className="font-semibold text-zinc-900 dark:text-zinc-100">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  hr: () => <hr className="my-2 border-zinc-200 dark:border-zinc-700" />,
  table: ({ children }) => (
    <div className="my-1 overflow-x-auto">
      <table className="w-full border-collapse border border-zinc-300 dark:border-zinc-700">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-zinc-100/60 dark:bg-zinc-800/40">{children}</thead>,
  th: ({ children }) => (
    <th className="border border-zinc-300 px-1.5 py-0.5 text-left font-semibold dark:border-zinc-700">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-zinc-300 px-1.5 py-0.5 dark:border-zinc-700">{children}</td>
  ),
};

export function MarkdownText({ content, className }: { content: string; className?: string }): JSX.Element {
  return (
    <div className={`min-w-0 text-xs leading-relaxed [overflow-wrap:anywhere] ${className ?? ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

function statusBadge(status?: string): { label: string; cls: string } {
  switch (status) {
    case "success":
    case "completed":
      return { label: "✓", cls: "text-emerald-600 dark:text-emerald-400" };
    case "error":
    case "failed":
      return { label: "✗", cls: "text-rose-600 dark:text-rose-400" };
    case "running":
      return { label: "⏵", cls: "text-sky-600 dark:text-sky-400" };
    case "waiting":
      return { label: "?", cls: "text-amber-600 dark:text-amber-400" };
    case "pending":
      return { label: "·", cls: "text-zinc-500 dark:text-zinc-400" };
    default:
      return { label: "·", cls: "text-zinc-500 dark:text-zinc-400" };
  }
}

/// 用户原始 prompt：右对齐蓝色气泡，跟 agent 输出（左侧）形成对话感。
/// 不走 markdown — 用户输入通常是单行中文，pre-wrap 保留换行就够。
///
/// hover 时气泡左侧出现 3 个动作按钮（复制 / 编辑重发 / 删除）：
///   - 复制：navigator.clipboard.writeText(content)；2s 内显示"已复制"
///   - 编辑重发：把内容回填到 InputBubble 的 textarea + focus，让用户改完手动启动
///     （故意**不自动启动**，避免用户误触造成意外发起）
///   - 删除：从该 tab 的 cliBlocks 视图里移除；不会影响 agent 后端会话历史
function UserPromptBlock({
  block,
  hl,
}: {
  block: CliBlock;
  hl: HighlightCtx;
}): JSX.Element | null {
  const content = block.content?.trim() ?? "";
  const hasImages = Boolean(block.images?.length);
  const hasAttachments = Boolean(block.attachments?.length);
  const removeCliBlock = useTabsStore((s) => s.removeCliBlock);
  const activeTabId = useActiveTabId();
  const { update } = useActiveTabActions();
  const bumpInputFocus = useUiStore((s) => s.bumpInputFocus);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  // 复制反馈：2s 后回到默认图标。useEffect 而不是 setTimeout 闭包，避免组件卸载时野定时器
  useEffect(() => {
    if (copyState === "idle") return;
    const id = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(id);
  }, [copyState]);

  if (!content && !hasImages && !hasAttachments) return null;

  const handleCopy = async (): Promise<void> => {
    const mode = getPromptCopyMode(block);
    try {
      let copied = false;
      if (mode === "text") {
        copied = await navigator.clipboard.writeText(content).then(() => true);
      } else if (mode === "image" && block.images?.[0]) {
        const image = block.images[0];
        const imageSource = image.dataUrl ?? (
          image.assetId ? await loadImportedAssetSource(image.assetId) : null
        );
        copied = imageSource ? await copyImageSource(imageSource) : false;
      }
      setCopyState(copied ? "copied" : "failed");
    } catch {
      setCopyState("failed");
    }
  };

  const handleEdit = (): void => {
    if (requiresAttachmentEditWarning(block)) {
      if (!content) {
        window.alert("这条消息只有附件，当前无法在编辑框中安全重建附件。");
        return;
      }
      if (!window.confirm("这条消息包含附件。继续只会把文字填回输入框，附件不会被静默删除，原消息仍会保留。是否继续？")) {
        return;
      }
    }
    // 同时切回 idle 状态：MainView 在 done/error/running 状态下渲染的是 ResultCard /
    // RunningBubble 而非 InputBubble，光改 task 字段用户看不到回填。把 uiState/mode/
    // agentStatus 都切回 idle 强制让 InputBubble 重新挂载，bumpInputFocus 触发
    // textarea focus；流式 cliBlocks 不动，聊天历史保留。
    update({
      task: content,
      uiState: "idle",
      mode: "idle",
      agentStatus: "idle",
    });
    bumpInputFocus();
  };

  const handleDelete = (): void => {
    if (!activeTabId) return;
    if (!window.confirm("从视图中移除这条提问？\n（仅清屏展示，不会影响 agent 已记住的会话上下文）")) {
      return;
    }
    removeCliBlock(activeTabId, block.id);
  };

  return (
    <div className="group flex min-w-0 items-end justify-end gap-1">
      {/* 操作按钮 — hover 才出现，避免平时干扰阅读 */}
      <div className="flex items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
        <button
          type="button"
          onClick={() => void handleCopy()}
          aria-label="复制"
          disabled={getPromptCopyMode(block) === "none"}
          title={copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制"}
          className={`flex h-9 w-9 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:cursor-not-allowed disabled:opacity-35 dark:text-zinc-500 dark:hover:bg-white/5 ${
            copyState === "copied" ? "text-emerald-500 dark:text-emerald-400" : copyState === "failed" ? "text-rose-500" : ""
          }`}
        >
          {copyState === "copied" ? (
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-3 w-3">
              <path d="M2.5 6.5L5 9l4.5-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" className="h-3 w-3">
              <rect x="3" y="3" width="6.5" height="7" rx="1" />
              <path d="M5 3V2.5a1 1 0 011-1h3.5a1 1 0 011 1v6.5a1 1 0 01-1 1H9.5" />
            </svg>
          )}
        </button>
        <button
          type="button"
          onClick={handleEdit}
          aria-label="编辑后重发"
          title={requiresAttachmentEditWarning(block) ? "编辑文字（附件会保留在原消息中）" : "编辑后重发（填回输入框）"}
          className="flex h-9 w-9 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-sky-400/15 hover:text-sky-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-zinc-500 dark:hover:text-sky-300"
        >
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" className="h-3 w-3">
            <path d="M2 10l1-3 5-5 2 2-5 5-3 1z" strokeLinejoin="round" />
            <path d="M7 3l2 2" />
          </svg>
        </button>
        <button
          type="button"
          onClick={handleDelete}
          aria-label="从视图删除"
          title="从视图中移除（不影响后端会话历史）"
          className="flex h-9 w-9 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-rose-400/15 hover:text-rose-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 dark:text-zinc-500 dark:hover:text-rose-400"
        >
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" className="h-3 w-3">
            <path d="M2.5 4h7M5 6.5v2M7 6.5v2M3.5 4l.5 5.5h4l.5-5.5M4.5 4V2.5h3V4" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="min-w-0 max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-tr-sm border border-sky-400/35 bg-sky-400/15 px-3 py-1.5 text-[13px] leading-relaxed text-zinc-800 shadow-sm [overflow-wrap:anywhere] dark:border-sky-300/30 dark:bg-sky-400/15 dark:text-zinc-100">
        <BlockImages images={block.images} />
        {content ? (
          <div className={hasImages ? "mt-2" : undefined}>
            {highlightText(content, hl.query, block.id, "content", hl.activeMatch)}
          </div>
        ) : null}
        <BlockAttachments attachments={block.attachments} />
      </div>
    </div>
  );
}

function AttachmentRow({ attachment }: { attachment: CliBlockAttachment }): JSX.Element {
  const [openError, setOpenError] = useState(false);
  const source = attachment.localPath ?? attachment.url;

  const handleOpen = async (): Promise<void> => {
    if (!source) return;
    setOpenError(false);
    try {
      const opener = await import("@tauri-apps/plugin-opener");
      if (attachment.localPath) await opener.openPath(attachment.localPath);
      else await opener.openUrl(source);
    } catch {
      setOpenError(true);
    }
  };

  return (
    <div className="flex min-h-10 min-w-0 items-center gap-2 rounded-md border border-zinc-300/60 bg-zinc-100/70 px-2 py-1 text-[11px] text-zinc-700 dark:border-zinc-600/60 dark:bg-zinc-800/70 dark:text-zinc-200">
      <span className="shrink-0" aria-hidden="true">▤</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{attachment.name}</span>
        <span className="block truncate text-[9px] text-zinc-500 dark:text-zinc-400">
          {openError ? "无法打开附件" : attachment.mediaType}
        </span>
      </span>
      {attachment.dataUrl ? (
        <a
          href={attachment.dataUrl}
          download={attachment.name}
          className="flex min-h-9 shrink-0 items-center rounded-md px-2 font-medium text-sky-700 hover:bg-sky-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-300"
        >
          保存
        </a>
      ) : attachment.assetId ? (
        <ImportedAssetDownloadButton
          assetId={attachment.assetId}
          fileName={attachment.name}
          className="min-h-9 shrink-0 rounded-md px-2 font-medium text-sky-700 hover:bg-sky-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:opacity-60 dark:text-sky-300"
        />
      ) : source ? (
        <button
          type="button"
          onClick={() => void handleOpen()}
          className="min-h-9 shrink-0 rounded-md px-2 font-medium text-sky-700 hover:bg-sky-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-300"
        >
          打开
        </button>
      ) : (
        <span className="shrink-0 text-[9px] text-zinc-400">仅元数据</span>
      )}
    </div>
  );
}

function BlockAttachments({
  attachments,
}: {
  attachments: CliBlock["attachments"];
}): JSX.Element | null {
  if (!attachments?.length) return null;
  return (
    <div className="mt-2 flex min-w-0 flex-col gap-1.5" aria-label="附件">
      {attachments.map((attachment, index) => (
        <AttachmentRow key={`${attachment.name}:${index}`} attachment={attachment} />
      ))}
    </div>
  );
}

function BlockImages({ images }: { images: CliBlock["images"] }): JSX.Element | null {
  if (!images?.length) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {images.map((image, index) => (
        <ImportedImage
          key={`${image.assetId ?? image.dataUrl ?? index}-${image.alt ?? "image"}`}
          source={image.dataUrl}
          assetId={image.assetId}
          alt={image.alt}
        />
      ))}
    </div>
  );
}

function ImageBlock({ block }: { block: CliBlock }): JSX.Element | null {
  if (!block.images?.length && !block.attachments?.length) return null;
  return (
    <div className="flex min-w-0 justify-start">
      <div className="min-w-0 max-w-[80%]">
        <BlockImages images={block.images} />
        <BlockAttachments attachments={block.attachments} />
      </div>
    </div>
  );
}

function TextBlock({ block, hl }: { block: CliBlock; hl: HighlightCtx }): JSX.Element | null {
  const content = block.content?.trim();
  if (!content && !block.attachments?.length) return null;
  const accent =
    block.tone === "file" ? "text-sky-700 dark:text-sky-300" : "text-zinc-800 dark:text-zinc-100";
  const isInternalContext = block.sourceRole === "developer" || block.sourceRole === "system";
  const text = content
    ? hl.query.trim()
      ? (
          <div className={`min-w-0 whitespace-pre-wrap text-xs leading-relaxed [overflow-wrap:anywhere] ${accent}`}>
            {highlightText(content, hl.query, block.id, "content", hl.activeMatch)}
          </div>
        )
      : <MarkdownText content={content} className={accent} />
    : null;

  if (isInternalContext) {
    return (
      <div className="min-w-0 rounded-md border border-zinc-300/50 bg-zinc-100/45 px-2.5 py-2 text-zinc-600 dark:border-zinc-700/60 dark:bg-zinc-800/35 dark:text-zinc-300">
        <div className="mb-1 text-[10px] font-medium text-zinc-500 dark:text-zinc-400">内部上下文</div>
        {text}
        <BlockAttachments attachments={block.attachments} />
      </div>
    );
  }

  // 搜索激活时退化为纯文本 + 高亮 mark；无搜索时正常 markdown
  return (
    <div className="min-w-0">
      {text}
      <BlockAttachments attachments={block.attachments} />
    </div>
  );
}

function ThoughtBlock({ block, hl }: { block: CliBlock; hl: HighlightCtx }): JSX.Element | null {
  const content = block.content?.trim();
  if (!content) return null;
  if (hl.query.trim()) {
    return (
      <div className="min-w-0 rounded-md border-l-2 border-zinc-300 bg-zinc-100/40 px-2 py-1 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800/30 dark:text-zinc-400">
        <div className="whitespace-pre-wrap break-words text-xs leading-relaxed [overflow-wrap:anywhere]">
          {highlightText(content, hl.query, block.id, "content", hl.activeMatch)}
        </div>
      </div>
    );
  }
  return (
    <div className="min-w-0 rounded-md border-l-2 border-zinc-300 bg-zinc-100/40 px-2 py-1 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800/30 dark:text-zinc-400">
      <MarkdownText content={content} className="text-zinc-500 dark:text-zinc-400" />
    </div>
  );
}

function CommandBlock({ block, hl }: { block: CliBlock; hl: HighlightCtx }): JSX.Element {
  const badge = statusBadge(block.status);
  const cmd = block.command?.trim() || "(command)";
  const output = block.output?.trim();
  // 中栏缩略形态：output 只露 1-2 行，整块可点击让右栏展开看完整 output
  const previewOutput = output ? output.split("\n").slice(0, 2).join("\n") : "";
  const hasMore = output ? output.split("\n").length > 2 : false;
  return (
    <div className="overflow-hidden rounded-md border border-zinc-700/30 bg-zinc-900/95 font-mono text-[11px] leading-relaxed text-zinc-200 dark:border-zinc-600/30">
      <div className="flex items-center gap-2 border-b border-zinc-700/30 px-2 py-1 dark:border-zinc-600/30">
        <span className={badge.cls}>{badge.label}</span>
        <span className="truncate">$ {highlightText(cmd, hl.query, block.id, "command", hl.activeMatch)}</span>
        {hasMore && <span className="ml-auto shrink-0 text-[10px] text-zinc-500">点击查看完整输出</span>}
      </div>
      {previewOutput ? (
        <pre className="max-h-12 overflow-hidden whitespace-pre-wrap break-all px-2 py-1 text-zinc-400">
          {highlightText(previewOutput, hl.query, block.id, "output", hl.activeMatch)}
          {hasMore && "…"}
        </pre>
      ) : null}
    </div>
  );
}

/// 每个 todo 项的三态视觉（pending / in_progress / completed），对齐 Claude
/// Code 终端的体验。其它 status 字符串（如 cancelled / error / running）做兜底。
function todoItemPalette(status: string | undefined): {
  icon: string;
  iconClass: string;
  labelClass: string;
  rowClass: string;
} {
  switch ((status ?? "").toLowerCase()) {
    case "completed":
    case "success":
    case "done":
      return {
        icon: "✓",
        iconClass: "text-emerald-600 dark:text-emerald-400",
        labelClass: "text-zinc-500 line-through dark:text-zinc-500",
        rowClass: "",
      };
    case "in_progress":
    case "running":
    case "active":
      return {
        icon: "◔",
        iconClass: "text-amber-600 animate-pulse dark:text-amber-400",
        labelClass: "text-zinc-900 font-medium dark:text-zinc-100",
        rowClass: "bg-amber-50/50 dark:bg-amber-500/5 rounded-md",
      };
    case "error":
    case "cancelled":
    case "failed":
      return {
        icon: "✕",
        iconClass: "text-rose-600 dark:text-rose-400",
        labelClass: "text-rose-700 dark:text-rose-300",
        rowClass: "",
      };
    default:
      return {
        icon: "○",
        iconClass: "text-zinc-400 dark:text-zinc-500",
        labelClass: "text-zinc-600 dark:text-zinc-300",
        rowClass: "",
      };
  }
}

function TodoBlock({ block, hl }: { block: CliBlock; hl: HighlightCtx }): JSX.Element | null {
  const items = block.items ?? [];
  if (items.length === 0) return null;
  const total = items.length;
  const done = items.filter((i) =>
    ["completed", "success", "done"].includes((i.status ?? "").toLowerCase())
  ).length;
  const inProgress = items.filter((i) =>
    ["in_progress", "running", "active"].includes((i.status ?? "").toLowerCase())
  ).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="rounded-md border-l-4 border-violet-400 border-y border-r border-violet-200/40 bg-violet-50/40 p-2.5 text-xs dark:border-violet-400 dark:border-violet-400/30 dark:bg-violet-500/5">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-violet-700 dark:text-violet-300">
          📋 {highlightText(block.title || "Todo", hl.query, block.id, "title", hl.activeMatch)}
        </span>
        <span className="ml-auto font-mono text-[10px] text-zinc-600 dark:text-zinc-400">
          {done}/{total}
          {inProgress > 0 && (
            <span className="ml-1 text-amber-600 dark:text-amber-400">· {inProgress} 进行中</span>
          )}
        </span>
      </div>
      {/* 进度条：done 部分翠绿，in_progress 部分琥珀（叠加在 done 之后） */}
      <div className="mb-2 h-1 w-full overflow-hidden rounded-full bg-zinc-200/60 dark:bg-zinc-700/60">
        <div className="flex h-full w-full">
          <div
            className="h-full bg-emerald-500/80 transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
          {inProgress > 0 && (
            <div
              className="h-full bg-amber-500/80 transition-[width] duration-300"
              style={{ width: `${Math.round((inProgress / total) * 100)}%` }}
            />
          )}
        </div>
      </div>
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => {
          const palette = todoItemPalette(item.status);
          return (
            <li key={item.id} className={`flex items-start gap-2 px-1 py-0.5 ${palette.rowClass}`}>
              <span className={`mt-0.5 inline-block w-3 shrink-0 text-center font-bold ${palette.iconClass}`}>
                {palette.icon}
              </span>
              <span className={`flex-1 ${palette.labelClass}`}>{item.label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ConfirmBlock({ block, hl }: { block: CliBlock; hl: HighlightCtx }): JSX.Element {
  return (
    <div className="min-w-0 rounded-md border border-amber-400/50 bg-amber-50/70 px-2 py-1.5 text-xs dark:border-amber-300/40 dark:bg-amber-400/10">
      <div className="font-semibold text-amber-700 dark:text-amber-300">
        {highlightText(block.title || "需要确认", hl.query, block.id, "title", hl.activeMatch)}
      </div>
      {block.content ? (
        <div className="mt-0.5 whitespace-pre-wrap break-words text-zinc-700 [overflow-wrap:anywhere] dark:text-zinc-200">
          {highlightText(block.content, hl.query, block.id, "content", hl.activeMatch)}
        </div>
      ) : null}
      {block.note ? (
        <div className="mt-0.5 text-[10px] text-amber-600 dark:text-amber-400">{block.note}</div>
      ) : null}
    </div>
  );
}

/// 把 Claude SDK 给的 mcp__<server>__<tool> 形式拆成 server / tool 两段
/// 让 ToolBlock 可以分两个色块展示。常见 server 名形如 plugin_ecc_github，
/// 拆开后做基本的 prettify（把首层下划线显成 ·）。
function parseMcpToolName(raw: string | undefined): { server?: string; tool: string } {
  const value = (raw ?? "tool").trim();
  if (!value.startsWith("mcp__")) {
    return { tool: value };
  }
  const body = value.slice(5); // 去 "mcp__"
  const sepIdx = body.indexOf("__");
  if (sepIdx < 0) return { tool: value };
  const server = body.slice(0, sepIdx);
  const tool = body.slice(sepIdx + 2);
  return {
    server: server.replace(/^plugin_/, "").replace(/_/g, "·"),
    tool,
  };
}

/// 根据工具名给整个 ToolBlock 卡片打配色组。让 Task / Skill / Web 等特殊工具
/// 一眼就能跟普通灰底工具块区分。
function toolBlockPalette(toolName: string | undefined): {
  container: string;
  toolText: string;
  icon: string;
} {
  const name = (toolName ?? "").trim();
  // Task 调用子代理 —— 靛蓝
  if (name.startsWith("Task")) {
    return {
      container:
        "bg-indigo-100/60 border border-indigo-300/50 dark:bg-indigo-500/15 dark:border-indigo-400/30",
      toolText: "text-indigo-800 dark:text-indigo-200",
      icon: "🤖",
    };
  }
  // Skill 调用安装的技能 —— 翠绿
  if (name === "Skill" || name.startsWith("Skill·") || name.startsWith("Skill ")) {
    return {
      container:
        "bg-teal-100/60 border border-teal-300/50 dark:bg-teal-500/15 dark:border-teal-400/30",
      toolText: "text-teal-800 dark:text-teal-200",
      icon: "✨",
    };
  }
  // Web 工具 —— 天蓝
  if (name === "WebFetch" || name === "WebSearch") {
    return {
      container:
        "bg-sky-100/60 border border-sky-300/50 dark:bg-sky-500/15 dark:border-sky-400/30",
      toolText: "text-sky-800 dark:text-sky-200",
      icon: name === "WebFetch" ? "🌐" : "🔍",
    };
  }
  // MCP 工具 —— 紫色（与 server 徽章颜色协调）
  if (name.startsWith("mcp__")) {
    return {
      container:
        "bg-violet-50/60 border border-violet-200/50 dark:bg-violet-500/10 dark:border-violet-400/20",
      toolText: "text-violet-800 dark:text-violet-200",
      icon: "🔌",
    };
  }
  // TodoWrite 不走这里（走 TodoBlock），但万一漏了兜底
  // 普通工具 —— 中性灰
  return {
    container: "bg-zinc-100/50 dark:bg-zinc-800/40",
    toolText: "text-zinc-700 dark:text-zinc-200",
    icon: "",
  };
}

/// 格式化耗时为 "Xs" / "Xm Ys"。
function formatElapsed(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
}

function ToolBlock({ block, hl }: { block: CliBlock; hl: HighlightCtx }): JSX.Element {
  const badge = statusBadge(block.status);
  const { server, tool } = parseMcpToolName(block.tool);
  const palette = toolBlockPalette(block.tool);
  const isRunning = block.status === "running" || block.status === "active";
  const isLongRunning =
    !!block.startedAt && (block.tool?.startsWith("Task") || block.tool?.startsWith("Skill"));
  const activeTabId = useActiveTabId();

  // Task / Skill running 时按秒刷新一次显示耗时；其它工具不需要走 ticker。
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState(false);
  const [detailExpanded, setDetailExpanded] = useState(false);
  useEffect(() => {
    if (!isLongRunning || !isRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isLongRunning, isRunning]);

  const elapsedText =
    block.startedAt && isLongRunning
      ? formatElapsed((isRunning ? now : block.startedAt + 0) - block.startedAt)
      : null;

  // Stop 按钮：仅 Task / Skill 跑着时显示。点了会调 stop_agent 停掉当前整个 turn —
  // Claude SDK 当前没有 per-Task 取消能力，停整 turn 是唯一可达的中断手段。
  const handleStop = async (): Promise<void> => {
    if (stopping || !activeTabId) return;
    setStopping(true);
    try {
      const { invoke } = await import("../../lib/bridge");
      await invoke("stop_agent", { runId: activeTabId });
    } catch (err) {
      console.error("[ToolBlock] stop failed", err);
    } finally {
      setStopping(false);
    }
  };

  return (
    <div
      className={`min-w-0 rounded-md px-2 py-1 text-[11px] ${palette.container} ${
        isRunning && isLongRunning ? "shadow-[0_0_12px_rgba(99,102,241,0.25)]" : ""
      }`}
    >
      <div className="flex min-h-8 min-w-0 items-center gap-2">
        <span className={`shrink-0 ${badge.cls}`}>{badge.label}</span>
        {palette.icon && (
          <span className={`shrink-0 ${isRunning && isLongRunning ? "animate-pulse" : ""}`} aria-hidden>
            {palette.icon}
          </span>
        )}
        {server && (
          <span
            className="shrink-0 rounded bg-violet-100/80 px-1 font-mono text-[9px] font-medium uppercase tracking-wider text-violet-700 dark:bg-violet-500/15 dark:text-violet-300"
            title={`MCP server: ${server}`}
          >
            {server}
          </span>
        )}
        <span className={`min-w-0 max-w-[35%] truncate font-medium ${palette.toolText}`}>
          {highlightText(tool, hl.query, block.id, "tool", hl.activeMatch)}
        </span>
        {block.detail ? (
          <span className="min-w-0 flex-1 truncate text-zinc-500 dark:text-zinc-400">
            {highlightText(block.detail, hl.query, block.id, "detail", hl.activeMatch)}
          </span>
        ) : null}
        {block.message ? (
          <span className="min-w-0 flex-1 truncate text-rose-600 dark:text-rose-400">
            {highlightText(block.message, hl.query, block.id, "message", hl.activeMatch)}
          </span>
        ) : null}
        {(block.detail || block.detailValue !== undefined) && (
          <button
            type="button"
            aria-expanded={detailExpanded}
            onClick={(event) => {
              event.stopPropagation();
              setDetailExpanded((value) => !value);
            }}
            className="min-h-8 shrink-0 rounded-md px-2 font-medium text-sky-700 hover:bg-sky-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-300"
          >
            {detailExpanded ? "收起" : "查看完整结果"}
          </button>
        )}
        {elapsedText && (
          <span
            className={`shrink-0 rounded px-1 font-mono text-[10px] tabular-nums ${
              isRunning
                ? "bg-amber-100/80 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
                : "bg-zinc-100/80 text-zinc-500 dark:bg-zinc-700/40 dark:text-zinc-400"
            }`}
            title={isRunning ? "进行中耗时" : "总耗时"}
          >
            {isRunning ? "⏱ " : ""}{elapsedText}
          </span>
        )}
        {isRunning && isLongRunning && (
          <button
            type="button"
            onClick={() => void handleStop()}
            disabled={stopping}
            title="停止当前整个 turn（Claude SDK 暂不支持单独取消子代理）"
            aria-label="Stop"
            className="min-h-8 shrink-0 rounded-md border border-rose-300/60 bg-rose-50/80 px-2 text-[10px] font-bold text-rose-700 transition-colors hover:bg-rose-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-rose-400/40 dark:bg-rose-500/15 dark:text-rose-300 dark:hover:bg-rose-500/25"
          >
            {stopping ? "…" : "✕"}
          </button>
        )}
      </div>
      {detailExpanded && (block.detail || block.detailValue !== undefined) && (
        <PagedImportedValue
          value={block.detailValue ?? block.detail ?? ""}
          fileName="imported-tool-result.txt"
          className="mt-1 border-t border-black/10 pt-1 dark:border-white/10"
        />
      )}
      <BlockAttachments attachments={block.attachments} />
    </div>
  );
}

function DiffBlock({ block, hl }: { block: CliBlock; hl: HighlightCtx }): JSX.Element {
  const path = block.path?.trim() || "(unknown file)";
  const tool = block.tool?.trim() || "Edit";
  const lines = (block.diff ?? "").split("\n");
  // 累计 occurrence offset：每行调 highlightText 时把这之前已出现的次数传入，
  // 让单行渲染的 occ 跟整段 diff 字符串里数到的 occ 对齐 active 那一段。
  let diffOcc = 0;
  const summary = (() => {
    let added = 0;
    let removed = 0;
    for (const l of lines) {
      if (l.startsWith("+")) added += 1;
      else if (l.startsWith("-")) removed += 1;
    }
    return `+${added} −${removed}`;
  })();
  return (
    <div className="overflow-hidden rounded-md border border-zinc-700/30 bg-zinc-900/95 font-mono text-[11px] leading-relaxed">
      <div className="flex items-center justify-between border-b border-zinc-700/30 px-2 py-1 text-zinc-300">
        <span className="flex items-center gap-2 truncate">
          <span className="text-amber-300">
            {highlightText(tool, hl.query, block.id, "tool", hl.activeMatch)}
          </span>
          <span className="truncate text-sky-300">
            {highlightText(path, hl.query, block.id, "path", hl.activeMatch)}
          </span>
        </span>
        <span className="shrink-0 text-[10px] text-zinc-400">{summary}</span>
      </div>
      {/* 中栏缩略：只渲染前 6 行 diff，更多行右栏完整查看 */}
      <pre className="max-h-24 overflow-hidden whitespace-pre-wrap break-all">
        {lines.slice(0, 6).map((line, i) => {
          let cls = "text-zinc-400";
          if (line.startsWith("+")) cls = "bg-emerald-500/10 text-emerald-300";
          else if (line.startsWith("-")) cls = "bg-rose-500/10 text-rose-300";
          else if (line.startsWith("@@")) cls = "text-amber-300";
          const node = highlightText(
            line || " ",
            hl.query,
            block.id,
            "diff",
            hl.activeMatch,
            diffOcc,
          );
          diffOcc += countOccurrences(line, hl.query);
          return (
            <div key={i} className={`px-2 ${cls}`}>
              {node}
            </div>
          );
        })}
        {lines.length > 6 && (
          <div className="px-2 text-[10px] text-zinc-500">
            … 还有 {lines.length - 6} 行，点击查看完整 diff
          </div>
        )}
      </pre>
    </div>
  );
}

function StderrBlock({ block, hl }: { block: CliBlock; hl: HighlightCtx }): JSX.Element | null {
  const msg = block.message?.trim();
  if (!msg) return null;
  // 启发式：含 error/failed/panic 时染红，否则灰（多数是 warning / debug）
  const looksLikeError = /(error|failed|panic|exception|fatal)/i.test(msg);
  const cls = looksLikeError
    ? "border-rose-400/40 bg-rose-500/10 text-rose-700 dark:text-rose-300"
    : "border-zinc-300/40 bg-zinc-100/40 text-zinc-500 dark:border-zinc-600/40 dark:bg-zinc-800/30 dark:text-zinc-400";
  return (
    <div
      className={`flex items-start gap-1.5 rounded-md border-l-2 px-2 py-1 font-mono text-[11px] leading-relaxed ${cls}`}
    >
      <span className="shrink-0 opacity-60">stderr</span>
      <span className="break-all">{highlightText(msg, hl.query, block.id, "message", hl.activeMatch)}</span>
    </div>
  );
}

function FileBlock({ block, hl }: { block: CliBlock; hl: HighlightCtx }): JSX.Element {
  const badge = statusBadge(block.status);
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border-l-2 border-sky-400/50 bg-sky-50/40 px-2 py-1 text-[11px] dark:border-sky-300/30 dark:bg-sky-400/5">
      <span className={`shrink-0 ${badge.cls}`}>{badge.label}</span>
      <span className="shrink-0 font-medium text-zinc-700 dark:text-zinc-200">
        {highlightText(block.tool || "file", hl.query, block.id, "tool", hl.activeMatch)}
      </span>
      {block.path ? (
        <span className="min-w-0 flex-1 truncate font-mono text-sky-700 dark:text-sky-300">
          {highlightText(block.path, hl.query, block.id, "path", hl.activeMatch)}
        </span>
      ) : null}
    </div>
  );
}

function StatusLine({ block, hl }: { block: CliBlock; hl: HighlightCtx }): JSX.Element | null {
  const msg = block.message?.trim();
  if (!msg) return null;
  return (
    <div className="break-words text-[11px] italic text-zinc-500 [overflow-wrap:anywhere] dark:text-zinc-400">
      {highlightText(msg, hl.query, block.id, "message", hl.activeMatch)}
    </div>
  );
}

/// type=error 的 cliBlock：薄包装 ErrorDiagnosisCard 的 inline variant。
/// 把 cmd+f 高亮的渲染通过 renderRawMessage 注入，让"详情"展开后仍能 highlight。
function ErrorLine({ block, hl }: { block: CliBlock; hl: HighlightCtx }): JSX.Element | null {
  const msg = block.message?.trim();
  if (!msg) return null;
  return (
    <ErrorDiagnosisCard
      message={msg}
      variant="inline"
      renderRawMessage={(m) => highlightText(m, hl.query, block.id, "message", hl.activeMatch)}
    />
  );
}

function shouldShowSourceMeta(block: CliBlock, previous: CliBlock | undefined): boolean {
  if (!block.sourceRole && !block.sourceTimestamp && !block.importedConversationId) return false;
  if (!previous) return true;
  if (block.sourceTurnId) return block.sourceTurnId !== previous.sourceTurnId;
  if (block.sourceMessageId) return block.sourceMessageId !== previous.sourceMessageId;
  return block.sourceRole !== previous.sourceRole || block.sourceTimestamp !== previous.sourceTimestamp;
}

function BlockSourceMeta({ block }: { block: CliBlock }): JSX.Element | null {
  const role = sourceRoleLabel(block.sourceRole);
  const time = formatSourceTime(block.sourceTimestamp);
  const origin = block.importedConversationId ? "导入" : block.backend;
  if (!role && !time && !origin) return null;
  return (
    <div className={`mb-1 flex items-center gap-1 text-[9px] text-zinc-400 dark:text-zinc-500 ${
      block.sourceRole === "user" ? "justify-end" : "justify-start"
    }`}>
      {[origin, role, time].filter(Boolean).map((value, index) => (
        <span key={`${value}:${index}`}>
          {index > 0 ? "· " : ""}{value}
        </span>
      ))}
    </div>
  );
}

const BlockRenderer = memo(function BlockRenderer({
  block,
  hl,
}: {
  block: CliBlock;
  hl: HighlightCtx;
}): JSX.Element | null {
  switch (block.type) {
    case "user-prompt":
      return <UserPromptBlock block={block} hl={hl} />;
    case "text":
      return <TextBlock block={block} hl={hl} />;
    case "thought":
      return <ThoughtBlock block={block} hl={hl} />;
    case "command":
      return <CommandBlock block={block} hl={hl} />;
    case "todo":
      return <TodoBlock block={block} hl={hl} />;
    case "confirm":
      return <ConfirmBlock block={block} hl={hl} />;
    case "tool":
      return <ToolBlock block={block} hl={hl} />;
    case "file":
      return <FileBlock block={block} hl={hl} />;
    case "diff":
      return <DiffBlock block={block} hl={hl} />;
    case "status":
      return <StatusLine block={block} hl={hl} />;
    case "error":
      return <ErrorLine block={block} hl={hl} />;
    case "stderr":
      return <StderrBlock block={block} hl={hl} />;
    case "image":
      return <ImageBlock block={block} />;
    case "permission-request":
      return <PermissionRequestBlock block={block} />;
    default:
      return null;
  }
});

/// 单个 block 行的初始高度估计——只在 virtualizer 还没 measure 真实高度时用，
/// 之后会被 ResizeObserver 自动校正。给个偏小的中位数让首屏渲染快一点，
/// 实际高度从 30px (短文本) 到 500+px (大 diff) 都有。
const ESTIMATED_BLOCK_HEIGHT = 80;
/// overscan：屏幕上下各多渲染几个 block，让快速滚动时不会出现白屏，
/// 也让用户在 ErrorLine 上展开"详情"后短距离滚走再回来还能保留 state。
const VIRTUAL_OVERSCAN = 8;

export function BlockStream(): JSX.Element | null {
  const blocks = useActiveTabField("cliBlocks");
  const activeTabId = useActiveTabId();
  const setDetailBlock = useUiStore((s) => s.setDetailBlock);
  const detailBlockId = useUiStore((s) => s.detailBlock?.id ?? null);
  const searchQuery = useUiStore((s) => s.searchQuery);
  const activeMatch = useUiStore((s) => s.activeMatch);
  const messageJumpCacheRef = useRef<{
    tabId: string | null;
    blocks: CliBlock[];
    items: MessageJumpItem[];
  }>({ tabId: null, blocks: [], items: [] });
  const messageJumps = useMemo(() => {
    const previous = messageJumpCacheRef.current;
    const items = previous.tabId === activeTabId
      ? updateMessageJumps(previous.blocks, previous.items, blocks)
      : updateMessageJumps([], [], blocks);
    messageJumpCacheRef.current = { tabId: activeTabId, blocks, items };
    return items;
  }, [activeTabId, blocks]);
  const [activeMessageJumpId, setActiveMessageJumpId] = useState<string | null>(null);

  useEffect(() => {
    if (messageJumps.length === 0) {
      setActiveMessageJumpId(null);
      return;
    }
    setActiveMessageJumpId((current) =>
      current && messageJumps.some((item) => item.blockId === current)
        ? current
        : messageJumps[0]!.blockId
    );
  }, [messageJumps]);

  const hl = useMemo<HighlightCtx>(
    () => (searchQuery ? { query: searchQuery, activeMatch } : NO_HIGHLIGHT),
    [searchQuery, activeMatch],
  );

  // 虚拟列表滚动容器：parentRef 给 useVirtualizer 用，stickToBottomRef 跟踪
  // "用户是否仍在底部附近"——key={activeTabId} 让切 tab 时整个容器重挂载，
  // virtualizer 自然 reset，stickToBottomRef 也回到 true。
  const parentRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  // 只在 cmd+f 真有活动命中时查找。旧实现每个流式增量都会重建整张 Map，
  // 即使搜索面板从未打开，也会白做一次 O(N) 遍历和分配。
  const activeMatchBlockId = activeMatch?.blockId ?? null;
  const activeMatchIndex = useMemo(
    () => activeMatchBlockId
      ? blocks.findIndex((block) => block.id === activeMatchBlockId)
      : -1,
    [blocks, activeMatchBlockId],
  );

  const virtualizer = useVirtualizer({
    count: blocks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ESTIMATED_BLOCK_HEIGHT,
    overscan: VIRTUAL_OVERSCAN,
    // 用 block.id 当 key 让 React reconcile 稳定——blocks 数组中间插入 / 替换时不会破坏
    // 不相关 row 的内部 state（ErrorLine expanded / UserPromptBlock copied flash）
    getItemKey: (index) => blocks[index]?.id ?? String(index),
  });

  const handleMessageJump = (blockId: string): void => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (jumpToMessage(
      blocks,
      blockId,
      (index, options) => virtualizer.scrollToIndex(index, options),
      stickToBottomRef,
      reducedMotion ? "auto" : "smooth",
    )) setActiveMessageJumpId(blockId);
  };

  // cmd+f 命中跳转：把按 ref scrollIntoView 改成 virtualizer.scrollToIndex —— virtualize
  // 后那个 block 可能不在 DOM 里，scrollIntoView 失效。useLayoutEffect 比 useEffect 早一帧，
  // 让滚动跟搜索结果显示同步（避免视觉上"先停一下才跳"）。
  useLayoutEffect(() => {
    if (activeMatchIndex < 0) return;
    virtualizer.scrollToIndex(activeMatchIndex, { align: "center", behavior: "smooth" });
  }, [activeMatchIndex, virtualizer]);

  // Auto-scroll-to-bottom：流式 block 到达时，若用户没向上滚走，自动跟到最新。
  // 用 scrollToIndex(length-1, align:end) 让 virtualizer 帮我们处理动态高度——比直接
  // 设 scrollTop=scrollHeight 更准，因为 virtualizer 知道实际渲染高度。
  useEffect(() => {
    if (blocks.length === 0) return;
    if (!stickToBottomRef.current) return;
    virtualizer.scrollToIndex(blocks.length - 1, { align: "end" });
  }, [blocks, virtualizer]);

  const handleScroll = (): void => {
    const el = parentRef.current;
    if (!el) return;
    stickToBottomRef.current = isNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
    const anchor = el.scrollTop + Math.min(120, el.clientHeight * 0.3);
    const rows = virtualizer.getVirtualItems();
    const currentRow = rows.find((row) => row.start + row.size >= anchor) ?? rows.at(-1);
    if (!currentRow) return;
    const currentId = findActiveMessageJump(messageJumps, currentRow.index);
    if (currentId) {
      setActiveMessageJumpId((previous) => previous === currentId ? previous : currentId);
    }
  };

  if (blocks.length === 0) return null;

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // key={activeTabId}：切 tab 时强制滚动容器 + virtualizer 重挂载，scrollTop 自然清零，
  // stickToBottomRef 回到 true（重新挂载默认值），切回该 tab 时自动滚到底。
  return (
    <div className="relative h-full min-h-0">
      <div
        ref={parentRef}
        onScroll={handleScroll}
        className={`h-full overflow-x-hidden overflow-y-auto py-1 text-xs leading-relaxed ${
          messageJumps.length > 1 ? "pl-6 pr-1" : "px-1"
        }`}
      >
      {/* 撑出整个虚拟列表的总高度（让滚动条比例正确）；内部 row 用 absolute 定位 */}
        <div style={{ height: totalSize, position: "relative", width: "100%" }}>
          {virtualItems.map((vRow) => {
          const block = blocks[vRow.index];
          if (!block) return null;
          const previousBlock = blocks[vRow.index - 1];
          const nextBlock = blocks[vRow.index + 1];
          const clickable = shouldOpenDetailOnClick(block.type);
          const isOpenInRight = detailBlockId === block.id;
          const wrapperCls = [
            clickable ? "cursor-pointer transition-all hover:translate-x-0.5" : "",
            isOpenInRight ? "ring-1 ring-sky-400/50 rounded-md" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div
              key={vRow.key}
              data-index={vRow.index}
              // measureElement：把这个 DOM 节点挂到 ResizeObserver，virtualizer
              // 自动测量它的实际高度并更新内部高度表；动态高度 block (长 diff / 短 status)
              // 都能正确占位，不需要我们手动 measure
              ref={virtualizer.measureElement}
              onClick={clickable ? () => setDetailBlock(block) : undefined}
              className={wrapperCls}
              title={clickable ? "点击在右栏查看完整内容" : undefined}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vRow.start}px)`,
                // 原来用 flex-col gap-2 实现 row 间距；virtualize 后子元素 absolute 定位，
                // gap 失效——用 paddingBottom 模拟 8px 间距，measureElement 会把这部分算进总高度
                paddingBottom: `${getTurnSpacing(block, nextBlock)}px`,
              }}
            >
              {shouldShowSourceMeta(block, previousBlock) && <BlockSourceMeta block={block} />}
              <BlockRenderer block={block} hl={hl} />
            </div>
          );
          })}
        </div>
      </div>
      <MessageJumpRail
        items={messageJumps}
        activeBlockId={activeMessageJumpId}
        onJump={handleMessageJump}
      />
    </div>
  );
}
