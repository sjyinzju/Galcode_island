import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../src/lib/cursor.js";

describe("cursor encode/decode", () => {
  it("round-trips a typical (createdAt, id) tuple", () => {
    const enc = encodeCursor(1715769600000, "abc-123");
    const back = decodeCursor(enc);
    expect(back).toEqual({ createdAt: 1715769600000, id: "abc-123" });
  });

  it("handles uuid-shaped ids", () => {
    const id = "f8c2f8a1-0c7e-4b6a-9b94-2a1bb3a39f12";
    const enc = encodeCursor(1, id);
    expect(decodeCursor(enc)).toEqual({ createdAt: 1, id });
  });

  it("empty / non-string cursor → null", () => {
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(123)).toBeNull();
  });

  it("garbage base64 → null (not throw)", () => {
    expect(decodeCursor("!!!not-base64")).toBeNull();
  });

  it("base64 with wrong shape JSON → null", () => {
    const bad = Buffer.from(JSON.stringify({ foo: 1 })).toString("base64url");
    expect(decodeCursor(bad)).toBeNull();
  });

  it("base64 with wrong tuple types → null", () => {
    const bad = Buffer.from(JSON.stringify(["not a number", "id"])).toString(
      "base64url",
    );
    expect(decodeCursor(bad)).toBeNull();

    const bad2 = Buffer.from(JSON.stringify([1, 2])).toString("base64url");
    expect(decodeCursor(bad2)).toBeNull();
  });

  it("encodeCursor throws on invalid args", () => {
    expect(() => encodeCursor(NaN, "id")).toThrow();
    expect(() => encodeCursor(1, "")).toThrow();
    expect(() => encodeCursor(1, 123)).toThrow();
  });
});
