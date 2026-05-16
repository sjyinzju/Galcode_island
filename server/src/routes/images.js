// /api/images 路由：上传 / 列表 / 计数 / 举报 / 自助隐藏。
//
// 错误处理：路由内只抛 ValidationError 或显式 status；其它意外由 index.js 的全局
// errorHandler 兜底翻译为 500。

import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { config, STATUS, MIME_TO_EXT } from "../config.js";
import { getDb } from "../db.js";
import {
  ValidationError,
  validateCategory,
  validateDeviceId,
  validatePromptOptional,
  validateUploaderNameOptional,
  validateUpload,
  clampPageSize,
} from "../lib/validate.js";
import { newId } from "../lib/ids.js";
import { sha256File } from "../lib/hash.js";
import { listImages, listImagesPaged } from "../lib/listing.js";
import { imageToDto, fetchAlbumIdsForImages } from "../lib/serialize.js";
import {
  DAILY_LIKE_LIMIT,
  computeImagePopularity,
  utcDateStr,
} from "../lib/popularity.js";
import { inferBaseUrl } from "../lib/baseUrl.js";
import { moderateImage } from "../lib/moderation/index.js";
import { rateLimitRead, rateLimitWrite } from "../lib/rateLimit.js";

export function createImagesRouter() {
  const router = express.Router();

  // multer 写到 uploads 目录的临时名，后面我们按 hash 重命名。
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: config.uploadsDir,
      filename: (_req, file, cb) => {
        const ext = MIME_TO_EXT[file.mimetype] ?? "bin";
        cb(null, `tmp-${newId()}.${ext}`);
      },
    }),
    limits: { fileSize: config.maxUploadBytes },
    fileFilter: (_req, file, cb) => {
      // 先 multer 层挡一下；validateUpload 还会再校一遍（保险 + 错误消息更清楚）
      if (!file.mimetype.startsWith("image/")) {
        cb(new ValidationError("not an image", "file"));
        return;
      }
      cb(null, true);
    },
  });

  // -------------------------------------------------------------------------
  // POST /api/images  上传一张图
  // -------------------------------------------------------------------------
  router.post(
    "/",
    (req, _res, next) => {
      // 把 deviceId 提到 req 供限流拿到。但 multer 还没解析 body，先做不到——
      // 用 X-Device-Id 头补一份（客户端两个都发），既能限流又能在 form-data 里出现。
      req.deviceId = req.headers["x-device-id"]?.toString();
      next();
    },
    rateLimitWrite,
    upload.single("file"),
    async (req, res, next) => {
      try {
        // body 里也读一份 deviceId 兜底（form-data 没法发 header 的客户端）
        const deviceId = validateDeviceId(req.body.deviceId ?? req.deviceId);
        const category = validateCategory(req.body.category);
        const prompt = validatePromptOptional(req.body.prompt);
        const uploaderName = validateUploaderNameOptional(req.body.uploaderName);
        const { ext } = validateUpload(req.file);

        const tmpPath = req.file.path;
        const hash = await sha256File(tmpPath);
        const db = getDb();

        // 去重粒度：**同 device 同 hash**。同 device 二次上传同张图 → 复用本人 image 行。
        // 跨 device 同 hash 不再去重 —— 各 device 拥有自己的 image row（保留所有权信息，
        // 让 createAlbum 的"图必须属于本 device"校验能正确工作）。
        const existing = db
          .prepare("SELECT * FROM images WHERE device_id = ? AND file_hash = ?")
          .get(deviceId, hash);
        if (existing) {
          fs.unlink(tmpPath, () => {});
          res.status(200).json({
            duplicate: true,
            image: imageToDto(existing, { baseUrl: inferBaseUrl(req) }),
          });
          return;
        }

        // 物理文件按 hash 命名，复用：第一个上传 hash X 的人写盘，后续 device 上传同 hash
        // 直接复用同一物理文件，跳过写盘（节省磁盘 + 二次上传带宽）。
        const finalName = `${hash}.${ext}`;
        const finalPath = path.join(config.uploadsDir, finalName);
        try {
          await fs.promises.access(finalPath, fs.constants.F_OK);
          // 文件已存在 → 删 tmp，跳过 rename
          fs.unlink(tmpPath, () => {});
        } catch {
          // 文件不存在 → 把 tmp 改名落盘
          await fs.promises.rename(tmpPath, finalPath);
        }

        // 审核策略：
        //   - none / stub：同步直通，status=APPROVED 立即返回（兼容 Phase 1 行为）
        //   - 其它 provider：先入库 status=PENDING_AI，**异步**审核完成后再 UPDATE
        //     status=approved|rejected + ai_verdict。前端拿到 image.status='pending_ai'
        //     时显示"审核中"，公开 list 暂不可见。
        const isAsyncProvider = config.moderationProvider !== "none" && config.moderationProvider !== "stub";
        const id = newId();
        const now = Date.now();
        const initialStatus = isAsyncProvider ? STATUS.PENDING_AI : STATUS.APPROVED;
        const initialVerdict = isAsyncProvider ? "pending" : null;

        if (!isAsyncProvider) {
          // 同步路径：先跑审核（stub 直接返回 stub_pass），写最终 status
          const verdict = await moderateImage(finalPath, {
            category,
            mime: req.file.mimetype,
          });
          const status = verdict.approved ? STATUS.APPROVED : STATUS.REJECTED;
          db.prepare(
            `INSERT INTO images
              (id, device_id, category, file_hash, file_ext, mime, size_bytes,
               prompt, uploader_name, status, ai_verdict, use_count,
               created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          ).run(
            id,
            deviceId,
            category,
            hash,
            ext,
            req.file.mimetype,
            req.file.size,
            prompt,
            uploaderName,
            status,
            verdict.verdict,
            now,
            now,
          );
        } else {
          // 异步路径：先写 pending_ai，立刻返回；setImmediate 后台跑审核
          db.prepare(
            `INSERT INTO images
              (id, device_id, category, file_hash, file_ext, mime, size_bytes,
               prompt, uploader_name, status, ai_verdict, use_count,
               created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          ).run(
            id,
            deviceId,
            category,
            hash,
            ext,
            req.file.mimetype,
            req.file.size,
            prompt,
            uploaderName,
            initialStatus,
            initialVerdict,
            now,
            now,
          );
          setImmediate(async () => {
            try {
              const v = await moderateImage(finalPath, {
                category,
                mime: req.file.mimetype,
              });
              const next = v.approved ? STATUS.APPROVED : STATUS.REJECTED;
              getDb()
                .prepare("UPDATE images SET status = ?, ai_verdict = ?, updated_at = ? WHERE id = ?")
                .run(next, v.verdict, Date.now(), id);
              console.log(`[moderation] image=${id} verdict=${v.verdict} approved=${v.approved}`);
            } catch (err) {
              // 审核 worker 异常：保持 pending_ai，管理员可在 admin 看到并手动复核
              console.error(`[moderation] worker error image=${id}:`, err);
            }
          });
        }

        const row = db.prepare("SELECT * FROM images WHERE id = ?").get(id);
        res.status(201).json({
          duplicate: false,
          pending: isAsyncProvider,
          image: imageToDto(row, { baseUrl: inferBaseUrl(req) }),
        });
      } catch (err) {
        // multer 上传失败时 req.file 可能不存在；ValidationError 之外的清理交给 multer
        if (req.file?.path) {
          fs.unlink(req.file.path, () => {});
        }
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/images?category=&sort=popular|time&page=N&pageSize=
  //   新形态：分页 + 排序。返回 { items, page, pageSize, total, totalPages, sort }
  //
  // 兼容老调用：检测到 ?cursor= 或 ?exclude= 时走旧 Top10 + cursor 接口（一段过渡期）。
  // 新前端发 ?sort= 或 ?page=（无 cursor/exclude）→ 走新分页接口。
  // -------------------------------------------------------------------------
  router.get("/", rateLimitRead, (req, res, next) => {
    try {
      const category = validateCategory(req.query.category);
      const useLegacy =
        typeof req.query.cursor === "string" ||
        typeof req.query.exclude === "string";

      if (useLegacy) {
        const pageSize = clampPageSize(req.query.pageSize);
        const rawCursor = typeof req.query.cursor === "string" ? req.query.cursor : "";
        const excludeRaw = typeof req.query.exclude === "string" ? req.query.exclude : "";
        const excludeIds = excludeRaw
          ? excludeRaw.split(",").map((s) => s.trim()).filter(Boolean)
          : [];
        const result = listImages(getDb(), {
          category,
          rawCursor,
          pageSize,
          excludeIds,
        });
        const baseUrl = inferBaseUrl(req);
        const allRows = [...result.topHot, ...result.timeline];
        const albumIdsMap = fetchAlbumIdsForImages(getDb(), allRows.map((r) => r.id));
        const toDto = (r) =>
          imageToDto(r, { baseUrl, albumIds: albumIdsMap.get(r.id) ?? [] });
        res.json({
          topHot: result.topHot.map(toDto),
          timeline: result.timeline.map(toDto),
          nextCursor: result.nextCursor,
          topHotIds: result.topHotIds,
        });
        return;
      }

      // 新分页路径
      const sort = req.query.sort === "time" ? "time" : "popular";
      const result = listImagesPaged(getDb(), {
        category,
        sort,
        rawPage: req.query.page,
        rawPageSize: req.query.pageSize,
      });
      const baseUrl = inferBaseUrl(req);
      const albumIdsMap = fetchAlbumIdsForImages(
        getDb(),
        result.items.map((r) => r.id),
      );
      res.json({
        items: result.items.map((r) =>
          imageToDto(r, { baseUrl, albumIds: albumIdsMap.get(r.id) ?? [] }),
        ),
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: result.totalPages,
        sort: result.sort,
      });
      return;
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/images/:id/use  使用计数 +1（每设备每图幂等）
  // -------------------------------------------------------------------------
  router.post(
    "/:id/use",
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
        const row = db.prepare("SELECT id, use_count FROM images WHERE id = ?").get(id);
        if (!row) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        const insert = db
          .prepare(
            "INSERT OR IGNORE INTO use_events (image_id, device_id, created_at) VALUES (?, ?, ?)",
          )
          .run(id, deviceId, Date.now());
        let useCount = row.use_count;
        if (insert.changes === 1) {
          // 同步更新 popularity（= use_count + 3*likes）—— 读 likes 一次保持原子
          const cur = db
            .prepare("SELECT use_count, likes FROM images WHERE id = ?")
            .get(id);
          const newPop = computeImagePopularity(cur.use_count + 1, cur.likes);
          db.prepare(
            "UPDATE images SET use_count = use_count + 1, popularity = ?, updated_at = ? WHERE id = ?",
          ).run(newPop, Date.now(), id);
          useCount += 1;
        }
        res.json({ useCount, counted: insert.changes === 1 });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/images/:id/like  点赞（每设备每图每天最多 DAILY_LIKE_LIMIT=10 次）
  // body: { deviceId }
  // 响应：
  //   200 { likes, dailyRemaining }      —— 加成功
  //   429 { error: 'daily_limit', dailyRemaining: 0 }  —— 当日额度已满
  //   404 { error: 'not_found' }         —— 图不存在 / 已 hidden
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
        const img = db
          .prepare("SELECT id, use_count, likes, status FROM images WHERE id = ?")
          .get(id);
        if (!img) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        // 已被隐藏 / 拒绝的图不允许再点赞（避免点赞数被脏数据继续推高）
        if (img.status !== STATUS.APPROVED) {
          res.status(404).json({ error: "not_found" });
          return;
        }

        const dateStr = utcDateStr();
        // 用事务保证 quota 和 likes 一起更新
        let dailyRemaining = -1;
        let newLikes = img.likes;
        const tx = db.transaction(() => {
          // 当前 quota
          const quota = db
            .prepare(
              "SELECT consumed_count FROM daily_like_quota WHERE target_type='image' AND target_id=? AND device_id=? AND date_str=?",
            )
            .get(id, deviceId, dateStr);
          const consumed = quota?.consumed_count ?? 0;
          if (consumed >= DAILY_LIKE_LIMIT) {
            dailyRemaining = 0;
            return; // 不更新，外层根据 dailyRemaining 决定 429
          }
          // upsert quota +1
          db.prepare(
            `INSERT INTO daily_like_quota (target_type, target_id, device_id, date_str, consumed_count, updated_at)
             VALUES ('image', ?, ?, ?, 1, ?)
             ON CONFLICT(target_type, target_id, device_id, date_str)
             DO UPDATE SET consumed_count = consumed_count + 1, updated_at = excluded.updated_at`,
          ).run(id, deviceId, dateStr, Date.now());
          // 更新 likes + popularity
          newLikes = img.likes + 1;
          const newPop = computeImagePopularity(img.use_count, newLikes);
          db.prepare(
            "UPDATE images SET likes = ?, popularity = ?, updated_at = ? WHERE id = ?",
          ).run(newLikes, newPop, Date.now(), id);
          dailyRemaining = DAILY_LIKE_LIMIT - (consumed + 1);
        });
        tx();

        if (dailyRemaining === 0 && newLikes === img.likes) {
          // 进 tx 前 consumed 已达上限
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
  // POST /api/images/:id/report  举报（每设备每图幂等）
  // -------------------------------------------------------------------------
  router.post(
    "/:id/report",
    (req, _res, next) => {
      req.deviceId = req.body?.deviceId ?? req.headers["x-device-id"]?.toString();
      next();
    },
    rateLimitWrite,
    express.json(),
    (req, res, next) => {
      try {
        const deviceId = validateDeviceId(req.body?.deviceId);
        const reason = validatePromptOptional(req.body?.reason); // 复用长度上限校验
        const { id } = req.params;
        const db = getDb();
        const row = db.prepare("SELECT id FROM images WHERE id = ?").get(id);
        if (!row) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        db.prepare(
          "INSERT OR IGNORE INTO reports (id, image_id, device_id, reason, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(newId(), id, deviceId, reason, Date.now());
        res.json({ reported: true });
      } catch (err) {
        next(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /api/images/:id/visibility  上传者自助隐藏 / 取消隐藏
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
        const deviceId = validateDeviceId(req.body?.deviceId);
        const hidden = req.body?.hidden;
        if (typeof hidden !== "boolean") {
          throw new ValidationError("hidden must be boolean", "hidden");
        }
        const { id } = req.params;
        const db = getDb();
        const row = db
          .prepare("SELECT id, device_id, status FROM images WHERE id = ?")
          .get(id);
        if (!row) {
          res.status(404).json({ error: "not_found" });
          return;
        }
        if (row.device_id !== deviceId) {
          res.status(403).json({ error: "forbidden" });
          return;
        }
        // 被 admin 下架的图，本人不能擅自恢复
        if (row.status === STATUS.HIDDEN_BY_ADMIN || row.status === STATUS.REJECTED) {
          res.status(403).json({ error: "locked_by_admin" });
          return;
        }
        const nextStatus = hidden ? STATUS.HIDDEN_BY_OWNER : STATUS.APPROVED;
        db.prepare(
          "UPDATE images SET status = ?, updated_at = ? WHERE id = ?",
        ).run(nextStatus, Date.now(), id);
        res.json({ status: nextStatus });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
