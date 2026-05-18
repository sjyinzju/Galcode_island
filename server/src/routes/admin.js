// /admin 复核台后端路由。
//
// 端点全景：
//   POST   /admin/login                          {username, password} → cookie
//   POST   /admin/logout
//   GET    /admin/me                             session 探针
//   GET    /admin/api/stats                      仪表盘统计（图/集 计数、近期趋势、热门 TOP）
//   GET    /admin/api/images                     列表 + 多维筛选 + 分页
//   GET    /admin/api/images/:id                 单图详情（含举报记录 + 所属图集）
//   PATCH  /admin/api/images/:id/status          上架 / 下架
//   GET    /admin/api/albums                     图集列表（admin 视角，含 device 等）
//   PATCH  /admin/api/albums/:id/status          图集上架 / 下架（admin 强制）
//
// 设计：
//   - 全部端点（除 /login）都过 requireAdmin
//   - 所有 SQL 用 prepared statement
//   - 分页：cursor (base64 [createdAt,id]) 风格；reported 用 offset（GROUP BY 不易 cursor）
//   - 错误：ValidationError 抛 400；其它走全局 errorHandler

import express from "express";
import { STATUS, config } from "../config.js";
import { getDb } from "../db.js";
import { ValidationError } from "../lib/validate.js";
import { decodeCursor, encodeCursor } from "../lib/cursor.js";
import { imageToDto, albumToDto } from "../lib/serialize.js";
import { inferBaseUrl } from "../lib/baseUrl.js";
import {
  clearAdminCookie,
  isAdminConfigured,
  requireAdmin,
  setAdminCookie,
  verifyAdminPassword,
} from "../lib/adminAuth.js";
import { rateLimitByIp } from "../lib/rateLimit.js";

const ADMIN_PAGE_SIZE_DEFAULT = 30;
const ADMIN_PAGE_SIZE_MAX = 100;

const IMAGE_STATUSES = [
  STATUS.APPROVED,
  STATUS.REJECTED,
  STATUS.PENDING_AI,
  STATUS.HIDDEN_BY_OWNER,
  STATUS.HIDDEN_BY_ADMIN,
];

const ALBUM_STATUSES = ["active", "hidden_by_owner", "hidden_by_admin"];

const CATEGORIES = ["welcome", "thinking", "waiting", "complete", "error", "others"];

function clampAdminPageSize(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return ADMIN_PAGE_SIZE_DEFAULT;
  return Math.min(n, ADMIN_PAGE_SIZE_MAX);
}

function parseDateMs(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  // 接受 ISO 字符串 / 毫秒数字字符串
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n > 1e12) return n; // 像毫秒
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

