import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useActiveTabField } from "../../hooks/useActiveTab";
import type { AgentStatus } from "../../types/agent";

const OTHERS_GIFS: string[] = [
  "/pet/others/对手指.gif",
  "/pet/others/thinking_2.gif",
  "/pet/others/启动.gif",
  "/pet/others/想要.gif",
  "/pet/others/戳戳.gif",
  "/pet/others/thinking_1.gif",
];

type PetVisualState = "thinking" | "complete" | "error" | "waiting" | "welcome";

function getVisualState(uiState: string, mode: string, agentStatus: AgentStatus): PetVisualState {
  if (uiState === "error" || mode === "error") return "error";
  if (uiState === "done" || mode === "complete") return "complete";
  if (uiState === "running" || mode === "thinking" || mode === "working") return "thinking";
  if (agentStatus === "idle" && uiState === "idle") return "welcome";
  return "waiting";
}

function pickRandomDefaultGif(state: PetVisualState): string {
  if (state === "welcome") return "/pet/welcome/welcome.gif";
  const maxMap: Record<string, number> = {
    thinking: 2,
    complete: 3,
    waiting: 2,
    error: 2,
  };
  const max = maxMap[state] || 1;
  const n = Math.floor(Math.random() * max) + 1;
  return `/pet/${state}/${state}_${n}.gif`;
}

function pickRandomOthersGif(): string {
  return OTHERS_GIFS[Math.floor(Math.random() * OTHERS_GIFS.length)];
}

const THINKING_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  "idle",
  "starting",
  "running",
  "thinking",
  "processing",
]);

/// 桌宠尺寸：
///   default — 主区独立桌宠（桌面端常用）：移动端 h-32 → 桌面 h-52
///   compact — 嵌入卡片头部（移动端整屏卡片用）：固定 h-20 全屏一律 80px，
///             目的是让 emotion 文字与桌宠并排时不挤占太多卡片高度
type PetSize = "default" | "compact";

interface PetCharacterProps {
  size?: PetSize;
}

const SIZE_CLASSES: Record<PetSize, { wrap: string; img: string }> = {
  default: {
    wrap: "h-32 w-32 sm:h-40 sm:w-40 lg:h-52 lg:w-52",
    img: "h-24 w-24 sm:h-32 sm:w-32 lg:h-40 lg:w-40",
  },
  compact: {
    wrap: "h-20 w-20",
    img: "h-16 w-16",
  },
};

function PetCharacterImpl({ size = "default" }: PetCharacterProps): JSX.Element {
  // ③ 单字段订阅：原本 useActiveTab() 拿整 slice，cliBlocks/bubble/percent 等
  // 任意字段变化都让 PetCharacter 重渲染。流式期 cliBlocks 每秒新增多次 → 桌宠
  // 跟着每秒重渲染数十次。改为 useActiveTabField 后只订阅这三个真正影响视觉的
  // 字段，无关字段抖动不再触发渲染。
  const uiState = useActiveTabField("uiState");
  const agentStatus = useActiveTabField("agentStatus");
  const mode = useActiveTabField("mode");

  const visualState = useMemo(
    () => getVisualState(uiState, mode, agentStatus),
    [uiState, mode, agentStatus],
  );

  const [displayGif, setDisplayGif] = useState<string>(() =>
    pickRandomDefaultGif(visualState),
  );
  const canSwapExpression = THINKING_STATUSES.has(agentStatus);

  // ① effect 依赖收窄：原本依赖 [visualState, uiState, agentStatus, mode]，
  // 后三者跟着流式 status-changed 事件每秒变十几次 → setDisplayGif 反复重选
  // 配合下面 <motion.img> 的 key 触发 unmount/remount → WKWebView 图像解码器
  // 累积、释放跟不上 → 越播越慢。visualState 是这三者的稳定派生。
  useEffect(() => {
    setDisplayGif(pickRandomDefaultGif(visualState));
  }, [visualState]);

  const handleClick = useCallback(() => {
    if (canSwapExpression) {
      setDisplayGif(pickRandomOthersGif());
    }
  }, [canSwapExpression]);

  const { wrap, img } = SIZE_CLASSES[size];

  return (
    <motion.div
      whileHover={{ scale: 1.03 }}
      whileTap={{ scale: 0.9 }}
      transition={{
        type: "spring",
        damping: 10,
        stiffness: 400,
        mass: 0.7,
      }}
      onClick={handleClick}
      className={`relative flex cursor-pointer select-none items-center justify-center ${wrap}`}
      role="img"
      aria-label="桌宠角色"
    >
      {/* ② 不带 key —— src 变化时 React 复用同一个 <img> DOM 节点（仅更新 src
          属性），WKWebView 内部复用图像解码器；带 key 会 unmount 旧 + mount
          新 → 旧解码器异步释放跟不上 → 越用越卡。
          代价：跨 GIF 切换时不再有 motion 的 fade-in（仅组件首次挂载触发一次）。 */}
      <motion.img
        src={displayGif}
        alt="桌宠"
        initial={{ opacity: 0, scale: 0.85 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className={`object-contain drop-shadow-xl ${img}`}
        draggable={false}
      />
    </motion.div>
  );
}

// ④ memo: PetCharacter 唯一外部 prop 是 size（稳定字符串字面量）。
// 父级（MainView/RunningBubble/...）因 cliBlocks 等无关字段每秒重渲染时
// 浅比较直接 hit cache，不再触发 PetCharacter 重新执行 render。
export const PetCharacter = memo(PetCharacterImpl);
