// /api/albums 路由：图集创建 / 查询 / 反查 / 自助隐藏。
//
// 设计：
//   - 图集是一组关联图，由同一 device 一次性"保存到云端"产生
//   - 一张图可属于多个图集（m2m）
//   - 创建时所有 imageIds 必须属于本 device + status=approved，跨 device / 非 approved 拒绝
//
// 错误处理：路由内只抛 ValidationError 或显式 status；其它由全局 errorHandler 翻 500。

import express from "express";
import { randomBytes } from "node:crypto";
import { STATUS } from "../config.js";
import { getDb } from "../db.js";
import {
  ValidationError,
  validateDeviceId,
  validatePromptOptional,
  validateUploaderNameOptional,
} from "../lib/validate.js";
import { newId } from "../lib/ids.js";
import {
  albumToDto,
  fetchAlbumIdsForImages,
  fetchCoverUrls,
  imageToDto,
} from "../lib/serialize.js";
import { inferBaseUrl } from "../lib/baseUrl.js";
import { rateLimitByIp, rateLimitRead, rateLimitWrite } from "../lib/rateLimit.js";
import {
  DAILY_LIKE_LIMIT,
  computeAlbumPopularity,
  utcDateStr,
} from "../lib/popularity.js";
import { listAlbumsPaged } from "../lib/listing.js";

const ALBUM_STATUS = {
  ACTIVE: "active",
  HIDDEN_BY_OWNER: "hidden_by_owner",
  HIDDEN_BY_ADMIN: "hidden_by_admin",
};

const MAX_NAME_LEN = 80;
const MAX_DESC_LEN = 500;
const MAX_IMAGES_PER_ALBUM = 60; // 防止滥用上传 N 千张

function validateAlbumName(raw) {
  if (typeof raw !== "string") {
    throw new ValidationError("name is required", "name");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ValidationError("name is required", "name");
  }
  if (trimmed.length > MAX_NAME_LEN) {
    throw new ValidationError(
      `name too long (max ${MAX_NAME_LEN} chars)`,
      "name",
    );
  }
  return trimmed;
}

function validateDescription(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") {
    throw new ValidationError("description must be a string", "description");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_DESC_LEN) {
    throw new ValidationError(
      `description too long (max ${MAX_DESC_LEN} chars)`,
      "description",
    );
  }
  return trimmed;
}

function validateImageIds(raw) {
  if (!Array.isArray(raw)) {
    throw new ValidationError("imageIds must be an array", "imageIds");
  }
  if (raw.length === 0) {
    throw new ValidationError("imageIds cannot be empty", "imageIds");
  }
  if (raw.length > MAX_IMAGES_PER_ALBUM) {
    throw new ValidationError(
      `too many images (max ${MAX_IMAGES_PER_ALBUM})`,
      "imageIds",
    );
  }
  const ids = [];
  for (const id of raw) {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new ValidationError("imageIds contains invalid entry", "imageIds");
    }
    ids.push(id.trim());
  }
  // 去重
  return Array.from(new Set(ids));
}

