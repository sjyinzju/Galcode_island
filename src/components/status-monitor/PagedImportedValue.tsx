import { useEffect, useRef, useState } from "react";
import { formatImportedValue } from "../../lib/importedConversation";

export const IMPORTED_VALUE_PAGE_SIZE = 96 * 1024;

interface ImportedValuePage {
  content: string;
  nextOffset: number;
}

export function takeImportedValuePage(text: string, offset: number): ImportedValuePage {
  const start = Math.max(0, Math.min(Math.trunc(offset), text.length));
  let end = Math.min(start + IMPORTED_VALUE_PAGE_SIZE, text.length);
  if (
    end < text.length &&
    end > start &&
    /[\uD800-\uDBFF]/.test(text[end - 1] ?? "") &&
    /[\uDC00-\uDFFF]/.test(text[end] ?? "")
  ) {
    end -= 1;
  }
  return { content: text.slice(start, end), nextOffset: end };
}

function defer<T>(work: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    globalThis.setTimeout(() => {
      try {
        resolve(work());
      } catch (error) {
        reject(error);
      }
    }, 0);
  });
}

function prepareImportedObjectInWorker(value: object): Promise<string> | null {
  if (
    typeof Worker === "undefined" ||
    typeof Blob === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) return null;
  const script = `
self.onmessage = function (event) {
  try {
    var text = JSON.stringify(event.data, function (key, nestedValue) {
      if (typeof nestedValue !== "string") return nestedValue;
      var container = this || {};
      return nestedValue.indexOf("data:image/") === 0 ||
        (key === "data" && container.type === "base64")
        ? "[Image data omitted]"
        : nestedValue;
    }, 2) || "";
    self.postMessage({ ok: true, text: text });
  } catch (error) {
    self.postMessage({ ok: false, error: String(error) });
  }
  };`;
  const workerUrl = URL.createObjectURL(new Blob([script], { type: "text/javascript" }));
  let worker: Worker;
  try {
    worker = new Worker(workerUrl);
  } catch (error) {
    URL.revokeObjectURL(workerUrl);
    return Promise.reject(error);
  }
  return new Promise<string>((resolve, reject) => {
    const cleanup = (): void => {
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
    };
    worker.onmessage = (event: MessageEvent<{ ok: boolean; text?: string; error?: string }>) => {
      cleanup();
      if (event.data.ok) resolve(event.data.text ?? "");
      else reject(new Error(event.data.error ?? "Imported value formatting failed"));
    };
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "Imported value worker failed"));
    };
    try {
      worker.postMessage(value);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

export function prepareImportedValue(value: unknown): Promise<string> {
  if (typeof value === "string") {
    return defer(() => value.startsWith("data:image/") ? formatImportedValue(value) : value);
  }
  if (value && typeof value === "object") {
    const workerResult = prepareImportedObjectInWorker(value);
    if (workerResult) return workerResult;
  }
  return defer(() => formatImportedValue(value));
}

export function downloadImportedValue(text: string, fileName: string): Promise<void> {
  return defer(() => {
    if (typeof document === "undefined") throw new Error("Downloads are unavailable");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.rel = "noreferrer noopener";
      anchor.click();
    } finally {
      globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  });
}

type PreparedState =
  | { input: unknown; status: "loading" }
  | { input: unknown; status: "error" }
  | {
      input: unknown;
      status: "ready";
      text: string;
      pages: string[];
      shownLength: number;
    };

interface PagedImportedValueProps {
  value: unknown;
  fileName?: string;
  className?: string;
}

export function PagedImportedValue({
  value,
  fileName = "imported-result.txt",
  className = "",
}: PagedImportedValueProps): JSX.Element {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<PreparedState>({ input: value, status: "loading" });
  const [saveState, setSaveState] = useState<"idle" | "saving" | "error">("idle");
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setState({ input: value, status: "loading" });
    setSaveState("idle");
    void prepareImportedValue(value).then(
      (text) => {
        if (!active) return;
        const firstPage = takeImportedValuePage(text, 0);
        setState({
          input: value,
          status: "ready",
          text,
          pages: firstPage.content ? [firstPage.content] : [],
          shownLength: firstPage.nextOffset,
        });
      },
      () => {
        if (active) setState({ input: value, status: "error" });
      },
    );
    return () => {
      active = false;
    };
  }, [attempt, value]);

  const currentState = Object.is(state.input, value) ? state : null;

  if (!currentState || currentState.status === "loading") {
    return (
      <div
        role="status"
        aria-live="polite"
        className={`py-2 text-[11px] text-zinc-500 dark:text-zinc-400 ${className}`}
      >
        正在准备完整结果…
      </div>
    );
  }

  if (currentState.status === "error") {
    return (
      <div
        role="alert"
        className={`flex min-h-9 items-center justify-between gap-3 py-1 text-[11px] text-rose-700 dark:text-rose-300 ${className}`}
      >
        <span>完整结果准备失败</span>
        <button
          type="button"
          onClick={() => {
            setState({ input: value, status: "loading" });
            setAttempt((current) => current + 1);
          }}
          className="min-h-9 shrink-0 rounded-md px-2 font-medium hover:bg-rose-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
        >
          重试
        </button>
      </div>
    );
  }

  const hasMore = currentState.shownLength < currentState.text.length;

  return (
    <div className={className}>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-zinc-700 [overflow-wrap:anywhere] dark:text-zinc-300">
        {currentState.pages.map((page, index) => (
          <span key={index} data-imported-value-page={index + 1}>{page}</span>
        ))}
      </pre>
      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-black/10 pt-2 text-[10px] text-zinc-500 dark:border-white/10 dark:text-zinc-400">
        <span className="mr-auto tabular-nums">
          已显示 {currentState.shownLength.toLocaleString()} / {currentState.text.length.toLocaleString()} 字符
        </span>
        {hasMore && (
          <button
            type="button"
            onClick={() => {
              setState((previous) => {
                if (previous.status !== "ready" || !Object.is(previous.input, value)) {
                  return previous;
                }
                const nextPage = takeImportedValuePage(previous.text, previous.shownLength);
                if (!nextPage.content) return previous;
                return {
                  ...previous,
                  pages: [...previous.pages, nextPage.content],
                  shownLength: nextPage.nextOffset,
                };
              });
            }}
            className="min-h-9 rounded-md px-2 font-medium text-sky-700 hover:bg-sky-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 dark:text-sky-300"
          >
            继续显示
          </button>
        )}
        <button
          type="button"
          disabled={saveState === "saving"}
          onClick={() => {
            setSaveState("saving");
            void downloadImportedValue(currentState.text, fileName).then(
              () => {
                if (mountedRef.current) setSaveState("idle");
              },
              () => {
                if (mountedRef.current) setSaveState("error");
              },
            );
          }}
          className="min-h-9 rounded-md px-2 font-medium text-zinc-700 hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 disabled:cursor-wait disabled:opacity-60 dark:text-zinc-200 dark:hover:bg-white/10"
        >
          {saveState === "saving" ? "正在保存…" : saveState === "error" ? "保存失败，重试" : "保存完整结果"}
        </button>
        <span className="sr-only" aria-live="polite">
          {saveState === "saving" ? "正在准备完整结果文件" : saveState === "error" ? "完整结果保存失败" : ""}
        </span>
      </div>
    </div>
  );
}
