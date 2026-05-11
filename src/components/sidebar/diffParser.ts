// Unified diff 解析：把 `git diff` 输出拆成"文件 → hunks → lines"，每行带准确的
// 旧 / 新文件行号。
//
// 输入：标准 unified diff 文本，可能含：
//   - 多文件（多段 `diff --git a/X b/Y`）
//   - new file mode / deleted file mode
//   - 二进制提示 `Binary files X and Y differ`
//   - noeol（`\ No newline at end of file`）—— 不算实际内容行，但会出现在 hunk 里
//   - 多 hunk（每个 `@@ -A,B +C,D @@ <context>`）
//
// 输出：DiffFile[]。如果输入完全空 / 不含 `diff --git`，返回单个"匿名"文件
// （path = ""）让 UI 仍能渲染原始内容——某些路径下后端给的不是标准 `git diff`
// 而是直接 `git diff <hash>` 已 strip 头部的情况。
//
// 这是纯函数模块，无副作用，便于 vitest 完全覆盖；UI 组件改造在另一文件。

export type DiffLineKind =
  | "context"     // 普通上下文行，前导空格
  | "add"         // + 行
  | "del"         // - 行
  | "noeol";      // "\ No newline at end of file" 标记

export interface DiffLine {
  kind: DiffLineKind;
  /// 旧文件行号；context / del 行有，add 行为 null
  oldLineNo: number | null;
  /// 新文件行号；context / add 行有，del 行为 null
  newLineNo: number | null;
  /// 去掉前导 + / - / 空格 / \ 后的内容；用于 shiki 高亮 + 显示
  content: string;
}

export interface DiffHunk {
  /// hunk header 原文（@@ -A,B +C,D @@ <可选 context>）
  header: string;
  /// 旧文件起始行号（从 1 开始；hunk header 里的 A）
  oldStart: number;
  /// 新文件起始行号（hunk header 里的 C）
  newStart: number;
  /// hunk 主体行
  lines: DiffLine[];
}

export interface DiffFile {
  /// 文件路径（取 `b/` 那侧；删除的文件取 `a/`）
  path: string;
  /// 'new' / 'deleted' / 'binary' / 'rename' 元信息标签，UI 可在 header 显示
  flags: string[];
  hunks: DiffHunk[];
}

const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;
const FILE_HEADER_RE = /^diff --git a\/(.+?) b\/(.+)$/;

/// 把一段 unified diff 文本解析成 DiffFile 列表。
export function parseUnifiedDiff(text: string): DiffFile[] {
  if (!text || text.trim().length === 0) return [];
  const lines = text.split("\n");

  const files: DiffFile[] = [];
  // 解析期间的可变状态。包进 object 是为了让 TS 6.0 在 closure-reassign 后的
  // property access 上 narrow 仍然生效——如果用 let 变量，TS 会过度悲观把它
  // narrow 到 never。
  const state: {
    currentFile: DiffFile | null;
    currentHunk: DiffHunk | null;
    /// 在 hunk 内部累计的"已渲染了几行新文件 / 旧文件" —— 每遇 +/-/context 自增
    oldCursor: number;
    newCursor: number;
  } = {
    currentFile: null,
    currentHunk: null,
    oldCursor: 0,
    newCursor: 0,
  };

  const startFile = (path: string): void => {
    const f: DiffFile = { path, flags: [], hunks: [] };
    state.currentFile = f;
    files.push(f);
    state.currentHunk = null;
  };

  const startHunk = (header: string, oldStart: number, newStart: number): void => {
    if (!state.currentFile) {
      // 没看到 `diff --git` 就出现 hunk header（比如 git diff <hash> -- <path> 输出）
      startFile("");
    }
    const h: DiffHunk = { header, oldStart, newStart, lines: [] };
    state.currentHunk = h;
    state.currentFile!.hunks.push(h);
    state.oldCursor = oldStart;
    state.newCursor = newStart;
  };

  for (const raw of lines) {
    // 1) 文件头：`diff --git a/X b/Y`
    const fileMatch = FILE_HEADER_RE.exec(raw);
    if (fileMatch) {
      // 优先用 b/（新路径）；若后续解析到 deleted file 时再覆盖为 a/
      startFile(fileMatch[2] ?? fileMatch[1] ?? "");
      continue;
    }

    // 2) 文件元信息：new file mode / deleted file mode / similarity / rename / binary
    if (raw.startsWith("new file mode")) {
      if (state.currentFile) state.currentFile.flags.push("new");
      continue;
    }
    if (raw.startsWith("deleted file mode")) {
      if (state.currentFile) state.currentFile.flags.push("deleted");
      // 删除时 b/ 的路径其实没意义，回退到 a/；通常 a/ 和 b/ 同名无需特别处理
      continue;
    }
    if (raw.startsWith("rename from") || raw.startsWith("rename to")) {
      if (state.currentFile && !state.currentFile.flags.includes("rename")) {
        state.currentFile.flags.push("rename");
      }
      continue;
    }
    if (raw.startsWith("Binary files")) {
      if (state.currentFile) state.currentFile.flags.push("binary");
      continue;
    }
    if (
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("similarity index") ||
      raw.startsWith("dissimilarity index") ||
      raw.startsWith("copy from") ||
      raw.startsWith("copy to") ||
      raw.startsWith("old mode") ||
      raw.startsWith("new mode")
    ) {
      // 这些都是元信息行，前端不需要单独展示
      continue;
    }

    // 3) hunk header：@@ -A,B +C,D @@
    const hunkMatch = HUNK_HEADER_RE.exec(raw);
    if (hunkMatch) {
      const oldStart = parseInt(hunkMatch[1] ?? "0", 10);
      const newStart = parseInt(hunkMatch[3] ?? "0", 10);
      startHunk(raw, oldStart, newStart);
      continue;
    }

    // 4) hunk body 行
    const hunk = state.currentHunk;
    if (!hunk) {
      // 没在 hunk 里就有内容——可能是 diff 还没解析到第一个 hunk header，跳过
      continue;
    }
    if (raw.startsWith("\\ ")) {
      // "\ No newline at end of file" —— 标记前一行没有结尾换行；不算实际内容
      hunk.lines.push({
        kind: "noeol",
        oldLineNo: null,
        newLineNo: null,
        content: raw.slice(2),
      });
      continue;
    }
    if (raw.startsWith("+")) {
      hunk.lines.push({
        kind: "add",
        oldLineNo: null,
        newLineNo: state.newCursor,
        content: raw.slice(1),
      });
      state.newCursor += 1;
    } else if (raw.startsWith("-")) {
      hunk.lines.push({
        kind: "del",
        oldLineNo: state.oldCursor,
        newLineNo: null,
        content: raw.slice(1),
      });
      state.oldCursor += 1;
    } else if (raw.startsWith(" ")) {
      // context 行：第一字符是空格；代码里真正的空行在 diff 里也是 " "（不会是空字符串）
      hunk.lines.push({
        kind: "context",
        oldLineNo: state.oldCursor,
        newLineNo: state.newCursor,
        content: raw.slice(1),
      });
      state.oldCursor += 1;
      state.newCursor += 1;
    }
    // 其它前缀（含 raw.length === 0 即 split("\n") 末尾换行残留 / 奇怪混入字符）跳过
  }

  return files;
}
