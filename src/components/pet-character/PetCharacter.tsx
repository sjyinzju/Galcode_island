import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useActiveTabField } from "../../hooks/useActiveTab";
import { invoke } from "../../lib/bridge";
import type { AgentStatus } from "../../types/agent";
import {
  getActiveCategories,
  isCustomPresetActive,
  usePetAssetsStore,
  type PetCategory,
} from "../../stores/usePetAssetsStore";
import { useProfileStore } from "../../stores/useProfileStore";
import { usePetInteractionStore } from "../../stores/usePetInteractionStore";

const DEFAULT_OTHERS_GIFS: string[] = [
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

/// 默认（内置）资源池：保留原有"按 visualState_N.gif 命名 + welcome 单张"规则。
function pickDefaultGif(state: PetVisualState): string {
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

function pickDefaultOthersGif(): string {
  return DEFAULT_OTHERS_GIFS[Math.floor(Math.random() * DEFAULT_OTHERS_GIFS.length)]!;
}

/// PetVisualState → 自定义 store 类别（一一对应）。
const VISUAL_TO_CATEGORY: Record<PetVisualState, PetCategory> = {
  welcome: "welcome",
  thinking: "thinking",
  waiting: "waiting",
  complete: "complete",
  error: "error",
};

/// 在自定义模式下取一张图：
///   - 若该类有图 → 随机一张（用 blobUrls 转出来的 ObjectURL）
///   - 若该类暂时没图（不应发生，setEnabled 校验过；但用户可能在 enabled 期间删空再被
///     auto-disable 之前的极短时间窗）→ fallback 到默认
function pickCustomGif(
  state: PetVisualState,
  metaList: { id: string }[],
  urlMap: Record<string, string>,
): string {
  if (metaList.length === 0) return pickDefaultGif(state);
  const meta = metaList[Math.floor(Math.random() * metaList.length)]!;
  return urlMap[meta.id] ?? pickDefaultGif(state);
}

function pickCustomOthersGif(
  metaList: { id: string }[],
  urlMap: Record<string, string>,
): string {
  if (metaList.length === 0) return pickDefaultOthersGif();
  const meta = metaList[Math.floor(Math.random() * metaList.length)]!;
  return urlMap[meta.id] ?? pickDefaultOthersGif();
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

  // 自定义桌宠资源：用当前活动预设（非 default 即视为"自定义"）的各类资源。
  // getActiveCategories 在 active 预设不变时返回稳定引用，让选择器 shallow-eq 生效。
  const customEnabled = usePetAssetsStore(isCustomPresetActive);
  const customAssets = usePetAssetsStore(getActiveCategories);
  const customBlobUrls = usePetAssetsStore((s) => s.blobUrls);

  const visualState = useMemo(
    () => getVisualState(uiState, mode, agentStatus),
    [uiState, mode, agentStatus],
  );

  /// 用 ID 列表 + URL map 算一个稳定 token（每类拼成 "id1,id2,..."）
  /// 让"用户上传 / 删除 / hydrate URL"这些写入也能触发当前 visualState 的重抽。
  /// 不直接用 customAssets / customBlobUrls 引用做依赖，是因为它们引用每次 set
  /// 都会变（即便 state 未涉及当前类别），会触发不必要的换图。
  const customCategoryToken = useMemo(() => {
    if (!customEnabled) return "default";
    const cat = VISUAL_TO_CATEGORY[visualState];
    return customAssets[cat]
      .map((m) => `${m.id}:${customBlobUrls[m.id] ? "y" : "n"}`)
      .join(",");
  }, [customEnabled, visualState, customAssets, customBlobUrls]);

  const [displayGif, setDisplayGif] = useState<string>(() => {
    if (customEnabled) {
      return pickCustomGif(visualState, customAssets[VISUAL_TO_CATEGORY[visualState]], customBlobUrls);
    }
    return pickDefaultGif(visualState);
  });
  const canSwapExpression = THINKING_STATUSES.has(agentStatus);

  // ① effect 依赖收窄：visualState 是 ui/agent/mode 的稳定派生，避免流式刷新反复换图。
  // 自定义模式下额外订阅 customCategoryToken，让"上传 / 删除 / hydrate" 事件
  // 也能让当前画面切到刚加入的图。
  useEffect(() => {
    if (customEnabled) {
      const cat = VISUAL_TO_CATEGORY[visualState];
      setDisplayGif(pickCustomGif(visualState, customAssets[cat], customBlobUrls));
    } else {
      setDisplayGif(pickDefaultGif(visualState));
    }
    // customAssets/customBlobUrls 通过 customCategoryToken 间接表达，避免因引用抖动多触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visualState, customEnabled, customCategoryToken]);

  // 戳/触摸互动台词的冷却：5s 内多次点击仍然切图，但只生成一次台词。
  // 用 ref 避免 setState 触发额外渲染；同时持 inflight token 拦截 race。
  const lastPokeAtRef = useRef<number>(0);
  const pokeTokenRef = useRef<number>(0);

  /// 选一张当前刚被点击切换到的 others 类图（决定 prompt 来源）。
  /// 自定义未启用 / others 类无图 → null（用默认凉宫风）
  function pickPokeImageForPersona(): {
    persona: string | null;
    imageId: string | null;
  } {
    if (!customEnabled) return { persona: null, imageId: null };
    const list = customAssets.others ?? [];
    if (list.length === 0) return { persona: null, imageId: null };
    const meta = list[Math.floor(Math.random() * list.length)]!;
    const p = meta.communityPrompt?.trim();
    return { persona: p && p.length > 0 ? p : null, imageId: meta.id };
  }

  const handleClick = useCallback(() => {
    if (!canSwapExpression) return;
    // 1) 切图（保留原行为）
    if (customEnabled) {
      setDisplayGif(pickCustomOthersGif(customAssets.others, customBlobUrls));
    } else {
      setDisplayGif(pickDefaultOthersGif());
    }
    // 2) 5s 冷却内：只切图不生成台词
    const now = Date.now();
    if (now - lastPokeAtRef.current < 5000) return;
    lastPokeAtRef.current = now;
    // 3) 异步生成"被戳"反应台词
    const myToken = ++pokeTokenRef.current;
    const { persona, imageId } = pickPokeImageForPersona();
    invoke<string>("generate_poke_speech", {
      persona,
      nickname: useProfileStore.getState().nickname?.trim() || null,
    })
      .then((speech) => {
        // race 拦截：如果在等待期间又有更新点击发起新生成，旧的丢弃
        if (myToken !== pokeTokenRef.current) return;
        const text = (speech ?? "").trim();
        if (text) {
          usePetInteractionStore.getState().setPoke(text, imageId);
        }
      })
      .catch(() => {
        // LLM 未配 / 任何错误：静默 fallback —— 不显示气泡（不影响切图）
      });
  }, [canSwapExpression, customEnabled, customAssets, customBlobUrls]);

  // 订阅气泡 store（任一桌宠实例点过的台词都会显示——目前应用只有一个 active tab 桌宠）
  const interactionSpeech = usePetInteractionStore((s) => s.speech);

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
      {/* "被戳"反应气泡：浮于桌宠**正上方**（水平居中），5s 自动消失。
          位置策略：
            - bottom-full + mb-2 ：紧贴桌宠顶部上方，留一点缝隙
            - left-1/2 + -translate-x-1/2 ：水平居中，避免被左右卡片挤
            - z-50 ：高于普通卡片 z-index，确保不被遮挡
            - pointer-events-none ：点击直接穿透到桌宠（连点继续触发 handleClick）
            - whitespace-normal + w-max + max-w-[260px] ：文字自然水平换行；不会被父级
              overflow 挤成竖排
            - 底部三角小尾巴用 ::after 伪元素，指向桌宠头顶 */}
      <AnimatePresence>
        {interactionSpeech ? (
          <motion.div
            key={interactionSpeech}
            initial={{ opacity: 0, y: 6, scale: 0.85 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.9 }}
            transition={{ type: "spring", damping: 18, stiffness: 320 }}
            style={{ width: "max-content" }}
            className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 whitespace-normal break-words rounded-2xl border border-white/60 bg-white/95 px-3 py-1.5 text-center text-[12px] font-medium leading-snug text-zinc-800 shadow-lg backdrop-blur after:absolute after:left-1/2 after:top-full after:-mt-px after:-translate-x-1/2 after:border-[6px] after:border-transparent after:border-t-white/95 after:content-[''] dark:border-white/15 dark:bg-slate-800/95 dark:text-zinc-100 dark:after:border-t-slate-800/95"
          >
            <span style={{ display: "inline-block", maxWidth: "260px" }}>
              {interactionSpeech}
            </span>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}

// ④ memo: PetCharacter 唯一外部 prop 是 size（稳定字符串字面量）。
// 父级（MainView/RunningBubble/...）因 cliBlocks 等无关字段每秒重渲染时
// 浅比较直接 hit cache，不再触发 PetCharacter 重新执行 render。
export const PetCharacter = memo(PetCharacterImpl);
