import { useState, useEffect, useRef, type KeyboardEvent } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { invoke } from "../../lib/bridge";
import { useAppStore } from "../../stores/useAppStore";
import { useProfileStore } from "../../stores/useProfileStore";
import { useTabsStore } from "../../stores/useTabsStore";
import { useActivityStore } from "../../stores/useActivityStore";
import { useActiveTab, useActiveTabActions } from "../../hooks/useActiveTab";
import { PetCharacter } from "../pet-character/PetCharacter";

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
  const { activeTabId, update } = useActiveTabActions();

  const projectPath = tab.projectPath;
  const agentStatus = tab.agentStatus;
  const task = tab.task;

  const [greeting, setGreeting] = useState("");
  const [displayedGreeting, setDisplayedGreeting] = useState("");
  // 中文输入法 composition 期间不要把 Enter 当发送 — 双保险用 keydown.isComposing
  // + composition* 事件标记
  const isComposingRef = useRef(false);

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

  const handleLaunch = async (): Promise<void> => {
    if (!task.trim() || !activeTabId || !projectPath) return;
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
            <div className="hidden shrink-0 min-h-[3rem] text-[15px] font-medium leading-relaxed tracking-wide text-zinc-600 sm:block dark:text-zinc-300">
              {displayedGreeting}
              {displayedGreeting.length < greeting.length && (
                <motion.span
                  animate={{ opacity: [1, 0] }}
                  transition={{ repeat: Infinity, duration: 0.8 }}
                  className="ml-1 inline-block h-[15px] w-2 bg-sky-400/70 align-middle"
                />
              )}
            </div>

            <textarea
              value={task}
              onChange={(e) => update({ task: e.target.value })}
              placeholder="和团长对话……  (Enter 发送，Shift+Enter 换行)"
              // 移动端 min-h 100px 给足输入区；桌面端 min-h-[100px]
              className="min-h-[100px] max-h-[40vh] w-full resize-none rounded-xl border border-black/5 bg-white/50 p-3 text-base text-zinc-800 outline-none transition-all placeholder:text-zinc-400 focus:border-sky-400/50 focus:bg-white/80 focus:ring-2 focus:ring-sky-400/15 sm:max-h-none sm:p-3.5 sm:text-sm dark:border-white/5 dark:bg-slate-900/40 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:border-sky-400/40 dark:focus:bg-slate-900/60 dark:focus:ring-sky-400/10"
              onCompositionStart={() => {
                isComposingRef.current = true;
              }}
              onCompositionEnd={() => {
                isComposingRef.current = false;
              }}
              onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
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
