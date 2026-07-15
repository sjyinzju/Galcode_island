import { describe, expect, it } from "vitest";
import { canContinueImportedConversation } from "../lib/importedConversation";
import { shouldShowConversationStatus } from "./MainView";

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
});
