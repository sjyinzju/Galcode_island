import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dialogMocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: dialogMocks.open,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

let pickFolder: typeof import("./bridge").pickFolder;

beforeAll(async () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  vi.resetModules();
  ({ pickFolder } = await import("./bridge"));
});

beforeEach(() => {
  dialogMocks.open.mockReset();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("pickFolder", () => {
  it("returns a single selected folder and forwards the dialog options", async () => {
    dialogMocks.open.mockResolvedValue("C:\\work");

    await expect(pickFolder({
      defaultPath: "C:\\projects",
      title: "选择项目目录",
    })).resolves.toBe("C:\\work");
    expect(dialogMocks.open).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      defaultPath: "C:\\projects",
      title: "选择项目目录",
    });
  });

  it("uses the first folder when the dialog returns an array", async () => {
    dialogMocks.open.mockResolvedValue(["C:\\first", "C:\\second"]);

    await expect(pickFolder()).resolves.toBe("C:\\first");
  });

  it("returns null when the dialog returns an empty array", async () => {
    dialogMocks.open.mockResolvedValue([]);

    await expect(pickFolder()).resolves.toBeNull();
  });

  it("returns null when the dialog is cancelled", async () => {
    dialogMocks.open.mockResolvedValue(null);

    await expect(pickFolder()).resolves.toBeNull();
  });
});
