# Galcode Island

Galcode 是兼具强大功能与优秀美化系统的二次元风格 Agent 工作台。包含一套可深度定制的桌宠系统，并内置社区功能以下载他人制作的桌宠预设或上传新预设。


| Agent 工作台 | 个性化与桌宠预设 |
| --- | --- |
| ![Galcode Island Agent 工作台预览](docs/assets/galcode-workbench-preview.webp) | ![Galcode Island 个性化与桌宠预设预览](docs/assets/galcode-personalization-preview.webp) |

Galcode 不直接处理 harness 工作，而是直接接入 codex、claude code、opencode 等常见 Agent ，将工作交由其全权负责。Galcode 的主要目标是在外围引入诸多实用功能，包括多项目管理、远程控制、Git 等。

二次元美化与角色扮演工作是我们的出发点，我们力求在此出发点的基础上让工具变得好用，从而兼顾审美偏好与效率。我们并未将角色扮演功能直接接入 Agent 工作流，而是将其打造为旁支，以免真正影响 Agent 能力。

## 快速开始

### 使用分发版

通过 [Release](https://github.com/sjyinzju/Galcode_island/releases/latest) 下载对应平台的分发版，目前支持 macOS 与 Windows 平台。

### 从源码构建

#### 环境要求

- Node.js 20 或更新版本
- Rust toolchain
- Tauri 2 对应平台依赖

#### 按需安装 backend CLI

```bash
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex
npm install -g opencode-ai
```

#### 运行

```bash
git clone https://github.com/sjyinzju/Galcode_island.git
cd Galcode_island
npm install
npm run dev
```

## 功能概览

- 统一接入 Claude Code、OpenCode、Codex 三个Agent cli。
- 个性化桌宠系统，支持深度定制动画、人设，并通过社区上传和下载整套预设。
- 可选接入 LLM，用于总结、角色扮演式反馈、下一步建议，以及可选的中英输入翻译。
- 通过侧边栏管理多项目、多会话。
- 关闭会话时归档，可从历史记录恢复。
- 支持跨项目搜索与页内查找。
- 分发局域网链接，供其它设备访问，页面适配移动设备。可设置密码以增强安全性，视用户需要可将局域网链接分发。跨设备状态同步，任一端的变更都会同时落到桌面端。

## 当前支持的 Backend

| Backend | 接入方式 | 会话模型 | 说明 |
| --- | --- | --- | --- |
| Claude Code | 长驻 `claude -p` 进程，使用 `stream-json` stdin/stdout | 每个 tab 一个 stream client，用 Claude session id 续接 | 启动参数包含 `--permission-mode acceptEdits`；可配置 model、effort、proxy、binary。 |
| Codex | 共享 `codex app-server`，通过 JSON-RPC 通信 | 全局单 app-server 进程，每个 tab 一个 `thread_id` | 使用 `thread/start`、`thread/resume` 和 `turn/start`；避免多个 Codex 进程抢 `~/.codex/auth.json`。 |
| OpenCode | 每个 tab 启动一个 `opencode serve`，监听 `127.0.0.1`，端口从 `4096` 起分配 | 每个 tab 一个 OpenCode server 进程和 session id | 使用 HTTP 与 SSE；可配置 provider、model、auth mode、proxy、binary。 |


## 架构

```text
React / Vite 前端
  - tabs、sidebars、search、stream blocks、result card、pet character
  - Zustand stores，持久化到 localStorage
        |
        | Tauri invoke/listen
        v
Rust 后端
  - ipc::commands / ipc::events
  - agent::manager 负责 lifecycle、routing、stop、finalize
  - llm::* 负责可选的 OpenAI 兼容翻译与总结
        |
        +-- Claude Code stream-json process
        +-- Codex shared app-server JSON-RPC process
        +-- OpenCode per-tab HTTP/SSE serve process
```

运行时以 `run_id` 做路由，`run_id` 与前端 tab id 对齐。同一个 tab 开始新 turn 时，会先停止该 tab 尚未完成的旧 turn；其他 tab 不受影响。


## 打包

```bash
npm run build
```

Tauri build 前会执行 `scripts/prepare-runtime.mjs`。脚本会把 CLI npm 包安装到临时目录，再尝试把当前平台的二进制复制到：

```text
src-tauri/resources/runtime/<platform>-<arch>/<kind>/<binary>
```

这个步骤是 best effort。某个 backend runtime 如果被跳过或暂存失败，打包产物会回退到用户系统 `PATH` 上查找 `claude`、`codex` 或 `opencode`。

可以按需跳过某个 runtime：

```bash
node scripts/prepare-runtime.mjs --skip-claude
node scripts/prepare-runtime.mjs --skip-codex
node scripts/prepare-runtime.mjs --skip-opencode
```

发布二进制前，请确认被打包 CLI 的再分发许可。

