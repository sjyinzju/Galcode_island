import { describe, expect, it } from "vitest";
import {
  ValidationError,
  clampPageSize,
  validateCategory,
  validateDeviceId,
  validatePromptOptional,
  validateUpload,
  validateUploaderNameOptional,
} from "../src/lib/validate.js";

describe("validateCategory", () => {
  it.each(["welcome", "thinking", "waiting", "complete", "error", "others"])(
    "accepts %s",
    (cat) => {
      expect(validateCategory(cat)).toBe(cat);
    },
  );
  it("rejects unknown", () => {
    expect(() => validateCategory("foo")).toThrow(ValidationError);
    expect(() => validateCategory("")).toThrow(ValidationError);
    expect(() => validateCategory(null)).toThrow(ValidationError);
    expect(() => validateCategory(123)).toThrow(ValidationError);
  });
});

describe("validateDeviceId", () => {
  it("accepts uuid v4", () => {
    expect(validateDeviceId("f8c2f8a1-0c7e-4b6a-9b94-2a1bb3a39f12")).toBeTruthy();
  });
  it("accepts custom 8+ char ascii", () => {
    expect(validateDeviceId("abcd1234")).toBeTruthy();
    expect(validateDeviceId("dev_abc-123:foo.bar")).toBeTruthy();
  });
  it("rejects too short / illegal chars / non-string", () => {
    expect(() => validateDeviceId("short")).toThrow(ValidationError);
    expect(() => validateDeviceId("has space 123")).toThrow(ValidationError);
    expect(() => validateDeviceId("中文中文中文中文")).toThrow(ValidationError);
    expect(() => validateDeviceId(null)).toThrow(ValidationError);
    expect(() => validateDeviceId(undefined)).toThrow(ValidationError);
  });
});

describe("validatePromptOptional", () => {
  it("empty / null / undefined → null", () => {
    expect(validatePromptOptional(undefined)).toBeNull();
    expect(validatePromptOptional(null)).toBeNull();
    expect(validatePromptOptional("")).toBeNull();
    expect(validatePromptOptional("   ")).toBeNull();
  });
  it("trims whitespace", () => {
    expect(validatePromptOptional("  hello  ")).toBe("hello");
  });
  it("rejects too long", () => {
    expect(() => validatePromptOptional("a".repeat(2001))).toThrow(ValidationError);
  });
  it("rejects non-string", () => {
    expect(() => validatePromptOptional(123)).toThrow(ValidationError);
  });
});

describe("validateUploaderNameOptional", () => {
  it("empty / null → null", () => {
    expect(validateUploaderNameOptional("")).toBeNull();
    expect(validateUploaderNameOptional(null)).toBeNull();
  });
  it("rejects > 40 chars", () => {
    expect(() => validateUploaderNameOptional("a".repeat(41))).toThrow(
      ValidationError,
    );
  });
});

describe("validateUpload", () => {
  it("requires file", () => {
    expect(() => validateUpload(null)).toThrow(/file is required/);
    expect(() => validateUpload(undefined)).toThrow(/file is required/);
  });
  it("accepts allowed mimes and maps to ext", () => {
    expect(validateUpload({ mimetype: "image/gif", size: 100 })).toEqual({
      ext: "gif",
    });
    expect(validateUpload({ mimetype: "image/png", size: 100 })).toEqual({
      ext: "png",
    });
    expect(validateUpload({ mimetype: "image/jpeg", size: 100 })).toEqual({
      ext: "jpg",
    });
    expect(validateUpload({ mimetype: "image/webp", size: 100 })).toEqual({
      ext: "webp",
    });
    expect(validateUpload({ mimetype: "image/apng", size: 100 })).toEqual({
      ext: "apng",
    });
  });
  it("rejects disallowed mimes", () => {
    expect(() =>
      validateUpload({ mimetype: "image/svg+xml", size: 100 }),
    ).toThrow(/unsupported mime/);
    expect(() =>
      validateUpload({ mimetype: "application/pdf", size: 100 }),
    ).toThrow(/unsupported mime/);
  });
  it("rejects empty file", () => {
    expect(() => validateUpload({ mimetype: "image/png", size: 0 })).toThrow(
      /empty file/,
    );
  });
  it("rejects oversize file (default 8MB)", () => {
    expect(() =>
      validateUpload({ mimetype: "image/png", size: 9 * 1024 * 1024 }),
    ).toThrow(/file too large/);
  });
});

describe("clampPageSize", () => {
  it("returns default for missing / non-numeric", () => {
    expect(clampPageSize(undefined)).toBeGreaterThan(0);
    expect(clampPageSize("abc")).toBeGreaterThan(0);
    expect(clampPageSize("-3")).toBeGreaterThan(0);
  });
  it("clamps over max", () => {
    expect(clampPageSize("9999")).toBeLessThanOrEqual(60);
  });
  it("accepts in-range string", () => {
    expect(clampPageSize("12")).toBe(12);
  });
});
