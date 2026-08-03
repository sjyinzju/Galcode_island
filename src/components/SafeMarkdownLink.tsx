import { useState, type ReactNode } from "react";
import { defaultUrlTransform } from "react-markdown";
import { invoke, isTauri } from "../lib/bridge";

type LocalFileInvoker = (
  command: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

const SAFE_LOCAL_FILE_EXTENSIONS = new Set([
  "bmp", "csv", "doc", "docx", "flac", "gif", "jpeg", "jpg", "json", "jsonl",
  "log", "m4a", "markdown", "md", "mkv", "mov", "mp3", "mp4", "odp", "ods",
  "odt", "ogg", "pdf", "png", "ppt", "pptx", "rtf", "toml", "tsv", "txt",
  "wav", "webm", "webp", "xls", "xlsx", "xml", "yaml", "yml",
]);

function decodePath(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function isSafeLocalFilePath(path: string): boolean {
  if (/^(?:\\\\|\/\/)/.test(path)) return false;
  const fileName = path.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const extension = fileName.includes(".") ? fileName.split(".").at(-1)?.toLowerCase() : null;
  return Boolean(extension && SAFE_LOCAL_FILE_EXTENSIONS.has(extension));
}

export function localFilePathFromHref(href: string | undefined): string | null {
  const value = href?.trim();
  if (!value) return null;
  const decodedValue = decodePath(value);
  if (/^(?:\\\\|\/\/)/.test(decodedValue)) return null;
  if (/^[a-z]:[\\/]/i.test(decodedValue)) {
    return isSafeLocalFilePath(decodedValue) ? decodedValue : null;
  }
  if (decodedValue.startsWith("/")) {
    return isSafeLocalFilePath(decodedValue) ? decodedValue : null;
  }
  if (!/^file:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    if (url.host && url.host.toLowerCase() !== "localhost") return null;
    const decoded = decodeURIComponent(url.pathname);
    const path = /^\/[a-z]:[\\/]/i.test(decoded) ? decoded.slice(1) : decoded;
    return isSafeLocalFilePath(path) ? path : null;
  } catch {
    return null;
  }
}

export function safeMarkdownUrlTransform(url: string, key: string): string {
  if (key === "href" && localFilePathFromHref(url)) return url;
  return defaultUrlTransform(url);
}

export async function requestOpenLocalFile(
  path: string,
  opener: LocalFileInvoker = invoke,
): Promise<void> {
  await opener("open_local_file", { path });
}

function isSafeRemoteHref(href: string): boolean {
  return /^https?:\/\//i.test(href.trim());
}

export function SafeMarkdownLink({
  href,
  children,
  className,
}: {
  href?: string;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  const [openError, setOpenError] = useState(false);
  const localPath = localFilePathFromHref(href);
  const remoteHref = href && isSafeRemoteHref(href) ? href : null;

  if (localPath) {
    if (!isTauri) {
      return (
        <span className={className} title="本地文件仅能在桌面端打开">
          {children}<span className="ml-1 text-[9px] text-zinc-400">仅桌面端可打开</span>
        </span>
      );
    }
    return (
      <button
        type="button"
        className={className}
        title={openError ? "文件不存在或无法打开" : localPath}
        onClick={() => {
          setOpenError(false);
          void requestOpenLocalFile(localPath).catch(() => setOpenError(true));
        }}
      >
        {children}{openError ? <span className="ml-1 text-[9px]">打开失败</span> : null}
      </button>
    );
  }

  if (remoteHref) {
    return (
      <a
        href={remoteHref}
        target="_blank"
        rel="noreferrer noopener"
        referrerPolicy="no-referrer"
        className={className}
      >
        {children}
      </a>
    );
  }

  return <span className={className}>{children}</span>;
}
