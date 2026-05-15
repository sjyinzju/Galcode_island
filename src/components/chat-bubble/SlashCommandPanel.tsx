// 斜杠命令面板的共用 hook + 渲染组件。
//
// 在 InputBubble（最初输入框）和 ResultCard 的"继续追问"输入框两个地方都用，
// 避免两边复制逻辑漂移。
//
// 使用方式：
//   const slash = useSlashCommandPanel({ value, setValue, ... });
//   <textarea
//     value={value}
//     onChange={e => setValue(e.target.value)}
//     onKeyDown={e => {
//       if (slash.handleKeyDown(e)) return;  // 面板吞掉了，不要走下面 submit 逻辑
//       // ... 你的 Enter 提交逻辑（注意 IME / shift+Enter）
//     }}
//   />
//   {slash.show && <SlashCommandPanel {...slash.panelProps} />}
//
// 提交逻辑里：
//   if (await slash.tryRunBuiltin()) return;  // builtin 跑完了，不要再 start_agent

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
} from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { useProjectSlashCommands } from "../../hooks/useProjectSlashCommands";
import {
  BUILTIN_COMMAND_HANDLERS,
  mergeCommands,
  parseSlashInput,
  type BuiltinCommandContext,
  type SlashCommandRecord,
} from "../../lib/slashCommands";

export interface UseSlashCommandPanelOpts {
  value: string;
  setValue: (next: string) => void;
  /// 用于补全后把光标移到末尾；可选（不传则只更新 value）
  textareaRef?: MutableRefObject<HTMLTextAreaElement | null>;
  /// IME composition 状态，避免在中文输入候选阶段当 Enter 当发送
  isComposingRef: MutableRefObject<boolean>;
  projectPath: string | null;
  activeTabId: string | null;
  /// builtin command handler 需要的 actions 集合；调用方组装好传进来。
  actions: BuiltinCommandContext["actions"];
}

export interface SlashCommandPanelProps {
  panelRef: React.RefObject<HTMLDivElement | null>;
  items: readonly SlashCommandRecord[];
  activeIndex: number;
  setActiveIndex: (i: number) => void;
  onPick: (cmd: SlashCommandRecord) => void;
  /// 可选：portal 模式锚点。传入时面板用 createPortal 渲染到 document.body
  /// 并按 anchorRef 元素的 viewport 坐标定位，绕过祖先的 overflow-hidden 裁切
  /// （例如 ResultCard inner container 的 rounded-2xl + overflow-hidden 组合）。
  /// 不传则走默认 inline 绝对定位行为（InputBubble 用）。
  anchorRef?: MutableRefObject<HTMLElement | null>;
}

export interface SlashCommandPanelKit {
  /// 面板当前是否应该可见
  show: boolean;
  panelProps: SlashCommandPanelProps;
  /// 在 textarea 的 onKeyDown 顶部调用。返回 true 表示已处理（调用方应 return）。
  /// Enter 在 exactMatch 时返回 false，让调用方走自己的提交逻辑。
  handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /// 在你的提交（launch / followup submit）路径前调用。
  /// 若当前文本是 builtin local 命令则跑掉、清空 value、返回 true。
  tryRunBuiltin: () => Promise<boolean>;
}

