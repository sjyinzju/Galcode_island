import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadImportedValue,
  IMPORTED_VALUE_PAGE_SIZE,
  PagedImportedValue,
  prepareImportedValue,
  takeImportedValuePage,
} from "./PagedImportedValue";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PagedImportedValue", () => {
  it("renders loading before touching an imported object", () => {
    let serialized = false;
    const value = {
      toJSON() {
        serialized = true;
        return { ok: true };
      },
    };

    const html = renderToStaticMarkup(<PagedImportedValue value={value} />);

    expect(serialized).toBe(false);
    expect(html).toContain('role="status"');
    expect(html).toContain("正在准备完整结果");
    expect(html).not.toContain("ok");
  });

  it("defers object formatting outside the caller stack", async () => {
    vi.useFakeTimers();
    let serialized = false;
    const pending = prepareImportedValue({
      toJSON() {
        serialized = true;
        return { ok: true };
      },
    });

    expect(serialized).toBe(false);
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toContain('"ok": true');
    expect(serialized).toBe(true);
  });

  it("keeps a top-level large string intact and pages it without a full display copy", async () => {
    vi.useFakeTimers();
    const text = `${"a".repeat(IMPORTED_VALUE_PAGE_SIZE)}😀${"b".repeat(IMPORTED_VALUE_PAGE_SIZE)}`;
    const pending = prepareImportedValue(text);
    await vi.runAllTimersAsync();
    const prepared = await pending;
    const pages: string[] = [];
    let offset = 0;
    while (offset < prepared.length) {
      const page = takeImportedValuePage(prepared, offset);
      pages.push(page.content);
      offset = page.nextOffset;
    }

    expect(prepared).toBe(text);
    expect(pages.every((page) => page.length <= IMPORTED_VALUE_PAGE_SIZE)).toBe(true);
    expect(pages.join("")).toBe(text);
    expect(pages.some((page) => page.endsWith("\ud83d"))).toBe(false);
  });

  it("can retry preparation after a transient formatter error", async () => {
    vi.useFakeTimers();
    let failing = true;
    const value = {
      toJSON() {
        if (failing) throw new Error("temporary JSON failure");
        return { recovered: true };
      },
      toString() {
        failing = false;
        throw new Error("temporary string failure");
      },
    };

    const first = prepareImportedValue(value);
    const firstResult = expect(first).rejects.toThrow("temporary string failure");
    await vi.runAllTimersAsync();
    await firstResult;

    const retry = prepareImportedValue(value);
    await vi.runAllTimersAsync();
    await expect(retry).resolves.toContain('"recovered": true');
  });

  it("defers saving and downloads the complete prepared value", async () => {
    vi.useFakeTimers();
    const click = vi.fn();
    const anchor = { href: "", download: "", rel: "", click };
    const createElement = vi.fn(() => anchor);
    const createObjectURL = vi.fn(() => "blob:imported-result");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("document", { createElement });
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });

    const pending = downloadImportedValue("complete result", "tool-result.txt");
    expect(createObjectURL).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    await pending;

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(anchor.href).toBe("blob:imported-result");
    expect(anchor.download).toBe("tool-result.txt");
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:imported-result");
  });
});
