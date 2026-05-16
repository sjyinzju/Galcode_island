// 桌宠图社区 HTTP client。
//
// 与 server/README.md API 表对齐。所有请求自动带：
//   - X-Device-Id 头（取自 useDeviceIdStore）
//   - 在 multipart 上传里同时也以 form field 形式带 deviceId（兼容 form-data 不能改 header 的客户端）
//
// baseUrl 现在硬编码在 src/lib/communityConfig.ts，不再读 settings store。
// 留下 isCommunityEnabled() / getCommunityBaseUrl() 是因为 UI 还在调；保留信号让以后
// 真要"未启用"开关时（如 LAN 离线模式）能轻易切回。
//
// fetch 路由（修复 WKWebView "Load failed"）：
//   - 桌面端（isTauri）：用 @tauri-apps/plugin-http，走 Rust reqwest 发请求，
//     绕开 macOS WKWebView 对 tauri:// → 外部 HTTPS 跨域 fetch 的拒绝
//   - 浏览器 / LAN 移动端：用 window.fetch 走标准 HTTP / CORS
//   两边签名同形（plugin-http 完整兼容 web fetch 接口），调用代码统一
//
// 错误统一 throw CommunityError；HTTP 网络层失败也包装成 CommunityError(code='network')。

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isTauri } from "./bridge";
import { getDeviceId } from "../stores/useDeviceIdStore";
import { COMMUNITY_BASE_URL } from "./communityConfig";
import {
  CommunityError,
  type AlbumDetailResponse,
  type AlbumsByImageResponse,
  type CommunityImageDto,
  type CommunityListResponse,
  type CommunityUploadResult,
  type CommunityUseResult,
  type CreateAlbumInput,
  type CreateAlbumResult,
} from "../types/community";
import type { PetCategory } from "../stores/usePetAssetsStore";

/// 桌面端 → plugin-http；浏览器端 → globalThis.fetch（每次调用查 global，
/// 让 vitest 的 stubGlobal("fetch", ...) 能正常拦截）。
/// plugin-http 的 fetch 与 web fetch 同形（Request/Response/FormData/Body 全兼容）。
const httpFetch: typeof fetch = ((...args: Parameters<typeof fetch>) =>
  isTauri
    ? (tauriFetch as unknown as typeof fetch)(...args)
    : globalThis.fetch(...args)) as typeof fetch;

function readBaseUrl(): string {
  return COMMUNITY_BASE_URL.replace(/\/+$/, "");
}

export function isCommunityEnabled(): boolean {
  return readBaseUrl().length > 0;
}

export function getCommunityBaseUrl(): string {
  return readBaseUrl();
}

function makeUrl(path: string): string {
  const base = readBaseUrl();
  if (!base) {
    throw new CommunityError({
      code: "disabled",
      status: 0,
      message: "社区服务地址未配置",
    });
  }
  return `${base}${path}`;
}

async function parseResponse<T>(res: Response): Promise<T> {
  let body: unknown = null;
  const text = await res.text();
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  if (!res.ok) {
    const b = (body ?? {}) as Record<string, unknown>;
    throw new CommunityError({
      code: typeof b.error === "string" ? b.error : `http_${res.status}`,
      status: res.status,
      message:
        typeof b.message === "string"
          ? b.message
          : typeof b.error === "string"
            ? b.error
            : res.statusText || "请求失败",
      field: typeof b.field === "string" ? b.field : null,
    });
  }
  return body as T;
}

