// 需求 3 端到端测试：点赞日配额 + 分页 + 排序 + 图集列表。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";

let serverInstance, baseUrl, db, STATUS;
const DEV_A = "dev-aaaa-1111";
const DEV_B = "dev-bbbb-2222";

beforeAll(async () => {
  process.env.PORT = "0";
  process.env.DATA_DIR = `/tmp/galcode-likes-test-${Date.now()}`;
  process.env.UPLOADS_DIR = `/tmp/galcode-likes-test-${Date.now()}-up`;
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD_HASH = await bcrypt.hash("p", 4);
  process.env.COOKIE_SECRET = "test-secret-1234567890";
  const { buildApp } = await import("../src/index.js");
  const dbMod = await import("../src/db.js");
  const cfgMod = await import("../src/config.js");
  STATUS = cfgMod.STATUS;
  db = dbMod.getDb();
  const app = buildApp();
  await new Promise((resolve) => {
    serverInstance = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${serverInstance.address().port}`;
      resolve();
    });
  });
});
afterAll(async () => {
  await new Promise((resolve) => serverInstance.close(resolve));
});
let _resetRateLimit;
beforeAll(async () => {
  const rl = await import("../src/lib/rateLimit.js");
  _resetRateLimit = rl._resetRateLimitForTests;
});
beforeEach(() => {
  db.exec(
    "DELETE FROM album_images; DELETE FROM albums; DELETE FROM daily_like_quota; DELETE FROM reports; DELETE FROM use_events; DELETE FROM images;",
  );
  // rateLimit 是 module-level 状态，跨测试累计；逐个清掉避免跨用例触发 429
  _resetRateLimit?.();
});

function insertImage(o) {
  const now = o.createdAt ?? Date.now();
  db.prepare(
    `INSERT INTO images
      (id, device_id, category, file_hash, file_ext, mime, size_bytes, status, ai_verdict,
       use_count, likes, popularity, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'png', 'image/png', 100, ?, 'stub', ?, ?, ?, ?, ?)`,
  ).run(
    o.id,
    o.deviceId ?? DEV_A,
    o.category ?? "welcome",
    o.fileHash ?? `hash-${o.id}`,
    o.status ?? STATUS.APPROVED,
    o.useCount ?? 0,
    o.likes ?? 0,
    o.popularity ?? (o.useCount ?? 0) + 3 * (o.likes ?? 0),
    now,
    now,
  );
}

function insertAlbum(o) {
  const now = o.createdAt ?? Date.now();
  db.prepare(
    `INSERT INTO albums (id, device_id, name, status, likes, popularity, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
  ).run(o.id, o.deviceId ?? DEV_A, o.name ?? "n", o.likes ?? 0, o.popularity ?? 3 * (o.likes ?? 0), now, now);
}

// ------------------------------ likes ------------------------------

describe("POST /api/images/:id/like 日配额", () => {
  it("每次 +1，第 10 次后 dailyRemaining=0；第 11 次 → 429", async () => {
    insertImage({ id: "img1" });
    for (let i = 1; i <= 10; i += 1) {
      const r = await fetch(`${baseUrl}/api/images/img1/like`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: DEV_A }),
      });
      const body = await r.json();
      expect(r.status).toBe(200);
      expect(body.likes).toBe(i);
      expect(body.dailyRemaining).toBe(10 - i);
    }
    // 第 11 次拒绝
    const r11 = await fetch(`${baseUrl}/api/images/img1/like`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: DEV_A }),
    });
    expect(r11.status).toBe(429);
    const body = await r11.json();
    expect(body.error).toBe("daily_limit");
    expect(body.dailyRemaining).toBe(0);
    // images.likes 仍是 10（不会被超额 +1）
    const cur = db.prepare("SELECT likes, popularity FROM images WHERE id='img1'").get();
    expect(cur.likes).toBe(10);
    expect(cur.popularity).toBe(0 + 3 * 10); // use_count=0 + 3*likes
  });

  it("跨设备配额独立：B 还能继续点", async () => {
    insertImage({ id: "img2" });
    // A 点满 10
    for (let i = 0; i < 10; i += 1) {
      await fetch(`${baseUrl}/api/images/img2/like`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: DEV_A }),
      });
    }
    // B 应该能从 0 开始点
    const r = await fetch(`${baseUrl}/api/images/img2/like`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: DEV_B }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.dailyRemaining).toBe(9);
    expect(body.likes).toBe(11);
  });

  it("不存在 / hidden 图 → 404", async () => {
    const r1 = await fetch(`${baseUrl}/api/images/no-such/like`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: DEV_A }),
    });
    expect(r1.status).toBe(404);
    insertImage({ id: "h1", status: STATUS.HIDDEN_BY_OWNER });
    const r2 = await fetch(`${baseUrl}/api/images/h1/like`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: DEV_A }),
    });
    expect(r2.status).toBe(404);
  });
});

