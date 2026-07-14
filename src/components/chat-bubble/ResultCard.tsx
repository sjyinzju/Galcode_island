import { invoke, pickFolder } from "../../lib/bridge";
import { buildImportedFallbackContext } from "../../lib/importedConversation";
import { useRef, useState, type KeyboardEvent } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useTabsStore } from "../../stores/useTabsStore";
import { useActivityStore } from "../../stores/useActivityStore";
import { useActiveTab, useActiveTabActions } from "../../hooks/useActiveTab";
import { motion, AnimatePresence } from "framer-motion";
import { PetCharacter } from "../pet-character/PetCharacter";
import { selectPromptOverride } from "../../lib/petPromptOverride";
import { ErrorDiagnosisCard } from "../status-monitor/ErrorDiagnosisCard";
import { PermissionModeBadge } from "../PermissionModeBadge";
import { SlashCommandPanel, useSlashCommandPanel } from "./SlashCommandPanel";

export function ResultCard(): JSX.Element {
  const tab = useActiveTab();
  const { activeTabId, update, clearBlocks } = useActiveTabActions();
  const addLogEntry = useAppStore((s) => s.addLogEntry);

  const mode = tab.mode;
  const uiState = tab.uiState;
  const emotionText = tab.emotionText;
  const summaryTranslation = tab.summaryTranslation;
  const suggestionOptions = tab.suggestionOptions;
  const petEnabled = useSettingsStore((s) => s.petEnabled);
  // 错误模式下喂给归因卡片的原始错误文本：优先 bubble（agent://error 写入的最准消息），
  // 其次 summaryTranslation（LLM finalize 失败时填的错误描述），再退到 emotionText
  const errorMessage = (tab.bubble || tab.summaryTranslation || tab.emotionText || "").trim();

  // ResultCard 内嵌的"继续追问"输入框 —— 跟选项按钮并存，让用户能直接打字而不必
  // 等回 InputBubble。组件态而非 tab.task：tab.task 是 InputBubble 的草稿，
  // 跟这里语义独立。
  const [followupText, setFollowupText] = useState("");
  // 中文输入法 composition 期间不要把 Enter 当发送 —— 用 keydown 检查 isComposing
  // 即可（Safari/Chrome/Edge 都支持）；composition* 事件做 backup 兜底。
  const isComposingRef = useRef(false);
  // 给 slash 面板 hook 补全后 setSelectionRange 用
  const followupTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  // ResultCard 外层 motion.div 和 inner container 都有 overflow-hidden（rounded-2xl
  // 切角用），普通 absolute 定位面板会被裁。挂这个 ref 给 SlashCommandPanel
  // 的 portal 模式做坐标 anchor。
  const followupRowRef = useRef<HTMLDivElement | null>(null);

  // 斜杠命令面板：跟 InputBubble 共用 hook。projectPath 走 tab.projectPath。
  // 切到 builtin 命令（/clear /mode /model ...）时不发送 follow-up，让命令本地生效。
  const slash = useSlashCommandPanel({
    value: followupText,
    setValue: setFollowupText,
    textareaRef: followupTextareaRef,
    isComposingRef,
    projectPath: tab.projectPath,
    activeTabId,
    actions: {
      clearActiveTabBlocks: () => clearBlocks(),
      openSettings: () => useSettingsStore.getState().openSettingsModal(),
      setPermissionMode: (value) => update({ permissionMode: value }),
      addLog: (level, message) =>
        addLogEntry({ timestamp: Date.now(), level, message }),
    },
  });

  const isVisible =
    uiState === "done" ||
    uiState === "error" ||
    mode === "complete" ||
    mode === "suggestion" ||
    mode === "error";

  /// 点选项 = 立即启动新一轮（不回 idle，避免 InputBubble 还没显示就把上一轮的
  /// 状态条都清掉造成"白屏"）。仍然在同一个 tab 内继续。
  /// **不清 cliBlocks** —— 单项目多轮会话累积保留；上一轮结果字段也保留，
  /// 新 turn 完成时被新的 session-complete 事件覆盖（RunningBubble 期间显示中）。
  const handleOptionClick = async (opt: string): Promise<void> => {
    if (!activeTabId) return;
    let launchProjectPath = tab.projectPath;
    if (launchProjectPath) {
      try {
        await invoke("validate_directory", { path: launchProjectPath });
      } catch {
        launchProjectPath = null;
      }
    }
    if (!launchProjectPath) {
      launchProjectPath = await pickFolder({
        defaultPath: tab.projectPath ?? undefined,
        title: "选择用于继续会话的有效项目目录",
      });
      if (!launchProjectPath) {
        window.alert("项目目录不可用，请选择有效目录后再继续。");
        return;
      }
      update({ projectPath: launchProjectPath });
    }
    // backend native session id 作 resume hint（Claude CLI session / Codex thread /
    // OpenCode session），让上下文延续；前端 sessionId 是 AgentSession UUID 不能用
    const resumeHint = tab.agentNativeSessionId;
    const importedFallbackContext = tab.importedConversationId
      ? buildImportedFallbackContext(tab.cliBlocks)
      : "";
    const userBlockId = `user-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const userTimestamp = Date.now();
    update({
      task: opt,
      percent: 0,
      uiState: "running",
      mode: "working",
      agentStatus: "running",
      lastUserPrompt: opt.slice(0, 80),
      lastActiveAt: Date.now(),
    });
    // 流式区追加用户消息气泡，跟 InputBubble 启动路径行为一致
    useTabsStore.getState().appendCliBlock(activeTabId, {
      id: userBlockId,
      type: "user-prompt",
      content: opt,
      sourceMessageId: userBlockId,
      sourceTimestamp: userTimestamp,
      sourceRole: "user",
      sourceTurnId: `galcode:${userBlockId}`,
    });

    try {
      const res = await invoke<{ sessionId?: string }>("start_agent", {
        userInputZh: opt,
        cwd: launchProjectPath,
        agent: tab.agent,
        runId: activeTabId,
        sessionId: resumeHint,
        importedFallbackContext: importedFallbackContext || null,
        attachmentPaths: [],
        promptOverride: (() => {
          const sel = selectPromptOverride();
          if (sel) {
            console.log(
              `[community-prompt] tab=${activeTabId.slice(0, 8)} use prompt from "${sel.sourceFileName}" preview="${(sel.prompt ?? "<no prompt – default 凉宫>").slice(0, 60)}"`,
            );
          }
          return sel?.prompt ?? null;
        })(),
      });
      if (res?.sessionId) update({ sessionId: res.sessionId });
      // 计入当天活跃 —— 跟 InputBubble 启动路径口径一致
      useActivityStore.getState().recordActivity({
        projectPath: launchProjectPath,
        agent: tab.agent,
        prompt: opt,
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

  const submitFollowup = async (): Promise<void> => {
    const text = followupText.trim();
    if (!text) return;
    // 斜杠命令优先：能本地处理就不发给 agent（不发起新一轮 turn）
    if (await slash.tryRunBuiltin()) return;
    setFollowupText("");
    void handleOptionClick(text);
  };

  const handleFollowupKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // 面板可见时优先处理（方向键 / Tab / Esc / 部分匹配 Enter 补全）；
    // Enter+exactMatch 时 hook 返回 false，让下面的 submit 接管。
    if (slash.handleKeyDown(e)) return;
    if (e.key !== "Enter") return;
    // shift+Enter 让默认行为生效（插入换行）
    if (e.shiftKey) return;
    // IME 候选词期间按 Enter 是选词，不能截走当发送：
    //   - e.nativeEvent.isComposing 是现代浏览器标准
    //   - keyCode 229 是 IME 阶段的兜底标记
    //   - isComposingRef 双保险（个别老 WebView 不报 isComposing 但有 composition 事件）
    const native = e.nativeEvent as KeyboardEvent["nativeEvent"] & { isComposing?: boolean };
    if (native.isComposing || e.keyCode === 229 || isComposingRef.current) return;
    e.preventDefault();
    void submitFollowup();
  };

  const isError = mode === "error" || uiState === "error";
  const headerColor = isError ? "text-rose-500 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400";

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          key="result-card"
          initial={{ opacity: 0, y: 10, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.98 }}
          transition={{ type: "spring", damping: 22, stiffness: 280 }}
          // 自然高度，不撑高度容器；summary 区自带 max-h cap + 滚动
          className="relative w-full rounded-2xl shadow-lg shadow-amber-500/10 dark:shadow-none"
        >
          {/* 真·环绕光效：背景 conic-gradient 的 from 角度做动画（用 @property
              --glow-angle），div 形状本身不旋转 —— mask 切出的圆角边框稳套外层，
              光段在边框上平滑滑动一圈。详细 CSS 在 index.css `.glow-frame`。 */}
          <div aria-hidden="true" className="glow-frame rounded-2xl" />

          {/* Inner glass content container —— 自然高度三段式：头 / summary（自带
              max-h cap + 滚动） / 底。不用 flex-1，避免在无具体父高度时 flex-1=0
              导致 summary 区高度坍塌的 CSS 循环依赖问题。 */}
          <div className="relative flex w-full flex-col gap-3 overflow-hidden rounded-2xl border border-white/60 bg-white/70 p-3.5 backdrop-blur-2xl sm:p-4 dark:border-white/10 dark:bg-slate-800/60">
            {/* ===== 顶部：状态徽章 + 权限模式 ===== */}
            <div className="flex shrink-0 items-center gap-2">
              <div className={`h-2.5 w-2.5 rounded-full ${isError ? "bg-rose-400 shadow-[0_0_6px_rgba(251,113,133,0.5)]" : "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]"} animate-pulse`} />
              <span className={`text-[13px] font-extrabold uppercase tracking-widest sm:text-sm ${headerColor}`}>
                {mode || "COMPLETE"}
              </span>
              {/* 桌面端：让用户在 result 阶段也能改 mode；下一轮就生效。
                  移动端 MobileTopBar 已有，不重复。 */}
              <div className="ml-auto hidden sm:block">
                <PermissionModeBadge compact />
              </div>
            </div>

            {/* 移动端嵌入式头部：左 桌宠 compact + 右 emotion 气泡。
                emotion 是桌宠的情绪台词，萌宠关闭时整行隐藏（summary 仍正常展示） */}
            {petEnabled && (
              <div className="flex shrink-0 items-start gap-3 sm:hidden">
                <div className="shrink-0">
                  <PetCharacter size="compact" />
                </div>
                {emotionText ? (
                  <div className="relative min-w-0 flex-1 self-stretch rounded-t-2xl rounded-br-2xl rounded-bl-sm border border-white/50 bg-white/70 p-3 shadow-sm backdrop-blur-md dark:border-white/10 dark:bg-slate-700/60">
                    <p className="text-[15px] font-bold leading-snug text-zinc-800 dark:text-zinc-100">
                      {emotionText}
                    </p>
                  </div>
                ) : (
                  <div className="flex-1 self-stretch flex items-center text-zinc-400 text-[13px] dark:text-zinc-500">
                    ……
                  </div>
                )}
              </div>
            )}

            {/* 桌面端 emotion 气泡（移动端已内嵌到上方头部）；同样跟着萌宠开关走 */}
            {petEnabled && emotionText && (
              <div className="relative hidden shrink-0 rounded-t-2xl rounded-br-2xl rounded-bl-sm border border-white/50 bg-white/70 p-4 shadow-sm backdrop-blur-md sm:block dark:border-white/10 dark:bg-slate-700/60">
                <p className="text-[15px] font-bold leading-snug text-zinc-800 dark:text-zinc-100">
                  {emotionText}
                </p>
              </div>
            )}

            {/* ===== 中部：Summary —— max-h cap + 内部滚动；自然高度。
                移动端 35vh 大约给 8-10 行；桌面端无上限保持原视觉。
                错误模式下隐藏 summary，下方归因卡片做替代展示，避免错误文本重复出现两次。 ===== */}
            {summaryTranslation && !isError && (
              <div className="max-h-[35vh] overflow-y-auto overscroll-contain px-1 text-[14px] leading-relaxed text-zinc-600 sm:max-h-none sm:overflow-visible sm:text-sm dark:text-zinc-300">
                {summaryTranslation}
              </div>
            )}

            {/* 错误归因卡片：仅 isError 时显示，提供友好标题 + 详情折叠 + 一键修复按钮。
                跟 BlockStream 里 type=error 块用同一个组件，UI 一致，仅 variant=card 略大 */}
            {isError && errorMessage && (
              <ErrorDiagnosisCard message={errorMessage} variant="card" />
            )}

            {/* ===== 底部：Suggestion 选项 + 输入框（不滚） ===== */}
            {suggestionOptions?.length > 0 && (
              <div className="flex shrink-0 flex-wrap gap-2 border-t border-zinc-200/50 pt-2 dark:border-zinc-700/50">
                {suggestionOptions.map((opt, i) => (
                  <button
                    key={i}
                    onClick={() => void handleOptionClick(opt)}
                    className="flex min-h-[36px] items-center rounded-full border border-white/40 bg-white/50 px-4 py-2 text-[13px] font-semibold text-zinc-700 shadow-sm backdrop-blur-sm transition-all hover:-translate-y-0.5 hover:bg-white hover:text-zinc-900 hover:shadow-md active:translate-y-0 active:scale-95 sm:min-h-0 sm:px-3.5 sm:py-1.5 sm:text-xs dark:border-white/10 dark:bg-slate-700/50 dark:text-zinc-300 dark:hover:bg-slate-600 dark:hover:text-white"
                  >
                    {opt}
                  </button>
                ))}
              </div>
            )}

            {/* 永久输入框：除了选项按钮之外用户始终能直接打字继续会话 */}
            <div
              ref={followupRowRef}
              className="relative flex shrink-0 items-end gap-2 border-t border-zinc-200/50 pt-2 dark:border-zinc-700/50"
            >
              <textarea
                ref={followupTextareaRef}
                value={followupText}
                onChange={(e) => setFollowupText(e.target.value)}
                onKeyDown={handleFollowupKeyDown}
                onCompositionStart={() => {
                  isComposingRef.current = true;
                }}
                onCompositionEnd={() => {
                  isComposingRef.current = false;
                }}
                placeholder="继续追问…  (Enter 发送，Shift+Enter 换行，/ 查看命令)"
                rows={1}
                // 移动端 text-base 防 iOS focus 放大；桌面端 text-sm 保密度
                className="min-h-[44px] max-h-32 flex-1 resize-y rounded-xl border border-black/5 bg-white/55 px-3 py-2.5 text-base text-zinc-800 outline-none transition-all placeholder:text-zinc-400 focus:border-sky-400/50 focus:bg-white/85 focus:ring-2 focus:ring-sky-400/15 sm:min-h-[36px] sm:py-2 sm:text-sm dark:border-white/5 dark:bg-slate-900/40 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-sky-400/40 dark:focus:bg-slate-900/60 dark:focus:ring-sky-400/10"
              />
              <button
                type="button"
                onClick={() => void submitFollowup()}
                disabled={!followupText.trim()}
                aria-label="发送"
                // 移动端 44x44 触控目标；桌面端 36x36 保紧凑
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-sky-500 text-white shadow-md shadow-sky-400/25 transition-all hover:bg-sky-600 hover:shadow-sky-400/40 active:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-40 sm:h-9 sm:w-9"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                  <path d="M2.5 8h11M9 3.5L13.5 8 9 12.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {/* 斜杠命令下拉面板：走 portal 模式定位到 followupRow 上方，
                  绕开 ResultCard 外层 / inner container 的 overflow-hidden 裁切 */}
              <AnimatePresence>
                {slash.show && (
                  <SlashCommandPanel {...slash.panelProps} anchorRef={followupRowRef} />
                )}
              </AnimatePresence>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
