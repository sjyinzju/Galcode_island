// 列表组装逻辑（Top10 + 时间倒序游标分页）。抽出来便于测试。
//
// 入参用 db handle + category + cursor + pageSize；
// 输出 { items, nextCursor, topHotIds }。
//
// 设计要点：
//   - 首页（cursor 空）：先查 Top10 by (use_count DESC, created_at DESC)，再查 pageSize 条
//     按 created_at DESC，排除前面 Top10 的 id。前端拼接展示。
//   - 翻页（cursor 非空）：纯按 created_at DESC 翻页，但仍把 Top10 的 id 排除（这些已经在
//     首页展示过，避免重复）。Top10 集合用首次返回的 topHotIds 还原。
//     -> 前端要把首次拿到的 topHotIds 缓存住，每次翻页带回（query: ?exclude=id1,id2...）
//        这样后端无状态。
//   - status='approved' 严格过滤；hidden_by_owner / hidden_by_admin / rejected / pending_ai 都不出现。
//   - 热度并列时（use_count 相同）按 created_at DESC 兜底；时间并列时按 id DESC 兜底，保证排序稳定。

import { STATUS, config } from "../config.js";
import { decodeCursor, encodeCursor } from "./cursor.js";

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