async function callJson<T>(
  path: string,
  init: { method: "GET" | "POST" | "PATCH"; body?: unknown; query?: Record<string, string | undefined> },
): Promise<T> {
  const url = new URL(makeUrl(path));
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) {
      if (typeof v === "string" && v.length > 0) {
        url.searchParams.set(k, v);
      }
    }
  }
  const deviceId = getDeviceId();
  try {
    const res = await httpFetch(url.toString(), {
      method: init.method,
      headers: {
        "Content-Type": "application/json",
        "X-Device-Id": deviceId,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    return await parseResponse<T>(res);
  } catch (err) {
    if (err instanceof CommunityError) throw err;
    throw new CommunityError({
      code: "network",
      status: 0,
      message: `网络错误：${(err as Error).message ?? "未知"}`,
    });
  }
}

// -----------------------------------------------------------------------------
// 上传
// -----------------------------------------------------------------------------

export interface UploadImageInput {
  file: File | Blob;
  fileName?: string;
  category: PetCategory;
  prompt?: string | null;
  uploaderName?: string | null;
}

/// 手动构造 multipart/form-data 二进制 body。
///
/// 不用浏览器原生 FormData 是因为：Tauri plugin-http 接收 FormData 时，IPC
/// 序列化 File/Blob 二进制部分有 bug，server multer 解析时报
/// "Unable to read form data file"。改用 Uint8Array body 经 plugin-http 透传
/// 给 Rust reqwest，两边都不动 binary，可靠。
///
/// 字段名 / filename 用 RFC 5987-ish 简化版：非 ASCII 字符 percent-encode；
/// 标准的 ASCII 引号 / 反斜杠 / 控制字符替换为 _ 兜底。server 端用文件 hash 而非
/// originalname 持久化，filename 仅用于日志。
function encodeMultipartName(s: string): string {
  return s
    .replace(/[\x00-\x1f"\\]/g, "_")
    .replace(/[\u0080-\uFFFF]/g, (c) => {
      const bytes = new TextEncoder().encode(c);
      let out = "";
      for (const b of bytes) out += `%${b.toString(16).padStart(2, "0").toUpperCase()}`;
      return out;
    });
}

export interface MultipartFile {
  fieldName: string;
  fileName: string;
  contentType: string;
  data: Uint8Array;
}

export interface BuiltMultipart {
  body: Uint8Array;
  contentType: string; // 含 boundary
}

/// 把若干 text 字段 + 一个文件拼成 multipart/form-data 字节流。
/// boundary 用时间戳 + 随机串保证唯一；与文件内容内嵌的 \r\n 极小概率撞，撞了
/// busboy 会报 parse 错误 —— 接受这个 epsilon 风险换实现简单。
export function buildMultipartBody(
  textFields: Record<string, string>,
  file: MultipartFile,
): BuiltMultipart {
  const boundary = `----galcode-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const [k, v] of Object.entries(textFields)) {
    chunks.push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${encodeMultipartName(k)}"\r\n\r\n${v}\r\n`,
      ),
    );
  }
  chunks.push(
    enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${encodeMultipartName(file.fieldName)}"; filename="${encodeMultipartName(file.fileName)}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ),
  );
  chunks.push(file.data);
  chunks.push(enc.encode(`\r\n--${boundary}--\r\n`));

  let total = 0;
  for (const c of chunks) total += c.length;
  const body = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    body.set(c, off);
    off += c.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function uploadImage(
  input: UploadImageInput,
): Promise<CommunityUploadResult> {
  const deviceId = getDeviceId();

  // 读取文件二进制（File / Blob 都支持 arrayBuffer()）
  const ab = await input.file.arrayBuffer();
  const data = new Uint8Array(ab);
  const fileName =
    input.fileName ??
    (input.file instanceof File && input.file.name
      ? input.file.name
      : "upload.bin");
  const contentType =
    input.file.type && input.file.type.length > 0
      ? input.file.type
      : "application/octet-stream";

  const textFields: Record<string, string> = {
    deviceId,
    category: input.category,
  };
  if (input.prompt) textFields.prompt = input.prompt;
  if (input.uploaderName) textFields.uploaderName = input.uploaderName;

  const { body, contentType: bodyContentType } = buildMultipartBody(
    textFields,
    { fieldName: "file", fileName, contentType, data },
  );

  try {
    // body 用 .buffer 取出 ArrayBuffer —— TS lib 的 BodyInit 在新版 lib 把
    // Uint8Array<ArrayBufferLike> 排除在外（与 BufferSource 不兼容），用
    // 裸 ArrayBuffer 最稳；plugin-http 和浏览器 fetch 都接受。
    const res = await httpFetch(makeUrl("/api/images"), {
      method: "POST",
      headers: {
        "X-Device-Id": deviceId,
        "Content-Type": bodyContentType,
      },
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    });
    return await parseResponse<CommunityUploadResult>(res);
  } catch (err) {
    if (err instanceof CommunityError) throw err;
    throw new CommunityError({
      code: "network",
      status: 0,
      message: `上传失败：${(err as Error).message ?? "未知"}`,
    });
  }
}

// -----------------------------------------------------------------------------
// 列表 / 计数 / 举报 / 隐藏
// -----------------------------------------------------------------------------

export interface ListImagesParams {
  category: PetCategory;
  cursor?: string | null;
  pageSize?: number;
  /// 翻页时需要带回首次拿到的 topHotIds，避免重复
  excludeIds?: string[];
}

export async function listImages(
  params: ListImagesParams,
): Promise<CommunityListResponse> {
  return callJson<CommunityListResponse>("/api/images", {
    method: "GET",
    query: {
      category: params.category,
      cursor: params.cursor ?? undefined,
      pageSize: params.pageSize ? String(params.pageSize) : undefined,
      exclude: params.excludeIds && params.excludeIds.length > 0
        ? params.excludeIds.join(",")
        : undefined,
    },
  });
}

export async function recordImageUse(
  imageId: string,
): Promise<CommunityUseResult> {
  return callJson<CommunityUseResult>(`/api/images/${encodeURIComponent(imageId)}/use`, {
    method: "POST",
    body: { deviceId: getDeviceId() },
  });
}

export async function reportImage(
  imageId: string,
  reason?: string | null,
): Promise<{ reported: boolean }> {
  return callJson<{ reported: boolean }>(
    `/api/images/${encodeURIComponent(imageId)}/report`,
    { method: "POST", body: { deviceId: getDeviceId(), reason: reason ?? null } },
  );
}

export async function setImageVisibility(
  imageId: string,
  hidden: boolean,
): Promise<{ status: string }> {
  return callJson<{ status: string }>(
    `/api/images/${encodeURIComponent(imageId)}/visibility`,
    { method: "PATCH", body: { deviceId: getDeviceId(), hidden } },
  );
}

// -----------------------------------------------------------------------------
// 图集 API
// -----------------------------------------------------------------------------

export async function createAlbum(
  input: CreateAlbumInput,
): Promise<CreateAlbumResult> {
  return callJson<CreateAlbumResult>("/api/albums", {
    method: "POST",
    body: {
      deviceId: getDeviceId(),
      name: input.name,
      description: input.description ?? null,
      imageIds: input.imageIds,
      uploaderName: input.uploaderName ?? null,
    },
  });
}

export async function getAlbum(albumId: string): Promise<AlbumDetailResponse> {
  return callJson<AlbumDetailResponse>(
    `/api/albums/${encodeURIComponent(albumId)}`,
    { method: "GET" },
  );
}

export async function getAlbumsByImage(
  imageId: string,
): Promise<AlbumsByImageResponse> {
  return callJson<AlbumsByImageResponse>(
    `/api/albums/by-image/${encodeURIComponent(imageId)}`,
    { method: "GET" },
  );
}

export async function setAlbumVisibility(
  albumId: string,
  hidden: boolean,
): Promise<{ status: string }> {
  return callJson<{ status: string }>(
    `/api/albums/${encodeURIComponent(albumId)}/visibility`,
    { method: "PATCH", body: { deviceId: getDeviceId(), hidden } },
  );
}

// -----------------------------------------------------------------------------
// 把社区图下载为本地 Blob —— 用户"选用"某张社区图后，前端把它落到 IDB 当作
// 自己的本地资产；这样离线也能用。直接 fetch url，不走 callJson（响应体是 binary）。
// -----------------------------------------------------------------------------

export async function fetchCommunityBlob(image: CommunityImageDto): Promise<Blob> {
  try {
    const res = await httpFetch(image.url);
    if (!res.ok) {
      throw new CommunityError({
        code: `http_${res.status}`,
        status: res.status,
        message: `下载图片失败 (HTTP ${res.status})`,
      });
    }
    return await res.blob();
  } catch (err) {
    if (err instanceof CommunityError) throw err;
    throw new CommunityError({
      code: "network",
      status: 0,
      message: `下载图片失败：${(err as Error).message ?? "未知"}`,
    });
  }
}
