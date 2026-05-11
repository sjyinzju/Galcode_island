// errorDiagnose 单元测试。
//
// 每条用例覆盖：
//   - 正向：典型错误 message → 期望 kind / severity / actions 数量
//   - 反向：用某一类错误的关键词写出"不应被这类抢匹配"的 message，验证另一类拿到
//
// 重点用例包括项目里已经踩坑的两个真实错误：
//   - "Failed to start Claude Code stream session: No such file or directory (os error 2)"
//   - "LLM 总结生成失败: LLM HTTP 401 Unauthorized: ... api key ... invalid"
//
// 这是"逻辑正确性"的最后一道闸——tsc 通过只代表类型对、不代表正则归因对，
// 任何后续模式增减都得让本测试通过才能算 Task 3 没回退。

import { describe, expect, it } from "vitest";
import { diagnoseError } from "./errorDiagnose";
import type { AgentType } from "../types/agent";

const C: AgentType = "claude-code";

describe("diagnoseError", () => {
  describe("PATTERN_CLI_MISSING", () => {
    it("匹配 Rust ENOENT 的 'Failed to start...No such file' 实战错误", () => {
      const d = diagnoseError(
        "Failed to start Claude Code stream session: No such file or directory (os error 2)",
        C,
      );
      expect(d.kind).toBe("cli-missing");
      expect(d.title).toContain("Claude Code");
    });
    it("匹配 'command not found'", () => {
      expect(diagnoseError("zsh: command not found: codex", C).kind).toBe("cli-missing");
    });
    it("匹配中文 '未检测到 Claude Code CLI'", () => {
      expect(diagnoseError("未检测到 Claude Code CLI。", C).kind).toBe("cli-missing");
    });
    it("匹配 Windows ENOENT (os error 3)", () => {
      expect(diagnoseError("spawn failed (os error 3)", C).kind).toBe("cli-missing");
    });
  });

  describe("PATTERN_LLM_AUTH", () => {
    it("匹配 'LLM 总结生成失败: LLM HTTP 401 ... api key ... invalid' 实战错误", () => {
      const msg =
        'LLM 总结生成失败: LLM HTTP 401 Unauthorized: {"error":{"message":"Authentication Fails, Your api key: ****2eac is invalid"}}';
      const d = diagnoseError(msg, C);
      expect(d.kind).toBe("llm-auth");
    });
    it("匹配 'LLM 翻译失败: 401'", () => {
      expect(diagnoseError("LLM 翻译失败: 401 Unauthorized", C).kind).toBe("llm-auth");
    });
    it("匹配 'api key: ****abc is invalid' 单独形态", () => {
      expect(diagnoseError("api key: ****abc is invalid", C).kind).toBe("llm-auth");
    });
    it("不抢 backend agent 自身的 '未登录 Claude Code'", () => {
      // 必须落到 PATTERN_AUTH (auth) 而不是 llm-auth
      expect(diagnoseError("未登录 Claude Code。", C).kind).toBe("auth");
    });
  });

  describe("PATTERN_AUTH (backend agent 鉴权)", () => {
    it("匹配 '未登录'", () => {
      expect(diagnoseError("未登录 Codex", C).kind).toBe("auth");
    });
    it("匹配 'unauthorized'（不含 LLM 关键字）", () => {
      expect(diagnoseError("Unauthorized: token expired", C).kind).toBe("auth");
    });
    it("匹配 401（裸）", () => {
      expect(diagnoseError("HTTP 401 from claude-code session", C).kind).toBe("auth");
    });
  });

  describe("PATTERN_QUOTA", () => {
    it("匹配 'insufficient_quota'", () => {
      expect(diagnoseError("insufficient_quota: you've exceeded your monthly limit", C).kind).toBe("quota");
    });
    it("匹配中文 '余额不足'", () => {
      expect(diagnoseError("余额不足，请充值", C).kind).toBe("quota");
    });
    it("匹配 'payment required (402)'", () => {
      expect(diagnoseError("payment required (402)", C).kind).toBe("quota");
    });
  });

  describe("PATTERN_CONCURRENT", () => {
    it("匹配中文 '仍在处理上一条请求'", () => {
      const d = diagnoseError("Claude Code 仍在处理上一条请求。", C);
      expect(d.kind).toBe("concurrent");
      expect(d.severity).toBe("warning"); // 并发是 warning，不是 error
    });
    it("匹配 'already running / in progress'", () => {
      expect(diagnoseError("session already in progress", C).kind).toBe("concurrent");
    });
  });

  describe("PATTERN_SESSION_NOT_READY", () => {
    it("匹配中文 '会话尚未就绪'", () => {
      const d = diagnoseError("Codex 会话尚未就绪。", C);
      expect(d.kind).toBe("session-not-ready");
      expect(d.severity).toBe("warning");
    });
    it("匹配 'stream not initialized'", () => {
      expect(diagnoseError("stream not initialized", C).kind).toBe("session-not-ready");
    });
  });

  describe("PATTERN_PROCESS_DIED", () => {
    it("匹配 'process exited with code 137'", () => {
      expect(diagnoseError("Claude Code process exited with code 137", C).kind).toBe("process-died");
    });
    it("匹配 'panic'", () => {
      expect(diagnoseError("panic: stack overflow", C).kind).toBe("process-died");
    });
    it("匹配中文 '异常退出'", () => {
      expect(diagnoseError("Claude Code 会话异常退出：runtime error", C).kind).toBe("process-died");
    });
  });

  describe("PATTERN_NETWORK", () => {
    it("匹配 'ECONNREFUSED'", () => {
      expect(diagnoseError("fetch failed: ECONNREFUSED 127.0.0.1:4096", C).kind).toBe("network");
    });
    it("匹配 'timeout'", () => {
      expect(diagnoseError("request timed out after 30s", C).kind).toBe("network");
    });
    it("匹配中文 '无法连接'", () => {
      expect(diagnoseError("无法连接到上游服务器", C).kind).toBe("network");
    });
  });

  describe("兜底 / 边界", () => {
    it("未识别消息走 generic 兜底", () => {
      expect(diagnoseError("xxx 一些莫名其妙的内部错误 yyy", C).kind).toBe("unknown");
    });
    it("空字符串走 empty 分支", () => {
      const d = diagnoseError("", C);
      expect(d.kind).toBe("empty");
    });
    it("仅空白字符走 empty 分支", () => {
      expect(diagnoseError("   \n  ", C).kind).toBe("empty");
    });
  });

  describe("所有归因都有合法 action 列表", () => {
    const samples: Array<[string, string]> = [
      ["cli-missing", "未检测到 Claude Code CLI。"],
      ["llm-auth", "LLM 总结生成失败: 401 api key invalid"],
      ["auth", "未登录"],
      ["quota", "insufficient_quota"],
      ["concurrent", "仍在处理上一条请求"],
      ["session-not-ready", "会话尚未就绪"],
      ["process-died", "process exited with code 1"],
      ["network", "ECONNREFUSED"],
      ["unknown", "随机内部错误"],
      ["empty", ""],
    ];
    for (const [expectedKind, msg] of samples) {
      it(`${expectedKind} 的 actions 数组非空 + 至多 3 个 + 最多 1 个 primary`, () => {
        const d = diagnoseError(msg, C);
        expect(d.kind).toBe(expectedKind);
        expect(d.actions.length).toBeGreaterThan(0);
        expect(d.actions.length).toBeLessThanOrEqual(3);
        expect(d.actions.filter((a) => a.primary).length).toBeLessThanOrEqual(1);
        // 必填字段
        expect(d.title.length).toBeGreaterThan(0);
        expect(d.detail.length).toBeGreaterThan(0);
        for (const a of d.actions) {
          expect(a.label.length).toBeGreaterThan(0);
        }
      });
    }
  });

  describe("不同 agent 类型反映在 title / actions", () => {
    it("agent=codex 时 cli-missing 标题含 'Codex'", () => {
      const d = diagnoseError("未检测到 Codex CLI", "codex");
      expect(d.kind).toBe("cli-missing");
      expect(d.title).toContain("Codex");
    });
    it("agent=opencode 时 auth 错误 actions 仍含登录按钮", () => {
      const d = diagnoseError("未登录", "opencode");
      expect(d.kind).toBe("auth");
      expect(d.actions.some((a) => a.kind === "open-backend-login")).toBe(true);
    });
  });
});
