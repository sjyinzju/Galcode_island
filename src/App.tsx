import { AnimatePresence, motion } from "framer-motion";
import { invoke, isTauri } from "./lib/bridge";
import { useEffect, useMemo } from "react";
import { MainView } from "./components/MainView";
import { MobileTopBar } from "./components/MobileTopBar";
import { WelcomeView } from "./components/welcome/WelcomeView";
import { SettingsModal } from "./components/settings/SettingsModal";
import { ProfileModal } from "./components/profile/ProfileModal";
import { SidebarLeft } from "./components/sidebar/SidebarLeft";
import { SidebarRight } from "./components/sidebar/SidebarRight";
import { InPageSearch } from "./components/InPageSearch";
import { useUiStore } from "./stores/useUiStore";
import { useAgentIPC } from "./hooks/useAgentIPC";
import { useCliStream } from "./hooks/useCliStream";
import { useInPageSearchHotkey } from "./hooks/useInPageSearchHotkey";
import { useLanProjectsSync } from "./hooks/useLanProjectsSync";
import { useTabsReattach } from "./hooks/useTabsReattach";
import { useThemeHotkey } from "./hooks/useThemeHotkey";
import { useUpdateBootstrap } from "./hooks/useUpdateBootstrap";
import { useAppStore } from "./stores/useAppStore";
import { useSettingsStore } from "./stores/useSettingsStore";
import { useProfileStore } from "./stores/useProfileStore";

