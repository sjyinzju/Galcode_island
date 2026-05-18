// communityClient 单测：mock fetch + useSettingsStore + useDeviceIdStore。
//
// 重点验证：
//   - isCommunityEnabled() 跟 communityBaseUrl 是否非空挂钩
//   - 自动带 X-Device-Id 头 + form-data deviceId
//   - listImages query 拼接（cursor / exclude / pageSize 缺省）
//   - HTTP 非 2xx 抛 CommunityError 且字段对齐 server 错误体
//   - 网络异常包成 CommunityError(code='network')

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  if (typeof globalThis.localStorage === "undefined") {
    const mem = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => void mem.set(k, v),
        removeItem: (k: string) => void mem.delete(k),
        clear: () => mem.clear(),
        key: (i: number) => Array.from(mem.keys())[i] ?? null,
        get length() {
          return mem.size;
        },
      },
    });
  }
});

beforeEach(() => {
  globalThis.localStorage?.clear();
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function setup() {
  // 注意：communityBaseUrl 已硬编码在 communityConfig，不再从 settings 读；
  // 这里仅准备 deviceId。
  const deviceMod = await import("../stores/useDeviceIdStore");
  const knownId = "test-device-abcd1234";
  deviceMod.useDeviceIdStore.setState({ deviceId: knownId });
  const clientMod = await import("./communityClient");
  const cfgMod = await import("./communityConfig");
  return { ...clientMod, deviceId: knownId, hardcodedBaseUrl: cfgMod.COMMUNITY_BASE_URL };
}

type FetchArgs = Parameters<typeof fetch>;
function mockFetchOnce(response: { status: number; body: unknown }) {
  const fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>(
    async (..._args: FetchArgs) => {
      return new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("communityBaseUrl 硬编码", () => {
  it("isCommunityEnabled() 始终为 true（地址已硬编码）", async () => {
    const { isCommunityEnabled } = await setup();
    expect(isCommunityEnabled()).toBe(true);
  });
  it("getCommunityBaseUrl 返回硬编码常量，末尾斜杠剥掉", async () => {
    const { getCommunityBaseUrl, hardcodedBaseUrl } = await setup();
    expect(getCommunityBaseUrl()).toBe(hardcodedBaseUrl.replace(/\/+$/, ""));
  });
});

describe("listImages", () => {
  it("调用首页：URL 以硬编码 baseUrl 开头，含 category", async () => {
    const { listImages, hardcodedBaseUrl } = await setup();
    const fetchMock = mockFetchOnce({
      status: 200,
      body: { topHot: [], timeline: [], nextCursor: null, topHotIds: [] },
    });
    await listImages({ category: "thinking" });
    const callUrl = String(fetchMock.mock.calls[0]![0]);
    expect(callUrl.startsWith(hardcodedBaseUrl.replace(/\/+$/, ""))).toBe(true);
    expect(callUrl).toContain("/api/images");
    expect(callUrl).toContain("category=thinking");
    expect(callUrl).not.toContain("cursor=");
    expect(callUrl).not.toContain("exclude=");
  });

  it("翻页：cursor + exclude 都拼到 query 上", async () => {
    const { listImages } = await setup();
    const fetchMock = mockFetchOnce({
      status: 200,
      body: { topHot: [], timeline: [], nextCursor: null, topHotIds: [] },
    });
    await listImages({
      category: "welcome",
      cursor: "abc123",
      pageSize: 30,
      excludeIds: ["id1", "id2"],
    });
    const callUrl = String(fetchMock.mock.calls[0]![0]);
    expect(callUrl).toContain("cursor=abc123");
    expect(callUrl).toContain("exclude=id1%2Cid2"); // "," 被 URLSearchParams 转义
    expect(callUrl).toContain("pageSize=30");
  });

  it("自动带 X-Device-Id 头", async () => {
    const { listImages, deviceId } = await setup();
    const fetchMock = mockFetchOnce({
      status: 200,
      body: { topHot: [], timeline: [], nextCursor: null, topHotIds: [] },
    });
    await listImages({ category: "welcome" });
    const init = fetchMock.mock.calls[0]![1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-Device-Id"]).toBe(deviceId);
  });
});

describe("recordImageUse / reportImage / setImageVisibility", () => {
  it("recordImageUse 发 POST 带 deviceId", async () => {
    const { recordImageUse, deviceId } = await setup();
    const fetchMock = mockFetchOnce({
      status: 200,
      body: { useCount: 1, counted: true },
    });
    await recordImageUse("img-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/images/img-1/use");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ deviceId });
  });

  it("setImageVisibility 用 PATCH + JSON body", async () => {
    const { setImageVisibility, deviceId } = await setup();
    const fetchMock = mockFetchOnce({
      status: 200,
      body: { status: "hidden_by_owner" },
    });
    await setImageVisibility("img-2", true);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init!.body as string)).toEqual({ deviceId, hidden: true });
  });
});

describe("错误处理", () => {
  it("HTTP 400 + 服务端 validation 体 → CommunityError 带 code/message/field", async () => {
    const { listImages } = await setup();
    mockFetchOnce({
      status: 400,
      body: { error: "validation", message: "invalid category", field: "category" },
    });
    const { CommunityError } = await import("../types/community");
    try {
      await listImages({ category: "welcome" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CommunityError);
      const err = e as InstanceType<typeof CommunityError>;
      expect(err.code).toBe("validation");
      expect(err.status).toBe(400);
      expect(err.field).toBe("category");
      expect(err.message).toBe("invalid category");
    }
  });

  it("HTTP 429 → code='rate_limited'", async () => {
    const { recordImageUse } = await setup();
    mockFetchOnce({
      status: 429,
      body: { error: "rate_limited", scope: "write" },
    });
    const { CommunityError } = await import("../types/community");
    try {
      await recordImageUse("img");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as InstanceType<typeof CommunityError>).code).toBe("rate_limited");
    }
  });

  it("网络抛错 → code='network'", async () => {
    const { listImages } = await setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const { CommunityError } = await import("../types/community");
    try {
      await listImages({ category: "welcome" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as InstanceType<typeof CommunityError>).code).toBe("network");
    }
  });
});

describe("分页 + 点赞 API（需求 3）", () => {
  it("listImagesPaged 默认 sort=popular，URL 含分页参数", async () => {
    const { listImagesPaged } = await setup();
    const fetchMock = mockFetchOnce({
      status: 200,
      body: { items: [], page: 1, pageSize: 24, total: 0, totalPages: 1, sort: "popular" },
    });
    await listImagesPaged({ category: "welcome", page: 2, pageSize: 12 });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("category=welcome");
    expect(url).toContain("sort=popular");
    expect(url).toContain("page=2");
    expect(url).toContain("pageSize=12");
  });

  it("listImagesPaged sort=time 透传", async () => {
    const { listImagesPaged } = await setup();
    const fetchMock = mockFetchOnce({
      status: 200,
      body: { items: [], page: 1, pageSize: 24, total: 0, totalPages: 1, sort: "time" },
    });
    await listImagesPaged({ category: "thinking", sort: "time" });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("sort=time");
  });

  it("listAlbumsPaged 走 /api/albums", async () => {
    const { listAlbumsPaged } = await setup();
    const fetchMock = mockFetchOnce({
      status: 200,
      body: { items: [], page: 1, pageSize: 24, total: 0, totalPages: 1, sort: "popular" },
    });
    await listAlbumsPaged({ sort: "time", page: 3 });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("/api/albums?");
    expect(url).toContain("sort=time");
    expect(url).toContain("page=3");
  });

  it("likeImage 发 POST 带 deviceId", async () => {
    const { likeImage, deviceId } = await setup();
    const fetchMock = mockFetchOnce({
      status: 200,
      body: { likes: 5, dailyRemaining: 6 },
    });
    const result = await likeImage("img-x");
    expect(result.likes).toBe(5);
    expect(result.dailyRemaining).toBe(6);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/images/img-x/like");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ deviceId });
  });

  it("likeAlbum 发 POST 带 deviceId", async () => {
    const { likeAlbum, deviceId } = await setup();
    const fetchMock = mockFetchOnce({
      status: 200,
      body: { likes: 1, dailyRemaining: 9 },
    });
    await likeAlbum("alb-y");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/albums/alb-y/like");
    expect(JSON.parse(init!.body as string)).toEqual({ deviceId });
  });

  it("likeImage 在 429 时抛 CommunityError(code=daily_limit)", async () => {
    const { likeImage } = await setup();
    mockFetchOnce({
      status: 429,
      body: { error: "daily_limit", dailyRemaining: 0 },
    });
    const { CommunityError } = await import("../types/community");
    try {
      await likeImage("img-q");
      throw new Error("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CommunityError);
      expect((e as InstanceType<typeof CommunityError>).code).toBe("daily_limit");
    }
  });
});

describe("图集 API", () => {
  it("createAlbum 发 POST /api/albums，带 name/description/imageIds/deviceId", async () => {
    const { createAlbum, deviceId } = await setup();
    const fetchMock = mockFetchOnce({
      status: 201,
      body: {
        album: {
          id: "a1",
          deviceId,
          name: "套1",
          description: "desc",
          uploaderName: null,
          status: "active",
          imageCount: 2,
          createdAt: 1,
          updatedAt: 1,
        },
      },
    });
    const result = await createAlbum({
      name: "套1",
      description: "desc",
      imageIds: ["i1", "i2"],
    });
    expect(result.album.id).toBe("a1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/albums");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init!.body as string);
    expect(body).toEqual({
      deviceId,
      name: "套1",
      description: "desc",
      persona: "",
      imageIds: ["i1", "i2"],
      uploaderName: null,
    });
  });

  it("getAlbum 发 GET /api/albums/:id", async () => {
    const { getAlbum } = await setup();
    const fetchMock = mockFetchOnce({
      status: 200,
      body: {
        album: {
          id: "a1",
          deviceId: "x",
          name: "套1",
          description: null,
          uploaderName: null,
          status: "active",
          imageCount: 0,
          createdAt: 1,
          updatedAt: 1,
        },
        images: [],
      },
    });
    await getAlbum("a1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/albums/a1");
    expect(init?.method).toBe("GET");
  });

  it("getAlbumsByImage 发 GET /api/albums/by-image/:id", async () => {
    const { getAlbumsByImage } = await setup();
    const fetchMock = mockFetchOnce({
      status: 200,
      body: { albums: [] },
    });
    await getAlbumsByImage("img-x");
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/albums/by-image/img-x");
  });

  it("setAlbumVisibility 发 PATCH 带 hidden + deviceId", async () => {
    const { setAlbumVisibility, deviceId } = await setup();
    const fetchMock = mockFetchOnce({
      status: 200,
      body: { status: "hidden_by_owner" },
    });
    await setAlbumVisibility("a1", true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/albums/a1/visibility");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init!.body as string)).toEqual({ deviceId, hidden: true });
  });
});

describe("uploadImage", () => {
  it("multipart form 包含 file/category/deviceId/prompt", async () => {
    const { uploadImage, deviceId } = await setup();
    const fetchMock = mockFetchOnce({
      status: 201,
      body: {
        duplicate: false,
        image: {
          id: "x",
          deviceId,
          category: "thinking",
          mime: "image/png",
          sizeBytes: 10,
          width: null,
          height: null,
          prompt: "温柔风",
          uploaderName: null,
          status: "approved",
          useCount: 0,
          createdAt: 1,
          updatedAt: 1,
          url: "https://example.com/uploads/abc.png",
        },
      },
    });
    const file = new File([new Uint8Array([1, 2, 3, 4])], "x.png", { type: "image/png" });
    const result = await uploadImage({
      file,
      category: "thinking",
      prompt: "温柔风",
    });
    expect(result.duplicate).toBe(false);
    expect(result.image.id).toBe("x");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    // body 现在是手动拼接的 multipart 二进制 ArrayBuffer（绕 plugin-http FormData bug）；
    // 验证它是 ArrayBuffer / Uint8Array 之类的 BufferSource，而非 FormData
    expect(init?.body).toBeInstanceOf(ArrayBuffer);
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-Device-Id"]).toBe(deviceId);
    // Content-Type 由我们自己显式设置，含 boundary
    expect(headers["Content-Type"]).toMatch(/^multipart\/form-data; boundary=/);
    // 反序列化 body 字节流确认 text 字段 + file 都正确写入
    const text = new TextDecoder().decode(new Uint8Array(init!.body as ArrayBuffer));
    expect(text).toContain('name="category"');
    expect(text).toContain("thinking");
    expect(text).toContain('name="deviceId"');
    expect(text).toContain(deviceId);
    // 中文 prompt 用 percent-encode 进 multipart text 部分（字段值原样，不 encode）
    expect(text).toContain("温柔风");
    // file 部分
    expect(text).toContain('name="file"');
    expect(text).toContain('filename="x.png"');
    expect(text).toContain("Content-Type: image/png");
  });
});

describe("buildMultipartBody (单元)", () => {
  it("拼接的 body 含 boundary 头尾 + 各字段 + 文件字节", async () => {
    const { buildMultipartBody } = await setup();
    const fileBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const { body, contentType } = buildMultipartBody(
      { foo: "bar", greet: "你好" },
      { fieldName: "file", fileName: "img.png", contentType: "image/png", data: fileBytes },
    );
    expect(contentType).toMatch(/^multipart\/form-data; boundary=----galcode-/);
    const boundary = contentType.split("boundary=")[1]!;
    const text = new TextDecoder().decode(body);
    // 头部以 boundary 开始
    expect(text.startsWith(`--${boundary}`)).toBe(true);
    // 尾部以 boundary-- 结束
    expect(text.endsWith(`--${boundary}--\r\n`)).toBe(true);
    expect(text).toContain('name="foo"');
    expect(text).toContain("bar");
    expect(text).toContain('name="greet"');
    expect(text).toContain("你好");
    expect(text).toContain('filename="img.png"');
    // 文件字节段：找到 0xDE 0xAD 0xBE 0xEF 出现在 body 中
    let found = false;
    for (let i = 0; i < body.length - 3; i += 1) {
      if (
        body[i] === 0xde &&
        body[i + 1] === 0xad &&
        body[i + 2] === 0xbe &&
        body[i + 3] === 0xef
      ) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it("filename 含非 ASCII → percent-encode（防止 multer 解析失败）", async () => {
    const { buildMultipartBody } = await setup();
    const { body } = buildMultipartBody(
      {},
      { fieldName: "file", fileName: "中文.png", contentType: "image/png", data: new Uint8Array([1]) },
    );
    const text = new TextDecoder().decode(body);
    // "中" UTF-8 是 E4 B8 AD → percent-encoded "%E4%B8%AD"
    expect(text).toContain("%E4%B8%AD");
    // 不应出现原始中文（已经被 encodeMultipartName 转码）
    expect(text).not.toContain("中文.png");
  });
});
