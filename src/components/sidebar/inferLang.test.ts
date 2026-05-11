import { describe, expect, it } from "vitest";
import { inferLang } from "./inferLang";

describe("inferLang", () => {
  it("空 / 未知 → text", () => {
    expect(inferLang("")).toBe("text");
    expect(inferLang("file_without_ext")).toBe("text");
    expect(inferLang("foo.unknownext")).toBe("text");
  });

  it("常见 Web 扩展名", () => {
    expect(inferLang("src/foo.ts")).toBe("typescript");
    expect(inferLang("src/foo.tsx")).toBe("tsx");
    expect(inferLang("foo.js")).toBe("javascript");
    expect(inferLang("foo.jsx")).toBe("jsx");
    expect(inferLang("foo.mjs")).toBe("javascript");
  });

  it("系统语言", () => {
    expect(inferLang("src/main.rs")).toBe("rust");
    expect(inferLang("server/main.go")).toBe("go");
    expect(inferLang("script.py")).toBe("python");
    expect(inferLang("App.java")).toBe("java");
    expect(inferLang("App.swift")).toBe("swift");
    expect(inferLang("main.cpp")).toBe("cpp");
  });

  it("样式 / 标记", () => {
    expect(inferLang("style.css")).toBe("css");
    expect(inferLang("style.scss")).toBe("scss");
    expect(inferLang("README.md")).toBe("markdown");
    expect(inferLang("page.html")).toBe("html");
  });

  it("数据 / 配置", () => {
    expect(inferLang("package.json")).toBe("json");
    expect(inferLang("tauri.conf.json")).toBe("json");
    expect(inferLang("config.yaml")).toBe("yaml");
    expect(inferLang("config.yml")).toBe("yaml");
    expect(inferLang("Cargo.toml")).toBe("toml");
  });

  it("Shell", () => {
    expect(inferLang("install.sh")).toBe("bash");
    expect(inferLang(".zshrc")).toBe("text"); // 无扩展名，未在 FILENAME_MAP
  });

  it("特殊文件名（无扩展名）", () => {
    expect(inferLang("Dockerfile")).toBe("docker");
    expect(inferLang("path/to/Dockerfile")).toBe("docker");
    expect(inferLang("Makefile")).toBe("makefile");
    expect(inferLang(".gitignore")).toBe("ignore");
  });

  it("大小写不敏感（扩展名）", () => {
    expect(inferLang("Foo.TS")).toBe("typescript");
    expect(inferLang("BAR.RS")).toBe("rust");
  });

  it("Windows 风格路径分隔符", () => {
    expect(inferLang("C:\\projects\\app\\main.ts")).toBe("typescript");
    expect(inferLang("src\\foo.rs")).toBe("rust");
  });

  it("以点开头但有扩展名的文件", () => {
    expect(inferLang(".env.ts")).toBe("typescript");
  });
});
