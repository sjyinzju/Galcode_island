// 列表组装逻辑。
//
// 现有两套：
//   1) listImagesPaged({category, sort, page, pageSize}) — 新分页 + 排序（图片维度）
//   2) listImages({category, rawCursor, pageSize, excludeIds}) — 旧 Top10 + cursor 翻页
//      保留兼容老 endpoint / 测试；新前端不再用。
//
// listAlbumsPaged 同形 —— 给图集维度列表用。
//
// 公开可见性规则（所有 image 公开列表都走它）：
//   image.status = 'approved'
//   AND (
//     该图不在任何图集里     — 独立上传的图
//     OR 它的至少一个父图集是 active — 任一可见图集"撑住"它
//   )
//
// 设计动机：admin / owner 下架图集（status != active）后，该图集里的图自动从公开
// 列表消失；图同时挂多个图集时，只要还有一个 active 就继续可见。不级联改 image
// 自己的 status —— 那个语义是"图本身有没有被针对性下架"。

import { STATUS, config } from "../config.js";
import { decodeCursor, encodeCursor } from "./cursor.js";

const ALBUM_ACTIVE = "active";

/// 公开图片可见性的 WHERE 谓词片段（要拼到具体 SQL 里，调用方负责加 status= 占位符）。
/// 给定 alias = 表别名（默认 images），返回需要 AND 进去的字符串。
function visibleImageWherePredicate(alias = "images") {
  return ` AND (
    NOT EXISTS (SELECT 1 FROM album_images WHERE image_id = ${alias}.id)
    OR EXISTS (
      SELECT 1 FROM album_images ai_vis
      INNER JOIN albums a_vis ON a_vis.id = ai_vis.album_id
      WHERE ai_vis.image_id = ${alias}.id AND a_vis.status = '${ALBUM_ACTIVE}'
    )
  )`;
}

const IMAGE_SORTS = {
  popular: "popularity DESC, created_at DESC, id DESC",
  time: "created_at DESC, id DESC",
};

const ALBUM_SORTS = {
  popular: "popularity DESC, created_at DESC, id DESC",
  time: "created_at DESC, id DESC",
};

function clampPage(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}
function clampPageSize(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return config.defaultPageSize;
  return Math.min(n, config.maxPageSize);
}

/// 图片维度分页 + 排序。
/// 返回 { items, page, pageSize, total, totalPages, sort }。
export function listImagesPaged(
  db,
  { category, sort = "popular", rawPage, rawPageSize },
) {
  const orderBy = IMAGE_SORTS[sort] ?? IMAGE_SORTS.popular;
  const page = clampPage(rawPage);
  const pageSize = clampPageSize(rawPageSize);
  const offset = (page - 1) * pageSize;
  // total
  const total = db
    .prepare(
      `SELECT COUNT(*) AS c FROM images
       WHERE category = ? AND status = ?${visibleImageWherePredicate("images")}`,
    )
    .get(category, STATUS.APPROVED).c;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const items = db
    .prepare(
      `SELECT id, device_id, category, file_hash, file_ext, mime, size_bytes,
              width, height, prompt, uploader_name, status, use_count, likes, popularity,
              created_at, updated_at
       FROM images
       WHERE category = ? AND status = ?${visibleImageWherePredicate("images")}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
    )
    .all(category, STATUS.APPROVED, pageSize, offset);
  return { items, page, pageSize, total, totalPages, sort: sort in IMAGE_SORTS ? sort : "popular" };
}

/// 图集维度分页 + 排序。
/// 返回 { items, page, pageSize, total, totalPages, sort }。
/// 每个 album 附带 imageCount。
export function listAlbumsPaged(
  db,
  { sort = "popular", rawPage, rawPageSize },
) {
  const orderBy = ALBUM_SORTS[sort] ?? ALBUM_SORTS.popular;
  const page = clampPage(rawPage);
  const pageSize = clampPageSize(rawPageSize);
  const offset = (page - 1) * pageSize;
  const total = db
    .prepare("SELECT COUNT(*) AS c FROM albums WHERE status = ?")
    .get(ALBUM_ACTIVE).c;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const items = db
    .prepare(
      `SELECT a.*,
              (SELECT COUNT(*) FROM album_images WHERE album_id = a.id) AS image_count
       FROM albums a
       WHERE a.status = ?
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
    )
    .all(ALBUM_ACTIVE, pageSize, offset);
  return {
    items,
    page,
    pageSize,
    total,
    totalPages,
    sort: sort in ALBUM_SORTS ? sort : "popular",
  };
}

export function fetchTopHot(db, category) {
  const stmt = db.prepare(`
    SELECT id, device_id, category, file_hash, file_ext, mime, size_bytes,
           width, height, prompt, uploader_name, status, use_count,
           created_at, updated_at
    FROM images
    WHERE category = ? AND status = ?${visibleImageWherePredicate("images")}
    ORDER BY use_count DESC, created_at DESC, id DESC
    LIMIT ?
  `);
  return stmt.all(category, STATUS.APPROVED, config.topHotCount);
}

// 时间倒序翻页查询；excludeIds 用 SQL placeholder 展开（数量受限于 topHotCount，安全）。
export function fetchTimeline(db, { category, cursor, pageSize, excludeIds }) {
  const params = [category, STATUS.APPROVED];
  let whereExtra = "";

  if (cursor) {
    whereExtra += " AND (created_at < ? OR (created_at = ? AND id < ?))";
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }

  if (excludeIds && excludeIds.length > 0) {
    const placeholders = excludeIds.map(() => "?").join(",");
    whereExtra += ` AND id NOT IN (${placeholders})`;
    params.push(...excludeIds);
  }

  // pageSize+1 看下一页是否还有
  params.push(pageSize + 1);

  const sql = `
    SELECT id, device_id, category, file_hash, file_ext, mime, size_bytes,
           width, height, prompt, uploader_name, status, use_count,
           created_at, updated_at
    FROM images
    WHERE category = ? AND status = ?${visibleImageWherePredicate("images")}${whereExtra}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(...params);
}

export function listImages(db, { category, rawCursor, pageSize, excludeIds }) {
  const cursor = decodeCursor(rawCursor);
  let topHotIds = [];
  let topHot = [];
  if (!cursor) {
    topHot = fetchTopHot(db, category);
    topHotIds = topHot.map((r) => r.id);
  }

  // 翻页时排除的 id：首页才有 topHot，翻页时从 excludeIds 参数还原
  const exclude = cursor ? (excludeIds ?? []) : topHotIds;

  const timeline = fetchTimeline(db, {
    category,
    cursor,
    pageSize,
    excludeIds: exclude,
  });

  let nextCursor = null;
  let truncated = timeline;
  if (timeline.length > pageSize) {
    truncated = timeline.slice(0, pageSize);
    const last = truncated[truncated.length - 1];
    nextCursor = encodeCursor(last.created_at, last.id);
  }

  return {
    topHot: cursor ? [] : topHot,
    timeline: truncated,
    nextCursor,
    topHotIds: cursor ? exclude : topHotIds,
  };
}