function App(): JSX.Element {
  const isStarted = useAppStore((state) => state.isStarted);
  const mobileLeftDrawerOpen = useUiStore((s) => s.mobileLeftDrawerOpen);
  const closeMobileLeftDrawer = useUiStore((s) => s.closeMobileLeftDrawer);

  useThemeHotkey();
  useAgentIPC();
  useCliStream();
  useTabsReattach();
  useInPageSearchHotkey();
  useLanProjectsSync();
  useUpdateBootstrap();

  useEffect(() => {
    // 浏览器（局域网客户端）模式：不要把自己 zustand 里可能为空的 settings 推给后端
    // 单例——后端是桌面端的真相，浏览器只读；不然会用空表覆盖桌面端用户已设置的 LLM key。
    if (!isTauri) return;

    const state = useSettingsStore.getState();
    const profile = useProfileStore.getState();

    // 启动时把 persist 出来的 LLM + 三个 backend 偏好同步给 Rust 端的内存单例。
    // Rust 端 OnceLock<Mutex<...>> 进程重启就空——前端 zustand persist 是真相之源。
    // nickname 在 useProfileStore 里管理（个人档案），其它在 useSettingsStore。
    invoke("update_llm_settings", {
      baseUrl: state.apiBaseUrl,
      apiKey: state.apiKey,
      nickname: profile.nickname,
      systemPrompt: state.systemPrompt,
      provider: state.provider,
      model: state.model,
      thinking: state.thinking,
      translateInput: state.translateInput,
    }).catch(console.error);

    for (const backend of ["claude-code", "codex", "opencode"] as const) {
      const prefs = state.backends[backend];
      invoke("update_backend_preferences", {
        backend,
        model: prefs.model || null,
        effort: prefs.effort || null,
        proxy: prefs.proxy || null,
        binary: prefs.binary || null,
        // 仅 OpenCode 使用，其它 backend 永远是空字符串 → null
        provider: prefs.provider || null,
        apiKey: prefs.apiKey || null,
        authMode: prefs.authMode || null,
      }).catch(console.error);
    }
  }, []);

  // 桌面端三栏；移动端 (<lg) 单栏 + 抽屉：
  //   - 顶部 MobileTopBar（汉堡 → 左栏抽屉 / 设置）
  //   - 中部 MainView 占满
  //   - SidebarLeft 在 <lg 时绝对定位 + translate-x 控制开合，背后加遮罩点击关闭
  //   - SidebarRight 在 <lg 时全屏覆盖（保留 detailBlock 详情体验）
  //   - 桌宠 / 立绘 / 结果卡 / 凉宫春日总结由 MainView 内部继续渲染，移动端不变
  const currentScreen = useMemo(() => {
    if (!isStarted) return <WelcomeView />;
    return (
      <div className="relative flex h-full w-full flex-col lg:flex-row">
        {/* 移动端顶栏：汉堡 / 当前项目 / 设置 —— 桌面端隐藏 */}
        <MobileTopBar />

        {/* 左栏：桌面端常驻；< lg 时绝对定位抽屉 + 遮罩点击关闭。
            移动端用 top-0 + h-[100dvh] 而不是 inset-y-0：fixed 元素的 inset-y-0
            在 iOS Safari 引用大视口（含底部地址栏）→ 抽屉底部会被浏览器栏挡住；
            h-[100dvh] 跟着可视区动态变化，浏览器栏显隐时 reflow */}
        <div
          className={`fixed top-0 left-0 z-30 h-[100dvh] w-[78%] max-w-[320px] transform transition-transform duration-200 ease-out lg:relative lg:z-auto lg:h-full lg:w-auto lg:max-w-none lg:translate-x-0 ${
            mobileLeftDrawerOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <SidebarLeft />
        </div>
        {mobileLeftDrawerOpen && (
          <button
            type="button"
            aria-label="关闭侧边栏"
            onClick={closeMobileLeftDrawer}
            className="fixed top-0 left-0 z-20 h-[100dvh] w-full bg-black/30 backdrop-blur-[2px] lg:hidden"
          />
        )}

        {/* min-h-0 关键！flex 子项默认 min-height: auto = max-content，
            BlockStream 内容多时会把这个 div 撑到 max-content，让内部所有
            flex-1 / overflow-y-auto 失效（StatusMonitor 跟着撑大、流式区不滚、卡片挤出屏） */}
        <div className="flex min-w-0 min-h-0 flex-1 flex-col">
          <MainView />
        </div>

        {/* 右栏（详情）：桌面端 inline；< lg 时全屏 fixed 覆盖 */}
        <SidebarRight />

        {/* cmd+f 触发的页内搜索浮窗：只在主界面挂，绝对定位浮在右上角 */}
        <InPageSearch />
      </div>
    );
  }, [isStarted, mobileLeftDrawerOpen, closeMobileLeftDrawer]);

  // 100dvh 而非 100vh：移动浏览器底部地址栏会算进 100vh 但实际遮挡内容；
  // 100dvh = dynamic viewport height，浏览器栏显隐时自动 reflow，
  // 子链所有 h-full / inset-0 单位都跟着正确
  return (
    <main className="relative h-[100dvh] w-screen overflow-hidden bg-slate-50 text-zinc-900 transition-colors dark:bg-[#0B1120] dark:text-zinc-100">
      {/* 静态背景光晕。原本是 3 个 motion.div 跑无限 x/y/scale 动画 ——
          scale 让 blur 层无法 cache，配合身后 backdrop-blur-2xl 玻璃层每帧
          (64px filter + 40px backdrop) 双重模糊重算，GPU 永远停不下来 →
          桌宠跟着抢 GPU 带宽变卡。改成静态后 backdrop-filter 整张缓存为
          合成层，GPU 持续开销 ≈ 0。
          18-22 秒一周期、低透明度的微小漂浮原本肉眼几乎察觉不到，去掉
          视觉损失极小。 */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
      >
        <div className="absolute -top-1/4 -left-1/4 h-[60%] w-[60%] rounded-full bg-sky-200/30 blur-3xl dark:bg-sky-400/15" />
        <div className="absolute -bottom-1/4 -right-1/4 h-[50%] w-[50%] rounded-full bg-amber-200/25 blur-3xl dark:bg-amber-400/10" />
        <div className="absolute top-1/3 -right-1/6 h-[55%] w-[55%] rounded-full bg-sky-300/15 blur-3xl dark:bg-sky-500/8" />
      </div>

      {/* Glass container —— 桌面端 inset-2 浮起感；移动端贴边铺满，最大化可用区 */}
      <div className="absolute inset-0 overflow-hidden border border-white/60 bg-white/70 backdrop-blur-2xl sm:inset-2 sm:rounded-[22px] sm:shadow-[0_8px_40px_rgba(0,0,0,0.06)] dark:border-white/10 dark:bg-slate-800/60 dark:shadow-none">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_18%,rgba(255,255,255,0.3),transparent_38%),radial-gradient(circle_at_88%_82%,rgba(0,0,0,0.04),transparent_30%)] dark:bg-[radial-gradient(circle_at_12%_18%,rgba(255,255,255,0.04),transparent_38%),radial-gradient(circle_at_88%_82%,rgba(255,255,255,0.02),transparent_30%)]" />
        <AnimatePresence mode="wait">
          <motion.div
            key={isStarted ? "main" : "welcome"}
            initial={{ opacity: 0, scale: 0.985 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.985 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="relative z-10 h-full w-full"
          >
            {currentScreen}
          </motion.div>
        </AnimatePresence>
        <SettingsModal />
        <ProfileModal />
      </div>
    </main>
  );
}

export default App;
