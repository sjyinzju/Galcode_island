// 全局 UI 状态：跟"哪个 tab 哪份会话"无关的瞬时 UI 控制（侧栏视图、
// 当前查看的详情块等）。不持久化（重启后默认值起步）。

import { create } from "zustand";
import type { CliBlock } from "../types/blocks";

/// 左栏中部当前显示哪个视图：项目树 / 历史会话 / Git / 搜索
export type LeftSidebarView = "projects" | "history" | "git" | "search";

interface UiState {
  /// 右栏当前打开的"块详情"。null 表示右栏收起。
  /// 不存 ID + lookup，直接存整个 block —— 用户切 tab 后 detail 不应该消失，
  /// 但块本身仍持有；前端只在用户主动关闭时清掉。
  detailBlock: CliBlock | null;
  setDetailBlock: (block: CliBlock | null) => void;
  closeDetail: () => void;

  /// 左栏中部视图。默认 "projects"
  leftSidebarView: LeftSidebarView;
  setLeftSidebarView: (view: LeftSidebarView) => void;

  /// 移动端 / 窄屏（< lg 断点）下，左栏抽屉是否展开。桌面端忽略此字段（左栏一直在）。
  /// 默认收起。点击 MobileTopBar 的汉堡按钮 / 选中某项后自动关闭。
  mobileLeftDrawerOpen: boolean;
  openMobileLeftDrawer: () => void;
  closeMobileLeftDrawer: () => void;
  toggleMobileLeftDrawer: () => void;

  /// 页内搜索（cmd+f 触发）：跟"全局搜索"不同，只搜当前 active tab 的 cliBlocks。
  /// open=true 时右上角浮窗显示。
  ///
  /// 高亮粒度细到具体一段匹配文字：
  ///   - searchQuery：当前 query 本身，BlockStream 拿来给每段命中文本套 <mark>
  ///   - activeMatch：当前焦点在哪条具体匹配（哪块 / 哪个字段 / 该字段第几次出现）
  ///     —— 这一段单独用更亮的高亮跟其他匹配区分开
  inPageSearchOpen: boolean;
  searchQuery: string;
  activeMatch: ActiveMatch | null;
  openInPageSearch: () => void;
  closeInPageSearch: () => void;
  setSearchQuery: (q: string) => void;
  setActiveMatch: (m: ActiveMatch | null) => void;

  /// 单调递增计数器，bump 一次让 InputBubble useEffect 监听到差异 → focus 输入框。
  /// 用 counter 而不是 boolean，避免"已 focus 的状态写不动" —— 多次请求 focus 都能触发。
  inputFocusRequest: number;
  /// 触发输入框 focus（编辑重发场景：把 user-prompt 内容回填到 task 后调）
  bumpInputFocus: () => void;

  /// 个性化弹窗（自定义桌宠图片 / 云端图集等）开关。从原"全局设置"中拆出来，
  /// 因为这块功能独立且使用频率高（普通 LLM 设置一次配完就不动了，桌宠图片
  /// 用户会反复换 / 上传），值得占侧栏一个一级入口。
  isPersonalizationModalOpen: boolean;
  openPersonalizationModal: () => void;
  closePersonalizationModal: () => void;
}

/// 当前焦点匹配：定位"哪个块的哪个字段的第几次出现"
export interface ActiveMatch {
  blockId: string;
  field: string;
  occurrence: number;
}

export const useUiStore = create<UiState>((set) => ({
  detailBlock: null,
  setDetailBlock: (block) => set({ detailBlock: block }),
  closeDetail: () => set({ detailBlock: null }),

  leftSidebarView: "projects",
  setLeftSidebarView: (view) => set({ leftSidebarView: view }),

  mobileLeftDrawerOpen: false,
  openMobileLeftDrawer: () => set({ mobileLeftDrawerOpen: true }),
  closeMobileLeftDrawer: () => set({ mobileLeftDrawerOpen: false }),
  toggleMobileLeftDrawer: () =>
    set((s) => ({ mobileLeftDrawerOpen: !s.mobileLeftDrawerOpen })),

  inPageSearchOpen: false,
  searchQuery: "",
  activeMatch: null,
  openInPageSearch: () => set({ inPageSearchOpen: true }),
  closeInPageSearch: () =>
    set({ inPageSearchOpen: false, searchQuery: "", activeMatch: null }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  setActiveMatch: (m) => set({ activeMatch: m }),

  inputFocusRequest: 0,
  bumpInputFocus: () => set((s) => ({ inputFocusRequest: s.inputFocusRequest + 1 })),

  isPersonalizationModalOpen: false,
  openPersonalizationModal: () => set({ isPersonalizationModalOpen: true }),
  closePersonalizationModal: () => set({ isPersonalizationModalOpen: false }),
}));
