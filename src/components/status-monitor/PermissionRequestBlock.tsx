// PermissionRequestBlock —— 桥接 Claude Code 的 permission-prompt-tool。
//
// Rust 端 permission_mcp.rs 收到 Claude 的 approve 工具调用后 emit
// `permission://request`，usePermissionRequests 把它转成 CliBlock 追加到对应
// tab 的 cliBlocks。本组件渲染卡片样式 + Allow/Always/Deny 按钮；用户点击后调
// `respond_permission_decision` Tauri 命令，Rust 端解阻塞，Claude 收到决策。
//
// 特化：
//   - ExitPlanMode（Plan Mode 退出）：把 input.plan 全宽 markdown 渲染，按钮
//     文案改成"批准计划并执行 / 继续完善"，模仿 Claude Code 桌面版。
//   - 其它工具：紧凑 inline 卡片 + 三按钮（Allow once / Always allow / Deny）。

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { motion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { invoke } from "../../lib/bridge";
import { useActiveTab, useActiveTabActions } from "../../hooks/useActiveTab";
import { useTabsStore } from "../../stores/useTabsStore";
import type { CliBlock } from "../../types/blocks";

interface Props {
  block: CliBlock;
}

/// 工具入参 JSON 预览：对常见工具做友好抽取（Bash 显示 command，Read/Edit
/// 显示 path），fallback 到 JSON.stringify。
function describeInput(toolName: string | undefined, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  if (toolName === "Bash" && typeof obj.command === "string") {
    return obj.command;
  }
  if ((toolName === "Read" || toolName === "Glob") && typeof obj.file_path === "string") {
    return obj.file_path;
  }
  if (toolName === "Edit" && typeof obj.file_path === "string") {
    return `${obj.file_path}\n${obj.old_string ?? ""} → ${obj.new_string ?? ""}`;
  }
  if (toolName === "Write" && typeof obj.file_path === "string") {
    return `${obj.file_path}（写入 ${
      typeof obj.content === "string" ? `${obj.content.length} 字符` : "内容"
    }）`;
  }
  if (toolName === "Grep" && typeof obj.pattern === "string") {
    return `pattern: ${obj.pattern}${obj.path ? `  · path: ${obj.path}` : ""}`;
  }
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj);
  }
}

/// ExitPlanMode 工具的 input.plan 字段含完整计划 markdown。
function extractPlanMarkdown(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.plan === "string" && obj.plan.trim().length > 0) {
    return obj.plan;
  }
  return null;
}

interface EditDiffInfo {
  /// 工具名（Edit / MultiEdit / Write）
  tool: "Edit" | "MultiEdit" | "Write";
  /// 文件绝对路径
  filePath: string;
  /// 待应用的 diff 行：每行以 ` ` / `+` / `-` 开头
  diffLines: string[];
  /// 仅 Write：完整内容字符长度，让头部能显示"新建 N 字符"
  writeLength?: number;
}

/// 从 Edit / MultiEdit / Write 的 input 抽 diff 行（+/- 前缀），跟 Rust 端
/// simple_diff 一致：old_string 全部转 `-`，new_string 全部转 `+`。
/// MultiEdit 多个 edit 之间用 `@@` 分隔；Write 把 content 全转 `+`。
function extractEditDiff(toolName: string, input: unknown): EditDiffInfo | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const filePath = typeof obj.file_path === "string" ? obj.file_path : "";

  if (toolName === "Edit") {
    const old = typeof obj.old_string === "string" ? obj.old_string : "";
    const fresh = typeof obj.new_string === "string" ? obj.new_string : "";
    if (!filePath && !old && !fresh) return null;
    const lines: string[] = [];
    old.split("\n").forEach((l) => lines.push(`-${l}`));
    fresh.split("\n").forEach((l) => lines.push(`+${l}`));
    return { tool: "Edit", filePath, diffLines: lines };
  }

  if (toolName === "MultiEdit") {
    const edits = Array.isArray(obj.edits) ? obj.edits : [];
    const lines: string[] = [];
    edits.forEach((e, i) => {
      if (!e || typeof e !== "object") return;
      const eo = e as Record<string, unknown>;
      const old = typeof eo.old_string === "string" ? eo.old_string : "";
      const fresh = typeof eo.new_string === "string" ? eo.new_string : "";
      if (i > 0) lines.push("@@");
      old.split("\n").forEach((l) => lines.push(`-${l}`));
      fresh.split("\n").forEach((l) => lines.push(`+${l}`));
    });
    if (!filePath && lines.length === 0) return null;
    return { tool: "MultiEdit", filePath, diffLines: lines };
  }

  if (toolName === "Write") {
    const content = typeof obj.content === "string" ? obj.content : "";
    const lines = content.split("\n").map((l) => `+${l}`);
    return { tool: "Write", filePath, diffLines: lines, writeLength: content.length };
  }

  return null;
}

