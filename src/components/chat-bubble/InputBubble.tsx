import { useState, useEffect, useRef, type KeyboardEvent } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke, isTauri, pickFiles, pickFolder } from "../../lib/bridge";
import {
  buildImportedFallbackContext,
  canContinueImportedConversation,
} from "../../lib/importedConversation";
import { resolveLaunchMessage } from "../../lib/chatLaunch";
import { runExclusive } from "../../lib/runExclusive";
import { useAppStore } from "../../stores/useAppStore";
import { useProfileStore } from "../../stores/useProfileStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useTabsStore } from "../../stores/useTabsStore";
import { useActivityStore } from "../../stores/useActivityStore";
import { useUiStore } from "../../stores/useUiStore";
import { useActiveTab, useActiveTabActions } from "../../hooks/useActiveTab";
import { PetCharacter } from "../pet-character/PetCharacter";
import { PermissionModeBadge } from "../PermissionModeBadge";
import { SlashCommandPanel, useSlashCommandPanel } from "./SlashCommandPanel";
import { selectPromptOverride } from "../../lib/petPromptOverride";
import {
  getActiveCategories,
  getActivePreset,
  isCustomPresetActive,
  usePetAssetsStore,
} from "../../stores/usePetAssetsStore";

const GREETINGS = [
  "喂，[称呼]，发什么呆呢？今天的部团活动要开始咯，有什么有趣的企划快交上来看看。",
  "真是的，让我等这么久。说吧，今天又有什么好玩的事情要做？",
  "就算是[称呼]，也得好好工作才行哦。有什么想做的，我们一起搞定吧！",
  "既然来了，就一起来找点乐子吧。有什么代码或者麻烦的任务需要我出马吗？",
  "[称呼]，今天有没有带来能让我眼前一亮的需求？普通的任务我可是会打哈欠的哦。",
];

