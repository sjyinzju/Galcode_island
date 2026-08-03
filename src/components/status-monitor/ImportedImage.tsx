import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "../../lib/bridge";

type AssetLoader = (command: string, args: { assetId: string }) => Promise<string>;
const pendingAssetLoads = new Map<string, Promise<string>>();
const resolvedAssetLoads = new Map<string, string>();
const assetLoadQueue: Array<() => void> = [];
const MAX_ASSET_LOAD_CONCURRENCY = 2;
const MAX_RESOLVED_ASSET_CACHE_CHARS = 24 * 1024 * 1024;
const MAX_RESOLVED_ASSET_CACHE_ENTRIES = 16;
let activeAssetLoads = 0;
let resolvedAssetCacheChars = 0;

function scheduleAssetLoad<T>(load: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = (): void => {
      activeAssetLoads += 1;
      void load().then(resolve, reject).finally(() => {
        activeAssetLoads -= 1;
        assetLoadQueue.shift()?.();
      });
    };
    if (activeAssetLoads < MAX_ASSET_LOAD_CONCURRENCY) run();
    else assetLoadQueue.push(run);
  });
}

function cachedAsset(assetId: string): string | null {
  const source = resolvedAssetLoads.get(assetId);
  if (!source) return null;
  resolvedAssetLoads.delete(assetId);
  resolvedAssetLoads.set(assetId, source);
  return source;
}

function cacheAsset(assetId: string, source: string): void {
  if (source.length > MAX_RESOLVED_ASSET_CACHE_CHARS) return;
  const previous = resolvedAssetLoads.get(assetId);
  if (previous) resolvedAssetCacheChars -= previous.length;
  resolvedAssetLoads.delete(assetId);
  resolvedAssetLoads.set(assetId, source);
  resolvedAssetCacheChars += source.length;
  while (
    resolvedAssetLoads.size > MAX_RESOLVED_ASSET_CACHE_ENTRIES ||
    resolvedAssetCacheChars > MAX_RESOLVED_ASSET_CACHE_CHARS
  ) {
    const oldest = resolvedAssetLoads.entries().next().value as [string, string] | undefined;
    if (!oldest) break;
    resolvedAssetLoads.delete(oldest[0]);
    resolvedAssetCacheChars -= oldest[1].length;
  }
}

function isInlineImageData(source: string): boolean {
  return /^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(source.trim());
}

export function isRemoteImageSource(source: string): boolean {
  const normalized = source.trim();
  return !isInlineImageData(normalized) && !/^blob:/i.test(normalized);
}

export async function loadImportedAssetSource(
  assetId: string,
  loader?: AssetLoader,
): Promise<string> {
  const source = await loadImportedAssetData(assetId, loader);
  if (!isInlineImageData(source)) throw new Error("Imported asset is not image data");
  return source;
}

export async function loadImportedAssetData(
  assetId: string,
  loader?: AssetLoader,
): Promise<string> {
  const cached = cachedAsset(assetId);
  if (cached) return cached;
  const load = (): Promise<string> => loader
    ? loader("load_imported_asset", { assetId })
    : invoke<string>("load_imported_asset", { assetId });
  const existing = pendingAssetLoads.get(assetId);
  if (existing) return existing;
  const pending = scheduleAssetLoad(load)
    .then((source) => {
      cacheAsset(assetId, source);
      return source;
    })
    .finally(() => pendingAssetLoads.delete(assetId));
  pendingAssetLoads.set(assetId, pending);
  return pending;
}

export async function copyImageSource(source: string): Promise<boolean> {
  try {
    if (isRemoteImageSource(source)) {
      await navigator.clipboard.writeText(source);
      return true;
    }
    if (!navigator.clipboard.write || typeof ClipboardItem === "undefined") return false;
    const blob = await (await fetch(source)).blob();
    if (!blob.type.startsWith("image/")) return false;
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return true;
  } catch {
    return false;
  }
}

function downloadSource(source: string, fileName: string): void {
  const anchor = document.createElement("a");
  anchor.href = source;
  anchor.download = fileName;
  anchor.rel = "noreferrer noopener";
  anchor.click();
}

