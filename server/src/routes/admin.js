// /admin 复核网页后端路由。
//
// 端点：
//   POST /admin/login   {username, password} → cookie
//   POST /admin/logout
//   GET  /admin/me      → {username} 或 401（前端用作 session 探针）
//   GET  /admin/api/images?filter=rejected|all|reported&cursor=&pageSize=
//        分页返回完整信息（与公开 list 不同：含 device_id / 所有 status / 举报数）
//   PATCH /admin/api/images/:id/status  {status: approved|hidden_by_admin}
//
// filter 语义：
//   rejected — 默认；AI 拒绝待人工复核。Phase 4 才大量出现，Phase 3 stub 期返回空
//   reported — 用户举报数 ≥ 1，按举报数倒序
//   all      — 所有非删除图，按 created_at 倒序

import express from "express";
import { STATUS, config } from "../config.js";
import { getDb } from "../db.js";
import { ValidationError } from "../lib/validate.js";
import { decodeCursor, encodeCursor } from "../lib/cursor.js";
import { imageToDto } from "../lib/serialize.js";
import { inferBaseUrl } from "../lib/baseUrl.js";
import {
  clearAdminCookie,
  isAdminConfigured,
  requireAdmin,
  setAdminCookie,
  verifyAdminPassword,
} from "../lib/adminAuth.js";

const ADMIN_PAGE_SIZE_DEFAULT = 30;
const ADMIN_PAGE_SIZE_MAX = 100;

function clampAdminPageSize(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return ADMIN_PAGE_SIZE_DEFAULT;
  return Math.min(n, ADMIN_PAGE_SIZE_MAX);
}

export function createAdminRouter() {
  const router = express.Router();

  // 所有 admin 端点都吃 JSON body
  router.use(express.json());

  // -------------------------------------------------------------------------
  // 登录 / 登出 / session 探针
  // -------------------------------------------------------------------------
  router.post("/login", async (req, res, next) => {
    try {
      if (!isAdminConfigured()) {
        res.status(503).json({
          error: "admin_not_configured",
          message: "管理员未配置；在 server 环境变量里设置 ADMIN_USERNAME / ADMIN_PASSWORD_HASH / COOKIE_SECRET",
        });
        return;
      }
      const { username, password } = req.body ?? {};
      const ok = await verifyAdminPassword(username, password);
      if (!ok) {
        res.status(401).json({ error: "invalid_credentials" });
        return;
      }
      setAdminCookie(res, ok);
      res.json({ username: ok });
    } catch (err) {
      next(err);
    }
  });

  router.post("/logout", (_req, res) => {
    clearAdminCookie(res);
    res.json({ ok: true });
  });

  router.get("/me", requireAdmin, (_req, res) => {
    res.json({ username: config.adminUsername });
  });

  // -------------------------------------------------------------------------
  // 图片列表（admin 视图：包含所有 status + device_id + 举报数）
  // -------------------------------------------------------------------------
  router.get("/api/images", requireAdmin, (req, res, next) => {
    try {
      const filter = String(req.query.filter ?? "rejected");
      if (!["rejected", "reported", "all"].includes(filter)) {
        throw new ValidationError(
          `invalid filter, must be one of rejected|reported|all`,
          "filter",
        );
      }
      const pageSize = clampAdminPageSize(req.query.pageSize);
      const cursor = decodeCursor(typeof req.query.cursor === "string" ? req.query.cursor : "");
      const db = getDb();
      const baseUrl = inferBaseUrl(req);

      let rows = [];
      let nextCursor = null;

      if (filter === "rejected") {
        // status=rejected + cursor 翻页
        const params = [STATUS.REJECTED];
        let where = " AND 1=1";
        if (cursor) {
          where += " AND (created_at < ? OR (created_at = ? AND id < ?))";
          params.push(cursor.createdAt, cursor.createdAt, cursor.id);
        }
        params.push(pageSize + 1);
        const sql = `
          SELECT * FROM images
          WHERE status = ?${where}
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `;
        rows = db.prepare(sql).all(...params);
        if (rows.length > pageSize) {
          rows = rows.slice(0, pageSize);
          const last = rows[rows.length - 1];
          nextCursor = encodeCursor(last.created_at, last.id);
        }
      } else if (filter === "reported") {
        // 有举报的图，按举报数倒序；同数时按 created_at 倒序
        // SQLite 不支持 GROUP BY 后 cursor 简单分页；为简化直接用 OFFSET（admin 流量小，能接受）
        const offset = Number.parseInt(req.query.offset, 10) || 0;
        const sql = `
          SELECT i.*, (SELECT COUNT(*) FROM reports WHERE image_id = i.id) AS report_count
          FROM images i
          WHERE (SELECT COUNT(*) FROM reports WHERE image_id = i.id) > 0
          ORDER BY report_count DESC, i.created_at DESC, i.id DESC
          LIMIT ? OFFSET ?
        `;
        rows = db.prepare(sql).all(pageSize + 1, offset);
        if (rows.length > pageSize) {
          rows = rows.slice(0, pageSize);
          // 用 offset 形式的游标 —— admin 简化路径
          nextCursor = String(offset + pageSize);
        }
      } else {
        // all
        const params = [];
        let where = "1=1";
        if (cursor) {
          where += " AND (created_at < ? OR (created_at = ? AND id < ?))";
          params.push(cursor.createdAt, cursor.createdAt, cursor.id);
        }
        params.push(pageSize + 1);
        const sql = `
          SELECT * FROM images
          WHERE ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `;
        rows = db.prepare(sql).all(...params);
        if (rows.length > pageSize) {
          rows = rows.slice(0, pageSize);
          const last = rows[rows.length - 1];
          nextCursor = encodeCursor(last.created_at, last.id);
        }
      }

      // 拼 DTO + 加 admin 视角字段（举报数）
      const items = rows.map((r) => {
        const baseDto = imageToDto(r, { baseUrl });
        // admin 看的是完整 status；imageToDto 已经透出。再补一份 reportCount。
        let reportCount;
        if ("report_count" in r) {
          reportCount = r.report_count;
        } else {
          reportCount = db
            .prepare("SELECT COUNT(*) AS c FROM reports WHERE image_id = ?")
            .get(r.id).c;
        }
        return { ...baseDto, reportCount, aiVerdict: r.ai_verdict ?? null };
      });

      res.json({ items, nextCursor });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // 上架 / 下架
  // -------------------------------------------------------------------------
  router.patch("/api/images/:id/status", requireAdmin, (req, res, next) => {
    try {
      const { id } = req.params;
      const desired = req.body?.status;
      if (![STATUS.APPROVED, STATUS.HIDDEN_BY_ADMIN].includes(desired)) {
        throw new ValidationError(
          `status must be one of approved|hidden_by_admin`,
          "status",
        );
      }
      const db = getDb();
      const row = db.prepare("SELECT id, status FROM images WHERE id = ?").get(id);
      if (!row) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      db.prepare(
        "UPDATE images SET status = ?, updated_at = ? WHERE id = ?",
      ).run(desired, Date.now(), id);
      res.json({ status: desired, previous: row.status });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