/// 进程内缓存：同 (persona, nickname) 一次会话内只调一次 LLM 生成欢迎语，
/// 避免反复"idle → 重新生成"耗 token。重启进程清空。
const welcomeSpeechCache = new Map<string, string>();

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
  const [attachmentPaths, setAttachmentPaths] = useState<string[]>([]);
  const petEnabled = useSettingsStore((s) => s.petEnabled);
  // 中文输入法 composition 期间不要把 Enter 当发送 — 双保险用 keydown.isComposing
  // + composition* 事件标记
  const isComposingRef = useRef(false);
  const launchInFlightRef = useRef(false);

  useEffect(() => {
    setAttachmentPaths([]);
  }, [activeTabId]);

  // textarea ref：让外部（user-prompt block 的"编辑重发"按钮）可以 focus 进来；
  // 同时给 slash 面板 hook 在 Tab/Enter 补全后调 setSelectionRange 移光标
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // ---------- 斜杠命令面板（共用 hook，详见 SlashCommandPanel.tsx）----------
  const slash = useSlashCommandPanel({
    value: task,
    setValue: (next) => update({ task: next }),
    textareaRef,
    isComposingRef,
    projectPath,
    activeTabId,
    actions: {
      clearActiveTabBlocks: () => clearBlocks(),
      openSettings: () => useSettingsStore.getState().openSettingsModal(),
      setPermissionMode: (value) => update({ permissionMode: value }),
      addLog: (level, message) =>
        addLogEntry({ timestamp: Date.now(), level, message }),
    },
  });
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
    if (agentStatus !== "idle") return;
    // 萌宠关闭时不生成问候语：界面上没有"无宠说话"的气泡，也省一次 LLM 调用
    if (!petEnabled) {
      setGreeting("");
      setDisplayedGreeting("");
      return;
    }
    // 优先策略：若启用了自定义桌宠且 welcome 类有任意一张图带 communityPrompt，
    // 调 LLM 用该 prompt 当人设生成一句开场欢迎语；失败 / 无 prompt → 回退默认 GREETINGS。
    let cancelled = false;
    const fallback = (): void => {
      const g = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
      setGreeting(g!.replace(/\[称呼\]/g, displayNickname));
      setDisplayedGreeting("");
    };
    const tryCustom = async (): Promise<void> => {
      const petState = usePetAssetsStore.getState();
      if (!isCustomPresetActive(petState)) return fallback();
      const welcomeList = getActiveCategories(petState).welcome ?? [];
      const presetPersona = getActivePreset(petState).persona?.trim() || null;
      // 解析顺序：先看 welcome 类有图带 prompt → 用图 prompt；否则回退到预设 persona；
      // 都空才走静态 GREETINGS 兜底
      const withPrompt = welcomeList.filter((m) => m.communityPrompt?.trim());
      let persona: string | null = null;
      if (withPrompt.length > 0) {
        const picked = withPrompt[Math.floor(Math.random() * withPrompt.length)]!;
        persona = picked.communityPrompt!.trim();
      } else if (presetPersona) {
        persona = presetPersona;
      }
      if (!persona) return fallback();
      // 缓存：同 persona 一次会话内只调一次 LLM（避免反复"idle → 重新生成"耗 token）
      const cacheKey = `welcome:${persona}:${displayNickname}`;
      const cached = welcomeSpeechCache.get(cacheKey);
      if (cached) {
        if (!cancelled) {
          setGreeting(cached);
          setDisplayedGreeting("");
        }
        return;
      }
      try {
        const speech = await invoke<string>("generate_welcome_speech", {
          persona,
          nickname: displayNickname,
        });
        if (cancelled) return;
        const final = speech.trim() || "";
        if (final) {
          welcomeSpeechCache.set(cacheKey, final);
          setGreeting(final);
          setDisplayedGreeting("");
        } else {
          fallback();
        }
      } catch {
        // LLM 未配置 / 失败 → fallback
        if (!cancelled) fallback();
      }
    };
    void tryCustom();
    return () => {
      cancelled = true;
    };
  }, [agentStatus, displayNickname, petEnabled]);

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

  const handleLaunch = (): Promise<void> => runExclusive(launchInFlightRef, async () => {
    const launchMessage = resolveLaunchMessage(task, attachmentPaths.length);
    if (!launchMessage || !activeTabId) return;
    const { visibleText, agentInput } = launchMessage;
    if (!canContinueImportedConversation(
      tab.importedConversationId,
      tab.hasFullImportedHistory,
    )) return;
    // 斜杠命令优先：能本地处理就不走 start_agent。
    // tryRunBuiltin 内部已 clear value 并返回 true；passthrough / 项目命令 /
    // 未知命令返回 false，落到下面的 start_agent 透传路径。
    if (visibleText && await slash.tryRunBuiltin()) return;
    let launchProjectPath = projectPath;
    if (launchProjectPath) {
      try {
        await invoke("validate_directory", { path: launchProjectPath });
      } catch {
        launchProjectPath = null;
      }
    }
    if (!launchProjectPath) {
      launchProjectPath = await pickFolder({
        defaultPath: projectPath ?? undefined,
        title: "选择用于继续会话的有效项目目录",
      });
      if (!launchProjectPath) {
        addLogEntry({
          timestamp: Date.now(),
          level: "error",
          message: "Cannot continue: project directory is unavailable.",
        });
        window.alert("项目目录不可用，请选择有效目录后再继续。");
        return;
      }
      update({ projectPath: launchProjectPath });
    }
    try {
      // 上一轮 backend native session id（Claude CLI session / Codex thread /
      // OpenCode session）作为 resume 候选 —— 重启 app 后内存 last_session_per_context
      // 是空的，前端持久化的 native id 能续上下文。**不能传 tab.sessionId**（那是
      // 前端 AgentSession UUID，跟后端 --resume 期望的 ID 不是一回事）。
      const resumeHint = tab.agentNativeSessionId;
      const importedFallbackContext = tab.importedConversationId
        ? buildImportedFallbackContext(tab.cliBlocks)
        : "";
      const userBlockId = `user-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const userTimestamp = Date.now();

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
        ...(visibleText ? { lastUserPrompt: visibleText.slice(0, 80) } : {}),
        lastActiveAt: Date.now(),
      });
      // 在流式区追加一条用户消息气泡（右对齐），让多轮对话有清晰的"用户/agent"
      // 交替顺序。前端自管，不依赖 backend emit。
      useTabsStore.getState().appendCliBlock(activeTabId, {
        id: userBlockId,
        type: "user-prompt",
        content: visibleText,
        sourceMessageId: userBlockId,
        sourceTimestamp: userTimestamp,
        sourceRole: "user",
        sourceTurnId: `galcode:${userBlockId}`,
        attachments: attachmentPaths.map((path) => ({
          name: path.split(/[\\/]/).filter(Boolean).at(-1) || "attachment",
          mediaType: "application/octet-stream",
          localPath: path,
        })),
      });

      const res = await invoke<{ sessionId?: string }>("start_agent", {
        userInputZh: agentInput,
        cwd: launchProjectPath,
        agent: tab.agent,
        runId: activeTabId,
        sessionId: resumeHint,
        importedFallbackContext: importedFallbackContext || null,
        attachmentPaths,
        // 仅 claude-code 后端读取；codex/opencode 在 Rust 侧忽略
        permissionMode: tab.agent === "claude-code" ? tab.permissionMode : null,
        promptOverride: (() => {
          const sel = selectPromptOverride();
          if (sel) {
            console.log(
              `[community-prompt] tab=${activeTabId.slice(0, 8)} use prompt from "${sel.sourceFileName}" (id=${sel.sourceImageId.slice(0, 8)}) preview="${(sel.prompt ?? "<no prompt – default 凉宫>").slice(0, 60)}"`,
            );
          }
          return sel?.prompt ?? null;
        })(),
      });
      if (res?.sessionId) {
        update({ sessionId: res.sessionId });
      }
      setAttachmentPaths([]);
      // start_agent 成功才计入当天活跃 —— 失败的尝试不该把今天点亮
      useActivityStore.getState().recordActivity({
        projectPath: launchProjectPath,
        agent: tab.agent,
        prompt: visibleText,
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
  });

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
            {/* 移动端嵌入式头部：左 桌宠 compact + 右 greeting 文字。
                萌宠关闭时整行隐藏（greeting 是桌宠台词，没有宠就不该说话） */}
            {petEnabled && (
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
            )}

            {/* 桌面端 greeting 单独行（移动端已嵌入头部）；萌宠关闭时 greeting 为空，
                去掉 min-h 让这一行只剩右侧权限徽章的自然高度 */}
            <div className={`hidden shrink-0 items-start justify-between gap-3 sm:flex ${petEnabled ? "min-h-[3rem]" : ""}`}>
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
              placeholder={`${petEnabled ? "和桌宠对话" : "输入任务"}……  (Enter 发送，Shift+Enter 换行，/ 查看命令)`}
              // 移动端 min-h 100px 给足输入区；桌面端 min-h-[100px]
              className="min-h-[100px] max-h-[40vh] w-full resize-none rounded-xl border border-black/5 bg-white/50 p-3 text-base text-zinc-800 outline-none transition-all placeholder:text-zinc-400 focus:border-sky-400/50 focus:bg-white/80 focus:ring-2 focus:ring-sky-400/15 sm:max-h-none sm:p-3.5 sm:text-sm dark:border-white/5 dark:bg-slate-900/40 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-sky-400/40 dark:focus:bg-slate-900/60 dark:focus:ring-sky-400/10"
              onCompositionStart={() => {
                isComposingRef.current = true;
              }}
              onCompositionEnd={() => {
                isComposingRef.current = false;
              }}
              onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
                // 斜杠面板可见时优先处理（方向键 / Tab 补全 / Esc 清空）；
                // Enter+exactMatch 时 hook 返回 false，让下面的 launch 接管。
                if (slash.handleKeyDown(e)) return;
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
              {slash.show && <SlashCommandPanel {...slash.panelProps} />}
            </AnimatePresence>
            </div>

            {attachmentPaths.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {attachmentPaths.map((path) => (
                  <span
                    key={path}
                    className="inline-flex max-w-full items-center gap-1 rounded-md border border-sky-400/25 bg-sky-400/10 px-2 py-1 text-[11px] text-sky-700 dark:text-sky-200"
                  >
                    <span className="truncate">
                      {path.split(/[\\/]/).filter(Boolean).at(-1) || path}
                    </span>
                    <button
                      type="button"
                      aria-label="移除附件"
                      onClick={() => setAttachmentPaths((paths) => paths.filter((item) => item !== path))}
                      className="shrink-0 rounded px-1 hover:bg-sky-400/15"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}

            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 sm:gap-3">
              <button
                type="button"
                disabled={!isTauri}
                title={isTauri ? "添加本地附件" : "LAN 模式不支持选择本地附件"}
                onClick={() => {
                  void pickFiles({
                    defaultPath: projectPath ?? undefined,
                    title: "选择要发送的附件",
                  }).then((paths) => {
                    if (paths.length === 0) return;
                    setAttachmentPaths((current) => Array.from(new Set([...current, ...paths])));
                  });
                }}
                className="mr-auto rounded-lg border border-zinc-300/70 px-2.5 py-1.5 text-[11px] text-zinc-600 transition-colors hover:bg-white/60 disabled:cursor-not-allowed disabled:opacity-45 dark:border-white/10 dark:text-zinc-300 dark:hover:bg-white/5"
              >
                添加附件
              </button>
              {!projectPath && (
                <span className="text-[11px] text-amber-600/90 dark:text-amber-300/90">
                  发送时请选择有效项目目录
                </span>
              )}
              <motion.button
                whileHover={{ scale: 1.02, y: -1 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => void handleLaunch()}
                disabled={!task.trim() && attachmentPaths.length === 0}
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
