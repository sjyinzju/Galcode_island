// 列表翻页游标：把 (created_at, id) 元组编成 base64，前端不解析、原样回传。
//
// 为什么不用 offset：
//   - 上传瞬时插入会让 offset 翻页跳行 / 重复
//   - 游标 (created_at, id) 唯一定位，索引 idx_images_time 直接命中
//
// 编码格式：base64url(JSON([createdAt, id]))；非法回传一律按"首页"处理，不抛错
// （兼容客户端版本差异 / 复制粘贴）。

const enc = (s) =>
  Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
const dec = (s) => {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64").toString("utf8");
};

export function encodeCursor(createdAt, id) {
  if (!Number.isFinite(createdAt) || typeof id !== "string" || !id) {
    throw new Error("encodeCursor: invalid args");
  }
  return enc(JSON.stringify([createdAt, id]));
}

export function decodeCursor(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(dec(raw));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [createdAt, id] = parsed;
    if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
    if (typeof id !== "string" || id.length === 0) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
