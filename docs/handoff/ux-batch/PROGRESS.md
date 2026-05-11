# UX 批次进度（跨会话交接）

**起始**：2026-05-11
**目标**：按用户指定顺序，把 6 项 UX 优化做完。每项做完都验证（typecheck / cargo check / 必要时手动验）。
**风格约束**：保持现有项目风格——zustand persist + sharedStorage、Tailwind 类、注释解释 *why* 不解释 *what*、useActiveTabField 单字段订阅、按钮 hover 显示动作、暗色/浅色都要兼容。

## 待办顺序

| # | 任务 | 状态 | 验证方式 |
|---|---|---|---|
| 1 | **任务结束系统通知 + 角标** | ✅ 已完成（dev 模式 macOS 通知不弹是签名限制，release 流程会签名） | tsc ✅ cargo ✅；Dock badge 在 dev 模式实测可见 |
| 2 | user-prompt 行悬浮操作（复制/编辑重发/删除） | ✅ 已完成（已 commit） | tsc ✅；用户手动验 OK |
| 3 | 错误归因 + 一键修复 | ✅ 已完成（待用户验证 + 提交） | tsc ✅；BlockStream ErrorLine + ResultCard 错误模式两处都接归因 |
| 4 | BlockStream 虚拟滚动 | 待办 | tsc + 手动：跑出 500+ block，滚动流畅；切 tab 不丢位置 |
| 5 | AI 生成 commit message | 待办 | tsc + cargo + 手动：staged 后点按钮，看到生成的 commit |
| 6 | Diff viewer 升级（syntax highlight + 行号 + hunk 折叠） | 待办 | tsc + 手动：看不同语言文件的 diff，浅色/暗色都能看 |

## 进度日志

### 2026-05-11 会话 #1
- 创建 to do 文档 (`notes/TODO-ux-improvements.md`) 把剩余 8 项移过去
- 创建本进度文档
- 完成 Task 1：系统通知 + 角标（含 Windows fallback）
  - `src-tauri/Cargo.toml` 加 `tauri-plugin-notification = "2"`
  - `src-tauri/src/lib.rs` 注册 plugin
  - `src-tauri/capabilities/default.json` 加 6 项权限：notification + setBadgeCount + setFocus + isFocused + setTitle + title
  - `package.json` 装 `@tauri-apps/plugin-notification`
  - 新建 `src/hooks/useTaskCompletionNotifier.ts`：监听 tabs uiState 转入 done/error → 弹通知；
    macOS/Linux 走 `setBadgeCount`，**Windows 走窗口标题前缀 `(N)` fallback**（任务栏无原生数字角标）
  - `src/App.tsx` 挂载该 hook
  - `src/stores/useTabsStore.ts` 把 `TabsStoreState` 改 `export`
  - tsc / cargo 都通过；用户后续可手动验（mac 看 Dock 数字、Win 看任务栏标题前缀）
- **节奏约定（2026-05-11 用户明确）**：一个任务一次对话，做完一项后由用户验证 + 提交，
  下次会话再开下一项。不要在同一次会话里连做多项。
- **跨平台约定（2026-05-11 用户明确）**：项目两端用户都不少，所有 UX 优化默认 mac+win 都覆盖；
  做完单平台后想到的"另一端怎么办"也属于该任务的覆盖度，要补完整。
- Task 2 暂不开始，等用户验证 / 提交 Task 1 后下次会话再做。

### 2026-05-11 会话 #2（用户 commit Task 1 后继续）
- 完成 Task 2：user-prompt 行悬浮操作
  - `src/stores/useTabsStore.ts` 加 `removeCliBlock(id, blockId)` action
  - `src/stores/useUiStore.ts` 加 `inputFocusRequest` 计数器 + `bumpInputFocus()`
  - `src/components/chat-bubble/InputBubble.tsx` 加 textareaRef + 监听 `inputFocusRequest`，
    变化时 focus 输入框并把光标移到末尾
  - `src/components/status-monitor/BlockStream.tsx` 的 `UserPromptBlock` 加 hover 操作组：
    - 复制：`navigator.clipboard.writeText` + 2s 内打勾反馈
    - 编辑重发：把内容回填到 active tab.task + 触发 InputBubble focus（**不自动启动**，避免误触）
    - 删除：window.confirm 警告"仅清屏不影响后端会话" + 调 `removeCliBlock`
  - 跨平台：clipboard API / window.confirm 都 mac+win 支持；hover 在两端鼠标 OK，
    触摸设备上 hover 不友好的 fallback 留给"手机端手势"那项 TODO
  - tsc 通过；用户手动验：hover 出按钮、复制看到打勾、编辑回填 textarea 自动 focus、删除 confirm 流程

### 2026-05-11 会话 #3（用户 commit Task 2 后继续）
- 完成 Task 3：错误归因 + 一键修复
  - **覆盖度补强教训**：开始时方向选了"只改 BlockStream ErrorLine"，但实测用户最常遇到
    的启动失败错误走 IPC throw 路径、显示在 ResultCard 不在 BlockStream。用户测试发现归因没出现 →
    扩补 ResultCard 错误模式同样接入归因；这是"做完一项的完整覆盖度"，跟 Task 1 给 Win 加 fallback 一样
  - 新建 `src/lib/errorDiagnose.ts`：纯函数模块，7 类模式（CLI 缺 / 鉴权 / 余额 / 网络 /
    并发 / 会话未就绪 / 进程崩溃）+ 兜底；返回 `{ title, detail, actions, severity, kind }`
  - 新建 `src/components/status-monitor/ErrorDiagnosisCard.tsx`：公共组件，两 variant
    （inline / card），含 8 种 action handler（open-settings / open-backend-login /
    verify-backend / resend-prompt / reset-tab / open-link / copy-error / copy-with-context）
  - `src/components/status-monitor/BlockStream.tsx`：ErrorLine 改成薄包装 ErrorDiagnosisCard，
    通过 renderRawMessage prop 保留 cmd+f 高亮；清掉之前 inline 在 BlockStream 里的所有 handler
  - `src/components/chat-bubble/ResultCard.tsx`：错误模式下渲染 ErrorDiagnosisCard 替代 summary
    显示（避免错误文本重复），保留 emotion 气泡（凉宫风角色感）
  - **跨平台**：clipboard / window.confirm / plugin-opener / *_login_open IPC 都 mac+win 通用
  - **错误展示路径盘点**：确认 RunningBubble / StderrBlock / ProjectOverview / 桌宠 emotion 都
    无需接入（理由见 PROGRESS 表格）；两条主要错误路径（启动失败 / turn 中 emit）都已覆盖

## 关键技术依赖（实施前要核实/补齐）

- **tauri-plugin-notification**：Tauri 2 跨平台系统通知；要在 `Cargo.toml` 加依赖、`tauri.conf.json` 加权限、前端 `npm i` 装 `@tauri-apps/plugin-notification`
- **Window.setBadgeCount**：macOS Dock 数字角标走这个；Windows 走 `setOverlayIcon`，需要单独写
- **virtualization 库**：选 `@tanstack/virtual`，体积小、不需要测高（动态高度 block 友好）
- **shiki**：syntax highlight 的方案；体积比 prism 小，懒加载
- **diff parsing**：自己解析 unified diff 块（`@@ -1,3 +1,4 @@`）拆 hunk

## 跨会话交接说明

如果 context 满了：
1. 阅读本文件**待办顺序**找到当前进度
2. 阅读**进度日志**最近一条记录看上次做到哪
3. 最近未提交的工作可能在 `git status` 里——先看再继续
4. 完成一项就把状态从⏳改成✅，并在日志里加一条
