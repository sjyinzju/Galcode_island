// 图集路由端到端测试。
// 起独立内存 db + 随机端口 + 真 fetch，覆盖：
//   - 创建：成功 / 空名 / 名过长 / 空 imageIds / 不存在的图 / 跨 device 图 / 非 approved 图
//   - 查询：通过 / 404（被隐藏 + 不存在）
//   - by-image 反查：返回 active 图集，不返回 hidden 的
//   - visibility：本人隐藏 / 别人 403 / admin 下架后不可恢复
//   - 列表 endpoint 中 albumIds 字段是否填充
//   - m2m：同一图属于多个图集

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";

let serverInstance, baseUrl, db, STATUS, ALBUM_STATUS;

beforeAll(async () => {
  process.env.PORT = "0";
  process.env.DATA_DIR = `/tmp/galcode-albums-test-${Date.now()}`;
  process.env.UPLOADS_DIR = `/tmp/galcode-albums-test-${Date.now()}-up`;
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD_HASH = await bcrypt.hash("p4ss-w0rd!", 4);
  process.env.COOKIE_SECRET = "test-cookie-secret-1234567890";

  const { buildApp } = await import("../src/index.js");
  const dbMod = await import("../src/db.js");
  const cfgMod = await import("../src/config.js");
  const albumsMod = await import("../src/routes/albums.js");
  STATUS = cfgMod.STATUS;
  ALBUM_STATUS = albumsMod.ALBUM_STATUS;
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

beforeEach(() => {
  db.exec(
    "DELETE FROM album_images; DELETE FROM albums; DELETE FROM reports; DELETE FROM use_events; DELETE FROM images;",
  );
});

function insertImage(o) {
  const id = o.id;
  const now = o.createdAt ?? Date.now();
  db.prepare(
    `INSERT INTO images
      (id, device_id, category, file_hash, file_ext, mime, size_bytes, prompt,
       uploader_name, status, ai_verdict, use_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stub_pass', ?, ?, ?)`,
  ).run(
    id,
    o.deviceId ?? "device-aaaa1111",
    o.category ?? "welcome",
    o.fileHash ?? `hash-${id}`,
    o.fileExt ?? "png",
    o.mime ?? "image/png",
    o.sizeBytes ?? 1000,
    o.prompt ?? null,
    o.uploaderName ?? null,
    o.status ?? STATUS.APPROVED,
    o.useCount ?? 0,
    now,
    now,
  );
}

const OWNER = "device-aaaa1111";
const STRANGER = "device-bbbb2222";

async function createAlbum(payload, deviceId = OWNER) {
  const res = await fetch(`${baseUrl}/api/albums`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Device-Id": deviceId },
    body: JSON.stringify({ deviceId, ...payload }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

describe("POST /api/albums", () => {
  it("成功创建：返回 201 + album DTO + imageCount", async () => {
    insertImage({ id: "i1", category: "welcome" });
    insertImage({ id: "i2", category: "thinking" });
    const { status, body } = await createAlbum({
      name: "第一套",
      description: "我的初版",
      imageIds: ["i1", "i2"],
      uploaderName: "tester",
    });
    expect(status).toBe(201);
    expect(body.album.name).toBe("第一套");
    expect(body.album.description).toBe("我的初版");
    expect(body.album.uploaderName).toBe("tester");
    expect(body.album.imageCount).toBe(2);
    expect(body.album.status).toBe("active");
  });

  it("imageIds 去重", async () => {
    insertImage({ id: "i1" });
    const { body } = await createAlbum({ name: "n", imageIds: ["i1", "i1", "i1"] });
    expect(body.album.imageCount).toBe(1);
  });

  it("空 name → 400", async () => {
    insertImage({ id: "i1" });
    const { status } = await createAlbum({ name: "  ", imageIds: ["i1"] });
    expect(status).toBe(400);
  });

  it("name 超长 → 400", async () => {
    insertImage({ id: "i1" });
    const { status } = await createAlbum({ name: "x".repeat(81), imageIds: ["i1"] });
    expect(status).toBe(400);
  });

  it("空 imageIds → 400", async () => {
    const { status } = await createAlbum({ name: "n", imageIds: [] });
    expect(status).toBe(400);
  });

  it("imageIds 含不存在的 id → 400", async () => {
    insertImage({ id: "i1" });
    const { status } = await createAlbum({ name: "n", imageIds: ["i1", "ghost"] });
    expect(status).toBe(400);
  });

  it("imageIds 含跨 device 的图 → 403", async () => {
    insertImage({ id: "mine", deviceId: OWNER });
    insertImage({ id: "yours", deviceId: STRANGER });
    const { status, body } = await createAlbum({
      name: "n",
      imageIds: ["mine", "yours"],
    });
    expect(status).toBe(403);
    expect(body.error).toBe("forbidden");
  });

  it("imageIds 含非 approved 的图 → 400", async () => {
    insertImage({ id: "i1", status: STATUS.PENDING_AI });
    const { status } = await createAlbum({ name: "n", imageIds: ["i1"] });
    expect(status).toBe(400);
  });

  it("缺 deviceId → 400", async () => {
    insertImage({ id: "i1" });
    const res = await fetch(`${baseUrl}/api/albums`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "n", imageIds: ["i1"] }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/albums/:id", () => {
  it("成功返回：album + images 按 position 升序", async () => {
    insertImage({ id: "i1" });
    insertImage({ id: "i2" });
    const { body: created } = await createAlbum({
      name: "test",
      imageIds: ["i2", "i1"], // 故意倒序
    });
    const res = await fetch(`${baseUrl}/api/albums/${created.album.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.album.id).toBe(created.album.id);
    expect(body.images.map((i) => i.id)).toEqual(["i2", "i1"]);
    // 每张图都应该有 albumIds，含本图集
    for (const img of body.images) {
      expect(img.albumIds).toContain(created.album.id);
    }
  });

  it("不存在的 id → 404", async () => {
    const res = await fetch(`${baseUrl}/api/albums/no-such-id`);
    expect(res.status).toBe(404);
  });

  it("被 hidden_by_owner 的图集 → 404", async () => {
    insertImage({ id: "i1" });
    const { body } = await createAlbum({ name: "x", imageIds: ["i1"] });
    db.prepare("UPDATE albums SET status = ? WHERE id = ?").run(
      ALBUM_STATUS.HIDDEN_BY_OWNER,
      body.album.id,
    );
    const res = await fetch(`${baseUrl}/api/albums/${body.album.id}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/albums/by-image/:imageId", () => {
  it("返回该图所属的 active 图集列表", async () => {
    insertImage({ id: "shared" });
    insertImage({ id: "i2" });
    const a1 = await createAlbum({ name: "套1", imageIds: ["shared", "i2"] });
    const a2 = await createAlbum({ name: "套2", imageIds: ["shared"] });
    const res = await fetch(`${baseUrl}/api/albums/by-image/shared`);
    const body = await res.json();
    const ids = body.albums.map((a) => a.id).sort();
    expect(ids).toEqual([a1.body.album.id, a2.body.album.id].sort());
  });

  it("不返回 hidden 的图集", async () => {
    insertImage({ id: "i1" });
    const a = await createAlbum({ name: "hidden", imageIds: ["i1"] });
    db.prepare("UPDATE albums SET status = ? WHERE id = ?").run(
      ALBUM_STATUS.HIDDEN_BY_ADMIN,
      a.body.album.id,
    );
    const res = await fetch(`${baseUrl}/api/albums/by-image/i1`);
    const body = await res.json();
    expect(body.albums).toEqual([]);
  });

  it("无图集时返回空数组", async () => {
    insertImage({ id: "lonely" });
    const res = await fetch(`${baseUrl}/api/albums/by-image/lonely`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.albums).toEqual([]);
  });
});

describe("PATCH /api/albums/:id/visibility", () => {
  it("本人隐藏 → 200 + 反查列表不再出现", async () => {
    insertImage({ id: "i1" });
    const a = await createAlbum({ name: "x", imageIds: ["i1"] });
    const r = await fetch(`${baseUrl}/api/albums/${a.body.album.id}/visibility`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: OWNER, hidden: true }),
    });
    expect(r.status).toBe(200);
    const list = await fetch(`${baseUrl}/api/albums/by-image/i1`);
    expect((await list.json()).albums).toEqual([]);
  });

  it("非本人 → 403", async () => {
    insertImage({ id: "i1" });
    const a = await createAlbum({ name: "x", imageIds: ["i1"] });
    const r = await fetch(`${baseUrl}/api/albums/${a.body.album.id}/visibility`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: STRANGER, hidden: true }),
    });
    expect(r.status).toBe(403);
  });

  it("被 admin 下架后，本人不能恢复 → 403 locked_by_admin", async () => {
    insertImage({ id: "i1" });
    const a = await createAlbum({ name: "x", imageIds: ["i1"] });
    db.prepare("UPDATE albums SET status = ? WHERE id = ?").run(
      ALBUM_STATUS.HIDDEN_BY_ADMIN,
      a.body.album.id,
    );
    const r = await fetch(`${baseUrl}/api/albums/${a.body.album.id}/visibility`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: OWNER, hidden: false }),
    });
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.error).toBe("locked_by_admin");
  });
});

describe("/api/images?category= 返回的 image.albumIds 包含所属图集", () => {
  it("一张图属于两个图集 → albumIds 包含两个 id", async () => {
    insertImage({ id: "shared", category: "thinking" });
    const a1 = await createAlbum({ name: "1", imageIds: ["shared"] });
    const a2 = await createAlbum({ name: "2", imageIds: ["shared"] });
    const res = await fetch(`${baseUrl}/api/images?category=thinking`);
    const body = await res.json();
    const img = body.items.find((x) => x.id === "shared");
    expect(img).toBeTruthy();
    expect(img.albumIds.sort()).toEqual(
      [a1.body.album.id, a2.body.album.id].sort(),
    );
  });

  it("游离图（不属于任何图集）→ albumIds 是空数组", async () => {
    insertImage({ id: "free", category: "welcome" });
    const res = await fetch(`${baseUrl}/api/images?category=welcome`);
    const body = await res.json();
    const img = body.items.find((x) => x.id === "free");
    expect(img.albumIds).toEqual([]);
  });
});