export function useSlashCommandPanel(opts: UseSlashCommandPanelOpts): SlashCommandPanelKit {
  const { value, setValue, textareaRef, isComposingRef, projectPath, activeTabId, actions } = opts;

  // 项目级 + 用户级 + 插件命令拉取（hook 内自处理 projectPath 变化）
  const projectCommands = useProjectSlashCommands(projectPath);
  const allCommands = useMemo(() => mergeCommands(projectCommands), [projectCommands]);

  // 解析"/<name> <args>"。trim 前导空白后必须以 / 开头才算 slash 输入。
  const slashQuery = useMemo(() => parseSlashInput(value), [value]);

  // 过滤匹配命令：startsWith 优先，再 includes（命名空间后半段 / description 关键字）
  const filteredCommands: SlashCommandRecord[] = useMemo(() => {
    if (!slashQuery) return [];
    const q = slashQuery.name.toLowerCase();
    if (!q) return allCommands;
    const startsWith: SlashCommandRecord[] = [];
    const includes: SlashCommandRecord[] = [];
    for (const cmd of allCommands) {
      const lname = cmd.name.toLowerCase();
      if (lname.startsWith(q)) {
        startsWith.push(cmd);
      } else if (lname.includes(q) || cmd.description.toLowerCase().includes(q)) {
        includes.push(cmd);
      }
    }
    return startsWith.concat(includes);
  }, [allCommands, slashQuery]);

  // 用户敲完命令名后已经在写参数（命令名后有空白）→ 面板收起
  const isStillTypingCommandName = useMemo(() => {
    const t = value.trimStart();
    if (!t.startsWith("/")) return false;
    return !/\s/.test(t);
  }, [value]);

  // 完整匹配某条命令名（含命名空间）：Enter 时直接 submit 而非补全
  const exactMatch = useMemo(() => {
    if (!slashQuery || !slashQuery.name) return null;
    return filteredCommands.find((c) => c.name === slashQuery.name) ?? null;
  }, [filteredCommands, slashQuery]);

  const show = !!slashQuery && filteredCommands.length > 0 && isStillTypingCommandName;

  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => {
    // 过滤集变化时把选中项归零，避免越界
    if (activeIndex >= filteredCommands.length) setActiveIndex(0);
  }, [filteredCommands, activeIndex]);

  // 选中项滚动到视野内：textarea 持续持焦，浏览器不会自动滚 listbox，方向键
  // 跨过 max-h 边界会丢失视觉跟随。block:"nearest" 保证已在视野内时不打扰。
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!show) return;
    const panel = panelRef.current;
    if (!panel) return;
    const item = panel.querySelector<HTMLElement>(`[data-slash-index="${activeIndex}"]`);
    item?.scrollIntoView({ block: "nearest" });
  }, [show, activeIndex]);

  // 补全后总是带一个尾部空格，让面板立刻收起、用户可继续敲参数；
  // 命令不需要参数时再按 Enter 即直接 submit。
  const completeCommand = useCallback(
    (cmd: SlashCommandRecord): void => {
      const next = `/${cmd.name} `;
      setValue(next);
      requestAnimationFrame(() => {
        const el = textareaRef?.current;
        if (!el) return;
        el.focus();
        const len = el.value.length;
        try {
          el.setSelectionRange(len, len);
        } catch {
          /* noop */
        }
      });
    },
    [setValue, textareaRef]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!show) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((activeIndex + 1) % filteredCommands.length);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex(
          (activeIndex - 1 + filteredCommands.length) % filteredCommands.length
        );
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setValue("");
        return true;
      }
      if (e.key === "Tab") {
        // Tab 补全；Shift+Tab 由 useChatHotkeys 处理 permission mode 切换
        if (e.shiftKey) return false;
        e.preventDefault();
        const pick = filteredCommands[activeIndex];
        if (pick) completeCommand(pick);
        return true;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        // IME 候选词阶段不能截走
        const native = e.nativeEvent as KeyboardEvent["nativeEvent"] & {
          isComposing?: boolean;
        };
        if (native.isComposing || e.keyCode === 229 || isComposingRef.current) return false;
        // exactMatch → 让调用方走自己的 submit（一般会调 tryRunBuiltin 然后回 idle）
        if (exactMatch) return false;
        e.preventDefault();
        const pick = filteredCommands[activeIndex];
        if (pick) completeCommand(pick);
        return true;
      }
      return false;
    },
    [
      show,
      filteredCommands,
      activeIndex,
      completeCommand,
      exactMatch,
      isComposingRef,
      setValue,
    ]
  );

  const tryRunBuiltin = useCallback(async (): Promise<boolean> => {
    const parsed = parseSlashInput(value);
    if (!parsed) return false;
    const builtin = allCommands.find(
      (c) => c.name === parsed.name && c.source === "builtin" && c.handler === "local"
    );
    if (!builtin) return false;
    const handler = BUILTIN_COMMAND_HANDLERS[parsed.name];
    if (!handler) return false;
    const result = await Promise.resolve(
      handler({
        rawText: value,
        commandName: parsed.name,
        args: parsed.args,
        activeTabId,
        projectPath,
        actions,
      })
    );
    if (result.notice) {
      actions.addLog("info", result.notice);
    }
    if (result.status === "handled") {
      setValue("");
      return true;
    }
    return false;
  }, [value, allCommands, activeTabId, projectPath, actions, setValue]);

  return {
    show,
    panelProps: {
      panelRef,
      items: filteredCommands,
      activeIndex,
      setActiveIndex,
      onPick: completeCommand,
    },
    handleKeyDown,
    tryRunBuiltin,
  };
}

/// portal 模式下追踪 anchor 元素的 viewport 坐标 + viewport 高度（视窗 resize 时
/// 也要重算 panel.bottom）。anchor 元素移动 / resize / 祖先滚动时同步重算。
interface AnchorRect {
  left: number;
  top: number;
  width: number;
  viewportHeight: number;
}
function useAnchorRect(
  anchorRef: MutableRefObject<HTMLElement | null> | undefined
): AnchorRect | null {
  const [rect, setRect] = useState<AnchorRect | null>(null);
  useEffect(() => {
    if (!anchorRef) return;
    const update = (): void => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect({
        left: r.left,
        top: r.top,
        width: r.width,
        viewportHeight: window.innerHeight,
      });
    };
    update();
    // 监听窗口 resize（视口换尺寸）+ 任意祖先滚动（capture=true 抓所有滚动）
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    // 元素自身大小变化（textarea 高度随内容增长）— ResizeObserver
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && anchorRef.current) {
      ro = new ResizeObserver(update);
      ro.observe(anchorRef.current);
    }
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      ro?.disconnect();
    };
  }, [anchorRef]);
  return rect;
}

