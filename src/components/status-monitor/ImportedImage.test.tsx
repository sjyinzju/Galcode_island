import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ImportedImage,
  isRemoteImageSource,
  loadImportedAssetData,
  loadImportedAssetSource,
} from "./ImportedImage";

describe("ImportedImage", () => {
  it("does not request a remote image before explicit consent", () => {
    const url = "https://tracker.example/image.png";
    const html = renderToStaticMarkup(<ImportedImage source={url} alt="remote" />);

    expect(isRemoteImageSource(url)).toBe(true);
    expect(html).toContain("加载远程图片");
    expect(html).not.toContain(`<img src="${url}"`);
  });

  it("treats protocol-relative and relative sources as external", () => {
    expect(isRemoteImageSource("//tracker.example/image.png")).toBe(true);
    expect(isRemoteImageSource("/private/image.png")).toBe(true);
    expect(isRemoteImageSource("data:image/png;base64,AA==")).toBe(false);
  });

  it("renders local image data lazily with discoverable actions", () => {
    const html = renderToStaticMarkup(
      <ImportedImage source="data:image/png;base64,AA==" alt="截图" />,
    );

    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain("查看原图");
    expect(html).toContain("复制图片");
    expect(html).toContain("保存图片");
  });

  it("loads content-addressed images only through the asset command", async () => {
    const assetId = "a".repeat(64);
    const loader = async (command: string, args: unknown): Promise<string> => {
      expect(command).toBe("load_imported_asset");
      expect(args).toEqual({ assetId });
      return "data:image/png;base64,AA==";
    };

    await expect(loadImportedAssetSource(assetId, loader))
      .resolves.toBe("data:image/png;base64,AA==");
    await expect(loadImportedAssetSource("c".repeat(64), async () => "https://tracker.example/x.png"))
      .rejects.toThrow("image data");
  });

  it("caches resolved assets and limits cross-asset reads to two at a time", async () => {
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const loader = async (): Promise<string> => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return "data:application/octet-stream;base64,AA==";
    };
    const ids = ["d".repeat(64), "e".repeat(64), "f".repeat(64)];
    const pending = ids.map((id) => loadImportedAssetData(id, loader));
    await Promise.resolve();

    expect(maxActive).toBe(2);
    release();
    await Promise.all(pending);
    await loadImportedAssetData(ids[0]!, loader);

    expect(calls).toBe(3);
  });

  it("renders an asset placeholder without embedding its payload", () => {
    const html = renderToStaticMarkup(
      <ImportedImage source={null} assetId={"b".repeat(64)} alt="stored" />,
    );

    expect(html).toContain("滚动到图片附近时加载");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("<img");
  });
});
