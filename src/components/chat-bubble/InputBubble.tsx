import { useState, useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "../../lib/bridge";
import { useAppStore } from "../../stores/useAppStore";
import { useProfileStore } from "../../stores/useProfileStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useTabsStore } from "../../stores/useTabsStore";
import { useActivityStore } from "../../stores/useActivityStore";
import { useUiStore } from "../../stores/useUiStore";
import { useActiveTab, useActiveTabActions } from "../../hooks/useActiveTab";
import { useProjectSlashCommands } from "../../hooks/useProjectSlashCommands";
import { PetCharacter } from "../pet-character/PetCharacter";
import { PermissionModeBadge } from "../PermissionModeBadge";
import {
  BUILTIN_COMMAND_HANDLERS,
  mergeCommands,
  parseSlashInput,
  type SlashCommandRecord,
} from "../../lib/slashCommands";

const GREETINGS = [
  "喂，[称呼]，发什么呆呢？今天的部团活动要开始咯，有什么有趣的企划快交上来看看。",
  "真是的，让我等这么久。说吧，今天又有什么好玩的事情要做？",
  "就算是[称呼]，也得好好工作才行哦。有什么想做的，我们一起搞定吧！",
  "既然来了，就一起来找点乐子吧。有什么代码或者麻烦的任务需要我出马吗？",
  "[称呼]，今天有没有带来能让我眼前一亮的需求？普通的任务我可是会打哈欠的哦。",
];

export function InputBubble(): JSX.Element {
  const nickname = useProfileStore((s) => s.nickname);
  const displayNickname = nickname.trim() ? nickname : "部员";
  const addLogEntry = useAppStore((s) => s.addLogEntry);

  const tab = useActiveTab();
  const { activeTabId, update, clearBlocks } = useActiveTabActions();

  const projectPath = tab.projectPath;
  const agentStatus = tab.agentStatus;
  const task = tab.task;

  const [greeting, setGreeting] = useState("");
  const [displayedGreeting, setDisplayedGreeting] = useState("");
  // 中文输入法 composition 期间不要把 Enter 当发送 — 双保险用 keydown.isComposing
  // + composition* 事件标记
  const isComposingRef = useRef(false);

  // ---------- 斜杠命令面板 ----------
  // task 以 `/` 开头时显示下拉；按 ↑↓ 选 / Enter|Tab 补全 / Esc 关闭。
  const projectCommands = useProjectSlashCommands(projectPath);
  const allCommands = useMemo(() => mergeCommands(projectCommands), [projectCommands]);
  const slashQuery = useMemo(() => parseSlashInput(task), [task]);
  // 当面板可见时，过滤命令并维护选中项
  // 匹配规则：
  //   - 命令名前缀 startsWith（最高优先级）
  //   - 命令名 includes（次优；让用户输入命名空间后半段也能匹中）
  //   - 命令描述 includes（让"翻译"之类的关键字也能撞上）
  // 输入裸 "/" 时 q="", 全部命令通过。
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
  // 用户在命令名后已经敲了空格 → 视为"在写参数"，面板必须收起。
  // 不收起的话 Enter / Tab 会调 completeSlashCommand，把用户在命令后写的
  // 那串 prompt 整个擦掉（bug：/ecc:plan + 一段话 → Enter → 只剩 /ecc:plan）。
  const isStillTypingCommandName = useMemo(() => {
    const t = task.trimStart();
    if (!t.startsWith("/")) return false;
    return !/\s/.test(t);
  }, [task]);
  // 当前输入是否完整匹配某个命令名（含命名空间，如 "ecc:plan"）。
  // 完整匹配时 Enter = 直接 submit；否则 Enter = 补全到选中项。
  const exactMatch = useMemo(() => {
    if (!slashQuery || !slashQuery.name) return null;
    return filteredCommands.find((c) => c.name === slashQuery.name) ?? null;
  }, [filteredCommands, slashQuery]);
  const showSlashPanel =
    !!slashQuery && filteredCommands.length > 0 && isStillTypingCommandName;
  const [slashIndex, setSlashIndex] = useState(0);
  useEffect(() => {
    // 过滤集变化时把选中项归零，避免越界
    if (slashIndex >= filteredCommands.length) setSlashIndex(0);
  }, [filteredCommands, slashIndex]);

  // 补全后总是带一个尾部空格：
  //   - 让面板立刻收起（isStillTypingCommandName 变 false），用户不会再误按 Enter
  //     触发二次补全；
  //   - 用户可以接着敲参数；
  //   - 命令本身不需要参数时（如 /clear），再按 Enter 直接 submit 即可，
  //     handleLaunch / builtin handler 对带 trailing space 的 raw text 都是宽容的。
  const completeSlashCommand = (cmd: SlashCommandRecord): void => {
    const next = `/${cmd.name} `;
    update({ task: next });
    // textarea 移到末尾，方便用户继续敲参数
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      try {
        el.setSelectionRange(len, len);
      } catch {
        /* noop */
      }
    });
  };

  // textarea ref：让外部（user-prompt block 的"编辑重发"按钮）可以 focus 进来
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const inputFocusRequest = useUiStore((s) => s.inputFocusRequest);
  // counter 一变就 focus + 把光标移到末尾，方便用户立刻继续敲
  useEffect(() => {
    if (inputFocusRequest === 0) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    try {
      el.setSelectionRange(len, len);
    } catch {
      /* 某些非常老的 webview 可能不支持，无关紧要 */
    }
  }, [inputFocusRequest]);

  useEffect(() => {
    if (agentStatus === "idle") {
      const g = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
      setGreeting(g.replace(/\[称呼\]/g, displayNickname));
      setDisplayedGreeting("");
    }
  }, [agentStatus, displayNickname]);

  useEffect(() => {
    if (!greeting || agentStatus !== "idle") return;

    let currentIndex = 0;
    const intervalId = setInterval(() => {
      setDisplayedGreeting(greeting.substring(0, currentIndex + 1));
      currentIndex++;
      if (currentIndex >= greeting.length) {
        clearInterval(intervalId);
      }
    }, 40);

    return () => clearInterval(intervalId);
  }, [greeting, agentStatus]);

  const runBuiltinCommand = async (
    name: string,
    args: string,
    rawText: string
  ): Promise<boolean> => {
    const handler = BUILTIN_COMMAND_HANDLERS[name];
    if (!handler) return false;
    const result = await Promise.resolve(
      handler({
        rawText,
        commandName: name,
        args,
        activeTabId,
        projectPath,
        actions: {
          clearActiveTabBlocks: () => clearBlocks(),
          openSettings: () => useSettingsStore.getState().openSettingsModal(),
          setPermissionMode: (value) => update({ permissionMode: value }),
          addLog: (level, message) =>
            addLogEntry({ timestamp: Date.now(), level, message }),
        },
      })
    );
    if (result.notice) {
      addLogEntry({ timestamp: Date.now(), level: "info", message: result.notice });
    }
    return result.status === "handled";
  };

  const handleLaunch = async (): Promise<void> => {
    if (!task.trim() || !activeTabId) return;
    // 斜杠命令优先：能本地处理就不走 start_agent
    const parsed = parseSlashInput(task);
    if (parsed) {
      const builtin = allCommands.find(
        (c) => c.name === parsed.name && c.source === "builtin" && c.handler === "local"
      );
      if (builtin && (await runBuiltinCommand(parsed.name, parsed.args, task))) {
        update({ task: "" });
        return;
      }
      // 其它情况（passthrough / 项目命令 / 未知）按透传处理：仍需要 projectPath
    }
    if (!projectPath) return;
    try {
      // 上一轮 backend native session id（Claude CLI session / Codex thread /
      // OpenCode session）作为 resume 候选 —— 重启 app 后内存 last_session_per_context
      // 是空的，前端持久化的 native id 能续上下文。**不能传 tab.sessionId**（那是
      // 前端 AgentSession UUID，跟后端 --resume 期望的 ID 不是一回事）。
      const resumeHint = tab.agentNativeSessionId;

      // 切到 running 状态。
      // **不清 cliBlocks** —— 单项目多轮会话累积保留，让用户能看到完整工作历史；
      // 也不清上次的 resultZh / summary / emotion / suggestionOptions —— uiState=running
      // 期间 RunningBubble 会盖住 ResultCard，新 turn 完成时这些字段被新的
      // session-complete 事件覆盖。
      update({
        percent: 0,
        uiState: "running",
        mode: "working",
        agentStatus: "running",
        lastUserPrompt: task.trim().slice(0, 80),
        lastActiveAt: Date.now(),
      });
      // 在流式区追加一条用户消息气泡（右对齐），让多轮对话有清晰的"用户/agent"
      // 交替顺序。前端自管，不依赖 backend emit。
      useTabsStore.getState().appendCliBlock(activeTabId, {
        id: `user-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: "user-prompt",
        content: task.trim(),
      });

      const res = await invoke<{ sessionId?: string }>("start_agent", {
        userInputZh: task,
        cwd: projectPath || ".",
        agent: tab.agent,
        runId: activeTabId,
        sessionId: resumeHint,
        // 仅 claude-code 后端读取；codex/opencode 在 Rust 侧忽略
        permissionMode: tab.agent === "claude-code" ? tab.permissionMode : null,
      });
      if (res?.sessionId) {
        update({ sessionId: res.sessionId });
      }
      // start_agent 成功才计入当天活跃 —— 失败的尝试不该把今天点亮
      useActivityStore.getState().recordActivity({
        projectPath,
        agent: tab.agent,
        prompt: task.trim(),
      });
    } catch (err) {
      addLogEntry({
        timestamp: Date.now(),
        level: "error",
        message: `launch err: ${String(err)}`,
      });
      update({
        uiState: "error",
        mode: "error",
        agentStatus: "error",
      });
    }
  };

  return (
    <AnimatePresence>
      {agentStatus === "idle" && (
        <motion.div
          key="input-bubble"
          initial={{ opacity: 0, y: 10, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.95 }}
          transition={{ type: "spring", damping: 22, stiffness: 280 }}
          // 自然高度，textarea 自身有 min-h 提供输入区
          className="relative w-full rounded-[22px] rounded-bl-[6px] shadow-lg shadow-amber-500/10 dark:shadow-none"
        >
          {/* 真·环绕光效：背景 conic-gradient 的 from 角度做动画（用 @property
              --glow-angle），div 形状本身不旋转 —— mask 切出的圆角边框稳套外层，
              光段在边框上平滑滑动一圈。详细 CSS 在 index.css `.glow-frame`。 */}
          <div aria-hidden="true" className="glow-frame rounded-[22px] rounded-bl-[6px]" />

          {/* Inner glass content container —— 自然高度，三段式（嵌入桌宠头部 /
              textarea / 启动按钮）；textarea 自身 min-h 提供编辑区高度 */}
          <div className="relative flex w-full flex-col gap-3 rounded-[22px] rounded-bl-[6px] border border-white/60 bg-white/70 p-3.5 backdrop-blur-2xl sm:p-5 dark:border-white/10 dark:bg-slate-800/60">
            {/* 移动端嵌入式头部：左 桌宠 compact + 右 greeting 文字 */}
            <div className="flex shrink-0 items-start gap-3 sm:hidden">
              <div className="shrink-0">
                <PetCharacter size="compact" />
              </div>
              <div className="min-h-[5rem] flex-1 self-stretch text-[14px] font-medium leading-relaxed tracking-wide text-zinc-600 dark:text-zinc-300">
                {displayedGreeting}
                {displayedGreeting.length < greeting.length && (
                  <motion.span
                    animate={{ opacity: [1, 0] }}
                    transition={{ repeat: Infinity, duration: 0.8 }}
                    className="ml-1 inline-block h-[14px] w-2 bg-sky-400/70 align-middle"
                  />
                )}
              </div>
            </div>

            {/* 桌面端 greeting 单独行（移动端已嵌入头部） */}
            <div className="hidden shrink-0 min-h-[3rem] items-start justify-between gap-3 sm:flex">
              <div className="flex-1 text-[15px] font-medium leading-relaxed tracking-wide text-zinc-600 dark:text-zinc-300">
                {displayedGreeting}
                {displayedGreeting.length < greeting.length && (
                  <motion.span
                    animate={{ opacity: [1, 0] }}
                    transition={{ repeat: Infinity, duration: 0.8 }}
                    className="ml-1 inline-block h-[15px] w-2 bg-sky-400/70 align-middle"
                  />
                )}
              </div>
              {/* Permission mode 徽章：桌面端紧贴 greeting 右侧；Shift+Tab 切换 */}
              <div className="shrink-0">
                <PermissionModeBadge />
              </div>
            </div>

            <div className="relative">
            <textarea
              ref={textareaRef}
              value={task}
              onChange={(e) => update({ task: e.target.value })}
              placeholder="和团长对话……  (Enter 发送，Shift+Enter 换行，/ 查看命令)"
              // 移动端 min-h 100px 给足输入区；桌面端 min-h-[100px]
              className="min-h-[100px] max-h-[40vh] w-full resize-none rounded-xl border border-black/5 bg-white/50 p-3 text-base text-zinc-800 outline-none transition-all placeholder:text-zinc-400 focus:border-sky-400/50 focus:bg-white/80 focus:ring-2 focus:ring-sky-400/15 sm:max-h-none sm:p-3.5 sm:text-sm dark:border-white/5 dark:bg-slate-900/40 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-sky-400/40 dark:focus:bg-slate-900/60 dark:focus:ring-sky-400/10"
              onCompositionStart={() => {
                isComposingRef.current = true;
              }}
              onCompositionEnd={() => {
                isComposingRef.current = false;
              }}
              onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
                // 斜杠命令面板可见时，方向键 / Tab / Enter 优先服务面板
                if (showSlashPanel) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSlashIndex((i) => (i + 1) % filteredCommands.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSlashIndex(
                      (i) => (i - 1 + filteredCommands.length) % filteredCommands.length
                    );
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    update({ task: "" });
                    return;
                  }
                  if (e.key === "Tab") {
                    // Tab 补全，Shift+Tab 由 useChatHotkeys 处理（不要拦下来）
                    if (e.shiftKey) return;
                    e.preventDefault();
                    completeSlashCommand(filteredCommands[slashIndex]);
                    return;
                  }
                  // Enter：
                  //  - 用户已经敲完完整命令名（exactMatch） → 立刻 submit，
                  //    交给 handleLaunch（builtin local / passthrough）。
                  //  - 只是部分匹配（还在边敲边选） → 补全到选中项。
                  if (e.key === "Enter" && !e.shiftKey) {
                    const native = e.nativeEvent as KeyboardEvent["nativeEvent"] & {
                      isComposing?: boolean;
                    };
                    if (native.isComposing || e.keyCode === 229 || isComposingRef.current) return;
                    e.preventDefault();
                    if (exactMatch) {
                      void handleLaunch();
                    } else {
                      completeSlashCommand(filteredCommands[slashIndex]);
                    }
                    return;
                  }
                }
                if (e.key !== "Enter") return;
                if (e.shiftKey) return;
                // IME 候选词期间按 Enter 是选词，跳过发送
                const native = e.nativeEvent as KeyboardEvent["nativeEvent"] & {
                  isComposing?: boolean;
                };
                if (native.isComposing || e.keyCode === 229 || isComposingRef.current) return;
                e.preventDefault();
                void handleLaunch();
              }}
            />
            {/* 斜杠命令下拉面板 */}
            <AnimatePresence>
              {showSlashPanel && (
                <motion.div
                  key="slash-panel"
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.12 }}
                  className="absolute bottom-full left-0 right-0 z-30 mb-1.5 max-h-64 overflow-y-auto rounded-xl border border-black/10 bg-white/95 shadow-lg backdrop-blur dark:border-white/10 dark:bg-slate-900/95"
                  role="listbox"
                >
                  {filteredCommands.map((cmd, idx) => {
                    const active = idx === slashIndex;
                    return (
                      <button
                        key={`${cmd.source}-${cmd.name}`}
                        type="button"
                        role="option"
                        aria-selected={active}
                        onMouseEnter={() => setSlashIndex(idx)}
                        onClick={() => completeSlashCommand(cmd)}
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
              )}
            </AnimatePresence>
            </div>

            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 sm:gap-3">
              {!projectPath && (
                <span className="text-[11px] text-amber-600/90 dark:text-amber-300/90">
                  请先在顶部选择项目目录
                </span>
              )}
              <motion.button
                whileHover={{ scale: 1.02, y: -1 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => void handleLaunch()}
                disabled={!task.trim() || !projectPath}
                // 移动端 px-7/py-3 = 44px+ 触控目标；桌面端保留原尺寸
                className="min-h-[44px] rounded-xl bg-sky-500 px-7 py-3 text-[15px] font-semibold tracking-wide text-white shadow-md shadow-sky-400/25 transition-all hover:bg-sky-600 hover:shadow-sky-400/40 active:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:px-6 sm:py-2.5 sm:text-sm"
              >
                启动
              </motion.button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
