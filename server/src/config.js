// 统一从环境变量读配置，默认值留给本地 dev。生产建议用 systemd EnvironmentFile。
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function readInt(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function readList(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export const config = {
  port: readInt("PORT", 8787),
  dataDir: path.resolve(projectRoot, process.env.DATA_DIR ?? "./data"),
  uploadsDir: path.resolve(projectRoot, process.env.UPLOADS_DIR ?? "./uploads"),
  allowedOrigins: readList("ALLOWED_ORIGINS", [
    "tauri://localhost",
    "http://tauri.localhost",
    "http://localhost:1420",
  ]),
  maxUploadBytes: readInt("MAX_UPLOAD_BYTES", 8 * 1024 * 1024),
  defaultPageSize: readInt("DEFAULT_PAGE_SIZE", 24),
  maxPageSize: readInt("MAX_PAGE_SIZE", 60),
  topHotCount: readInt("TOP_HOT_COUNT", 10),
  // admin 复核网页：用户名 + bcrypt hash + cookie 签名密钥。
  // 启动时若 admins 表空且这三项都填，会自动 seed 一个管理员账号。
  adminUsername: process.env.ADMIN_USERNAME ?? "",
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH ?? "",
  // cookie 签名 / session token 用。生产强烈建议在 systemd EnvironmentFile 里设。
  // 没设时启动会用随机值，重启即所有管理员 session 失效（这是想要的安全默认）。
  cookieSecret:
    process.env.COOKIE_SECRET ??
    `vol-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
  // 内容审核 provider：none / sightengine / hive / stub。默认 none = 全部直通 = 等价 stub。
  // 接 sightengine 时还需要配 SIGHTENGINE_USER / SIGHTENGINE_SECRET。
  moderationProvider: (process.env.MODERATION_PROVIDER ?? "none").toLowerCase(),
  sightengineUser: process.env.SIGHTENGINE_USER ?? "",
  sightengineSecret: process.env.SIGHTENGINE_SECRET ?? "",
  // 阈值：超过即拒绝
  sightengineNudityThreshold: Number.parseFloat(
    process.env.SIGHTENGINE_NUDITY_THRESHOLD ?? "0.5",
  ),
  sightengineOffensiveThreshold: Number.parseFloat(
    process.env.SIGHTENGINE_OFFENSIVE_THRESHOLD ?? "0.5",
  ),
};

export const CATEGORIES = /** @type {const} */ ([
  "welcome",
  "thinking",
  "waiting",
  "complete",
  "error",
  "others",
]);

export const ALLOWED_MIMES = new Set([
  "image/gif",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/apng",
]);

export const MIME_TO_EXT = {
  "image/gif": "gif",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/apng": "apng",
};

// status 状态机
// pending_ai   — 等 AI 审核（Phase 4 才用，stub 期不出现）
// approved     — 通过，公开可见
// rejected     — AI 拒绝，进入复核（Phase 3 admin 可看）
// hidden_by_owner — 上传者自己隐藏
// hidden_by_admin — 管理员下架
export const STATUS = {
  PENDING_AI: "pending_ai",
  APPROVED: "approved",
  REJECTED: "rejected",
  HIDDEN_BY_OWNER: "hidden_by_owner",
  HIDDEN_BY_ADMIN: "hidden_by_admin",
};