describe("POST /api/albums/:id/like 日配额（同 image）", () => {
  it("加到 10 后第 11 次 429", async () => {
    insertAlbum({ id: "a1" });
    for (let i = 0; i < 10; i += 1) {
      const r = await fetch(`${baseUrl}/api/albums/a1/like`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId: DEV_A }),
      });
      expect(r.status).toBe(200);
    }
    const r11 = await fetch(`${baseUrl}/api/albums/a1/like`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: DEV_A }),
    });
    expect(r11.status).toBe(429);
    const cur = db.prepare("SELECT likes, popularity FROM albums WHERE id='a1'").get();
    expect(cur.likes).toBe(10);
    expect(cur.popularity).toBe(30); // 3 * 10
  });
});

// ------------------------------ pagination ------------------------------

describe("GET /api/images 分页 + 排序", () => {
  it("按 popularity DESC 排（默认）", async () => {
    insertImage({ id: "low", popularity: 1 });
    insertImage({ id: "mid", popularity: 5 });
    insertImage({ id: "hi", popularity: 9 });
    const r = await fetch(`${baseUrl}/api/images?category=welcome`);
    const body = await r.json();
    expect(body.items.map((i) => i.id)).toEqual(["hi", "mid", "low"]);
    expect(body.page).toBe(1);
    expect(body.total).toBe(3);
    expect(body.sort).toBe("popular");
  });

  it("sort=time → created_at DESC", async () => {
    insertImage({ id: "old", createdAt: 100, popularity: 99 });
    insertImage({ id: "new", createdAt: 200, popularity: 0 });
    const r = await fetch(
      `${baseUrl}/api/images?category=welcome&sort=time`,
    );
    const body = await r.json();
    expect(body.items.map((i) => i.id)).toEqual(["new", "old"]);
    expect(body.sort).toBe("time");
  });

  it("分页：page=2 pageSize=2 拿第二页", async () => {
    for (let i = 0; i < 5; i += 1) {
      insertImage({ id: `i${i}`, popularity: 100 - i, createdAt: 1000 + i });
    }
    const r = await fetch(
      `${baseUrl}/api/images?category=welcome&page=2&pageSize=2`,
    );
    const body = await r.json();
    expect(body.items.length).toBe(2);
    expect(body.page).toBe(2);
    expect(body.totalPages).toBe(3); // 5/2 向上
  });

  it("超出页数 → 空 items", async () => {
    insertImage({ id: "only" });
    const r = await fetch(
      `${baseUrl}/api/images?category=welcome&page=99&pageSize=10`,
    );
    const body = await r.json();
    expect(body.items).toEqual([]);
    expect(body.totalPages).toBe(1);
  });

  it("image DTO 含 likes + popularity 字段", async () => {
    insertImage({ id: "x", likes: 3, useCount: 2, popularity: 11 });
    const r = await fetch(`${baseUrl}/api/images?category=welcome`);
    const body = await r.json();
    const img = body.items[0];
    expect(img.likes).toBe(3);
    expect(img.useCount).toBe(2);
    expect(img.popularity).toBe(11);
  });

  it("旧 cursor 路径仍工作（兼容）", async () => {
    insertImage({ id: "a", popularity: 1 });
    const r = await fetch(`${baseUrl}/api/images?category=welcome&cursor=`);
    const body = await r.json();
    // 老形态：topHot + timeline
    expect(Array.isArray(body.topHot)).toBe(true);
    expect(Array.isArray(body.timeline)).toBe(true);
  });
});

describe("GET /api/albums 图集列表", () => {
  it("按 popularity DESC + 时间分页", async () => {
    insertAlbum({ id: "alo", likes: 1, popularity: 3, createdAt: 100 });
    insertAlbum({ id: "amid", likes: 2, popularity: 6, createdAt: 200 });
    insertAlbum({ id: "ahi", likes: 5, popularity: 15, createdAt: 300 });
    const r = await fetch(`${baseUrl}/api/albums?sort=popular`);
    const body = await r.json();
    expect(body.items.map((a) => a.id)).toEqual(["ahi", "amid", "alo"]);
  });

  it("含 cover url（第一张图的 url）", async () => {
    insertImage({ id: "img-cover", fileHash: "abc", fileExt: "png" });
    insertAlbum({ id: "alb1" });
    db.prepare(
      "INSERT INTO album_images (album_id, image_id, position, added_at) VALUES (?, ?, 0, 1)",
    ).run("alb1", "img-cover");
    const r = await fetch(`${baseUrl}/api/albums`);
    const body = await r.json();
    expect(body.items[0].coverUrl).toMatch(/\/uploads\/abc\.png$/);
    expect(body.items[0].imageCount).toBe(1);
    expect(body.items[0].likes).toBe(0);
  });

  it("hidden album 不出现", async () => {
    insertAlbum({ id: "ok" });
    db.prepare("INSERT INTO albums (id, device_id, name, status, likes, popularity, created_at, updated_at) VALUES ('hid','dev','h','hidden_by_admin',0,0,1,1)").run();
    const r = await fetch(`${baseUrl}/api/albums`);
    const body = await r.json();
    expect(body.items.map((a) => a.id)).toEqual(["ok"]);
  });
});