export function ImportedAssetDownloadButton({
  assetId,
  fileName,
  className,
}: {
  assetId: string;
  fileName: string;
  className: string;
}): JSX.Element {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  return (
    <>
      <button
        type="button"
        disabled={state === "loading"}
        onClick={() => {
          setState("loading");
          void loadImportedAssetData(assetId)
            .then((source) => {
              downloadSource(source, fileName);
              setState("idle");
            })
            .catch(() => setState("error"));
        }}
        className={className}
      >
        {state === "loading" ? "正在保存…" : state === "error" ? "重试保存" : "保存"}
      </button>
      <span className="sr-only" aria-live="polite">
        {state === "loading" ? "正在准备附件" : state === "error" ? "附件保存失败" : ""}
      </span>
    </>
  );
}

interface ImportedImageProps {
  source?: string | null;
  assetId?: string | null;
  alt: string | null;
  className?: string;
}

export function ImportedImage({ source, assetId, alt, className }: ImportedImageProps): JSX.Element {
  const directSource = source?.trim() || null;
  const [loadedAsset, setLoadedAsset] = useState<{ id: string; source: string } | null>(null);
  const [assetLoadingId, setAssetLoadingId] = useState<string | null>(null);
  const [assetErrorId, setAssetErrorId] = useState<string | null>(null);
  const [assetAttempt, setAssetAttempt] = useState(0);
  const [approvedRemoteSource, setApprovedRemoteSource] = useState<string | null>(null);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewerCloseRef = useRef<HTMLButtonElement | null>(null);
  const resolvedSource = directSource ?? (
    assetId && loadedAsset?.id === assetId ? loadedAsset.source : null
  );
  const remote = resolvedSource ? isRemoteImageSource(resolvedSource) : false;
  const remoteAllowed = Boolean(resolvedSource) && (
    !remote || approvedRemoteSource === resolvedSource
  );
  const failed = Boolean(resolvedSource && failedSource === resolvedSource);

  useEffect(() => {
    if (directSource || !assetId || loadedAsset?.id === assetId) return;
    let active = true;
    let observer: IntersectionObserver | null = null;
    const load = (): void => {
      if (!active) return;
      setAssetLoadingId(assetId);
      setAssetErrorId(null);
      void loadImportedAssetSource(assetId)
        .then((assetSource) => {
          if (active) setLoadedAsset({ id: assetId, source: assetSource });
        })
        .catch(() => {
          if (active) setAssetErrorId(assetId);
        })
        .finally(() => {
          if (active) setAssetLoadingId(null);
        });
    };

    if (typeof IntersectionObserver === "undefined" || !rootRef.current) {
      load();
    } else {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer?.disconnect();
          load();
        }
      }, { rootMargin: "600px 0px" });
      observer.observe(rootRef.current);
    }
    return () => {
      active = false;
      observer?.disconnect();
    };
  }, [assetAttempt, assetId, directSource, loadedAsset?.id]);

  useEffect(() => {
    setFailedSource(null);
    setAttempt(0);
    setViewerOpen(false);
    setCopyState("idle");
  }, [assetId, directSource]);

  useEffect(() => {
    if (copyState === "idle") return;
    const id = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(id);
  }, [copyState]);

  useEffect(() => {
    if (!viewerOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const parentDialog = rootRef.current?.closest<HTMLElement>("[role='dialog']") ?? null;
    const previousAriaHidden = parentDialog?.getAttribute("aria-hidden") ?? null;
    const hadInert = parentDialog?.hasAttribute("inert") ?? false;
    parentDialog?.setAttribute("aria-hidden", "true");
    parentDialog?.setAttribute("inert", "");
    viewerCloseRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setViewerOpen(false);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        viewerCloseRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (parentDialog) {
        if (previousAriaHidden === null) parentDialog.removeAttribute("aria-hidden");
        else parentDialog.setAttribute("aria-hidden", previousAriaHidden);
        if (!hadInert) parentDialog.removeAttribute("inert");
      }
      previousFocus?.focus();
    };
  }, [viewerOpen]);

  if (!resolvedSource) {
    if (!assetId) {
      return (
        <div className="rounded-lg border border-zinc-300/60 px-3 py-2 text-[11px] text-zinc-500 dark:border-zinc-600/60 dark:text-zinc-400">
          图片数据不可用
        </div>
      );
    }
    return (
      <div
        ref={rootRef}
        role="status"
        aria-live="polite"
        className={`flex min-h-16 w-full items-center justify-center rounded-lg border px-3 py-2 text-[11px] ${
          assetErrorId === assetId
            ? "border-rose-300/40 bg-rose-500/10 text-rose-700 dark:text-rose-300"
            : "border-zinc-300/60 bg-zinc-100/60 text-zinc-500 dark:border-zinc-600/60 dark:bg-zinc-800/60 dark:text-zinc-300"
        }`}
      >
        {assetErrorId === assetId ? (
          <button
            type="button"
            onClick={() => {
              setAssetErrorId(null);
              setAssetAttempt((value) => value + 1);
            }}
            className="min-h-9 rounded-md px-3 font-medium hover:bg-rose-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
          >
            图片加载失败，重试
          </button>
        ) : assetLoadingId === assetId ? "正在加载图片…" : "滚动到图片附近时加载"}
      </div>
    );
  }

  if (!remoteAllowed) {
    return (
      <button
        type="button"
        onClick={() => setApprovedRemoteSource(resolvedSource)}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-zinc-300/60 bg-zinc-100/60 px-3 py-2 text-[11px] text-zinc-700 transition-colors hover:bg-zinc-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:border-zinc-600/60 dark:bg-zinc-800/60 dark:text-zinc-200 dark:hover:bg-zinc-700/70"
      >
        <span aria-hidden="true">▧</span>
        加载远程图片
      </button>
    );
  }

  if (failed) {
    return (
      <div role="alert" className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-rose-300/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-700 dark:text-rose-300">
        <span>图片无法解码或已经失效</span>
        <button
          type="button"
          onClick={() => {
            setFailedSource(null);
            setAttempt((value) => value + 1);
          }}
          className="min-h-9 shrink-0 rounded-md px-3 font-medium hover:bg-rose-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
        >
          重试
        </button>
      </div>
    );
  }

  const accessibleAlt = alt?.trim() || "导入的图片";
  return (
    <div ref={rootRef} className="group/image relative inline-flex max-w-full flex-col">
      <button
        type="button"
        onClick={() => setViewerOpen(true)}
        aria-label={`查看原图：${accessibleAlt}`}
        className="max-w-full rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900"
      >
        <img
          key={attempt}
          src={resolvedSource}
          alt={accessibleAlt}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedSource(resolvedSource)}
          className={className ?? "max-h-[420px] max-w-full rounded-lg object-contain"}
        />
      </button>

      <div className="mt-1 flex items-center justify-end gap-1 opacity-100 transition-opacity sm:absolute sm:right-1 sm:top-1 sm:mt-0 sm:opacity-0 sm:group-hover/image:opacity-100 sm:group-focus-within/image:opacity-100">
        <button
          type="button"
          onClick={() => {
            void copyImageSource(resolvedSource).then((copied) => setCopyState(copied ? "copied" : "failed"));
          }}
          aria-label="复制图片"
          title={copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制图片"}
          className="flex h-10 min-w-10 items-center justify-center rounded-md bg-zinc-900/75 px-2 text-[10px] text-white hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          {copyState === "copied" ? "已复制" : copyState === "failed" ? "失败" : "复制图片"}
        </button>
        <a
          href={resolvedSource}
          download={alt?.trim() || "image"}
          target="_blank"
          rel="noreferrer noopener"
          aria-label="保存图片"
          className="flex h-10 min-w-10 items-center justify-center rounded-md bg-zinc-900/75 px-2 text-[10px] text-white hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        >
          保存图片
        </a>
      </div>

      <span className="sr-only" aria-live="polite">
        {copyState === "copied" ? "图片已复制" : copyState === "failed" ? "图片复制失败" : ""}
      </span>

      {remoteAllowed && viewerOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              data-imported-image-viewer
              role="dialog"
              aria-modal="true"
              aria-label={`原图预览：${accessibleAlt}`}
              className="fixed inset-0 z-[250] flex items-center justify-center bg-black/85 p-4"
              onClick={(event) => {
                if (event.target === event.currentTarget) setViewerOpen(false);
              }}
            >
              <img
                src={resolvedSource}
                alt={accessibleAlt}
                referrerPolicy="no-referrer"
                className="max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] object-contain"
              />
              <button
                ref={viewerCloseRef}
                type="button"
                onClick={() => setViewerOpen(false)}
                aria-label="关闭原图预览"
                className="absolute right-4 top-4 flex h-11 w-11 items-center justify-center rounded-full bg-black/70 text-xl text-white hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
              >
                ×
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
