// 任务结束的系统通知 + Dock/任务栏角标（跨平台）。
//
// 触发：tab.uiState 从非 done/error 转入 done/error → 弹原生通知（前提：
//   - 桌面 Tauri 环境（浏览器/LAN 模式跳过）
//   - 通知权限已授予（首次需要 requestPermission）
//   - 当前窗口不在前台 **或** 该 tab 不是 active —— 用户正盯着这个 tab 看
//     就别再叠通知打断
// 角标 / 未读提示（按平台选择最合适的"原生味"方案）：
//   - macOS / Linux：Window.setBadgeCount(N) → Dock 数字角标 / Unity 启动器角标
//   - Windows：setBadgeCount 不支持（要 setOverlayIcon + 提供图标资源），改走
//     "窗口标题加 `(N)` 前缀"——微信 / Slack / VSCode 在 Windows 任务栏的常见做法
//
// 设计点：
//   - prevStateRef 缓存上一轮每个 tab 的 uiState，diff 出"刚刚转入完成态"的
//   - initializedRef：第一次订阅 tick 不发通知（避免应用启动 / rehydrate 时把
//     已经是 done 的旧 tab 重新报一遍）
//   - 通知 / badge 调用都用 lazy import，浏览器模式下走 isTauri 短路就不会引入
//     plugin-notification 模块
//   - badge count 用 lastBadgeRef 去重；流式期 store 高频 set 也只调一次系统 API
//   - baseTitleRef 缓存第一次读到的"原始窗口标题"，之后基于它加 / 去前缀

import { useEffect, useRef } from "react";
import { isTauri } from "../lib/bridge";
import { useTabsStore, type TabState, type TabsStoreState } from "../stores/useTabsStore";

const COMPLETED_STATES: ReadonlySet<string> = new Set(["done", "error"]);

/// 检测当前是否在 Windows（用 navigator——Tauri 环境也有 webview navigator）。
/// 用 platform 优先，userAgent 兜底，因为现代浏览器逐步弃用 platform。
function isWindowsPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform || "";
  if (/Win/i.test(platform)) return true;
  return /Windows/i.test(navigator.userAgent || "");
}

export function useTaskCompletionNotifier(): void {
  const initializedRef = useRef(false);
  const prevStateRef = useRef<Record<string, string>>({});
  const lastBadgeRef = useRef<number>(-1);
  const permissionPromiseRef = useRef<Promise<boolean> | null>(null);
  /// Windows fallback 用：第一次进 updateBadge 时惰性读窗口标题作为 base
  const baseTitleRef = useRef<string | null>(null);
  const isWindowsRef = useRef<boolean>(false);

  useEffect(() => {
    if (!isTauri) return;
    isWindowsRef.current = isWindowsPlatform();

    /// 启动时立刻"摸一下" notification API：让操作系统把 app 登记进通知设置列表，
    /// 用户即使第一次拒了权限，之后想去系统设置改主意也能找到这个 app。
    /// 注意：isPermissionGranted **本身**就触发系统注册；不主动 requestPermission()
    /// 避免一启动就弹权限框骚扰用户。真要弹的时机仍由"任务完成"那条路径触发。
    void (async () => {
      try {
        const { isPermissionGranted } = await import("@tauri-apps/plugin-notification");
        await isPermissionGranted();
      } catch (err) {
        console.debug("[notify] initial probe failed", err);
      }
    })();

    /// 懒申请通知权限：第一次要弹通知时触发；用户拒绝后这次进程内不再问。
    /// Promise 缓存避免并发竞态多次弹权限框。
    const ensurePermission = async (): Promise<boolean> => {
      if (permissionPromiseRef.current) return permissionPromiseRef.current;
      permissionPromiseRef.current = (async () => {
        try {
          const { isPermissionGranted, requestPermission } = await import(
            "@tauri-apps/plugin-notification"
          );
          if (await isPermissionGranted()) return true;
          const result = await requestPermission();
          return result === "granted";
        } catch (err) {
          console.warn("[notify] permission check failed", err);
          return false;
        }
      })();
      return permissionPromiseRef.current;
    };

    const sendCompletion = async (tab: TabState): Promise<void> => {
      const ok = await ensurePermission();
      if (!ok) return;
      try {
        const { sendNotification } = await import("@tauri-apps/plugin-notification");
        const isError = tab.uiState === "error";
        // 标题简洁；body 给一行能看到 task / 用户最后输入 / 项目目录之一
        const title = isError ? "❌ 任务失败" : "✅ 任务完成";
        const body =
          tab.lastUserPrompt?.trim() ||
          tab.task?.trim() ||
          tab.title?.trim() ||
          "未命名会话";
        sendNotification({ title, body: body.slice(0, 240) });
      } catch (err) {
        console.warn("[notify] sendNotification failed", err);
      }
    };

    /// 跨平台未读提示：
    ///   - macOS / Linux：Window.setBadgeCount → Dock / Unity 数字角标
    ///   - Windows：把窗口标题加 `(N) ` 前缀作为 fallback —— Windows 任务栏没有原生
    ///     数字角标 API（setOverlayIcon 需要图标资源），用标题前缀是 Win 上常见做法
    const updateBadge = async (count: number): Promise<void> => {
      if (count === lastBadgeRef.current) return;
      lastBadgeRef.current = count;
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        if (isWindowsRef.current) {
          // 第一次惰性记下"未带前缀"的窗口标题；之后所有更新基于它
          if (baseTitleRef.current === null) {
            try {
              baseTitleRef.current = await win.title();
            } catch {
              baseTitleRef.current = "";
            }
          }
          const base = baseTitleRef.current ?? "";
          const next = count > 0 ? `(${count}) ${base}` : base;
          await win.setTitle(next);
        } else {
          // setBadgeCount(undefined / 0) 在 Tauri 2 上等效于"清除角标"
          await win.setBadgeCount(count > 0 ? count : undefined);
        }
      } catch (err) {
        // 不支持的 webview / 缺权限——静默失败，至少通知还在
        console.debug("[notify] updateBadge failed", err);
      }
    };

    const handleSnapshot = (state: TabsStoreState): void => {
      const tabs = state.tabs;
      const activeTabId = state.activeTabId;
      const focused = typeof document === "undefined" || document.hasFocus();
      const newPrev: Record<string, string> = {};
      let unreadCount = 0;
      const completedTabs: TabState[] = [];

      for (const id of Object.keys(tabs)) {
        const tab = tabs[id];
        if (!tab) continue;
        const prev = prevStateRef.current[id];
        newPrev[id] = tab.uiState;
        if (
          initializedRef.current &&
          COMPLETED_STATES.has(tab.uiState) &&
          prev !== undefined &&
          !COMPLETED_STATES.has(prev)
        ) {
          // 用户正盯着这个 tab 看 → 不打扰；否则弹通知
          if (!focused || activeTabId !== id) {
            completedTabs.push(tab);
          }
        }
        if (tab.hasUnread) unreadCount += 1;
      }

      prevStateRef.current = newPrev;
      initializedRef.current = true;

      for (const tab of completedTabs) {
        void sendCompletion(tab);
      }
      void updateBadge(unreadCount);
    };

    // 立即跑一次（建立 prevStateRef 基线，且初始化角标），然后订阅后续变化
    handleSnapshot(useTabsStore.getState());
    const unsub = useTabsStore.subscribe(handleSnapshot);

    return () => {
      unsub();
      // 关闭 hook 时把角标也清掉，避免遗留
      void updateBadge(0);
    };
  }, []);
}