/// 纯渲染：吃 hook 的 panelProps，输出 listbox。
///
/// 渲染模式：
/// - 默认：inline absolute（依赖父容器 `position: relative`）。简单、不受
///   resize/scroll 抖动；但被任何祖先 `overflow-hidden` 裁切。
/// - 传 anchorRef：portal 到 document.body 用 fixed 坐标定位，绕开所有
///   祖先 overflow 限制。给 ResultCard 这种 inner container 有 overflow-hidden 的用。
export function SlashCommandPanel({
  panelRef,
  items,
  activeIndex,
  setActiveIndex,
  onPick,
  anchorRef,
}: SlashCommandPanelProps): JSX.Element | null {
  const anchorRect = useAnchorRect(anchorRef);
  const portalMode = !!anchorRef;

  // portal 模式下 anchor 还没量到坐标时不渲染（避免 (0,0) 闪一帧）
  if (portalMode && !anchorRect) return null;

  const node = (
    <motion.div
      key="slash-panel"
      ref={panelRef}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.12 }}
      role="listbox"
      // portal 模式：fixed 定位到 anchor 上方，translateY(-100%) 让自己向上展开
      // inline 模式：保留原 bottom-full / left-0 / right-0 绝对定位
      className={
        portalMode
          ? "fixed z-50 max-h-64 overflow-y-auto rounded-xl border border-black/10 bg-white/95 shadow-lg backdrop-blur dark:border-white/10 dark:bg-slate-900/95"
          : "absolute bottom-full left-0 right-0 z-30 mb-1.5 max-h-64 overflow-y-auto rounded-xl border border-black/10 bg-white/95 shadow-lg backdrop-blur dark:border-white/10 dark:bg-slate-900/95"
      }
      style={
        portalMode && anchorRect
          ? {
              left: anchorRect.left,
              // 用 bottom 直接定位，让面板底部贴 anchor 顶部上方 6px。
              // 不用 transform 是因为 framer-motion 的 animate={{ y }} 会用
              // inline transform 实现 y 动画，覆盖我们手写的 translateY，
              // 导致面板按 top 坐标渲染就显示在 anchor 同位置（看起来"往下展开"）。
              bottom: anchorRect.viewportHeight - anchorRect.top + 6,
              width: anchorRect.width,
            }
          : undefined
      }
    >
      {items.map((cmd, idx) => {
        const active = idx === activeIndex;
        return (
          <button
            key={`${cmd.source}-${cmd.name}`}
            type="button"
            role="option"
            aria-selected={active}
            data-slash-index={idx}
            onMouseEnter={() => setActiveIndex(idx)}
            onClick={() => onPick(cmd)}
            className={`flex w-full items-baseline gap-3 border-l-2 px-3 py-2 text-left transition-colors ${
              active
                ? "border-sky-400 bg-sky-50/70 dark:bg-sky-500/10"
                : "border-transparent hover:bg-zinc-100/60 dark:hover:bg-slate-800/60"
            }`}
          >
            <span className="shrink-0 font-mono text-xs font-semibold text-zinc-800 dark:text-zinc-100">
              /{cmd.name}
            </span>
            {cmd.argumentHint && (
              <span className="shrink-0 font-mono text-[10px] text-zinc-400">
                {cmd.argumentHint}
              </span>
            )}
            <span className="flex-1 truncate text-[11px] text-zinc-500 dark:text-zinc-400">
              {cmd.description}
            </span>
            <span
              className={`shrink-0 rounded px-1 text-[9px] font-medium uppercase tracking-wider ${
                cmd.source === "builtin"
                  ? "bg-zinc-200/70 text-zinc-600 dark:bg-zinc-700/40 dark:text-zinc-300"
                  : cmd.source === "project"
                    ? "bg-sky-100/80 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300"
                    : cmd.source === "user"
                      ? "bg-violet-100/80 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300"
                      : "bg-emerald-100/80 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
              }`}
              title={cmd.plugin ? `插件：${cmd.plugin}` : undefined}
            >
              {cmd.source === "plugin" && cmd.plugin
                ? `plugin · ${cmd.plugin}`
                : cmd.source}
            </span>
          </button>
        );
      })}
    </motion.div>
  );

  return portalMode ? createPortal(node, document.body) : node;
}
