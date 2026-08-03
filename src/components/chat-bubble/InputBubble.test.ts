import { describe, expect, it } from "vitest";
import { resolveLaunchMessage } from "../../lib/chatLaunch";

describe("resolveLaunchMessage", () => {
  it("allows an attachment-only message without inventing visible user text", () => {
    const message = resolveLaunchMessage("   ", 1);

    expect(message?.visibleText).toBe("");
    expect(message?.agentInput).toContain("attached files");
  });

  it("rejects an empty message without attachments", () => {
    expect(resolveLaunchMessage("   ", 0)).toBeNull();
  });

  it("uses the user's text for both the bubble and the agent", () => {
    expect(resolveLaunchMessage("  inspect this  ", 1)).toEqual({
      visibleText: "inspect this",
      agentInput: "inspect this",
    });
  });
});