interface AskQuestionOption {
  /// 选项主标题（Claude SDK 用 label，旧版本可能用 description）
  label: string;
  /// 副说明（可选）
  description?: string;
}

interface AskQuestion {
  header: string;
  multiSelect: boolean;
  options: AskQuestionOption[];
}

/// AskUserQuestion 的 input.questions 解析。容错老/新字段名。
function extractAskQuestions(input: unknown): AskQuestion[] | null {
  if (!input || typeof input !== "object") return null;
  const raw = (input as Record<string, unknown>).questions;
  if (!Array.isArray(raw)) return null;
  const out: AskQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const obj = q as Record<string, unknown>;
    const header =
      (typeof obj.header === "string" && obj.header) ||
      (typeof obj.question === "string" && obj.question) ||
      "";
    if (!header) continue;
    const multiSelect = Boolean(obj.multiSelect ?? obj.multi_select);
    const optsRaw = Array.isArray(obj.options) ? obj.options : [];
    const options: AskQuestionOption[] = [];
    for (const o of optsRaw) {
      if (!o || typeof o !== "object") continue;
      const oo = o as Record<string, unknown>;
      const label =
        (typeof oo.label === "string" && oo.label) ||
        (typeof oo.description === "string" && oo.description) ||
        (typeof oo.value === "string" && oo.value) ||
        "";
      if (!label) continue;
      const description =
        typeof oo.description === "string" && oo.description !== label
          ? oo.description
          : undefined;
      options.push({ label, description });
    }
    if (options.length === 0) continue;
    out.push({ header, multiSelect, options });
  }
  return out.length > 0 ? out : null;
}

/// 把用户的选择格式化成 Claude 期望的回包形式（作 permission deny message
/// 透传给 Claude 当作 tool_result content）。Schema 跟 CLI 默认 fallback 兼容：
///
///   - 单问题单选 → "User has answered your questions: <选中label>"
///   - 单问题多选 → "User has answered your questions: [\"A\",\"B\"]"
///   - 多个问题 → JSON 形式数组：
///       [{"question":"...","answers":["A","B"]}, ...]
///     带前缀句让 Claude 识别这是 AskUserQuestion 的回应而不是错误。
///
/// 一律带 "User has answered your questions:" 前缀，让 Claude 训练里已经熟悉的
/// 模式立刻命中，即便 CLI 用 <error> 包装也无碍解读。
function formatQuestionAnswers(
  questions: AskQuestion[],
  selections: ReadonlyArray<ReadonlyArray<string>>
): string {
  if (questions.length === 0) return "User has answered your questions: (no questions)";

  if (questions.length === 1) {
    const q = questions[0];
    const picked = selections[0] ?? [];
    if (picked.length === 0) {
      return "User has answered your questions: (no selection)";
    }
    if (q.multiSelect || picked.length > 1) {
      // 多选 → 数组
      return `User has answered your questions: ${JSON.stringify(picked)}`;
    }
    // 单选 → 直接 label
    return `User has answered your questions: ${picked[0]}`;
  }

  // 多个问题 → 结构化数组，每个元素带 question + answers
  const responses = questions.map((q, i) => ({
    question: q.header,
    multi_select: q.multiSelect,
    answers: selections[i] ?? [],
  }));
  return `User has answered your questions: ${JSON.stringify(responses)}`;
}

