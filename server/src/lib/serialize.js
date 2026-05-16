// db 行 → API DTO。
// 关键：把图片的对外 URL 拼出来（前端不需要知道 file_hash/ext 实现细节）。
// 客户端拿到 url 就能 <img src=url> 或 fetch 下载到本地 IDB。

export function imageToDto(row, { baseUrl, albumIds = [] }) {
  return {
    id: row.id,
    deviceId: row.device_id,
    category: row.category,
    mime: row.mime,
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
    prompt: row.prompt ?? null,
    uploaderName: row.uploader_name ?? null,
    status: row.status,
    useCount: row.use_count,
    likes: row.likes ?? 0,
    popularity: row.popularity ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    url: `${baseUrl}/uploads/${row.file_hash}.${row.file_ext}`,
    // 该图所属的图集 id 列表；CommunityPickerModal 用来决定是否显示"查看所属图集"按钮。
    // 列表批量查询时由 routes/images.js 一次性 SELECT 反向索引聚合，避免 N+1。
    albumIds,
  };
}

/// 批量为一组图查 album_id 反向索引，返回 Map<imageId, string[]>。
/// 单次 SQL（IN clause，最多受 SQLite SQLITE_MAX_VARIABLE_NUMBER 限制，默认 999；
/// 我们一页 ≤ 60，远低于此），不会触发 N+1。
export function fetchAlbumIdsForImages(db, imageIds) {
  const result = new Map();
  for (const id of imageIds) result.set(id, []);
  if (imageIds.length === 0) return result;
  const placeholders = imageIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT ai.image_id, ai.album_id
       FROM album_images ai
       INNER JOIN albums a ON a.id = ai.album_id
       WHERE ai.image_id IN (${placeholders})
         AND a.status = 'active'`,
    )
    .all(...imageIds);
  for (const row of rows) {
    const list = result.get(row.image_id);
    if (list) list.push(row.album_id);
  }
  return result;
}

export function albumToDto(row, { imageCount, coverUrl = null }) {
  return {
    id: row.id,
    deviceId: row.device_id,
    name: row.name,
    description: row.description ?? null,
    uploaderName: row.uploader_name ?? null,
    status: row.status,
    imageCount,
    likes: row.likes ?? 0,
    popularity: row.popularity ?? 0,
    coverUrl, // 图集封面（取第一张图的 url）；列表时填，单查时按需
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/// 给一批 album 批量取每个图集的"封面图 url"（即 position 最小的那张图）。
/// 一次 SQL 不走 N+1。
export function fetchCoverUrls(db, albumIds, baseUrl) {
  const result = new Map();
  if (albumIds.length === 0) return result;
  const placeholders = albumIds.map(() => "?").join(",");
  // 每个 album 找 position 最小的那张图作为封面
  const rows = db
    .prepare(
      `SELECT ai.album_id, i.file_hash, i.file_ext
       FROM album_images ai
       INNER JOIN images i ON i.id = ai.image_id
       WHERE ai.album_id IN (${placeholders})
         AND ai.position = (
           SELECT MIN(position) FROM album_images WHERE album_id = ai.album_id
         )`,
    )
    .all(...albumIds);
  for (const r of rows) {
    result.set(r.album_id, `${baseUrl}/uploads/${r.file_hash}.${r.file_ext}`);
  }
  return result;
}
