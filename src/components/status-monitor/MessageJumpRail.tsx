import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import type { MessageJumpItem } from "./messageJumps";

interface MessageJumpRailProps {
  items: MessageJumpItem[];
  activeBlockId?: string | null;
  onJump: (blockId: string) => void;
}

interface PreviewState {
  item: MessageJumpItem;
  left: number;
  top: number;
}

const TOOLTIP_ID = "message-jump-preview";

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(length - 1, index));
}

export function MessageJumpRail({
  items,
  activeBlockId,
  onJump,
}: MessageJumpRailProps): JSX.Element | null {
  const railRef = useRef<HTMLDivElement | null>(null);
  const activeIndex = Math.max(0, items.findIndex((item) => item.blockId === activeBlockId));
  const [selectedIndex, setSelectedIndex] = useState(activeIndex);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);

  useEffect(() => {
    setSelectedIndex(activeIndex);
  }, [activeIndex]);

  if (items.length < 2) return null;

  const indexAtPointer = (clientY: number): number => {
    const rect = railRef.current?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return selectedIndex;
    const ratio = Math.max(0, Math.min(0.999_999, (clientY - rect.top) / rect.height));
    return Math.floor(ratio * items.length);
  };

  const showPreview = (index: number, clientY?: number): void => {
    const rect = railRef.current?.getBoundingClientRect();
    const item = items[clampIndex(index, items.length)];
    if (!rect || !item) return;
    const width = Math.min(340, window.innerWidth - 32);
    const markerY = clientY ?? rect.top + ((index + 0.5) / items.length) * rect.height;
    setPreview({
      item,
      left: Math.min(rect.right + 8, window.innerWidth - width - 16),
      top: Math.min(Math.max(16, markerY - 64), window.innerHeight - 144),
    });
  };

  const selectIndex = (index: number): void => {
    const nextIndex = clampIndex(index, items.length);
    setSelectedIndex(nextIndex);
    showPreview(nextIndex);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const index = indexAtPointer(event.clientY);
    setHoveredIndex(index);
    showPreview(index, event.clientY);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") nextIndex = selectedIndex + 1;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") nextIndex = selectedIndex - 1;
    else if (event.key === "PageDown") nextIndex = selectedIndex + 10;
    else if (event.key === "PageUp") nextIndex = selectedIndex - 10;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = items.length - 1;
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const item = items[selectedIndex];
      if (item) onJump(item.blockId);
      setPreview(null);
      return;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    selectIndex(nextIndex);
  };

  const jumpAtPointer = (event: MouseEvent<HTMLDivElement>): void => {
    const index = indexAtPointer(event.clientY);
    const item = items[index];
    if (item) {
      setSelectedIndex(index);
      onJump(item.blockId);
    }
    setPreview(null);
  };

  return (
    <>
      <nav
        aria-label={`消息跳转，共 ${items.length} 条`}
        className="absolute left-0 top-1/2 z-20 h-[80%] min-h-24 w-6 -translate-y-1/2"
      >
        <div
          ref={railRef}
          role="slider"
          tabIndex={0}
          aria-label={`消息跳转，当前第 ${selectedIndex + 1} 条，共 ${items.length} 条`}
          aria-orientation="vertical"
          aria-valuemin={1}
          aria-valuemax={items.length}
          aria-valuenow={selectedIndex + 1}
          aria-valuetext={items[selectedIndex]?.prompt}
          aria-describedby={preview ? TOOLTIP_ID : undefined}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => {
            setHoveredIndex(null);
            setPreview(null);
          }}
          onClick={jumpAtPointer}
          onFocus={() => showPreview(selectedIndex)}
          onBlur={() => setPreview(null)}
          onKeyDown={handleKeyDown}
          className="absolute left-0 top-1/2 w-full -translate-y-1/2 cursor-pointer touch-none rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500/70"
          style={{ height: `min(${items.length * 14}px, 100%)` }}
        >
          {items.map((item, index) => {
            const isActive = item.blockId === activeBlockId;
            const isHighlighted = index === hoveredIndex || index === selectedIndex || isActive;
            return (
              <span
                key={item.blockId}
                data-message-marker="true"
                data-active={isActive ? "true" : undefined}
                aria-hidden="true"
                className={`pointer-events-none absolute left-1 h-0.5 -translate-y-1/2 rounded-full transition-[width,background-color] duration-150 ease-out motion-reduce:transition-none ${
                  isHighlighted
                    ? "w-5 bg-sky-500 dark:bg-sky-300"
                    : "w-2.5 bg-zinc-400/60 dark:bg-zinc-600"
                }`}
                style={{ top: `${((index + 0.5) / items.length) * 100}%` }}
              />
            );
          })}
        </div>
      </nav>

      {preview && typeof document !== "undefined"
        ? createPortal(
            <div
              id={TOOLTIP_ID}
              role="tooltip"
              className="pointer-events-none fixed z-[60] w-[340px] max-w-[calc(100vw-2rem)] rounded-xl border border-black/10 bg-white/95 p-3 text-left shadow-md backdrop-blur dark:border-white/10 dark:bg-slate-900/95"
              style={{ left: preview.left, top: preview.top }}
            >
              <div className="line-clamp-2 text-[13px] font-semibold leading-5 text-zinc-800 dark:text-zinc-100">
                {preview.item.prompt}
              </div>
              <div className="mt-1 line-clamp-3 text-[12px] leading-[1.45] text-zinc-500 dark:text-zinc-400">
                {preview.item.responsePreview || "本轮暂无文字回复"}
              </div>
              {(preview.item.files.length > 0 || preview.item.extraFileCount > 0) && (
                <div className="mt-2 flex min-w-0 items-center gap-2 text-[10px] text-zinc-500 dark:text-zinc-400">
                  {preview.item.files.map((file) => (
                    <span key={file} className="flex min-w-0 items-center gap-1">
                      <svg
                        viewBox="0 0 12 12"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        className="h-3 w-3 shrink-0"
                        aria-hidden="true"
                      >
                        <path d="M2.5 1.5h4l3 3v6h-7z" />
                        <path d="M6.5 1.5v3h3" />
                      </svg>
                      <span className="max-w-24 truncate">{file}</span>
                    </span>
                  ))}
                  {preview.item.extraFileCount > 0 && (
                    <span className="shrink-0">+{preview.item.extraFileCount}</span>
                  )}
                </div>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