export function PermissionRequestBlock({ block }: Props): JSX.Element {
  const { activeTabId, upsertBlock, appendBlock } = useActiveTabActions();
  const tab = useActiveTab();
  const [busy, setBusy] = useState<"" | "allow" | "always" | "deny">("");
  const [showFullInput, setShowFullInput] = useState(false);
  // plan / 反馈输入框：批准时附给 Claude 作 updatedInput.user_followup，
  // 拒绝时作 message。空串则按钮回退到默认文案。
  const [feedback, setFeedback] = useState("");
  const isComposingRef = useRef(false);
  const decision = block.permissionDecision;
  const toolName = block.permissionToolName || "(未知工具)";
  const isExitPlan = toolName === "ExitPlanMode";
  const planMarkdown = useMemo(
    () => (isExitPlan ? extractPlanMarkdown(block.permissionInput) : null),
    [isExitPlan, block.permissionInput]
  );
  const isEditFamily = toolName === "Edit" || toolName === "MultiEdit" || toolName === "Write";
  const editDiff = useMemo(
    () => (isEditFamily ? extractEditDiff(toolName, block.permissionInput) : null),
    [isEditFamily, toolName, block.permissionInput]
  );
  const isAskQuestion = toolName === "AskUserQuestion";
  const askQuestions = useMemo(
    () => (isAskQuestion ? extractAskQuestions(block.permissionInput) : null),
    [isAskQuestion, block.permissionInput]
  );
  // 每个问题的当前选择；multiSelect 用数组装多个，单选也存数组（最多 1 个）
  const [askSelections, setAskSelections] = useState<string[][]>([]);
  useEffect(() => {
    // 问题数量变了（首次解析完成 / 切换不同 tool）才 reset，避免串扰
    if (askQuestions && askSelections.length !== askQuestions.length) {
      setAskSelections(askQuestions.map(() => []));
    }
  }, [askQuestions, askSelections.length]);
  const summary = describeInput(block.permissionToolName, block.permissionInput);
  const fullJson =
    block.permissionInput !== undefined
      ? JSON.stringify(block.permissionInput, null, 2)
      : "";
  const alreadyWhitelisted =
    Array.isArray(tab.autoApprovedTools) && tab.autoApprovedTools.includes(toolName);

  const respond = async (kind: "allow" | "always" | "deny", message?: string) => {
    if (!block.permissionRequestId || busy || decision) return;
    setBusy(kind);
    try {
      if (kind === "always" && activeTabId) {
        useTabsStore.getState().addAutoApprovedTool(activeTabId, toolName);
      }
      const apiDecision = kind === "deny" ? "deny" : "allow";
      const trimmedFeedback = feedback.trim();
      // 批准时把用户反馈以 updatedInput 形式附回去，让 Claude 在下一轮上下文里
      // 看到这条 user_followup（Claude SDK 把 updatedInput 转发为该 tool 的实际入参，
      // 多余字段不会被工具拒绝，Claude 在 conversation context 里能读到）。
      let updatedInput: Record<string, unknown> | null = null;
      if (kind !== "deny" && trimmedFeedback) {
        const orig =
          block.permissionInput && typeof block.permissionInput === "object"
            ? (block.permissionInput as Record<string, unknown>)
            : {};
        updatedInput = { ...orig, user_followup: trimmedFeedback };
      }
      await invoke("respond_permission_decision", {
        requestId: block.permissionRequestId,
        decision: apiDecision,
        message:
          kind === "deny"
            ? trimmedFeedback || message || (isExitPlan ? "请继续完善计划" : "用户拒绝")
            : null,
        updatedInput,
      });
      upsertBlock({
        ...block,
        permissionDecision:
          kind === "deny"
            ? "denied"
            : kind === "always"
              ? "approved-always"
              : "approved",
      });
    } catch (err) {
      console.error("[permission] respond failed", err);
      setBusy("");
    }
  };

  const handleFeedbackKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey) return;
    const native = e.nativeEvent as KeyboardEvent["nativeEvent"] & {
      isComposing?: boolean;
    };
    if (native.isComposing || e.keyCode === 229 || isComposingRef.current) return;
    e.preventDefault();
    // 默认行为：plan 卡 Enter 等同于"批准并附反馈"；普通卡片 Enter 等同 allow
    void respond("allow");
  };

  // ============ 特化：Edit / MultiEdit / Write 文件改动预览 ============
  if (isEditFamily && editDiff) {
    const editIcon = editDiff.tool === "Write" ? "📄" : "✏️";
    const editTitle =
      editDiff.tool === "Write"
        ? `Write · 新建 ${editDiff.writeLength ?? 0} 字符`
        : editDiff.tool;
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15 }}
        className="my-2 rounded-xl border border-rose-300/60 bg-rose-50/70 p-3 shadow-sm dark:border-rose-400/40 dark:bg-rose-500/10"
      >
        <div className="flex items-center gap-2">
          <span className="text-base" aria-hidden>
            {editIcon}
          </span>
          <span className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-200">
            权限请求
          </span>
          <span className="font-mono text-xs font-bold text-zinc-800 dark:text-zinc-100">
            {editTitle}
          </span>
          {decision && (
            <span
              className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
                decision.startsWith("approved")
                  ? "bg-emerald-200/70 text-emerald-800 dark:bg-emerald-700/40 dark:text-emerald-200"
                  : "bg-zinc-200/70 text-zinc-600 dark:bg-zinc-700/40 dark:text-zinc-300"
              }`}
            >
              {decision === "approved"
                ? "已允许"
                : decision === "approved-always"
                  ? "已加白名单"
                  : "已拒绝"}
            </span>
          )}
        </div>

        {editDiff.filePath && (
          <div
            className="mt-2 truncate font-mono text-[11px] text-zinc-600 dark:text-zinc-300"
            title={editDiff.filePath}
          >
            {editDiff.filePath}
          </div>
        )}

        {/* +/- 着色 diff 预览：跟 BlockStream.DiffBlock 同款配色，仅展示前 N 行
            避免大文件撑爆界面；展开看完整在生效后的 diff 块上做（生效后才进 cliBlocks）。 */}
        <pre className="mt-1.5 max-h-[40vh] overflow-auto whitespace-pre rounded-md bg-white/70 px-2 py-1.5 font-mono text-[11px] leading-snug text-zinc-700 dark:bg-slate-900/40 dark:text-zinc-200">
          {editDiff.diffLines.slice(0, 200).map((line, idx) => {
            if (line === "@@") {
              return (
                <div
                  key={idx}
                  className="my-1 select-none border-y border-zinc-300/40 py-0.5 text-center text-[9px] tracking-wider text-zinc-500 dark:border-zinc-600/40 dark:text-zinc-400"
                >
                  @@
                </div>
              );
            }
            const cls =
              line.startsWith("+")
                ? "bg-emerald-100/60 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200"
                : line.startsWith("-")
                  ? "bg-rose-100/60 text-rose-800 dark:bg-rose-500/15 dark:text-rose-200"
                  : "";
            return (
              <div key={idx} className={`-mx-2 px-2 ${cls}`}>
                {line || " "}
              </div>
            );
          })}
          {editDiff.diffLines.length > 200 && (
            <div className="mt-1 px-2 text-[10px] italic text-zinc-500 dark:text-zinc-400">
              …还有 {editDiff.diffLines.length - 200} 行，批准后在流式区看完整 diff
            </div>
          )}
        </pre>

        {!decision && (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.97 }}
              disabled={busy !== ""}
              onClick={() => void respond("allow")}
              className="rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white shadow-sm shadow-emerald-500/30 transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "allow" ? "处理中…" : "Allow（仅这次）"}
            </motion.button>
            {!alreadyWhitelisted && (
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.97 }}
                disabled={busy !== ""}
                onClick={() => void respond("always")}
                title={`本 tab 之后所有 ${toolName} 调用都自动放行；关 tab 后失效`}
                className="rounded-md border border-emerald-400/60 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-400/40 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:bg-emerald-500/20"
              >
                {busy === "always" ? "处理中…" : `Always allow ${toolName}`}
              </motion.button>
            )}
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.97 }}
              disabled={busy !== ""}
              onClick={() => void respond("deny")}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:bg-slate-800 dark:text-zinc-200 dark:hover:bg-slate-700"
            >
              {busy === "deny" ? "处理中…" : "Deny"}
            </motion.button>
          </div>
        )}
      </motion.div>
    );
  }

  // ============ 特化：AskUserQuestion 多选 / 单选问卷 ============
  // 由于 permission_prompt_tool 只能控制工具入参（不能改 output），
  // 我们用 deny + message 把用户答案塞回给 Claude —— Claude 收到 tool_result 是
  // error 但 content 里是用户答案，会顺势用上。
  if (isAskQuestion && askQuestions && askQuestions.length > 0) {
    const toggle = (qIdx: number, optLabel: string, multi: boolean) => {
      setAskSelections((prev) => {
        const next = prev.map((arr) => arr.slice());
        const cur = next[qIdx] ?? [];
        if (multi) {
          next[qIdx] = cur.includes(optLabel)
            ? cur.filter((v) => v !== optLabel)
            : [...cur, optLabel];
        } else {
          next[qIdx] = cur.includes(optLabel) ? [] : [optLabel];
        }
        return next;
      });
    };

    const submitAnswers = async (): Promise<void> => {
      if (!block.permissionRequestId || busy || decision) return;
      // 实测：allow + updatedInput 路径 Claude 不读改写过的 header，会反复重问。
      // 唯一让 Claude 真正在 tool_result content 里看到用户答案的，是 deny + message。
      // 副作用是 CLI 把 tool_result 标 is_error=true 并可能用 <error>...</error>
      // 包装内容。我们在 Rust claude.rs::extract_claude_blocks 的 tool_result
      // 分支里特化 AskUserQuestion：强制 status="success" + 把 message 当 output
      // 显示，所以用户视觉上看到绿色 ✓ 的 tool_result。Claude 即便读到 <error>
      // 包装也能从内容 "User has answered your questions: ..." 识别答案。
      const formatted = formatQuestionAnswers(askQuestions, askSelections);
      setBusy("allow");
      try {
        await invoke("respond_permission_decision", {
          requestId: block.permissionRequestId,
          decision: "deny",
          message: formatted,
          updatedInput: null,
        });
        upsertBlock({ ...block, permissionDecision: "approved" });
        // 流式区前端层追加一条 schema 块作显式提示，跟 Rust 侧改写后的 tool_result
        // 块并排（两条相同内容但 id 不同；append 给"用户已提交"明确信号）
        appendBlock({
          id: `askuserquestion-answer-${block.permissionRequestId}`,
          type: "tool",
          tool: "AskUserQuestion · answer",
          detail: formatted,
          status: "success",
          backend: "claude",
          suppressLogLine: true,
        });
      } catch (err) {
        console.error("[permission] submit answers failed", err);
        setBusy("");
      }
    };

    const totalSelected = askSelections.reduce((sum, arr) => sum + arr.length, 0);

    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18 }}
        className="my-3 rounded-2xl border border-sky-300/60 bg-sky-50/60 p-4 shadow-md shadow-sky-500/10 dark:border-sky-400/40 dark:bg-sky-500/10"
      >
        <div className="mb-3 flex items-center gap-2">
          <span className="text-lg" aria-hidden>
            ❓
          </span>
          <span className="font-mono text-xs font-semibold uppercase tracking-wider text-sky-700 dark:text-sky-300">
            Claude 提问 · 请选答
          </span>
          {decision && (
            <span
              className={`ml-auto rounded px-2 py-0.5 text-[10px] font-medium uppercase ${
                decision.startsWith("approved")
                  ? "bg-emerald-200/70 text-emerald-800 dark:bg-emerald-700/40 dark:text-emerald-200"
                  : "bg-zinc-200/70 text-zinc-600 dark:bg-zinc-700/40 dark:text-zinc-300"
              }`}
            >
              {decision === "approved" || decision === "approved-always"
                ? "已提交"
                : "已跳过"}
            </span>
          )}
        </div>

        <div className="space-y-4">
          {askQuestions.map((q, qIdx) => (
            <fieldset
              key={qIdx}
              className="rounded-lg border border-sky-200/60 bg-white/70 px-3 py-2 dark:border-sky-400/20 dark:bg-slate-900/40"
            >
              <legend className="px-1 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                {q.header}
                <span className="ml-2 text-[10px] font-normal text-zinc-500 dark:text-zinc-400">
                  ({q.multiSelect ? "可多选" : "单选"})
                </span>
              </legend>
              <div className="mt-1.5 space-y-1">
                {q.options.map((opt) => {
                  const picked = (askSelections[qIdx] ?? []).includes(opt.label);
                  return (
                    <label
                      key={opt.label}
                      className={`flex cursor-pointer items-start gap-2 rounded-md px-2 py-1 transition-colors ${
                        picked
                          ? "bg-sky-100/60 dark:bg-sky-500/15"
                          : "hover:bg-zinc-100/60 dark:hover:bg-slate-800/60"
                      }`}
                    >
                      <input
                        type={q.multiSelect ? "checkbox" : "radio"}
                        name={`q-${block.permissionRequestId}-${qIdx}`}
                        checked={picked}
                        disabled={busy !== "" || !!decision}
                        onChange={() => toggle(qIdx, opt.label, q.multiSelect)}
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-sky-500"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium text-zinc-800 dark:text-zinc-100">
                          {opt.label}
                        </div>
                        {opt.description && (
                          <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
                            {opt.description}
                          </div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>

        {!decision && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.97 }}
              disabled={busy !== "" || totalSelected === 0}
              onClick={() => void submitAnswers()}
              className="rounded-md bg-sky-500 px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-sky-500/30 transition-colors hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "allow"
                ? "提交中…"
                : `提交答案${totalSelected > 0 ? `（已选 ${totalSelected}）` : ""}`}
            </motion.button>
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.97 }}
              disabled={busy !== ""}
              onClick={() => void respond("deny", "用户跳过 AskUserQuestion，请用默认范围继续")}
              className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:bg-slate-800 dark:text-zinc-200 dark:hover:bg-slate-700"
            >
              {busy === "deny" ? "处理中…" : "跳过 / 让 Claude 用默认"}
            </motion.button>
            <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
              提交答案 → Claude 收到 user_responses 数组；跳过 → Claude 用默认范围
            </span>
          </div>
        )}
      </motion.div>
    );
  }

  // ============ 特化：ExitPlanMode 计划书卡片 ============
  if (isExitPlan && planMarkdown) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18 }}
        className="my-3 rounded-2xl border border-violet-300/60 bg-violet-50/60 p-4 shadow-md shadow-violet-500/10 dark:border-violet-400/40 dark:bg-violet-500/10"
      >
        <div className="mb-3 flex items-center gap-2">
          <span className="text-lg" aria-hidden>
            📋
          </span>
          <span className="font-mono text-xs font-semibold uppercase tracking-wider text-violet-700 dark:text-violet-300">
            Plan Mode · 待批准
          </span>
          {decision && (
            <span
              className={`ml-auto rounded px-2 py-0.5 text-[10px] font-medium uppercase ${
                decision.startsWith("approved")
                  ? "bg-emerald-200/70 text-emerald-800 dark:bg-emerald-700/40 dark:text-emerald-200"
                  : "bg-zinc-200/70 text-zinc-600 dark:bg-zinc-700/40 dark:text-zinc-300"
              }`}
            >
              {decision === "denied" ? "已拒绝" : "已批准"}
            </span>
          )}
        </div>

        <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-violet-200/50 bg-white/80 px-4 py-3 text-sm leading-relaxed text-zinc-800 shadow-inner dark:border-violet-400/20 dark:bg-slate-900/60 dark:text-zinc-100">
          <article className="prose prose-sm max-w-none prose-headings:my-2 prose-p:my-1.5 prose-li:my-0.5 prose-pre:my-2 dark:prose-invert">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{planMarkdown}</ReactMarkdown>
          </article>
        </div>

        {!decision && (
          <div className="mt-3 flex flex-col gap-2">
            {/* 反馈输入框：参照 Claude Code 终端 —— 用户除了点按钮，也能
                写一段补充意见。批准时附给 Claude 作 user_followup 入参；
                拒绝时直接作为 reason message 让 Claude 看到。 */}
            <textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              onKeyDown={handleFeedbackKeyDown}
              onCompositionStart={() => {
                isComposingRef.current = true;
              }}
              onCompositionEnd={() => {
                isComposingRef.current = false;
              }}
              placeholder="（可选）给 Claude 写点意见 — Enter 批准并附反馈，Shift+Enter 换行"
              rows={2}
              className="min-h-[56px] max-h-40 w-full resize-y rounded-lg border border-violet-200/60 bg-white/70 px-3 py-2 text-sm text-zinc-800 outline-none transition-colors placeholder:text-zinc-400 focus:border-violet-400/70 focus:bg-white/95 focus:ring-2 focus:ring-violet-400/20 dark:border-violet-400/30 dark:bg-slate-900/40 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:bg-slate-900/70"
            />
            <div className="flex flex-wrap items-center gap-2">
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.97 }}
                disabled={busy !== ""}
                onClick={() => void respond("allow")}
                className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-emerald-500/30 transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === "allow"
                  ? "处理中…"
                  : feedback.trim()
                    ? "批准并附反馈"
                    : "批准计划并开始执行"}
              </motion.button>
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.97 }}
                disabled={busy !== ""}
                onClick={() => void respond("deny")}
                className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:bg-slate-800 dark:text-zinc-200 dark:hover:bg-slate-700"
              >
                {busy === "deny"
                  ? "处理中…"
                  : feedback.trim()
                    ? "拒绝并提交意见"
                    : "继续完善计划"}
              </motion.button>
              <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
                批准 → Claude 退出 Plan Mode 执行 ｜ 拒绝 → 把反馈作为反馈让 Claude 继续打磨
              </span>
            </div>
          </div>
        )}
      </motion.div>
    );
  }

  // ============ 通用工具审批卡片 ============
  const isDangerous = ["Bash", "Write", "Edit", "MultiEdit"].includes(toolName);
  const headerPalette = isDangerous
    ? "border-rose-300/60 bg-rose-50/70 dark:border-rose-400/40 dark:bg-rose-500/10"
    : "border-amber-300/60 bg-amber-50/70 dark:border-amber-400/40 dark:bg-amber-500/10";

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      className={`my-2 rounded-xl border ${headerPalette} p-3 shadow-sm`}
    >
      <div className="flex items-center gap-2">
        <span className="text-base" aria-hidden>
          {isDangerous ? "⚠️" : "🔐"}
        </span>
        <span className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-200">
          权限请求
        </span>
        <span className="font-mono text-xs font-bold text-zinc-800 dark:text-zinc-100">
          {toolName}
        </span>
        {decision && (
          <span
            className={`ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
              decision.startsWith("approved")
                ? "bg-emerald-200/70 text-emerald-800 dark:bg-emerald-700/40 dark:text-emerald-200"
                : "bg-zinc-200/70 text-zinc-600 dark:bg-zinc-700/40 dark:text-zinc-300"
            }`}
          >
            {decision === "approved"
              ? "已允许"
              : decision === "approved-always"
                ? "已加白名单"
                : "已拒绝"}
          </span>
        )}
      </div>

      {summary && (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-white/60 px-2 py-1.5 font-mono text-[11px] leading-snug text-zinc-700 dark:bg-slate-900/40 dark:text-zinc-200">
          {summary}
        </pre>
      )}

      {fullJson && fullJson !== summary && (
        <div className="mt-1.5">
          <button
            type="button"
            onClick={() => setShowFullInput((v) => !v)}
            className="text-[10px] text-zinc-500 underline-offset-2 hover:underline dark:text-zinc-400"
          >
            {showFullInput ? "收起完整入参" : "查看完整入参 JSON"}
          </button>
          {showFullInput && (
            <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-md bg-white/60 px-2 py-1.5 font-mono text-[10px] text-zinc-600 dark:bg-slate-900/40 dark:text-zinc-300">
              {fullJson}
            </pre>
          )}
        </div>
      )}

      {!decision && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.97 }}
            disabled={busy !== ""}
            onClick={() => void respond("allow")}
            className="rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white shadow-sm shadow-emerald-500/30 transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "allow" ? "处理中…" : "Allow（仅这次）"}
          </motion.button>
          {/* AskUserQuestion 不允许加入白名单：自动放行 = 失去交互意义 */}
          {!alreadyWhitelisted && toolName !== "AskUserQuestion" && (
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.97 }}
              disabled={busy !== ""}
              onClick={() => void respond("always")}
              title={`本 tab 之后所有 ${toolName} 工具调用都自动放行；切 tab / 关 tab 后失效`}
              className="rounded-md border border-emerald-400/60 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-400/40 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:bg-emerald-500/20"
            >
              {busy === "always" ? "处理中…" : `Always allow ${toolName}`}
            </motion.button>
          )}
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.97 }}
            disabled={busy !== ""}
            onClick={() => void respond("deny")}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-700 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:bg-slate-800 dark:text-zinc-200 dark:hover:bg-slate-700"
          >
            {busy === "deny" ? "处理中…" : "Deny"}
          </motion.button>
        </div>
      )}
    </motion.div>
  );
}
