import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./diffParser";

const SIMPLE = `diff --git a/foo.ts b/foo.ts
index 1234567..abcdef0 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 22;
+const c = 3;
 console.log(a, b);
`;

const MULTI_FILE = `diff --git a/a.ts b/a.ts
index aaa..bbb 100644
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
-old
+new
 keep
diff --git a/b.ts b/b.ts
index ccc..ddd 100644
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-x
+y
`;

const NEW_FILE = `diff --git a/newone.md b/newone.md
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/newone.md
@@ -0,0 +1,2 @@
+# title
+body
`;

const DELETED_FILE = `diff --git a/gone.py b/gone.py
deleted file mode 100644
index 1234567..0000000
--- a/gone.py
+++ /dev/null
@@ -1,3 +0,0 @@
-line1
-line2
-line3
`;

const BINARY = `diff --git a/img.png b/img.png
index 1234567..abcdef0 100644
Binary files a/img.png and b/img.png differ
`;

const NOEOL = `diff --git a/x.txt b/x.txt
--- a/x.txt
+++ b/x.txt
@@ -1,2 +1,2 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;

const MULTI_HUNK = `diff --git a/long.ts b/long.ts
--- a/long.ts
+++ b/long.ts
@@ -1,3 +1,3 @@
 line1
-line2
+LINE2
 line3
@@ -10,3 +10,3 @@
 lineA
-lineB
+LINEB
 lineC
`;

describe("parseUnifiedDiff", () => {
  it("空输入返回空数组", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("   \n  \n")).toEqual([]);
  });

  describe("单文件简单修改", () => {
    const parsed = parseUnifiedDiff(SIMPLE);
    it("解析出一个 DiffFile", () => {
      expect(parsed).toHaveLength(1);
      expect(parsed[0]!.path).toBe("foo.ts");
      expect(parsed[0]!.flags).toEqual([]);
    });
    it("hunk 数量 + header 正确", () => {
      expect(parsed[0]!.hunks).toHaveLength(1);
      expect(parsed[0]!.hunks[0]!.oldStart).toBe(1);
      expect(parsed[0]!.hunks[0]!.newStart).toBe(1);
    });
    it("行号正确：context+/-/context 的旧 + 新行号", () => {
      const lines = parsed[0]!.hunks[0]!.lines;
      // 第 1 行 context: old=1, new=1
      expect(lines[0]).toMatchObject({ kind: "context", oldLineNo: 1, newLineNo: 1, content: "const a = 1;" });
      // 第 2 行 del: old=2, new=null
      expect(lines[1]).toMatchObject({ kind: "del", oldLineNo: 2, newLineNo: null, content: "const b = 2;" });
      // 第 3 行 add: old=null, new=2
      expect(lines[2]).toMatchObject({ kind: "add", oldLineNo: null, newLineNo: 2, content: "const b = 22;" });
      // 第 4 行 add: old=null, new=3
      expect(lines[3]).toMatchObject({ kind: "add", oldLineNo: null, newLineNo: 3, content: "const c = 3;" });
      // 第 5 行 context: old=3, new=4
      expect(lines[4]).toMatchObject({ kind: "context", oldLineNo: 3, newLineNo: 4 });
    });
  });

  describe("多文件", () => {
    const parsed = parseUnifiedDiff(MULTI_FILE);
    it("拆出两个 DiffFile", () => {
      expect(parsed).toHaveLength(2);
      expect(parsed[0]!.path).toBe("a.ts");
      expect(parsed[1]!.path).toBe("b.ts");
    });
    it("每个文件各有 1 个 hunk", () => {
      expect(parsed[0]!.hunks).toHaveLength(1);
      expect(parsed[1]!.hunks).toHaveLength(1);
    });
  });

  describe("new file", () => {
    const parsed = parseUnifiedDiff(NEW_FILE);
    it("含 'new' flag", () => {
      expect(parsed[0]!.flags).toContain("new");
      expect(parsed[0]!.path).toBe("newone.md");
    });
    it("新文件的所有内容都是 add 行，oldStart=0", () => {
      const hunk = parsed[0]!.hunks[0]!;
      expect(hunk.oldStart).toBe(0);
      expect(hunk.newStart).toBe(1);
      expect(hunk.lines.every((l) => l.kind === "add")).toBe(true);
      expect(hunk.lines[0]!.newLineNo).toBe(1);
      expect(hunk.lines[1]!.newLineNo).toBe(2);
    });
  });

  describe("deleted file", () => {
    const parsed = parseUnifiedDiff(DELETED_FILE);
    it("含 'deleted' flag", () => {
      expect(parsed[0]!.flags).toContain("deleted");
    });
    it("所有内容都是 del 行", () => {
      const hunk = parsed[0]!.hunks[0]!;
      expect(hunk.lines.every((l) => l.kind === "del")).toBe(true);
    });
  });

  describe("二进制文件", () => {
    const parsed = parseUnifiedDiff(BINARY);
    it("含 'binary' flag + 无 hunk", () => {
      expect(parsed[0]!.flags).toContain("binary");
      expect(parsed[0]!.hunks).toHaveLength(0);
    });
  });

  describe("noeol 标记", () => {
    const parsed = parseUnifiedDiff(NOEOL);
    it("noeol 行不破坏前后行号", () => {
      const lines = parsed[0]!.hunks[0]!.lines;
      // del / noeol / add / noeol
      expect(lines[0]!.kind).toBe("del");
      expect(lines[1]!.kind).toBe("noeol");
      expect(lines[2]!.kind).toBe("add");
      expect(lines[3]!.kind).toBe("noeol");
    });
  });

  describe("多 hunk", () => {
    const parsed = parseUnifiedDiff(MULTI_HUNK);
    it("一个文件，两个 hunk", () => {
      expect(parsed[0]!.hunks).toHaveLength(2);
      expect(parsed[0]!.hunks[0]!.oldStart).toBe(1);
      expect(parsed[0]!.hunks[1]!.oldStart).toBe(10);
    });
    it("两个 hunk 之间行号独立计数", () => {
      const h1 = parsed[0]!.hunks[0]!;
      const h2 = parsed[0]!.hunks[1]!;
      expect(h1.lines[0]!.oldLineNo).toBe(1);
      expect(h2.lines[0]!.oldLineNo).toBe(10);
    });
  });

  describe("非标准输入：缺 'diff --git' 头", () => {
    it("仍能解析裸 hunk —— 兜底成单个匿名文件", () => {
      const parsed = parseUnifiedDiff("@@ -1,2 +1,2 @@\n line1\n-old\n+new\n line2\n");
      expect(parsed).toHaveLength(1);
      expect(parsed[0]!.path).toBe("");
      expect(parsed[0]!.hunks).toHaveLength(1);
      expect(parsed[0]!.hunks[0]!.lines).toHaveLength(4);
    });
  });
});
