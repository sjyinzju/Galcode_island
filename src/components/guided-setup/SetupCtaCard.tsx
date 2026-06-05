// overview 上的「必要引导项未配置」入口卡。
//
// 显隐规则（见 useSetupStore）：
//   - noLlmKey：角色扮演 LLM 的 apiKey 为空（持久化状态，瞬时可判，新用户默认就是空）。
//   - agentReady === false：本会话探测过三个 backend，没有任何一个就绪。
//   agentReady === null（尚未探测）时不因这一维显示，避免误报闪烁；挂载时触发一次探测。
//
// 点击卡片上的按钮打开四步引导向导（GuidedSetupModal）。
// 两个 overview（GlobalOverview / ProjectOverview）都复用本组件，逻辑只此一份。

import { useEffect } from "react";
import { motion } from "framer-motion";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useSetupStore } from "../../stores/useSetupStore";

export function SetupCtaCard({ className = "" }: { className?: string }): JSX.Element | null {
  const apiKey = useSettingsStore((s) => s.apiKey);
  const agentReady = useSetupStore((s) => s.agentReady);
  const probeAgents = useSetupStore((s) => s.probeAgents);
  const openSetup = useSetupStore((s) => s.open);

  // 挂载时探测一次（store 内部幂等：整会话只真正 spawn 一次 CLI）
  useEffect(() => {
    void probeAgents();
  }, [probeAgents]);

  const noLlmKey = apiKey.trim() === "";
  const showSetupCta = noLlmKey || agentReady === false;
  if (!showSetupCta) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28 }}
      className={`rounded-2xl border border-amber-300/40 bg-amber-50/70 px-5 py-4 backdrop-blur-md dark:border-amber-300/20 dark:bg-amber-300/5 ${className}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-amber-700 dark:text-amber-200">
            必要引导项未配置
          </div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-amber-700/80 dark:text-amber-200/70">
            请配置编程所需的 Agent 以及角色扮演所需的 API key，从而体验完整功能。
          </p>
        </div>
        <button
          type="button"
          onClick={openSetup}
          className="min-h-[44px] shrink-0 rounded-xl bg-amber-500 px-5 py-2 text-[13px] font-medium text-white shadow-md shadow-amber-400/20 transition-all hover:-translate-y-0.5 hover:bg-amber-600 sm:min-h-0"
        >
          开始引导配置
        </button>
      </div>
    </motion.div>
  );
}
