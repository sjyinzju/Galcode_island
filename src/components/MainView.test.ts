import { describe, expect, it } from "vitest";
import { canContinueImportedConversation } from "../lib/importedConversation";
import {
  importedHistoryControlState,
  shouldShowConversationStatus,
} from "./MainView";

describe("shouldShowConversationStatus", () => {
  it("mounts the status view while a restored imported timeline is still unloaded", () => {
    expect(shouldShowConversationStatus(
      "idle",
      "idle",
      0,
      "external:codex:restored",
      false,
    )).toBe(true);
  });

  it("keeps a normal empty tab on the project overview", () => {
    expect(shouldShowConversationStatus("idle", "idle", 0, null, false)).toBe(false);
  });

  it("keeps all conversation controls disabled until imported history is complete", () => {
    expect(canContinueImportedConversation("external:codex:restored", false)).toBe(false);
    expect(canContinueImportedConversation("external:codex:restored", true)).toBe(true);
    expect(canContinueImportedConversation(null, false)).toBe(true);
  });

  it("distinguishes a failed history restore from an in-progress load", () => {
    expect(importedHistoryControlState("external:codex:restored", false, null)).toBe("loading");
    expect(importedHistoryControlState(
      "external:codex:restored",
      false,
      "history unavailable",
    )).toBe("error");
    expect(importedHistoryControlState("external:codex:restored", true, null)).toBe("ready");
    expect(importedHistoryControlState(null, false, null)).toBe("ready");
  });
});
