// 迁移路径专项测试：
//   - 老库（file_hash 单列 UNIQUE）→ 自动迁移成功，数据保留
//   - 迁移幂等（重复调用 no-op）
//   - 新 schema 直接建库时跳过迁移
//   - 上传 endpoint 的"同 device 同 hash 去重 + 跨 device 同 hash 允许多行"端到端

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";

let serverInstance, baseUrl, db, STATUS;

beforeAll(async () => {
  process.env.PORT = "0";
  process.env.DATA_DIR = `/tmp/galcode-migration-test-${Date.now()}`;
  process.env.UPLOADS_DIR = `/tmp/galcode-migration-test-${Date.now()}-up`;
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

beforeEach(() => {
  db.exec(
    "DELETE FROM album_images; DELETE FROM albums; DELETE FROM reports; DELETE FROM use_events; DELETE FROM images;",
  );
});

describe("migrateImagesUniqueHash", () => {
  it("老库（列级 UNIQUE）→ 检测出来 + 迁移 + 数据保留", async () => {
    const dbMod = await import("../src/db.js");
    const legacy = dbMod.buildLegacyInMemoryDb();
    legacy
      .prepare(
        `INSERT INTO images (id, device_id, category, file_hash, file_ext, mime, size_bytes, status, ai_verdict, use_count, created_at, updated_at) VALUES ('a','dA','welcome','hA','png','image/png',1,'approved','stub',0,1,1)`,
      )
      .run();
    legacy
      .prepare(
        `INSERT INTO images (id, device_id, category, file_hash, file_ext, mime, size_bytes, status, ai_verdict, use_count, created_at, updated_at) VALUES ('b','dB','thinking','hB','png','image/png',2,'approved','stub',0,2,2)`,
      )
      .run();

    expect(dbMod.detectLegacyHashUnique(legacy)).toBe(true);
    expect(dbMod.migrateImagesUniqueHash(legacy)).toBe(true);
    expect(dbMod.detectLegacyHashUnique(legacy)).toBe(false);

    // 数据完整保留
    const rows = legacy
      .prepare("SELECT id, device_id, file_hash FROM images ORDER BY id")
      .all();
    expect(rows).toEqual([
      { id: "a", device_id: "dA", file_hash: "hA" },
      { id: "b", device_id: "dB", file_hash: "hB" },
    ]);

    // 新约束生效：同 device 同 hash UNIQUE
    expect(() => {
      legacy
        .prepare(
          `INSERT INTO images (id, device_id, category, file_hash, file_ext, mime, size_bytes, status, ai_verdict, use_count, created_at, updated_at) VALUES ('dup','dA','welcome','hA','png','image/png',1,'approved','stub',0,3,3)`,
        )
        .run();
    }).toThrow(/UNIQUE/);

    // 跨 device 同 hash 允许
    legacy
      .prepare(
        `INSERT INTO images (id, device_id, category, file_hash, file_ext, mime, size_bytes, status, ai_verdict, use_count, created_at, updated_at) VALUES ('c','dC','welcome','hA','png','image/png',1,'approved','stub',0,4,4)`,
      )
      .run();
    expect(
      legacy.prepare("SELECT COUNT(*) AS c FROM images WHERE file_hash = 'hA'").get().c,
    ).toBe(2);
  });

  it("迁移幂等：第二次调用返回 false 不变更", async () => {
    const dbMod = await import("../src/db.js");
    const legacy = dbMod.buildLegacyInMemoryDb();
    expect(dbMod.migrateImagesUniqueHash(legacy)).toBe(true);
    expect(dbMod.migrateImagesUniqueHash(legacy)).toBe(false);
  });

  it("新库（buildInMemoryDb）→ 不需要迁移", async () => {
    const dbMod = await import("../src/db.js");
    const fresh = dbMod.buildInMemoryDb();
    expect(dbMod.detectLegacyHashUnique(fresh)).toBe(false);
    expect(dbMod.migrateImagesUniqueHash(fresh)).toBe(false);
  });
});

describe("migrateBrokenFkReferences（修上一版 migration bug 残留）", () => {
  function buildProdBrokenDb() {
    // 模拟生产数据库实际状态：images 已经迁移到新 schema，但 album_images / reports /
    // use_events 的 FOREIGN KEY 引用仍然是 images_legacy_unique_hash（被 SQLite 的
    // ALTER TABLE RENAME 自动改名行为污染过）。
    const Database = require("better-sqlite3");
    const db = new Database(":memory:");
    db.pragma("foreign_keys = OFF");
    db.exec(`
      CREATE TABLE images (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        category TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        file_ext TEXT NOT NULL,
        mime TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        width INTEGER, height INTEGER, prompt TEXT, uploader_name TEXT,
        status TEXT NOT NULL, ai_verdict TEXT,
        use_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE albums (
        id TEXT PRIMARY KEY, device_id TEXT NOT NULL, name TEXT NOT NULL,
        description TEXT, uploader_name TEXT, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE album_images (
        album_id        TEXT NOT NULL,
        image_id        TEXT NOT NULL,
        position        INTEGER NOT NULL DEFAULT 0,
        added_at        INTEGER NOT NULL,
        PRIMARY KEY (album_id, image_id),
        FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE,
        FOREIGN KEY (image_id) REFERENCES "images_legacy_unique_hash"(id) ON DELETE CASCADE
      );
      CREATE TABLE reports (
        id TEXT PRIMARY KEY, image_id TEXT NOT NULL, device_id TEXT NOT NULL,
        reason TEXT, created_at INTEGER NOT NULL,
        UNIQUE(image_id, device_id),
        FOREIGN KEY (image_id) REFERENCES "images_legacy_unique_hash"(id) ON DELETE CASCADE
      );
      CREATE TABLE use_events (
        image_id TEXT NOT NULL, device_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (image_id, device_id),
        FOREIGN KEY (image_id) REFERENCES "images_legacy_unique_hash"(id) ON DELETE CASCADE
      );
    `);
    db.pragma("foreign_keys = ON");
    return db;
  }

  it("检测出 3 张坏 FK 表，重建后 sql 指向 images", async () => {
    const dbMod = await import("../src/db.js");
    const broken = buildProdBrokenDb();
    expect(dbMod.migrateBrokenFkReferences(broken)).toBe(true);
    for (const name of ["album_images", "reports", "use_events"]) {
      const sql = broken
        .prepare("SELECT sql FROM sqlite_master WHERE name=?")
        .get(name).sql;
      expect(sql).not.toContain("images_legacy_unique_hash");
      expect(sql).toMatch(/REFERENCES\s+images\b/);
    }
  });

  it("修复后 FK 行为正确：INSERT album_images 不再 500", async () => {
    const dbMod = await import("../src/db.js");
    const broken = buildProdBrokenDb();
    dbMod.migrateBrokenFkReferences(broken);
    broken.pragma("foreign_keys = ON");
    // 准备 image + album
    broken
      .prepare(
        `INSERT INTO images (id, device_id, category, file_hash, file_ext, mime, size_bytes, status, ai_verdict, use_count, created_at, updated_at) VALUES (?, ?, 'welcome','h','png','image/png',1,'approved','stub',0,1,1)`,
      )
      .run("img1", "dev");
    broken
      .prepare(
        `INSERT INTO albums (id, device_id, name, status, created_at, updated_at) VALUES (?, ?, 'a', 'active', 1, 1)`,
      )
      .run("a1", "dev");
    // 关键：INSERT album_images 是之前 500 的入口
    expect(() => {
      broken
        .prepare(
          `INSERT INTO album_images (album_id, image_id, position, added_at) VALUES (?, ?, 0, 1)`,
        )
        .run("a1", "img1");
    }).not.toThrow();
  });

  it("修复保留原有数据", async () => {
    const dbMod = await import("../src/db.js");
    const broken = buildProdBrokenDb();
    // 在坏 FK 的 album_images 里塞一行（FK enforcement 关掉绕过）
    broken.pragma("foreign_keys = OFF");
    broken
      .prepare(
        `INSERT INTO images (id, device_id, category, file_hash, file_ext, mime, size_bytes, status, ai_verdict, use_count, created_at, updated_at) VALUES ('old','dev','welcome','h','png','image/png',1,'approved','stub',0,1,1)`,
      )
      .run();
    broken
      .prepare(
        `INSERT INTO albums (id, device_id, name, status, created_at, updated_at) VALUES ('a','dev','old','active',1,1)`,
      )
      .run();
    broken
      .prepare(
        `INSERT INTO album_images (album_id, image_id, position, added_at) VALUES ('a','old',0,1)`,
      )
      .run();
    broken.pragma("foreign_keys = ON");

    dbMod.migrateBrokenFkReferences(broken);
    const rows = broken.prepare("SELECT * FROM album_images").all();
    expect(rows).toEqual([
      { album_id: "a", image_id: "old", position: 0, added_at: 1 },
    ]);
  });

  it("无损坏时 no-op（返回 false）", async () => {
    const dbMod = await import("../src/db.js");
    const fresh = dbMod.buildInMemoryDb();
    expect(dbMod.migrateBrokenFkReferences(fresh)).toBe(false);
  });
});

describe("POST /api/images dedupe 行为（新 schema）", () => {
  function makePng(varyByte) {
    // 极简 PNG 头 + tEXt 注入 random byte 让 hash 唯一可控
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    function chunk(type, data) {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length, 0);
      const td = Buffer.concat([Buffer.from(type), data]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crypto.createHash("sha1").update(td).digest().readUInt32BE(0), 0);
      // 注：CRC 不算严格的 png crc32，但 multer 接受 image/png mime + magic 不算 crc
      return Buffer.concat([len, td, crc]);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0); // width
    ihdr.writeUInt32BE(1, 4); // height
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const text = Buffer.from(`vary\x00${varyByte}`);
    const idat = Buffer.from([0x78, 0x9c, 0x62, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]);
    return Buffer.concat([
      sig,
      chunk("IHDR", ihdr),
      chunk("tEXt", text),
      chunk("IDAT", idat),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }

  async function uploadAs(deviceId, pngBytes) {
    const fd = new FormData();
    fd.append("file", new Blob([pngBytes], { type: "image/png" }), "x.png");
    fd.append("deviceId", deviceId);
    fd.append("category", "welcome");
    const res = await fetch(`${baseUrl}/api/images`, {
      method: "POST",
      headers: { "X-Device-Id": deviceId },
      body: fd,
    });
    return { status: res.status, body: await res.json() };
  }

  it("同 device 同 hash → 第二次 duplicate=true 返回相同 image.id", async () => {
    const png = makePng("a");
    const r1 = await uploadAs("dev-aaaa1111", png);
    expect(r1.status).toBe(201);
    expect(r1.body.duplicate).toBe(false);
    const r2 = await uploadAs("dev-aaaa1111", png);
    expect(r2.status).toBe(200);
    expect(r2.body.duplicate).toBe(true);
    expect(r2.body.image.id).toBe(r1.body.image.id);
    expect(r2.body.image.deviceId).toBe("dev-aaaa1111");
  });

  it("跨 device 同 hash → 各自创建独立 image，device_id 是 caller", async () => {
    const png = makePng("b");
    const ra = await uploadAs("dev-aaaa1111", png);
    const rb = await uploadAs("dev-bbbb2222", png);
    expect(ra.status).toBe(201);
    expect(rb.status).toBe(201);
    expect(ra.body.duplicate).toBe(false);
    expect(rb.body.duplicate).toBe(false);
    expect(rb.body.image.id).not.toBe(ra.body.image.id);
    expect(ra.body.image.deviceId).toBe("dev-aaaa1111");
    expect(rb.body.image.deviceId).toBe("dev-bbbb2222");

    // 物理文件复用 hash 命名，只有 1 个磁盘文件
    const fs = await import("node:fs");
    const path = await import("node:path");
    const cfg = await import("../src/config.js");
    const files = fs.readdirSync(cfg.config.uploadsDir).filter((f) => f.startsWith(ra.body.image.url.split("/").pop().split(".")[0]));
    // ra/rb url 共享同一 hash 文件
    expect(ra.body.image.url).toBe(rb.body.image.url);
    expect(files.length).toBe(1);
    void path;
  });

  it("跨 device 同 hash 后，createAlbum 用本 device 的 id 应成功（不再 403）", async () => {
    const png = makePng("c");
    const ra = await uploadAs("dev-aaaa1111", png);
    const rb = await uploadAs("dev-bbbb2222", png);
    // dev-bbbb2222 拿自己的 image id 建图集 → 应该成功
    const album = await fetch(`${baseUrl}/api/albums`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": "dev-bbbb2222" },
      body: JSON.stringify({ deviceId: "dev-bbbb2222", name: "n", imageIds: [rb.body.image.id] }),
    });
    expect(album.status).toBe(201);
    // 但若用 A 的 id → 应该 403
    const wrong = await fetch(`${baseUrl}/api/albums`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": "dev-bbbb2222" },
      body: JSON.stringify({ deviceId: "dev-bbbb2222", name: "n2", imageIds: [ra.body.image.id] }),
    });
    expect(wrong.status).toBe(403);
  });
});