/// 把 image_id 列表查出来，附带 status + device_id，便于权限校验。
function loadImagesByIds(db, imageIds) {
  if (imageIds.length === 0) return [];
  const placeholders = imageIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT id, device_id, status FROM images WHERE id IN (${placeholders})`,
    )
    .all(...imageIds);
}

export function createAlbumsRouter() {
  const router = express.Router();

  // -------------------------------------------------------------------------
  // GET /api/albums?sort=popular|time&page=N&pageSize=  图集维度列表（带分页 + 排序）
  // 返回 { items, page, pageSize, total, totalPages, sort }
  // 每个 album 携带 coverUrl（第一张图的 url）+ likes + popularity + imageCount
  // -------------------------------------------------------------------------
  router.get("/", rateLimitRead, (req, res, next) => {
    try {
      const sort = req.query.sort === "time" ? "time" : "popular";
      const db = getDb();
      const result = listAlbumsPaged(db, {
        sort,
        rawPage: req.query.page,
        rawPageSize: req.query.pageSize,
      });
      const baseUrl = inferBaseUrl(req);
      const coverMap = fetchCoverUrls(db, result.items.map((r) => r.id), baseUrl);
      res.json({
        items: result.items.map((r) =>
          albumToDto(r, {
            imageCount: r.image_count,
            coverUrl: coverMap.get(r.id) ?? null,
          }),
        ),
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: result.totalPages,
        sort: result.sort,
      });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/albums   {name, description?, imageIds[], uploaderName?, deviceId?}
  // -------------------------------------------------------------------------
  router.post(
    "/",
    (req, _res, next) => {
      req.deviceId = req.headers["x-device-id"]?.toString();
      next();
    },
    rateLimitWrite,
    express.json(),
    (req, res, next) => {
      try {
        const deviceId = validateDeviceId(
          req.body?.deviceId ?? req.headers["x-device-id"]?.toString(),
        );
        const name = validateAlbumName(req.body?.name);
        const description = validateDescription(req.body?.description);
        const uploaderName = validateUploaderNameOptional(req.body?.uploaderName);
        const imageIds = validateImageIds(req.body?.imageIds);

        const db = getDb();
        const rows = loadImagesByIds(db, imageIds);
        // 找不齐 → 至少一个 id 不存在
        if (rows.length !== imageIds.length) {
          throw new ValidationError(
            "some imageIds do not exist on server",
            "imageIds",
          );
        }
        for (const r of rows) {
          if (r.device_id !== deviceId) {
            // 用户不能把别人的图打包成自己的图集
            res.status(403).json({
              error: "forbidden",
              message: `image ${r.id} does not belong to your device`,
            });
            return;
          }
          if (r.status !== STATUS.APPROVED) {
            throw new ValidationError(
              `image ${r.id} is not approved (status=${r.status})`,
              "imageIds",
            );
          }
        }

        const id = newId();
        const now = Date.now();
        // 32 字节 hex = 64 字符，足够无歧义且不太长；URL-safe（无特殊字符）
        const managementKey = randomBytes(32).toString("hex");
        // 事务包裹：保证 album + 所有 album_images 一起成功 / 一起回滚
        const tx = db.transaction(() => {
          db.prepare(
            `INSERT INTO albums
              (id, device_id, name, description, uploader_name, status, management_key, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            id,
            deviceId,
            name,
            description,
            uploaderName,
            ALBUM_STATUS.ACTIVE,
            managementKey,
            now,
            now,
          );
          const insertLink = db.prepare(
            `INSERT INTO album_images (album_id, image_id, position, added_at)
             VALUES (?, ?, ?, ?)`,
          );
          imageIds.forEach((imgId, idx) => {
            insertLink.run(id, imgId, idx, now);
          });
        });
        tx();

        const row = db.prepare("SELECT * FROM albums WHERE id = ?").get(id);
        // managementKey 只在创建响应里返一次；其它 GET / 列表 / DTO 都不包含
        res.status(201).json({
          album: albumToDto(row, { imageCount: imageIds.length }),
          managementKey,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/albums/:id  → 图集 + 包含的所有图
  // -------------------------------------------------------------------------
  router.get("/:id", rateLimitRead, (req, res, next) => {
    try {
      const { id } = req.params;
      const db = getDb();
      const album = db.prepare("SELECT * FROM albums WHERE id = ?").get(id);
      if (!album) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // 被 admin / owner 隐藏：404 处理（不暴露存在性）
      if (album.status !== ALBUM_STATUS.ACTIVE) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      // 顺序按 position 升序，与 创建时的 imageIds 顺序一致
      const images = db
        .prepare(
          `SELECT i.*
           FROM album_images ai
           INNER JOIN images i ON i.id = ai.image_id
           WHERE ai.album_id = ?
           ORDER BY ai.position ASC, ai.added_at ASC`,
        )
        .all(id);
      const baseUrl = inferBaseUrl(req);
      // 也填 albumIds（这些图本身可能属于多个图集）
      const albumIdsMap = fetchAlbumIdsForImages(db, images.map((r) => r.id));
      res.json({
        album: albumToDto(album, { imageCount: images.length }),
        images: images.map((r) =>
          imageToDto(r, { baseUrl, albumIds: albumIdsMap.get(r.id) ?? [] }),
        ),
      });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/albums/by-image/:imageId  → 该图属于哪些图集（仅 active）
  // -------------------------------------------------------------------------
  router.get("/by-image/:imageId", rateLimitRead, (req, res, next) => {
    try {
      const { imageId } = req.params;
      const db = getDb();
      const rows = db
        .prepare(
          `SELECT a.*, (SELECT COUNT(*) FROM album_images WHERE album_id = a.id) AS image_count
           FROM album_images ai
           INNER JOIN albums a ON a.id = ai.album_id
           WHERE ai.image_id = ?
             AND a.status = ?
           ORDER BY a.created_at DESC`,
        )
        .all(imageId, ALBUM_STATUS.ACTIVE);
      res.json({
        albums: rows.map((r) =>
          albumToDto(r, { imageCount: r.image_count }),
        ),
      });
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/albums/:id/like  点赞（每设备每图集每天最多 DAILY_LIKE_LIMIT 次）
  // 行为与 images/:id/like 一致；album popularity = 3 * likes
  // -------------------------------------------------------------------------
  router.post(
    "/:id/like",
    (req, _res, next) => {
      req.deviceId = req.body?.deviceId ?? req.headers["x-device-id"]?.toString();
      next();
    },
    rateLimitWrite,
    express.json(),
    (req, res, next) => {
      try {
        const deviceId = validateDeviceId(req.body?.deviceId);
        const { id } = req.params;
        const db = getDb();
        const album = db
          .prepare("SELECT id, likes, status FROM albums WHERE id = ?")
          .get(id);
        if (!album || album.status !== ALBUM_STATUS.ACTIVE) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        const dateStr = utcDateStr();
        let dailyRemaining = -1;
        let newLikes = album.likes;
        const tx = db.transaction(() => {
          const quota = db
            .prepare(
              "SELECT consumed_count FROM daily_like_quota WHERE target_type='album' AND target_id=? AND device_id=? AND date_str=?",
            )
            .get(id, deviceId, dateStr);
          const consumed = quota?.consumed_count ?? 0;
          if (consumed >= DAILY_LIKE_LIMIT) {
            dailyRemaining = 0;
            return;
          }
          db.prepare(
            `INSERT INTO daily_like_quota (target_type, target_id, device_id, date_str, consumed_count, updated_at)
             VALUES ('album', ?, ?, ?, 1, ?)
             ON CONFLICT(target_type, target_id, device_id, date_str)
             DO UPDATE SET consumed_count = consumed_count + 1, updated_at = excluded.updated_at`,
          ).run(id, deviceId, dateStr, Date.now());
          newLikes = album.likes + 1;
          const newPop = computeAlbumPopularity(newLikes);
          db.prepare(
            "UPDATE albums SET likes = ?, popularity = ?, updated_at = ? WHERE id = ?",
          ).run(newLikes, newPop, Date.now(), id);
          dailyRemaining = DAILY_LIKE_LIMIT - (consumed + 1);
        });
        tx();
        if (dailyRemaining === 0 && newLikes === album.likes) {
          res.status(429).json({ error: "daily_limit", dailyRemaining: 0 });
          return;
        }
        res.json({ likes: newLikes, dailyRemaining });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/albums/manage   {managementKey}
  // 用一次性密钥反查 album + images（同 GET /:id 形状）。
  // 设计：密钥不进 URL（避免被 referer / proxy 日志 / 浏览器历史泄露），走 POST body。
  // 401 = 没传 key；403 = key 长度 / 格式不合法；404 = key 不存在或对应 album 已被 admin 隐藏。
  //
  // 限速叠两层：rateLimitWrite（device 维度，绕过容易）+ rateLimitByIp（硬上限挡 deviceId 旋转）。
  // 每 IP 每分钟 20 次查询——正常用户管自己 album 用不到这个量；恶意试探即便密钥空间
  // 256 bit 不可枚举，也避免对数据库做慢查询 DoS。
  // -------------------------------------------------------------------------
  router.post(
    "/manage",
    rateLimitByIp(20, "manage"),
    rateLimitWrite,
    express.json(),
    (req, res, next) => {
      try {
        const key = req.body?.managementKey;
        if (typeof key !== "string" || key.length === 0) {
          res.status(401).json({ error: "missing_key" });
          return;
        }
        if (key.length > 256 || !/^[A-Za-z0-9_-]+$/.test(key)) {
          res.status(403).json({ error: "bad_key_format" });
          return;
        }
        const db = getDb();
        const album = db
          .prepare("SELECT * FROM albums WHERE management_key = ?")
          .get(key);
        if (!album) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        if (album.status === ALBUM_STATUS.HIDDEN_BY_ADMIN) {
          res.status(403).json({ error: "locked_by_admin" });
          return;
        }
        // 返回完整图列表，跟 GET /:id 一致——管理面板会展示
        const images = db
          .prepare(
            `SELECT i.*
             FROM album_images ai
             INNER JOIN images i ON i.id = ai.image_id
             WHERE ai.album_id = ?
             ORDER BY ai.position ASC, ai.added_at ASC`,
          )
          .all(album.id);
        const baseUrl = inferBaseUrl(req);
        const albumIdsMap = fetchAlbumIdsForImages(db, images.map((r) => r.id));
        res.json({
          album: albumToDto(album, { imageCount: images.length }),
          images: images.map((r) =>
            imageToDto(r, { baseUrl, albumIds: albumIdsMap.get(r.id) ?? [] }),
          ),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /api/albums/:id   {managementKey, name?, description?}
  // 用密钥修改 album 元数据（不改 image 关联）。任何字段未提供则保持原值。
  // -------------------------------------------------------------------------
  router.patch(
    "/:id",
    rateLimitWrite,
    express.json(),
    (req, res, next) => {
      try {
        const key = req.body?.managementKey;
        if (typeof key !== "string" || key.length === 0) {
          res.status(401).json({ error: "missing_key" });
          return;
        }
        const { id } = req.params;
        const db = getDb();
        const row = db.prepare("SELECT * FROM albums WHERE id = ?").get(id);
        if (!row || row.management_key !== key) {
          // 既保护 id 存在性也保护"该 key 是不是本 album 的"——一律 404
          res.status(404).json({ error: "not_found" });
          return;
        }
        if (row.status === ALBUM_STATUS.HIDDEN_BY_ADMIN) {
          res.status(403).json({ error: "locked_by_admin" });
          return;
        }

        let nextName = row.name;
        let nextDesc = row.description;
        let nextUploaderName = row.uploader_name;
        let touched = false;
        if (req.body?.name !== undefined) {
          nextName = validateAlbumName(req.body.name);
          touched = true;
        }
        if (req.body?.description !== undefined) {
          nextDesc = validateDescription(req.body.description);
          touched = true;
        }
        if (req.body?.uploaderName !== undefined) {
          nextUploaderName = validateUploaderNameOptional(req.body.uploaderName);
          touched = true;
        }
        if (!touched) {
          // 没东西改，直接返当前状态（幂等）
          const imageCount = db
            .prepare("SELECT COUNT(*) AS c FROM album_images WHERE album_id = ?")
            .get(id).c;
          res.json({ album: albumToDto(row, { imageCount }) });
          return;
        }
        db.prepare(
          `UPDATE albums
             SET name = ?, description = ?, uploader_name = ?, updated_at = ?
             WHERE id = ?`,
        ).run(nextName, nextDesc, nextUploaderName, Date.now(), id);
        const updated = db.prepare("SELECT * FROM albums WHERE id = ?").get(id);
        const imageCount = db
          .prepare("SELECT COUNT(*) AS c FROM album_images WHERE album_id = ?")
          .get(id).c;
        res.json({ album: albumToDto(updated, { imageCount }) });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /api/albums/:id/visibility  上传者自助隐藏 / 恢复
  // 支持两种身份：(a) body.managementKey 匹配 album.management_key
  //               (b) body.deviceId 匹配 album.device_id（向后兼容）
  // -------------------------------------------------------------------------
  router.patch(
    "/:id/visibility",
    (req, _res, next) => {
      req.deviceId = req.body?.deviceId ?? req.headers["x-device-id"]?.toString();
      next();
    },
    rateLimitWrite,
    express.json(),
    (req, res, next) => {
      try {
        const hidden = req.body?.hidden;
        if (typeof hidden !== "boolean") {
          throw new ValidationError("hidden must be boolean", "hidden");
        }
        const { id } = req.params;
        const db = getDb();
        const row = db
          .prepare("SELECT id, device_id, status, management_key FROM albums WHERE id = ?")
          .get(id);
        if (!row) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        // 任一身份成立即可：先查 key，再 fallback device_id
        const providedKey = req.body?.managementKey;
        const keyOk =
          typeof providedKey === "string" &&
          providedKey.length > 0 &&
          row.management_key === providedKey;
        let deviceOk = false;
        if (!keyOk) {
          const providedDevice = req.body?.deviceId;
          if (typeof providedDevice === "string" && providedDevice.length > 0) {
            const deviceId = validateDeviceId(providedDevice);
            deviceOk = row.device_id === deviceId;
          }
        }
        if (!keyOk && !deviceOk) {
          res.status(403).json({ error: "forbidden" });
          return;
        }
        if (row.status === ALBUM_STATUS.HIDDEN_BY_ADMIN) {
          res.status(403).json({ error: "locked_by_admin" });
          return;
        }
        const next = hidden ? ALBUM_STATUS.HIDDEN_BY_OWNER : ALBUM_STATUS.ACTIVE;
        db.prepare(
          "UPDATE albums SET status = ?, updated_at = ? WHERE id = ?",
        ).run(next, Date.now(), id);
        res.json({ status: next });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

// 顺手把 ALBUM_STATUS 暴露给测试 / admin
export { ALBUM_STATUS };

// 留意：validatePromptOptional 没用上但 import 留着兼容性；实际未来 album 也可能加 prompt
// 这里防止 unused 警告
void validatePromptOptional;
