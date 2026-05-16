// listing.js 是社区"前十热门 + 后续时间倒序"的核心逻辑，这里用内存 SQLite 跑端到端
// 验证：构造一批图覆盖热度并列 / 时间并列 / 跨类别污染 / hidden 排除 / 翻页连续性。
//
// 重点验证场景：
//   1. 首页返回 topHot 按 use_count DESC + created_at DESC + id DESC，三级稳定排序
//   2. timeline 不与 topHot 重复
//   3. 翻页带回 excludeIds 后仍排除 topHot
//   4. 不同 category 互不污染
//   5. hidden_by_owner / hidden_by_admin / rejected / pending_ai 不出现

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildInMemoryDb } from "../src/db.js";
import { listImages } from "../src/lib/listing.js";
import { STATUS } from "../src/config.js";

function insertImage(db, overrides) {
  const now = overrides.createdAt ?? Date.now();
  const id = overrides.id;
  db.prepare(
    `INSERT INTO images
      (id, device_id, category, file_hash, file_ext, mime, size_bytes, prompt,
       uploader_name, status, ai_verdict, use_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stub_pass', ?, ?, ?)`,
  ).run(
    id,
    overrides.deviceId ?? "device-1",
    overrides.category ?? "welcome",
    overrides.fileHash ?? `hash-${id}`,
    overrides.fileExt ?? "png",
    overrides.mime ?? "image/png",
    overrides.sizeBytes ?? 1000,
    overrides.prompt ?? null,
    overrides.uploaderName ?? null,
    overrides.status ?? STATUS.APPROVED,
    overrides.useCount ?? 0,
    now,
    now,
  );
}

describe("listImages — Top10 热门 + 时间倒序游标分页", () => {
  let db;
  beforeEach(() => {
    db = buildInMemoryDb();
  });
  afterEach(() => {
    db.close();
  });

  it("首页返回 topHot 按 (use_count DESC, created_at DESC, id DESC) 排序", () => {
    // 同热度并列时按时间倒序兜底；时间也并列时按 id DESC 兜底
    insertImage(db, { id: "a", useCount: 5, createdAt: 100 });
    insertImage(db, { id: "b", useCount: 10, createdAt: 100 });
    insertImage(db, { id: "c", useCount: 10, createdAt: 200 });
    insertImage(db, { id: "d", useCount: 10, createdAt: 100 }); // 与 b 并列

    const out = listImages(db, {
      category: "welcome",
      rawCursor: "",
      pageSize: 20,
      excludeIds: [],
    });
    expect(out.topHot.map((r) => r.id)).toEqual(["c", "d", "b", "a"]);
  });

  it("timeline 不与 topHot 重复（首页）", () => {
    // 12 张图 -> Top10 拿前 10 热门，timeline 应该是剩下 2 张
    for (let i = 0; i < 12; i += 1) {
      insertImage(db, {
        id: `img-${i}`,
        useCount: 100 - i,
        createdAt: 1000 + i,
      });
    }
    const out = listImages(db, {
      category: "welcome",
      rawCursor: "",
      pageSize: 20,
      excludeIds: [],
    });
    expect(out.topHot).toHaveLength(10);
    const topIds = new Set(out.topHotIds);
    expect(out.timeline.length).toBe(2);
    for (const item of out.timeline) {
      expect(topIds.has(item.id)).toBe(false);
    }
  });

  it("翻页时带回 excludeIds，topHot id 仍排除", () => {
    // 25 张图，前 10 热门 + timeline 14 条；首页 pageSize=10 -> 拿前 10 timeline，应返回 nextCursor
    for (let i = 0; i < 25; i += 1) {
      insertImage(db, {
        id: `img-${i}`,
        useCount: i < 10 ? 1000 - i : 0,
        createdAt: 1000 + i,
      });
    }
    const page1 = listImages(db, {
      category: "welcome",
      rawCursor: "",
      pageSize: 10,
      excludeIds: [],
    });
    expect(page1.topHot).toHaveLength(10);
    expect(page1.timeline).toHaveLength(10);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = listImages(db, {
      category: "welcome",
      rawCursor: page1.nextCursor,
      pageSize: 10,
      excludeIds: page1.topHotIds,
    });
    // 25 - 10(topHot) - 10(page1 timeline) = 5 剩下
    expect(page2.topHot).toHaveLength(0);
    expect(page2.timeline).toHaveLength(5);
    const topIds = new Set(page1.topHotIds);
    for (const item of page2.timeline) {
      expect(topIds.has(item.id)).toBe(false);
    }
  });

  it("不同 category 互不污染", () => {
    insertImage(db, { id: "w-1", category: "welcome", useCount: 100 });
    insertImage(db, { id: "t-1", category: "thinking", useCount: 50 });
    insertImage(db, { id: "t-2", category: "thinking", useCount: 200 });

    const w = listImages(db, {
      category: "welcome",
      rawCursor: "",
      pageSize: 20,
      excludeIds: [],
    });
    const t = listImages(db, {
      category: "thinking",
      rawCursor: "",
      pageSize: 20,
      excludeIds: [],
    });
    expect(w.topHot.map((r) => r.id)).toEqual(["w-1"]);
    expect(t.topHot.map((r) => r.id)).toEqual(["t-2", "t-1"]);
  });

  it("仅 approved 出现；hidden / rejected / pending_ai 全部排除", () => {
    insertImage(db, { id: "ok", status: STATUS.APPROVED, useCount: 1 });
    insertImage(db, { id: "ho", status: STATUS.HIDDEN_BY_OWNER, useCount: 99 });
    insertImage(db, { id: "ha", status: STATUS.HIDDEN_BY_ADMIN, useCount: 99 });
    insertImage(db, { id: "rj", status: STATUS.REJECTED, useCount: 99 });
    insertImage(db, { id: "pe", status: STATUS.PENDING_AI, useCount: 99 });

    const out = listImages(db, {
      category: "welcome",
      rawCursor: "",
      pageSize: 20,
      excludeIds: [],
    });
    const ids = [...out.topHot, ...out.timeline].map((r) => r.id);
    expect(ids).toEqual(["ok"]);
  });

  it("空目录：topHot 和 timeline 都空，nextCursor null", () => {
    const out = listImages(db, {
      category: "welcome",
      rawCursor: "",
      pageSize: 20,
      excludeIds: [],
    });
    expect(out.topHot).toEqual([]);
    expect(out.timeline).toEqual([]);
    expect(out.nextCursor).toBeNull();
  });

  it("非法 cursor 当首页处理（不抛错）", () => {
    insertImage(db, { id: "x", useCount: 1 });
    const out = listImages(db, {
      category: "welcome",
      rawCursor: "garbage-not-base64-!!!",
      pageSize: 20,
      excludeIds: [],
    });
    // 当首页：topHot 应该有 x
    expect(out.topHot.map((r) => r.id)).toEqual(["x"]);
  });
});
