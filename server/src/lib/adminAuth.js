// admin 复核网页鉴权。
//
// 设计：
//   - bcryptjs（pure JS）校验密码。生成 hash 走 scripts/admin-hash.mjs。
//   - 登录成功后签发 httpOnly + Signed cookie "galadmin"，值是 username。
//   - requireAdmin 中间件读 signedCookies.galadmin；非空即视为已登录（再校验用户名匹配
//     config.adminUsername 防多人共享 secret 后误用）。
//   - 没启用 admin 凭据时一切拒绝；不会"匿名直入"。

import bcrypt from "bcryptjs";
import { config } from "../config.js";

const ADMIN_COOKIE = "galadmin";

export function isAdminConfigured() {
  return Boolean(
    config.adminUsername && config.adminPasswordHash && config.cookieSecret,
  );
}

/// 校验密码 + 返回 username（用于登录 endpoint）。
export async function verifyAdminPassword(username, password) {
  if (!isAdminConfigured()) return null;
  if (typeof username !== "string" || typeof password !== "string") return null;
  if (username !== config.adminUsername) return null;
  const ok = await bcrypt.compare(password, config.adminPasswordHash);
  return ok ? username : null;
}

export function setAdminCookie(res, username) {
  res.cookie(ADMIN_COOKIE, username, {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // 反代 HTTPS 时由 trust proxy + secure: 'auto' 处理；本机 http 用 false
    signed: true,
    maxAge: 12 * 60 * 60 * 1000, // 12h
  });
}

export function clearAdminCookie(res) {
  res.clearCookie(ADMIN_COOKIE);
}

/// Express 中间件：未登录或用户名不匹配时返回 401。
/// 401 比 403 更合适：表示"没有有效凭据"，前端可重定向回登录页。
export function requireAdmin(req, res, next) {
  if (!isAdminConfigured()) {
    res.status(401).json({ error: "admin_not_configured" });
    return;
  }
  const got = req.signedCookies?.[ADMIN_COOKIE];
  if (!got || got !== config.adminUsername) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

export const ADMIN_COOKIE_NAME = ADMIN_COOKIE;
