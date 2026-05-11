// 按文件路径推断 shiki 语言标签。
//
// shiki 用语言名（如 "typescript" / "rust" / "python"）作 key 加载语言。
// 这里把常见的扩展名 / 文件名映射到对应的 shiki lang id。
//
// 找不到匹配 → 返回 "text"（shiki 内置的"无高亮"语言，永远可加载）。

const EXT_MAP: Record<string, string> = {
  // Web
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  vue: "vue",
  svelte: "svelte",
  // 样式 / 标记
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  md: "markdown",
  mdx: "mdx",
  // 数据
  json: "json",
  jsonc: "jsonc",
  json5: "json5",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  // 编译语言
  rs: "rust",
  go: "go",
  py: "python",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  fs: "fsharp",
  rb: "ruby",
  php: "php",
  pl: "perl",
  lua: "lua",
  // Shell / 配置
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  ps1: "powershell",
  // DB
  sql: "sql",
  // 文档 / 构建
  dockerfile: "docker",
  makefile: "makefile",
};

const FILENAME_MAP: Record<string, string> = {
  Dockerfile: "docker",
  Makefile: "makefile",
  ".gitignore": "ignore",
  ".dockerignore": "ignore",
};

export function inferLang(path: string): string {
  if (!path) return "text";
  // 取 basename
  const slashIdx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const basename = slashIdx >= 0 ? path.slice(slashIdx + 1) : path;

  // 优先按完整 basename 匹配（Dockerfile / Makefile 等无扩展名特殊文件）
  if (FILENAME_MAP[basename]) return FILENAME_MAP[basename];

  // 再按扩展名（小写）匹配
  const dotIdx = basename.lastIndexOf(".");
  if (dotIdx <= 0) return "text"; // 无扩展名或仅以 . 开头（如 .gitignore 走 FILENAME_MAP）
  const ext = basename.slice(dotIdx + 1).toLowerCase();
  return EXT_MAP[ext] ?? "text";
}
