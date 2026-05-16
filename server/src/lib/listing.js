// 列表组装逻辑。
//
// 现有两套：
//   1) listImagesPaged({category, sort, page, pageSize}) — 新分页 + 排序（图片维度）
//   2) listImages({category, rawCursor, pageSize, excludeIds}) — 旧 Top10 + cursor 翻页
//      保留兼容老 endpoint / 测试；新前端不再用。
//
// listAlbumsPaged 同形 —— 给图集维度列表用。
//
// status='approved'（image） / 'active'（album） 严格过滤；hidden / rejected / pending_ai 都不出现。
// 排序稳定：人气并列 → created_at DESC 兜底；时间并列 → id DESC 兜底。

import { STATUS, config } from "../config.js";
import { decodeCursor, encodeCursor } from "./cursor.js";

const ALBUM_ACTIVE = "active";

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
      "SELECT COUNT(*) AS c FROM images WHERE category = ? AND status = ?",
    )
    .get(category, STATUS.APPROVED).c;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const items = db
    .prepare(
      `SELECT id, device_id, category, file_hash, file_ext, mime, size_bytes,
              width, height, prompt, uploader_name, status, use_count, likes, popularity,
              created_at, updated_at
       FROM images
       WHERE category = ? AND status = ?
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
    WHERE category = ? AND status = ?
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
    WHERE category = ? AND status = ?${whereExtra}
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