export function createAdminRouter() {
  const router = express.Router();

  router.use(express.json());

  // ===========================================================================
  // 登录 / 登出 / session 探针
  // ===========================================================================
  // /login 必须按 IP 限速，否则 bcrypt 慢但仍可暴破；开源后路径已知，必须挡住。
  router.post("/login", rateLimitByIp(10, "admin_login"), async (req, res, next) => {
    try {
      if (!isAdminConfigured()) {
        res.status(503).json({
          error: "admin_not_configured",
          message:
            "管理员未配置；在 server 环境变量里设置 ADMIN_USERNAME / ADMIN_PASSWORD_HASH / COOKIE_SECRET",
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

  // ===========================================================================
  // 仪表盘统计
  // ===========================================================================
  router.get("/api/stats", requireAdmin, (req, res, next) => {
    try {
      const db = getDb();
      const baseUrl = inferBaseUrl(req);
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;

      // 图片 status 分布
      const imageStatusRows = db
        .prepare("SELECT status, COUNT(*) AS c FROM images GROUP BY status")
        .all();
      const imageByStatus = {};
      let imageTotal = 0;
      for (const r of imageStatusRows) {
        imageByStatus[r.status] = r.c;
        imageTotal += r.c;
      }

      // 图集 status 分布
      const albumStatusRows = db
        .prepare("SELECT status, COUNT(*) AS c FROM albums GROUP BY status")
        .all();
      const albumByStatus = {};
      let albumTotal = 0;
      for (const r of albumStatusRows) {
        albumByStatus[r.status] = r.c;
        albumTotal += r.c;
      }

      // 待复核数 = 待 AI + AI 拒绝
      const pendingReview =
        (imageByStatus[STATUS.PENDING_AI] ?? 0) +
        (imageByStatus[STATUS.REJECTED] ?? 0);

      // 近 24h / 7d 上传量
      const imageUploaded24h = db
        .prepare("SELECT COUNT(*) AS c FROM images WHERE created_at >= ?")
        .get(now - day).c;
      const imageUploaded7d = db
        .prepare("SELECT COUNT(*) AS c FROM images WHERE created_at >= ?")
        .get(now - 7 * day).c;
      const albumUploaded24h = db
        .prepare("SELECT COUNT(*) AS c FROM albums WHERE created_at >= ?")
        .get(now - day).c;

      // 近 7 日按天分桶上传量（用于柱状图）
      const dailyImages = [];
      for (let i = 6; i >= 0; i -= 1) {
        const end = now - i * day;
        const start = end - day;
        const c = db
          .prepare(
            "SELECT COUNT(*) AS c FROM images WHERE created_at >= ? AND created_at < ?",
          )
          .get(start, end).c;
        // YYYY-MM-DD UTC 当地都好；用日期 short 给前端
        const d = new Date(end);
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        dailyImages.push({ label: `${mm}-${dd}`, count: c });
      }

      // 总举报数 / 含举报图数
      const totalReports = db
        .prepare("SELECT COUNT(*) AS c FROM reports")
        .get().c;
      const reportedImageCount = db
        .prepare(
          "SELECT COUNT(DISTINCT image_id) AS c FROM reports WHERE image_id IN (SELECT id FROM images)",
        )
        .get().c;

      // 总点赞 / 使用计数
      const eng = db
        .prepare(
          "SELECT COALESCE(SUM(use_count),0) AS uses, COALESCE(SUM(likes),0) AS likes FROM images",
        )
        .get();

      // 热门图 TOP 5（按 popularity）—— 老字段保留兼容
      const topImages = db
        .prepare(
          `SELECT * FROM images WHERE status = ? ORDER BY popularity DESC, created_at DESC LIMIT 5`,
        )
        .all(STATUS.APPROVED);

      // 被举报最多的图 TOP 5：admin 关心的"待处理工作"
      const topReportedRows = db
        .prepare(
          `SELECT i.*, COUNT(r.id) AS report_count
           FROM images i
           INNER JOIN reports r ON r.image_id = i.id
           GROUP BY i.id
           ORDER BY report_count DESC, i.created_at DESC
           LIMIT 5`,
        )
        .all();

      // 热门图集 TOP 5
      const topAlbums = db
        .prepare(
          `SELECT a.*, (SELECT COUNT(*) FROM album_images WHERE album_id = a.id) AS image_count
           FROM albums a WHERE a.status = 'active' ORDER BY a.popularity DESC, a.created_at DESC LIMIT 5`,
        )
        .all();

      // 上传最多的设备 TOP 5（含 banned 状态信息——目前没有 ban 表，简单展示数量）
      const topUploaders = db
        .prepare(
          `SELECT device_id AS deviceId, COUNT(*) AS count,
                  MAX(uploader_name) AS uploaderName,
                  MAX(created_at) AS lastUploadAt
           FROM images GROUP BY device_id ORDER BY count DESC LIMIT 5`,
        )
        .all();

      res.json({
        generatedAt: now,
        images: {
          total: imageTotal,
          byStatus: imageByStatus,
          uploadedLast24h: imageUploaded24h,
          uploadedLast7d: imageUploaded7d,
          pendingReview,
          dailySeries: dailyImages,
        },
        albums: {
          total: albumTotal,
          byStatus: albumByStatus,
          uploadedLast24h: albumUploaded24h,
        },
        moderation: {
          totalReports,
          reportedImageCount,
        },
        engagement: {
          totalUseCount: eng.uses,
          totalLikes: eng.likes,
        },
        topImages: topImages.map((r) => imageToDto(r, { baseUrl })),
        topAlbums: topAlbums.map((r) =>
          albumToDto(r, { imageCount: r.image_count }),
        ),
        topReportedImages: topReportedRows.map((r) => ({
          ...imageToDto(r, { baseUrl }),
          reportCount: r.report_count,
        })),
        topUploaders,
      });
    } catch (err) {
      next(err);
    }
  });

  // ===========================================================================
  // 图片列表（admin 视图）—— 支持多维筛选 + 搜索
  //   filter: rejected | reported | all | approved | pending_ai | hidden_by_owner | hidden_by_admin
  //   category: welcome | thinking | ...（可选）
  //   q: 搜索串——deviceId（全等）或 uploaderName（LIKE）
  //   dateFrom / dateTo: 时间过滤（毫秒数字或 ISO 字符串）
  // ===========================================================================
  router.get("/api/images", requireAdmin, (req, res, next) => {
    try {
      const filter = String(req.query.filter ?? "rejected");
      const allowedFilters = ["rejected", "reported", "all", ...IMAGE_STATUSES];
      if (!allowedFilters.includes(filter)) {
        throw new ValidationError(
          `invalid filter, must be one of ${allowedFilters.join("|")}`,
          "filter",
        );
      }

      const category = req.query.category
        ? String(req.query.category)
        : null;
      if (category && !CATEGORIES.includes(category)) {
        throw new ValidationError(`invalid category`, "category");
      }
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const dateFrom = parseDateMs(req.query.dateFrom);
      const dateTo = parseDateMs(req.query.dateTo);
      const pageSize = clampAdminPageSize(req.query.pageSize);
      const cursor = decodeCursor(
        typeof req.query.cursor === "string" ? req.query.cursor : "",
      );

      const db = getDb();
      const baseUrl = inferBaseUrl(req);

      // 拼 WHERE
      const params = [];
      const wheres = [];
      if (filter === "rejected") {
        wheres.push("status = ?");
        params.push(STATUS.REJECTED);
      } else if (filter === "reported") {
        // reported 通过 join 处理，不进 wheres
      } else if (filter === "all") {
        // nothing
      } else {
        // 具体 status 字面
        wheres.push("status = ?");
        params.push(filter);
      }
      if (category) {
        wheres.push("category = ?");
        params.push(category);
      }
      if (q.length > 0) {
        // device id 通常是 8-64 [A-Za-z0-9._:-]——若像 device id 全等匹配，否则 uploader LIKE
        if (/^[A-Za-z0-9._:-]{8,64}$/.test(q)) {
          wheres.push("(device_id = ? OR uploader_name LIKE ?)");
          params.push(q, `%${q}%`);
        } else {
          wheres.push("uploader_name LIKE ?");
          params.push(`%${q}%`);
        }
      }
      if (dateFrom !== null) {
        wheres.push("created_at >= ?");
        params.push(dateFrom);
      }
      if (dateTo !== null) {
        wheres.push("created_at < ?");
        params.push(dateTo);
      }

      let rows = [];
      let nextCursor = null;

      if (filter === "reported") {
        // 有举报的图，按举报数倒序；OFFSET 分页
        const offset = Number.parseInt(req.query.offset, 10) || 0;
        const subWhere = wheres.length > 0 ? `AND ${wheres.join(" AND ")}` : "";
        const sql = `
          SELECT i.*, (SELECT COUNT(*) FROM reports WHERE image_id = i.id) AS report_count
          FROM images i
          WHERE (SELECT COUNT(*) FROM reports WHERE image_id = i.id) > 0
            ${subWhere.replace(/(\bdevice_id\b|\buploader_name\b|\bcategory\b|\bcreated_at\b|\bstatus\b)/g, "i.$1")}
          ORDER BY report_count DESC, i.created_at DESC, i.id DESC
          LIMIT ? OFFSET ?
        `;
        rows = db.prepare(sql).all(...params, pageSize + 1, offset);
        if (rows.length > pageSize) {
          rows = rows.slice(0, pageSize);
          nextCursor = String(offset + pageSize);
        }
      } else {
        let where = wheres.length > 0 ? wheres.join(" AND ") : "1=1";
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

      const items = rows.map((r) => {
        const baseDto = imageToDto(r, { baseUrl });
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

  // ===========================================================================
  // 单图详情：含全部举报记录 + 所属图集
  // ===========================================================================
  router.get("/api/images/:id", requireAdmin, (req, res, next) => {
    try {
      const { id } = req.params;
      const db = getDb();
      const baseUrl = inferBaseUrl(req);
      const row = db.prepare("SELECT * FROM images WHERE id = ?").get(id);
      if (!row) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const reports = db
        .prepare(
          "SELECT id, device_id AS deviceId, reason, created_at AS createdAt FROM reports WHERE image_id = ? ORDER BY created_at DESC",
        )
        .all(id);
      const albums = db
        .prepare(
          `SELECT a.id, a.name, a.status, a.uploader_name AS uploaderName, a.created_at AS createdAt
           FROM album_images ai
           INNER JOIN albums a ON a.id = ai.album_id
           WHERE ai.image_id = ?
           ORDER BY a.created_at DESC`,
        )
        .all(id);
      const reportCount = reports.length;
      const dto = imageToDto(row, { baseUrl });
      res.json({
        image: { ...dto, reportCount, aiVerdict: row.ai_verdict ?? null },
        reports,
        albums,
      });
    } catch (err) {
      next(err);
    }
  });

  // ===========================================================================
  // 上架 / 下架（图）
  // ===========================================================================
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

  // ===========================================================================
  // 图集列表（admin 视图）
  //   filter: all | active | hidden_by_owner | hidden_by_admin
  //   q: 搜索 name LIKE / deviceId 全等 / uploaderName LIKE
  //   dateFrom / dateTo
  // ===========================================================================
  router.get("/api/albums", requireAdmin, (req, res, next) => {
    try {
      const filter = String(req.query.filter ?? "all");
      if (!["all", ...ALBUM_STATUSES].includes(filter)) {
        throw new ValidationError(`invalid filter`, "filter");
      }
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const dateFrom = parseDateMs(req.query.dateFrom);
      const dateTo = parseDateMs(req.query.dateTo);
      const pageSize = clampAdminPageSize(req.query.pageSize);
      const cursor = decodeCursor(
        typeof req.query.cursor === "string" ? req.query.cursor : "",
      );
      const db = getDb();
      const baseUrl = inferBaseUrl(req);

      const params = [];
      const wheres = [];
      if (filter !== "all") {
        wheres.push("status = ?");
        params.push(filter);
      }
      if (q.length > 0) {
        if (/^[A-Za-z0-9._:-]{8,64}$/.test(q)) {
          wheres.push("(device_id = ? OR name LIKE ? OR uploader_name LIKE ?)");
          params.push(q, `%${q}%`, `%${q}%`);
        } else {
          wheres.push("(name LIKE ? OR uploader_name LIKE ?)");
          params.push(`%${q}%`, `%${q}%`);
        }
      }
      if (dateFrom !== null) {
        wheres.push("created_at >= ?");
        params.push(dateFrom);
      }
      if (dateTo !== null) {
        wheres.push("created_at < ?");
        params.push(dateTo);
      }

      let where = wheres.length > 0 ? wheres.join(" AND ") : "1=1";
      if (cursor) {
        where += " AND (created_at < ? OR (created_at = ? AND id < ?))";
        params.push(cursor.createdAt, cursor.createdAt, cursor.id);
      }
      params.push(pageSize + 1);
      const sql = `
        SELECT a.*, (SELECT COUNT(*) FROM album_images WHERE album_id = a.id) AS image_count,
          (SELECT i.file_hash || '.' || i.file_ext FROM album_images ai
             INNER JOIN images i ON i.id = ai.image_id
             WHERE ai.album_id = a.id
             ORDER BY ai.position ASC, ai.added_at ASC LIMIT 1) AS cover_file
        FROM albums a
        WHERE ${where}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ?
      `;
      let rows = db.prepare(sql).all(...params);
      let nextCursor = null;
      if (rows.length > pageSize) {
        rows = rows.slice(0, pageSize);
        const last = rows[rows.length - 1];
        nextCursor = encodeCursor(last.created_at, last.id);
      }
      const items = rows.map((r) => ({
        ...albumToDto(r, {
          imageCount: r.image_count,
          coverUrl: r.cover_file ? `${baseUrl}/uploads/${r.cover_file}` : null,
        }),
      }));
      res.json({ items, nextCursor });
    } catch (err) {
      next(err);
    }
  });

  // ===========================================================================
  // 图集详情（admin 视角：不论 status 都能看，public GET 会 404 隐藏的）
  // ===========================================================================
  router.get("/api/albums/:id", requireAdmin, (req, res, next) => {
    try {
      const { id } = req.params;
      const db = getDb();
      const baseUrl = inferBaseUrl(req);
      const album = db.prepare("SELECT * FROM albums WHERE id = ?").get(id);
      if (!album) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // public 路径会按 status 过滤；admin 路径不过滤——隐藏的也能看
      const images = db
        .prepare(
          `SELECT i.* FROM album_images ai
           INNER JOIN images i ON i.id = ai.image_id
           WHERE ai.album_id = ?
           ORDER BY ai.position ASC, ai.added_at ASC`,
        )
        .all(id);
      res.json({
        album: albumToDto(album, { imageCount: images.length }),
        images: images.map((r) => imageToDto(r, { baseUrl })),
      });
    } catch (err) {
      next(err);
    }
  });

  // ===========================================================================
  // 图集 admin 强制上架 / 下架
  // ===========================================================================
  router.patch("/api/albums/:id/status", requireAdmin, (req, res, next) => {
    try {
      const { id } = req.params;
      const desired = req.body?.status;
      if (!["active", "hidden_by_admin"].includes(desired)) {
        throw new ValidationError(
          `status must be one of active|hidden_by_admin`,
          "status",
        );
      }
      const db = getDb();
      const row = db.prepare("SELECT id, status FROM albums WHERE id = ?").get(id);
      if (!row) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      db.prepare(
        "UPDATE albums SET status = ?, updated_at = ? WHERE id = ?",
      ).run(desired, Date.now(), id);
      res.json({ status: desired, previous: row.status });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
