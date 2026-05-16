// 纯函数校验工具：抽出来好做单元测试（feedback_tests_for_pattern_logic）。
// 路由里只负责把 req 数据塞给这些函数，错误抛 ValidationError，由 errorHandler 统一翻译为 400。

import { CATEGORIES, ALLOWED_MIMES, MIME_TO_EXT, config } from "../config.js";

export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "ValidationError";
    this.status = 400;
    this.field = field ?? null;
  }
}

const CATEGORIES_SET = new Set(CATEGORIES);

// 设备 ID 形态：放宽一点，只要是 8–64 字符的可见 ASCII（uuid / 自定义都行）。
// 太严会拒掉旧设备生成的 id；太松起不到防误用作用。
const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{8,64}$/;
export function validateDeviceId(raw) {
  if (typeof raw !== "string" || !DEVICE_ID_RE.test(raw)) {
    throw new ValidationError("invalid deviceId", "deviceId");
  }
  return raw;
}

export function validateCategory(raw) {
  if (typeof raw !== "string" || !CATEGORIES_SET.has(raw)) {
    throw new ValidationError(
      `invalid category, must be one of ${CATEGORIES.join(", ")}`,
      "category",
    );
  }
  return raw;
}

// prompt: 可选；非空时长度 ≤ 2000，避免被塞超长 system prompt 反复消耗 LLM 配额
const MAX_PROMPT_LEN = 2000;
export function validatePromptOptional(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") {
    throw new ValidationError("prompt must be a string", "prompt");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_PROMPT_LEN) {
    throw new ValidationError(
      `prompt too long (max ${MAX_PROMPT_LEN} chars)`,
      "prompt",
    );
  }
  return trimmed;
}

const MAX_NAME_LEN = 40;
export function validateUploaderNameOptional(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") {
    throw new ValidationError("uploaderName must be a string", "uploaderName");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_NAME_LEN) {
    throw new ValidationError(
      `uploaderName too long (max ${MAX_NAME_LEN} chars)`,
      "uploaderName",
    );
  }
  return trimmed;
}

// 由 multer 已经验过 size 上限，这里再兜底；mime 用白名单。
// 同时返回归一化后的 ext（jpeg → jpg）。
export function validateUpload(file) {
  if (!file) {
    throw new ValidationError("file is required", "file");
  }
  if (!ALLOWED_MIMES.has(file.mimetype)) {
    throw new ValidationError(
      `unsupported mime ${file.mimetype}`,
      "file",
    );
  }
  if (file.size <= 0) {
    throw new ValidationError("empty file", "file");
  }
  if (file.size > config.maxUploadBytes) {
    throw new ValidationError(
      `file too large (max ${config.maxUploadBytes} bytes)`,
      "file",
    );
  }
  const ext = MIME_TO_EXT[file.mimetype];
  return { ext };
}

export function clampPageSize(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return config.defaultPageSize;
  return Math.min(n, config.maxPageSize);
}
