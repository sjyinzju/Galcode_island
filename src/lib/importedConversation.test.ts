import { describe, expect, it } from "vitest";
import type {
  ImportedConversation,
  ImportedTranscriptMessage,
} from "../types/externalHistory";
import {
  buildImportedFallbackContext,
  dedupeImportedConversationMessages,
  formatImportedValuePreview,
  importedConversationToTabInit,
  mergeImportedConversationTimeline,
} from "./importedConversation";
import { buildMessageJumps } from "../components/status-monitor/messageJumps";

function makeConversation(
  overrides: Partial<ImportedConversation> = {},
): ImportedConversation {
  return {
    id: "external:codex:thread-123",
    source: "codex",
    nativeSessionId: "thread-123",
    title: "Imported task",
    projectPath: "C:\\work\\galcode",
    createdAt: 100,
    updatedAt: 200,
    importedAt: 300,
    messageCount: 2,
    messages: [
      {
        id: "user-1",
        role: "user",
        content: "Fix the login flow",
        timestamp: 100,
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "The login flow is fixed.",
        timestamp: 200,
      },
    ],
    ...overrides,
  };
}

describe("importedConversationToTabInit", () => {
  it("bounds preview traversal as well as output length", () => {
    let indexedReads = 0;
    const values = new Proxy(Array.from({ length: 10_000 }, () => ({})), {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) indexedReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const hugeKey = "k".repeat(50_000);

    const preview = formatImportedValuePreview({ [hugeKey]: values });

    expect(preview.length).toBeLessThanOrEqual(4_003);
    expect(indexedReads).toBeLessThanOrEqual(64);
  });

  it("creates an idle Codex tab that resumes the imported native session", () => {
    const result = importedConversationToTabInit(makeConversation());

    expect(result).toMatchObject({
      title: "Imported task",
      agent: "codex",
      projectPath: "C:\\work\\galcode",
      agentNativeSessionId: "thread-123",
      lastUserPrompt: "Fix the login flow",
    });
    expect(result.cliBlocks).toMatchObject([
      { type: "user-prompt", content: "Fix the login flow" },
      { type: "text", content: "The login flow is fixed." },
    ]);
  });

  it("maps Claude rich transcript parts into visible blocks in source order", () => {
    const conversation = makeConversation({
      id: "external:claude-code:session-456",
      source: "claude-code",
      nativeSessionId: "session-456",
      messages: [
        {
          id: "user-rich",
          role: "user",
          content: "Inspect this diagram",
          timestamp: 100,
          parts: [
            { type: "text", text: "Inspect this diagram" },
            { type: "image", dataUrl: "data:image/png;base64,abc", alt: "architecture" },
          ],
        },
        {
          id: "assistant-rich",
          role: "assistant",
          content: "Inspection complete",
          timestamp: 200,
          parts: [
            { type: "thinking", text: "Tracing dependencies" },
            { type: "toolCall", toolCallId: "call-1", name: "Read", input: { path: "src/app.ts" } },
            { type: "toolResult", toolCallId: "call-1", output: "file contents", isError: false },
            { type: "event", kind: "turn.complete", data: { ok: true } },
            { type: "text", text: "Inspection complete" },
          ],
        },
      ],
    });

    const result = importedConversationToTabInit(conversation);

    expect(result.agent).toBe("claude-code");
    expect(result.agentNativeSessionId).toBe("session-456");
    expect(result.cliBlocks.map((block) => block.type)).toEqual([
      "user-prompt",
      "thought",
      "tool",
      "tool",
      "status",
      "text",
    ]);
    expect(result.cliBlocks).toMatchObject([
      {
        type: "user-prompt",
        content: "Inspect this diagram",
        images: [
          { dataUrl: "data:image/png;base64,abc", alt: "architecture" },
        ],
      },
      { content: "Tracing dependencies" },
      { tool: "Read", detail: '{\n  "path": "src/app.ts"\n}', status: "completed" },
      { tool: "Tool result", detail: "file contents", status: "completed" },
      { message: 'turn.complete: {\n  "ok": true\n}', collapsedLabel: "turn.complete" },
      { content: "Inspection complete" },
    ]);
    expect(result.cliBlocks.filter((block) => block.type === "user-prompt")).toHaveLength(1);
  });

  it.each([
    ["signature JSON", '{"signature":"ErgbCokBCA8YAipApWmJdlES3BFg"}'],
    ["prefixed signature JSON", 'thinking: {"signature":"ErgbCokBCA8YAipApWmJdlES3BFg"}'],
  ])("collapses undecodable %s thinking into a short label", (_label, thinking) => {
    const result = importedConversationToTabInit(makeConversation({
      messages: [
        {
          id: "assistant-thinking",
          role: "assistant",
          content: thinking,
          timestamp: 100,
          parts: [{ type: "thinking", text: thinking }],
        },
      ],
    }));

    expect(result.cliBlocks).toMatchObject([
      { type: "thought", content: "Thinking" },
    ]);
    expect(result.cliBlocks.map((block) => block.content ?? "").join("\n"))
      .not.toContain("signature");
  });

  it("keeps readable thinking text even when the payload also has a signature", () => {
    const thinking = JSON.stringify({
      thinking: "Check the state transition first.",
      signature: "opaque-signature",
    });
    const result = importedConversationToTabInit(makeConversation({
      messages: [{
        id: "assistant-readable-signed-thinking",
        role: "assistant",
        content: thinking,
        timestamp: 100,
        parts: [{ type: "thinking", text: thinking }],
      }],
    }));

    expect(result.cliBlocks).toMatchObject([{
      type: "thought",
      content: "Check the state transition first.",
    }]);
  });

  it("collapses persisted opaque thinking events without serializing their signature", () => {
    const result = importedConversationToTabInit(makeConversation({
      messages: [
        {
          id: "assistant-thinking-event",
          role: "assistant",
          content: "[thinking]",
          timestamp: 100,
          parts: [{
            type: "event",
            kind: "thinking",
            data: { type: "thinking", thinking: "", signature: "opaque-signature" },
          }],
        },
      ],
    }));

    expect(result.cliBlocks).toMatchObject([{
      id: "imported-external:codex:thread-123-assistant-thinking-event-0",
      type: "thought",
      content: "Thinking",
    }]);
  });

  it("keeps readable reasoning events instead of collapsing them", () => {
    const result = importedConversationToTabInit(makeConversation({
      messages: [{
        id: "assistant-readable-thinking",
        role: "assistant",
        content: "[reasoning]",
        timestamp: 100,
        parts: [{
          type: "event",
          kind: "reasoning",
          data: { reasoning: "Compare the two implementations first." },
        }],
      }],
    }));

    expect(result.cliBlocks).toMatchObject([{
      type: "thought",
      content: "Compare the two implementations first.",
    }]);
  });

  it("preserves source role, timestamp, message, and turn metadata", () => {
    const result = importedConversationToTabInit(makeConversation({
      messages: [
        {
          id: "system-1",
          role: "system",
          content: "Follow repository policy",
          timestamp: 90,
        },
        {
          id: "user-1",
          role: "user",
          content: "Fix the login flow",
          timestamp: 100,
        },
        {
          id: "developer-1",
          role: "developer",
          content: "Use the existing auth client",
          timestamp: 110,
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "Done",
          timestamp: 120,
        },
      ],
    }));

    expect(result.cliBlocks).toMatchObject([
      {
        type: "status",
        collapsedLabel: "内部上下文",
        sourceRole: "system",
        sourceMessageId: "system-1",
        sourceTimestamp: 90,
        sourceTurnId: "external:codex:thread-123:turn:0",
      },
      {
        type: "user-prompt",
        sourceRole: "user",
        sourceMessageId: "user-1",
        sourceTimestamp: 100,
        sourceTurnId: "external:codex:thread-123:turn:1",
      },
      {
        type: "status",
        collapsedLabel: "内部上下文",
        sourceRole: "developer",
        sourceMessageId: "developer-1",
        sourceTimestamp: 110,
        sourceTurnId: "external:codex:thread-123:turn:1",
      },
      {
        type: "text",
        sourceRole: "assistant",
        sourceMessageId: "assistant-1",
        sourceTimestamp: 120,
        sourceTurnId: "external:codex:thread-123:turn:1",
      },
    ]);
    expect(result.cliBlocks.filter((block) => block.type === "user-prompt")).toHaveLength(1);
  });

  it("folds legacy assistant API errors without hiding ordinary replies", () => {
    const result = importedConversationToTabInit(makeConversation({
      messages: [{
        id: "api-error",
        role: "assistant",
        content: "API Error: overloaded_error with a very long payload",
        timestamp: 100,
      }, {
        id: "ordinary-reply",
        role: "assistant",
        content: "The request completed normally.",
        timestamp: 200,
      }],
    }));

    expect(result.cliBlocks).toMatchObject([{
      type: "text",
      content: "API Error: overloaded_error with a very long payload",
      collapsedLabel: "API 错误",
    }, {
      type: "text",
      content: "The request completed normally.",
    }]);
    expect(result.cliBlocks[1]).not.toHaveProperty("collapsedLabel");
  });

  it("folds explicitly classified API errors and excludes them from resume context", () => {
    const result = importedConversationToTabInit(makeConversation({
      messages: [{
        id: "api-error",
        role: "assistant",
        isApiError: true,
        content: "Request failed after all retries",
        timestamp: 100,
      }, {
        id: "ordinary-reply",
        role: "assistant",
        content: "The request completed normally.",
        timestamp: 200,
      }],
    }));

    expect(result.cliBlocks[0]).toMatchObject({
      type: "text",
      collapsedLabel: "API 错误",
      isApiError: true,
    });
    const context = buildImportedFallbackContext(result.cliBlocks, 1_000);
    expect(context).not.toContain("Request failed after all retries");
    expect(context).toContain("The request completed normally.");
  });

  it("preserves equal non-user messages when their stable source ids differ", () => {
    const result = importedConversationToTabInit(makeConversation({
      messages: [{
        id: "context-1",
        role: "system",
        isUserPrompt: false,
        sourceTurnId: "turn-a",
        content: "Repeated internal policy",
        timestamp: 100,
      }, {
        id: "context-2",
        role: "system",
        isUserPrompt: false,
        sourceTurnId: "turn-a",
        content: "Repeated internal policy",
        timestamp: 110,
      }, {
        id: "answer-1",
        role: "assistant",
        isUserPrompt: false,
        sourceTurnId: "turn-a",
        content: "Done",
        timestamp: 120,
      }, {
        id: "answer-2",
        role: "assistant",
        isUserPrompt: false,
        sourceTurnId: "turn-a",
        content: "Done",
        timestamp: 130,
      }, {
        id: "answer-check-state",
        role: "assistant",
        isUserPrompt: false,
        sourceTurnId: "turn-a",
        content: "Check state",
        timestamp: 135,
      }, {
        id: "thinking-1",
        role: "assistant",
        isUserPrompt: false,
        sourceTurnId: "turn-a",
        content: "Check state",
        parts: [{ type: "thinking", text: "Check state" }],
        timestamp: 140,
      }, {
        id: "thinking-2",
        role: "assistant",
        isUserPrompt: false,
        sourceTurnId: "turn-a",
        content: "Check state",
        parts: [{ type: "thinking", text: "Check state" }],
        timestamp: 150,
      }, {
        id: "tool-1",
        role: "assistant",
        isUserPrompt: false,
        sourceTurnId: "turn-a",
        content: "[Tool call: Read]",
        parts: [{ type: "toolCall", toolCallId: "call-1", name: "Read", input: { path: "a" } }],
        timestamp: 160,
      }, {
        id: "tool-2",
        role: "assistant",
        isUserPrompt: false,
        sourceTurnId: "turn-a",
        content: "[Tool call: Read]",
        parts: [{ type: "toolCall", toolCallId: "call-2", name: "Read", input: { path: "a" } }],
        timestamp: 170,
      }, {
        id: "user-repeat-1",
        role: "user",
        isUserPrompt: true,
        sourceTurnId: "turn-b",
        content: "Retry",
        timestamp: 180,
      }, {
        id: "user-repeat-2",
        role: "user",
        isUserPrompt: true,
        sourceTurnId: "turn-c",
        content: "Retry",
        timestamp: 190,
      }, {
        id: "answer-other-turn",
        role: "assistant",
        isUserPrompt: false,
        sourceTurnId: "turn-c",
        content: "Done",
        timestamp: 200,
      }],
    }));

    expect(result.cliBlocks.filter((block) => block.message === "Repeated internal policy"))
      .toHaveLength(2);
    expect(result.cliBlocks.filter((block) => block.type === "text" && block.content === "Done"))
      .toHaveLength(3);
    expect(result.cliBlocks.filter((block) => block.type === "thought" && block.content === "Check state"))
      .toHaveLength(2);
    expect(result.cliBlocks.filter((block) => block.type === "text" && block.content === "Check state"))
      .toHaveLength(1);
    expect(result.cliBlocks.filter((block) => block.type === "tool"))
      .toHaveLength(2);
    expect(result.cliBlocks.filter((block) => block.type === "user-prompt" && block.content === "Retry"))
      .toHaveLength(2);
  });

  it("drops an exactly replayed non-user source message id defensively", () => {
    const duplicate = {
      id: "same-tool-message",
      role: "assistant" as const,
      isUserPrompt: false,
      sourceTurnId: "turn-a",
      content: "[Tool call: Read]",
      parts: [{ type: "toolCall" as const, toolCallId: "call-1", name: "Read", input: { path: "a" } }],
      timestamp: 100,
    };
    const result = importedConversationToTabInit(makeConversation({
      messages: [duplicate, { ...duplicate, timestamp: 110 }],
    }));

    expect(result.cliBlocks.filter((block) => block.type === "tool")).toHaveLength(1);
  });

  it("deduplicates a replayed stable source turn without deleting legitimate repeated turns", () => {
    const result = importedConversationToTabInit(makeConversation({
      messages: [{
        id: "user-a",
        role: "user",
        isUserPrompt: true,
        sourceTurnId: "turn-a",
        content: "Retry the request",
        timestamp: 100,
      }, {
        id: "answer-a",
        role: "assistant",
        isUserPrompt: false,
        sourceTurnId: "turn-a",
        content: "Completed",
        timestamp: 110,
      }, {
        id: "user-b",
        role: "user",
        isUserPrompt: true,
        sourceTurnId: "turn-a",
        content: "Retry the request",
        timestamp: 200,
      }, {
        id: "answer-b",
        role: "assistant",
        isUserPrompt: false,
        sourceTurnId: "turn-a",
        content: "Completed",
        timestamp: 210,
      }, {
        id: "user-c",
        role: "user",
        isUserPrompt: true,
        sourceTurnId: "turn-c",
        content: "Retry the request",
        timestamp: 300,
      }, {
        id: "answer-c",
        role: "assistant",
        isUserPrompt: false,
        sourceTurnId: "turn-c",
        content: "Completed",
        timestamp: 310,
      }, {
        id: "user-d",
        role: "user",
        isUserPrompt: true,
        sourceTurnId: "turn-d",
        content: "Retry the request",
        timestamp: 400,
      }, {
        id: "answer-d",
        role: "assistant",
        isUserPrompt: false,
        sourceTurnId: "turn-d",
        content: "Completed with a different result",
        timestamp: 410,
      }],
    }));

    expect(result.cliBlocks.filter((block) =>
      block.type === "user-prompt" && block.content === "Retry the request"
    )).toHaveLength(3);
    expect(result.cliBlocks.filter((block) =>
      block.type === "text" && block.content === "Completed"
    )).toHaveLength(2);
    expect(result.cliBlocks.some((block) =>
      block.type === "text" && block.content === "Completed with a different result"
    )).toBe(true);
  });

  it("merges cumulative replay snapshots for the same stable source turn", () => {
    const result = importedConversationToTabInit(makeConversation({
      messages: [{
        id: "user-original",
        role: "user",
        isUserPrompt: true,
        sourceTurnId: "turn-a",
        content: "Build the report",
        timestamp: 100,
      }, {
        id: "answer-original",
        role: "assistant",
        isUserPrompt: false,
        sourceTurnId: "turn-a",
        content: "Started",
        timestamp: 110,
      }, {
        id: "context-original",
        role: "system",
        isUserPrompt: false,
        sourceTurnId: "context-a",
        content: "Internal context",
        timestamp: 115,
      }, {
        id: "user-replay-one",
        role: "user",
        isUserPrompt: true,
        sourceTurnId: "turn-a",
        content: "Build the report",
        timestamp: 200,
      }, {
        id: "answer-replay-one",
        role: "assistant",
        isUserPrompt: false,
        sourceTurnId: "turn-a",
        content: "Started",
        timestamp: 210,
      }, {
        id: "context-replay-one",
        role: "system",
        isUserPrompt: false,
        sourceTurnId: "context-b",
        content: "Internal context",
        timestamp: 215,
      }, {
        id: "tool-replay-one",
        role: "assistant",
        isUserPrompt: false,
        sourceTurnId: "turn-a",
        content: "[Tool call: Write]",
        parts: [{ type: "toolCall", toolCallId: "call-1", name: "Write", input: { path: "report.pdf" } }],
        timestamp: 220,
      }, {
        id: "user-replay-two",
        role: "user",
        isUserPrompt: true,
        sourceTurnId: "turn-a",
        content: "Build the report",
        timestamp: 300,
      }, {
        id: "answer-replay-two",
        role: "assistant",
        isUserPrompt: false,
        sourceTurnId: "turn-a",
        content: "Started",
        timestamp: 310,
      }, {
        id: "context-replay-two",
        role: "system",
        isUserPrompt: false,
        sourceTurnId: "context-c",
        content: "Internal context",
        timestamp: 315,
      }, {
        id: "tool-replay-two",
        role: "assistant",
        isUserPrompt: false,
        sourceTurnId: "turn-a",
        content: "[Tool call: Write]",
        parts: [{ type: "toolCall", toolCallId: "call-1", name: "Write", input: { path: "report.pdf" } }],
        timestamp: 320,
      }, {
        id: "answer-final",
        role: "assistant",
        isUserPrompt: false,
        sourceTurnId: "turn-a",
        content: "Report completed",
        timestamp: 330,
      }],
    }));

    expect(result.cliBlocks.filter((block) => block.type === "user-prompt")).toHaveLength(1);
    expect(result.cliBlocks.filter((block) => block.type === "text" && block.content === "Started"))
      .toHaveLength(1);
    expect(result.cliBlocks.filter((block) => block.type === "status" && block.message === "Internal context"))
      .toHaveLength(1);
    expect(result.cliBlocks.filter((block) => block.type === "tool")).toHaveLength(1);
    expect(result.cliBlocks.some((block) =>
      block.type === "text" && block.content === "Report completed"
    )).toBe(true);
  });

  it("preserves changed tool payloads that reuse a source message id", () => {
    const result = importedConversationToTabInit(makeConversation({
      messages: [{
        id: "same-tool-message",
        role: "assistant",
        isUserPrompt: false,
        sourceTurnId: "turn-a",
        content: "[Tool call: Read]",
        parts: [{ type: "toolCall", toolCallId: "call-1", name: "Read", input: { path: "a" } }],
        timestamp: 100,
      }, {
        id: "same-tool-message",
        role: "assistant",
        isUserPrompt: false,
        sourceTurnId: "turn-a",
        content: "[Tool call: Read]",
        parts: [{ type: "toolCall", toolCallId: "call-2", name: "Read", input: { path: "b" } }],
        timestamp: 110,
      }],
    }));

    const toolBlocks = result.cliBlocks.filter((block) => block.type === "tool");
    expect(toolBlocks).toHaveLength(2);
    expect(new Set(toolBlocks.map((block) => block.id)).size).toBe(2);
    expect(toolBlocks.every((block) => block.sourceMessageId === "same-tool-message")).toBe(true);
  });

  it("preserves equal timestamp-free messages without reliable replay evidence", () => {
    const result = importedConversationToTabInit(makeConversation({
      messages: [{
        id: "user-a",
        role: "user",
        isUserPrompt: true,
        sourceTurnId: "turn-a",
        content: "Retry",
        timestamp: 0,
      }, {
        id: "answer-a",
        role: "assistant",
        isUserPrompt: false,
        sourceTurnId: "turn-a",
        content: "Same answer",
        timestamp: 0,
      }, {
        id: "answer-b",
        role: "assistant",
        isUserPrompt: false,
        sourceTurnId: "turn-a",
        content: "Same answer",
        timestamp: 0,
      }],
    }));

    expect(result.cliBlocks.filter((block) =>
      block.type === "text" && block.content === "Same answer"
    )).toHaveLength(2);
  });

  it("deduplicates replayed tool-rich turns only when the stable turn id matches", () => {
    const toolTurn = (prefix: string, turnId: string, toolCallId: string, timestamp: number) => [{
      id: `${prefix}-user`,
      role: "user" as const,
      isUserPrompt: true,
      sourceTurnId: turnId,
      content: "Read the file",
      timestamp,
    }, {
      id: `${prefix}-call`,
      role: "assistant" as const,
      isUserPrompt: false,
      sourceTurnId: turnId,
      content: "[Tool call: Read]",
      parts: [{ type: "toolCall" as const, toolCallId, name: "Read", input: { path: "a" } }],
      timestamp: timestamp + 1,
    }, {
      id: `${prefix}-result`,
      role: "tool" as const,
      isUserPrompt: false,
      sourceTurnId: turnId,
      content: "[Tool result]",
      parts: [{ type: "toolResult" as const, toolCallId, output: "done", isError: false }],
      timestamp: timestamp + 2,
    }];
    const result = importedConversationToTabInit(makeConversation({
      messages: [
        ...toolTurn("original", "turn-a", "call-1", 100),
        ...toolTurn("replay", "turn-a", "call-1", 200),
        ...toolTurn("legitimate", "turn-b", "call-2", 300),
      ],
    }));

    expect(result.cliBlocks.filter((block) => block.type === "user-prompt")).toHaveLength(2);
    expect(result.cliBlocks.filter((block) => block.type === "tool")).toHaveLength(4);
  });

  it("bounds semantic comparisons for many variants sharing one source turn id", () => {
    let contentReads = 0;
    const trackContentReads = (message: ImportedTranscriptMessage): ImportedTranscriptMessage =>
      new Proxy(message, {
        get(target, property, receiver) {
          if (property === "content") contentReads += 1;
          return Reflect.get(target, property, receiver);
        },
      });
    const messages = Array.from({ length: 256 }, (_, index) => [
      trackContentReads({
        id: `user-${index}`,
        role: "user",
        isUserPrompt: true,
        sourceTurnId: "shared-turn-id",
        content: `Prompt ${index}`,
        timestamp: index * 2 + 1,
      }),
      trackContentReads({
        id: `answer-${index}`,
        role: "assistant",
        isUserPrompt: false,
        sourceTurnId: "shared-turn-id",
        content: "Answer",
        timestamp: index * 2 + 2,
      }),
    ]).flat();

    expect(dedupeImportedConversationMessages(messages)).toHaveLength(messages.length);
    expect(contentReads).toBeLessThan(40_000);
  });

  it("preserves repeated parts inside one source message", () => {
    const result = importedConversationToTabInit(makeConversation({
      messages: [{
        id: "assistant-with-repeated-parts",
        role: "assistant",
        isUserPrompt: false,
        sourceTurnId: "turn-a",
        content: "Repeated\n\nRepeated",
        parts: [
          { type: "text", text: "Repeated" },
          { type: "text", text: "Repeated" },
        ],
        timestamp: 100,
      }],
    }));

    expect(result.cliBlocks.filter((block) =>
      block.type === "text" && block.content === "Repeated"
    )).toHaveLength(2);
  });

  it("trusts explicit v4 user semantics and stable source turns before legacy prefixes", () => {
    const result = importedConversationToTabInit(makeConversation({
      messages: [{
        id: "context-shaped-user",
        role: "user",
        content: "<environment_context>pasted by the user</environment_context>",
        timestamp: 100,
        isUserPrompt: true,
        sourceTurnId: "source-turn-user",
      }, {
        id: "internal-shaped-user",
        role: "user",
        content: "This looks like an ordinary prompt",
        timestamp: 110,
        isUserPrompt: false,
        sourceTurnId: "source-turn-user",
      }, {
        id: "assistant-turn",
        role: "assistant",
        content: "Handled",
        timestamp: 120,
        isUserPrompt: false,
        sourceTurnId: "source-turn-user",
      }],
    }));

    expect(result.cliBlocks).toMatchObject([
      { type: "user-prompt", sourceTurnId: "source-turn-user" },
      {
        type: "status",
        sourceTurnId: "source-turn-user",
        collapsedLabel: "内部上下文",
      },
      { type: "text", sourceTurnId: "source-turn-user" },
    ]);
    expect(result.cliBlocks.filter((block) => block.type === "user-prompt")).toHaveLength(1);
  });

  it("maps imported attachments without turning internal output into a user prompt", () => {
    const result = importedConversationToTabInit(makeConversation({
      messages: [{
        id: "assistant-attachment",
        role: "assistant",
        content: "Attached report",
        timestamp: 100,
        parts: [{
          type: "attachment",
          name: "report.pdf",
          mediaType: "application/pdf",
          dataUrl: "data:application/pdf;base64,abc",
          url: null,
        }],
      }],
    }));

    expect(result.cliBlocks.find((block) => block.attachments)).toMatchObject({
      type: "image",
      attachments: [{
        name: "report.pdf",
        mediaType: "application/pdf",
        dataUrl: "data:application/pdf;base64,abc",
      }],
      sourceRole: "assistant",
    });
    expect(result.cliBlocks.every((block) => block.type !== "user-prompt")).toBe(true);
  });

  it("keeps content-addressed image and attachment ids without loading their data", () => {
    const imageAssetId = "a".repeat(64);
    const fileAssetId = "b".repeat(64);
    const result = importedConversationToTabInit(makeConversation({
      messages: [{
        id: "user-assets",
        role: "user",
        content: "Inspect these assets",
        timestamp: 100,
        parts: [
          { type: "text", text: "Inspect these assets" },
          { type: "image", dataUrl: null, assetId: imageAssetId, alt: "diagram" },
          {
            type: "attachment",
            name: "report.pdf",
            mediaType: "application/pdf",
            dataUrl: null,
            assetId: fileAssetId,
            url: null,
          },
        ],
      }],
    }));

    expect(result.cliBlocks[0]).toMatchObject({
      images: [{ assetId: imageAssetId, alt: "diagram" }],
      attachments: [{ assetId: fileAssetId, name: "report.pdf" }],
    });
    expect(result.cliBlocks[0]?.images?.[0]?.dataUrl).toBeUndefined();
    expect(result.cliBlocks[0]?.attachments?.[0]?.dataUrl).toBeUndefined();
  });

  it("keeps task notifications as internal output instead of user prompts", () => {
    const notification = [
      "<task-notification>",
      "<task-id>bbuq999l2</task-id>",
      "<status>stopped</status>",
      "<summary>No completion record was found for this background shell command.</summary>",
      "</task-notification>",
    ].join("\n");
    const result = importedConversationToTabInit(makeConversation({
      messages: [
        {
          id: "task-notification",
          role: "user",
          isUserPrompt: true,
          sourceTurnId: "incorrect-legacy-turn",
          content: notification,
          timestamp: 100,
          parts: [{ type: "text", text: notification }],
        },
      ],
    }));

    expect(result.cliBlocks).toMatchObject([{
      type: "tool",
      tool: "Task notification",
      detail: "No completion record was found for this background shell command.",
      status: "error",
      sourceRole: "system",
    }]);
    expect(buildMessageJumps(result.cliBlocks)).toEqual([]);
    expect(result.lastUserPrompt).toBeNull();
    expect(buildImportedFallbackContext(result.cliBlocks, 1_000)).not.toContain("[user]");
  });

  it("keeps legacy Claude command metadata out of user prompts and navigation", () => {
    const result = importedConversationToTabInit(makeConversation({
      source: "claude-code",
      messages: [{
        id: "command-metadata",
        role: "user",
        isUserPrompt: true,
        sourceTurnId: "incorrect-legacy-turn",
        content: [
          "<command-name>/release</command-name>",
          "<command-message>release</command-message>",
          "<command-args></command-args>",
        ].join("\n"),
        timestamp: 100,
      }],
    }));

    expect(result.cliBlocks).toMatchObject([{
      type: "status",
      collapsedLabel: "内部上下文",
      sourceRole: "system",
    }]);
    expect(buildMessageJumps(result.cliBlocks)).toEqual([]);
    expect(result.lastUserPrompt).toBeNull();
    const context = buildImportedFallbackContext(result.cliBlocks, 1_000);
    expect(context).toContain("[system] <command-name>/release</command-name>");
    expect(context).not.toContain("[user]");
  });

  it("keeps Claude tool results without creating fake user prompts", () => {
    const result = importedConversationToTabInit(makeConversation({
      source: "claude-code",
      nativeSessionId: "claude-session",
      messages: [
        {
          id: "user-prompt",
          role: "user",
          content: "Find a VPS",
          timestamp: 100,
          parts: [{ type: "text", text: "Find a VPS" }],
        },
        {
          id: "tool-result",
          role: "user",
          content: "[Tool result]",
          timestamp: 200,
          parts: [
            {
              type: "toolResult",
              toolCallId: "call-1",
              output: "Search results",
              isError: false,
            },
          ],
        },
        {
          id: "internal-context",
          role: "user",
          content: '<codex_internal_context source="goal">internal</codex_internal_context>',
          timestamp: 300,
          parts: [
            {
              type: "text",
              text: '<codex_internal_context source="goal">internal</codex_internal_context>',
            },
          ],
        },
        {
          id: "interrupted",
          role: "user",
          content: "[Request interrupted by user]",
          timestamp: 400,
          parts: [{ type: "text", text: "[Request interrupted by user]" }],
        },
      ],
    }));

    expect(result.cliBlocks).toMatchObject([
      { type: "user-prompt", content: "Find a VPS" },
      { type: "tool", tool: "Tool result", detail: "Search results" },
      { type: "status", message: '<codex_internal_context source="goal">internal</codex_internal_context>' },
      { type: "status", message: "Request interrupted by user" },
    ]);
    expect(result.cliBlocks.filter((block) => block.type === "user-prompt")).toHaveLength(1);
    expect(result.lastUserPrompt).toBe("Find a VPS");
  });

  it("keeps a bounded tool preview and defers the complete value until expansion", () => {
    const output = "x".repeat(2_000_000);
    const result = importedConversationToTabInit(makeConversation({
      messages: [{
        id: "tool-result-large",
        role: "tool",
        content: "[Tool result]",
        timestamp: 100,
        parts: [{ type: "toolResult", toolCallId: "call-1", output, isError: false }],
      }],
    }));

    expect(result.cliBlocks[0]?.detail?.length).toBeLessThanOrEqual(4_003);
    expect(result.cliBlocks[0]?.detail).toMatch(/\.\.\.$/);
    expect(result.cliBlocks[0]?.detailValue).toBe(output);
  });

  it("keeps the complete chronology for a large imported session", () => {
    const messages = Array.from({ length: 5 }, (_, turn) => [
      {
        id: `user-${turn}`,
        role: "user" as const,
        content: `Prompt ${turn}`,
        timestamp: turn * 100,
      },
      ...Array.from({ length: 60 }, (_, index) => ({
        id: `assistant-${turn}-${index}`,
        role: "assistant" as const,
        content: `Response ${turn}.${index}`,
        timestamp: turn * 100 + index + 1,
      })),
    ]).flat();

    const result = importedConversationToTabInit(makeConversation({
      messageCount: messages.length,
      messages,
    }));

    expect(result.cliBlocks).toHaveLength(305);
    expect(result.cliBlocks.slice(0, 3).map((block) => block.content)).toEqual([
      "Prompt 0",
      "Response 0.0",
      "Response 0.1",
    ]);
    expect(result.cliBlocks.filter((block) => block.type === "user-prompt").map((block) => block.content)).toEqual([
      "Prompt 0",
      "Prompt 1",
      "Prompt 2",
      "Prompt 3",
      "Prompt 4",
    ]);
    expect(result.cliBlocks.at(-1)?.content).toBe("Response 4.59");
    expect(result.lastUserPrompt).toBe("Prompt 4");
    expect(result.importedConversationId).toBe("external:codex:thread-123");
    expect(result.hasFullImportedHistory).toBe(true);
    expect(messages[0]?.content).toBe("Prompt 0");
  });

  it("refreshes a reimported baseline without duplicating a continued turn", () => {
    const initial = importedConversationToTabInit(makeConversation());
    const continuedAt = 1_000;
    const existingBlocks = [
      ...initial.cliBlocks,
      {
        id: "continued-user",
        type: "user-prompt" as const,
        content: "Add a regression test",
        sourceTimestamp: continuedAt,
      },
      {
        id: "continued-assistant",
        type: "text" as const,
        content: "Regression test added.",
      },
    ];
    const refreshed = makeConversation({
      messages: [
        ...makeConversation().messages,
        {
          id: "native-user-2",
          role: "user",
          content: "Add a regression test",
          timestamp: continuedAt + 500,
        },
        {
          id: "native-assistant-2",
          role: "assistant",
          content: "Regression test added.",
          timestamp: continuedAt + 1_000,
        },
      ],
    });

    const result = mergeImportedConversationTimeline(refreshed, existingBlocks);

    expect(result.cliBlocks.filter(
      (block) => block.type === "user-prompt" && block.content === "Add a regression test",
    )).toHaveLength(1);
    expect(result.cliBlocks.filter(
      (block) => block.type === "text" && block.content === "Regression test added.",
    )).toHaveLength(1);
    expect(result.cliBlocks.some((block) => block.id === "continued-user")).toBe(false);
  });

  it("keeps a repeated prompt when the local response differs from the imported turn", () => {
    const initial = importedConversationToTabInit(makeConversation());
    const existingBlocks = [
      ...initial.cliBlocks,
      {
        id: "local-continue-user",
        type: "user-prompt" as const,
        content: "Continue",
        sourceTimestamp: 10_000,
      },
      {
        id: "local-continue-assistant",
        type: "text" as const,
        content: "Local continuation answer",
      },
    ];
    const refreshed = makeConversation({
      messages: [
        ...makeConversation().messages,
        {
          id: "native-continue-user",
          role: "user",
          content: "Continue",
          timestamp: 10_500,
        },
        {
          id: "native-continue-assistant",
          role: "assistant",
          content: "Different native answer",
          timestamp: 11_000,
        },
      ],
    });

    const result = mergeImportedConversationTimeline(refreshed, existingBlocks);

    expect(result.cliBlocks.some((block) => block.id === "local-continue-user")).toBe(true);
    expect(result.cliBlocks.some((block) => block.id === "local-continue-assistant")).toBe(true);
  });

  it("keeps unique Galcode continuation blocks and respects imported deletion tombstones", () => {
    const initial = importedConversationToTabInit(makeConversation());
    const deletedId = initial.cliBlocks[1]!.id;
    const uniqueContinuation = {
      id: "continued-user",
      type: "user-prompt" as const,
      content: "A new local-only turn",
      sourceTimestamp: 10_000,
    };

    const result = mergeImportedConversationTimeline(
      makeConversation(),
      [...initial.cliBlocks, uniqueContinuation],
      { deletedImportedBlockIds: [deletedId] },
    );

    expect(result.cliBlocks.some((block) => block.id === deletedId)).toBe(false);
    expect(result.cliBlocks).toContainEqual(uniqueContinuation);
  });

  it("builds a bounded role-aware fallback transcript without image payloads", () => {
    const result = importedConversationToTabInit(makeConversation({
      messages: [{
        id: "user-image",
        role: "user",
        content: "Inspect this",
        timestamp: 100,
        parts: [
          { type: "text", text: "Inspect this" },
          { type: "image", dataUrl: "data:image/png;base64,secret", alt: "screen" },
        ],
      }, {
        id: "assistant-1",
        role: "assistant",
        content: "I inspected it.",
        timestamp: 200,
      }],
    }));

    const context = buildImportedFallbackContext(result.cliBlocks, 1_000);

    expect(context).toContain("[User] Inspect this");
    expect(context).toContain("[Assistant] I inspected it.");
    expect(context).toContain("[Attachment] screen");
    expect(context).not.toContain("base64");
    expect(context.length).toBeLessThanOrEqual(1_000);
  });

  it("keeps recent dialogue when trailing tool results exhaust the fallback budget", () => {
    const blocks = [
      { id: "user-old", type: "user-prompt" as const, content: "Original request" },
      { id: "assistant-old", type: "text" as const, content: "Original answer" },
      { id: "user-new", type: "user-prompt" as const, content: "What changed?" },
      { id: "assistant-new", type: "text" as const, content: "The import path is fixed." },
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `tool-${index}`,
        ...(index % 2 === 0
          ? {
              type: "status" as const,
              sourceRole: "system",
              message: `${index}:${"x".repeat(4_000)}`,
            }
          : {
              type: "tool" as const,
              tool: "Search",
              detail: `${index}:${"x".repeat(4_000)}`,
            }),
      })),
    ];

    const context = buildImportedFallbackContext(blocks, 8_000);

    expect(context).toContain("[User] What changed?");
    expect(context).toContain("[Assistant] The import path is fixed.");
    expect(context.length).toBeLessThanOrEqual(8_000);
  });
});
