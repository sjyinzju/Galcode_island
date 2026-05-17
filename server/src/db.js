// better-sqlite3 同步 API：少一层 Promise，路由里直接拿值；
// SQLite 单文件，dev/部署/迁移都最简。
//
// 启动时建表（IF NOT EXISTS），不依赖外部 migration 工具。
// 字段变更走 PRAGMA user_version + 手写 migration，暂未使用——schema 还在 Phase 1 设计期。

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";

let dbInstance = null;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS images (
  id              TEXT PRIMARY KEY,
  device_id       TEXT NOT NULL,
  category        TEXT NOT NULL,
  -- 注意：file_hash 不是单列 UNIQUE，唯一性是 (device_id, file_hash) 复合（见下方索引）。
  -- 这样同一张图（hash 相同）可以被多个设备各自上传一份，每个 device 拥有自己的 image 行。
  -- 物理文件按 hash 命名，自然复用：第一次上传时落盘，后续 device 上传同 hash 时跳过写盘。
  file_hash       TEXT NOT NULL,
  file_ext        TEXT NOT NULL,
  mime            TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  width           INTEGER,
  height          INTEGER,
  prompt          TEXT,
  uploader_name   TEXT,
  status          TEXT NOT NULL,
  ai_verdict      TEXT,
  use_count       INTEGER NOT NULL DEFAULT 0,
  likes           INTEGER NOT NULL DEFAULT 0,
  popularity      INTEGER NOT NULL DEFAULT 0,    -- 物化 = use_count + 3*likes，like/use 时同步更新
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- 注意：idx_images_popular 引用 popularity 列，但老库的 popularity 列要 migrateAddLikesPopularity
-- 之后才存在。所以**不**放在 SCHEMA_SQL 里，挪到 migrateAddLikesPopularity 末尾建。

-- 翻页时按时间倒序：(category, status) 等值 + (created_at DESC) 排序
CREATE INDEX IF NOT EXISTS idx_images_time
  ON images(category, status, created_at DESC, id DESC);

-- 同 device 同 hash 唯一：让 upload dedupe 返回该 device 自己的旧 image 行；
-- 跨 device 同 hash 允许多行存在。
CREATE UNIQUE INDEX IF NOT EXISTS idx_images_device_hash
  ON images(device_id, file_hash);

CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,
  image_id    TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  reason      TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE(image_id, device_id),
  FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reports_image ON reports(image_id);

-- 一台设备对一张图只算一次"使用"，幂等
CREATE TABLE IF NOT EXISTS use_events (
  image_id    TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (image_id, device_id),
  FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
);

-- Phase 3 才填数据；表先建
CREATE TABLE IF NOT EXISTS admins (
  username    TEXT PRIMARY KEY,
  pw_hash     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- 图集：一组关联的图，由同一 device 一次性"保存到云端"产生
CREATE TABLE IF NOT EXISTS albums (
  id              TEXT PRIMARY KEY,
  device_id       TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  uploader_name   TEXT,
  status          TEXT NOT NULL,            -- active / hidden_by_owner / hidden_by_admin
  likes           INTEGER NOT NULL DEFAULT 0,
  popularity      INTEGER NOT NULL DEFAULT 0,    -- 物化 = 3*likes（album 无 use 概念）
  -- 管理密钥：创建时生成的 32 字节 hex token，**只在 POST /api/albums 响应里返一次**。
  -- 后续走密钥认证的端点（POST /manage / PATCH 元数据 / PATCH 可见性）都比对它。
  -- 老库迁移时填空串 = "无密钥"，对应 album 只能用 device_id 同设备路径管理。
  management_key  TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_albums_by_device ON albums(device_id, created_at DESC);
-- 注意：idx_albums_popular 引用 popularity 列，由 migrateAddLikesPopularity 建（同上）
-- 注意：idx_albums_management_key 引用 management_key 列。老库初次启动时该列由
--   migrateAddLikesPopularity 通过 ALTER ADD COLUMN 加上——必须等列建好才能建索引，
--   所以这条索引也放到 migrateAddLikesPopularity 里建，SCHEMA_SQL 不要写。
-- 图集列表按时间倒序
CREATE INDEX IF NOT EXISTS idx_albums_time
  ON albums(status, created_at DESC, id DESC);

-- 图集 → 图 多对多关联（一张图可属于多个图集）
CREATE TABLE IF NOT EXISTS album_images (
  album_id        TEXT NOT NULL,
  image_id        TEXT NOT NULL,
  position        INTEGER NOT NULL DEFAULT 0,
  added_at        INTEGER NOT NULL,
  PRIMARY KEY (album_id, image_id),
  FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE,
  FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
);
-- 反向查询：一张图属于哪些图集（"查看所属图集" 入口走的索引）
CREATE INDEX IF NOT EXISTS idx_album_images_by_image ON album_images(image_id);

-- 每个 device 对每个 image/album 每天的"点赞配额"使用记录。
-- date_str 用 UTC YYYY-MM-DD（toISOString().slice(0,10)）—— 简单、不依赖 server 时区，
-- 用户在 UTC 0 点重置（对 CST 用户 = 早 8 点，可接受）。
-- consumed_count 软上限 10，由路由层校验；这里允许 > 10 用于日志审计（不约束）。
CREATE TABLE IF NOT EXISTS daily_like_quota (
  target_type      TEXT NOT NULL,            -- 'image' | 'album'
  target_id        TEXT NOT NULL,
  device_id        TEXT NOT NULL,
  date_str         TEXT NOT NULL,            -- 'YYYY-MM-DD'，UTC
  consumed_count   INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (target_type, target_id, device_id, date_str)
);
-- 反向查询：某 image/album 一共被多少 device 点过赞（管理面板未来要用）
CREATE INDEX IF NOT EXISTS idx_daily_like_quota_by_target
  ON daily_like_quota(target_type, target_id);
`;

/// 检查老库的 images 表 schema 里 file_hash 是否单列 UNIQUE。
/// 是 → 需要 rebuild 表把 UNIQUE 改成 (device_id, file_hash) 复合。
/// 不是 → 已经是新 schema，跳过。
function detectLegacyHashUnique(db) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='images'")
    .get();
  if (!row || !row.sql) return false;
  // 老 schema：`file_hash       TEXT NOT NULL UNIQUE`（列级 UNIQUE）
  return /file_hash\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(row.sql);
}

/// 把老的 images 表（file_hash UNIQUE）迁移到新的 schema：
///   1. 临时禁 FK（否则 DROP TABLE 会级联清掉 album_images / reports / use_events）
///   2. RENAME 旧表
///   3. CREATE 新 images（无列级 UNIQUE）
///   4. INSERT SELECT 显式列名搬迁数据
///   5. CREATE UNIQUE INDEX (device_id, file_hash) —— 老数据每个 hash 至多 1 行，约束自然满足
///   6. DROP 旧表
///   7. 启 FK
/// 整个流程包在事务里；失败回滚 + FK 恢复，老数据安全。
function migrateImagesUniqueHash(db) {
  if (!detectLegacyHashUnique(db)) return false;
  console.log(
    "[migration] images.file_hash 单列 UNIQUE → (device_id, file_hash) 复合 UNIQUE，开始迁移…",
  );
  db.pragma("foreign_keys = OFF");
  // 关键：SQLite >=3.25 默认 legacy_alter_table=OFF，ALTER TABLE RENAME 会自动
  // 修改其它表里指向该表的 FOREIGN KEY 引用名字。我们立刻又 CREATE 同名表
  // + DROP 旧名表，但 FK 引用没复原 → 后续任何插入都 "no such table: <legacy>"。
  // 开 legacy_alter_table=ON 让 RENAME 不动 FK references，root cause 修好。
  db.pragma("legacy_alter_table = ON");
  let actuallyMigrated = false;
  try {
    const tx = db.transaction(() => {
      // 在 transaction 内**重新检测**：如果别的进程刚刚已经做完了迁移
      // （SQLite 多进程下两个 connection 都触发 init 时可能发生），
      // 我们看到的快照仍是老 schema，但实际上文件已经是新 schema。
      // 这种情况 ALTER RENAME 之后 INSERT SELECT 可能搬空表 / 破坏数据。
      // 重新查 sqlite_master 拿"当前最新可见"版本，不是 legacy 就跳过。
      if (!detectLegacyHashUnique(db)) {
        return; // 让事务空 commit
      }
      actuallyMigrated = true;
      db.exec("ALTER TABLE images RENAME TO images_legacy_unique_hash");
      // 与 SCHEMA_SQL 里 images 表定义保持一致（无列级 UNIQUE）
      db.exec(`
        CREATE TABLE images (
          id              TEXT PRIMARY KEY,
          device_id       TEXT NOT NULL,
          category        TEXT NOT NULL,
          file_hash       TEXT NOT NULL,
          file_ext        TEXT NOT NULL,
          mime            TEXT NOT NULL,
          size_bytes      INTEGER NOT NULL,
          width           INTEGER,
          height          INTEGER,
          prompt          TEXT,
          uploader_name   TEXT,
          status          TEXT NOT NULL,
          ai_verdict      TEXT,
          use_count       INTEGER NOT NULL DEFAULT 0,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        );
      `);
      db.exec(`
        INSERT INTO images
          (id, device_id, category, file_hash, file_ext, mime, size_bytes,
           width, height, prompt, uploader_name, status, ai_verdict, use_count,
           created_at, updated_at)
        SELECT
          id, device_id, category, file_hash, file_ext, mime, size_bytes,
          width, height, prompt, uploader_name, status, ai_verdict, use_count,
          created_at, updated_at
        FROM images_legacy_unique_hash;
      `);
      db.exec("DROP TABLE images_legacy_unique_hash");
    });
    tx();
    if (!actuallyMigrated) {
      console.log(
        "[migration] 进入事务时检测到别的进程已完成迁移，本进程跳过",
      );
      return false;
    }
    // 索引在事务外重建（CREATE INDEX 也不影响 FK 但放外面更直观）
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_images_device_hash ON images(device_id, file_hash)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_images_list ON images(category, status, use_count DESC, created_at DESC)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_images_time ON images(category, status, created_at DESC, id DESC)",
    );
    const count = db.prepare("SELECT COUNT(*) AS c FROM images").get().c;
    console.log(`[migration] 迁移完成，images 行数 = ${count}`);
    return true;
  } finally {
    db.pragma("legacy_alter_table = OFF");
    db.pragma("foreign_keys = ON");
  }
}

/// 修复历史 migration bug 残留：上一版 migrateImagesUniqueHash 没开 legacy_alter_table，
/// 导致 ALTER TABLE images RENAME TO images_legacy_unique_hash 时 SQLite 把 album_images /
/// reports / use_events 三张表的 FOREIGN KEY 引用名字也改成 images_legacy_unique_hash。
/// 而该表已被 DROP，后续任何 INSERT 都会 "no such table: images_legacy_unique_hash" 500。
///
/// 修法：检测三张表 sql 文本里是否包含损坏的引用，是则重建表（COPY 数据 + drop + rename）。
/// 重建过程禁用 FK enforcement 避免数据级联清空。
function migrateBrokenFkReferences(db) {
  const BAD = "images_legacy_unique_hash";
  const fixSpecs = {
    album_images: {
      create: `CREATE TABLE album_images_fixed (
        album_id        TEXT NOT NULL,
        image_id        TEXT NOT NULL,
        position        INTEGER NOT NULL DEFAULT 0,
        added_at        INTEGER NOT NULL,
        PRIMARY KEY (album_id, image_id),
        FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE,
        FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
      )`,
      copy: `INSERT INTO album_images_fixed (album_id, image_id, position, added_at)
             SELECT album_id, image_id, position, added_at FROM album_images`,
    },
    reports: {
      create: `CREATE TABLE reports_fixed (
        id          TEXT PRIMARY KEY,
        image_id    TEXT NOT NULL,
        device_id   TEXT NOT NULL,
        reason      TEXT,
        created_at  INTEGER NOT NULL,
        UNIQUE(image_id, device_id),
        FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
      )`,
      copy: `INSERT INTO reports_fixed (id, image_id, device_id, reason, created_at)
             SELECT id, image_id, device_id, reason, created_at FROM reports`,
    },
    use_events: {
      create: `CREATE TABLE use_events_fixed (
        image_id    TEXT NOT NULL,
        device_id   TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (image_id, device_id),
        FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
      )`,
      copy: `INSERT INTO use_events_fixed (image_id, device_id, created_at)
             SELECT image_id, device_id, created_at FROM use_events`,
    },
  };

  // 找出哪些表的 sql 里仍引用坏表名
  const broken = [];
  for (const name of Object.keys(fixSpecs)) {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
      .get(name);
    if (row && row.sql && row.sql.includes(BAD)) broken.push(name);
  }
  if (broken.length === 0) return false;

  console.log(
    `[migration] 修复 FK 引用损坏的表: ${broken.join(", ")}（被指向已 DROP 的 ${BAD}）`,
  );
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  try {
    const tx = db.transaction(() => {
      for (const name of broken) {
        const spec = fixSpecs[name];
        db.exec(spec.create);
        db.exec(spec.copy);
        db.exec(`DROP TABLE ${name}`);
        db.exec(`ALTER TABLE ${name}_fixed RENAME TO ${name}`);
      }
    });
    tx();
    // 重建被破坏的索引
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_album_images_by_image ON album_images(image_id)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_reports_image ON reports(image_id)",
    );
    console.log("[migration] FK 引用修复完成");
    return true;
  } finally {
    db.pragma("legacy_alter_table = OFF");
    db.pragma("foreign_keys = ON");
  }
}

/// 给已存在的 images / albums 表 ALTER ADD COLUMN 加入 likes / popularity 列。
/// CREATE TABLE IF NOT EXISTS 在表已存在时**不会**追加新列——必须显式 ALTER。
/// 用 PRAGMA table_info 检测是否已有该列实现幂等。
function migrateAddLikesPopularity(db) {
  function hasCol(table, col) {
    return db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((r) => r.name === col);
  }
  const targets = [
    { table: "images", col: "likes", sql: "ALTER TABLE images ADD COLUMN likes INTEGER NOT NULL DEFAULT 0" },
    { table: "images", col: "popularity", sql: "ALTER TABLE images ADD COLUMN popularity INTEGER NOT NULL DEFAULT 0" },
    { table: "albums", col: "likes", sql: "ALTER TABLE albums ADD COLUMN likes INTEGER NOT NULL DEFAULT 0" },
    { table: "albums", col: "popularity", sql: "ALTER TABLE albums ADD COLUMN popularity INTEGER NOT NULL DEFAULT 0" },
  ];
  let added = 0;
  for (const t of targets) {
    // 跳过：表不存在（首启动时 SCHEMA_SQL 会建表，这次 migration 在 SCHEMA_SQL 之后跑 → 表必然存在）；
    // 列已存在
    const tableExists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(t.table);
    if (!tableExists) continue;
    if (hasCol(t.table, t.col)) continue;
    db.exec(t.sql);
    added += 1;
  }
  // albums 加 management_key 列（默认空串，老 row 没密钥，仅 device_id 路径能管）
  if (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='albums'").get()
    && !hasCol("albums", "management_key")
  ) {
    db.exec("ALTER TABLE albums ADD COLUMN management_key TEXT NOT NULL DEFAULT ''");
    added += 1;
  }
  // SCHEMA_SQL 已经声明唯一索引（带 WHERE length>0），这里再 IF NOT EXISTS 跑一遍幂等
  if (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='albums'").get()
    && hasCol("albums", "management_key")
  ) {
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_management_key ON albums(management_key) WHERE length(management_key) > 0",
    );
  }

  // 物化 popularity 列：用现有 use_count + 3 * likes 回填（likes 初值都是 0）
  // 第一次运行迁移时所有 row 的 popularity = use_count + 3*0 = use_count；
  // 之后 like/use 写入会维护 popularity 一致。
  if (added > 0) {
    db.exec(
      "UPDATE images SET popularity = use_count + 3 * likes WHERE popularity = 0 AND (use_count > 0 OR likes > 0)",
    );
    db.exec(
      "UPDATE albums SET popularity = 3 * likes WHERE popularity = 0 AND likes > 0",
    );
    console.log(`[migration] 加列 likes/popularity 完成 (+${added} 列)`);
  }
  // 引用 popularity 列的索引：只能在 ADD COLUMN 之后建（无论新装 / 老库）。
  // CREATE INDEX IF NOT EXISTS 自身幂等。
  const imagesHasPopularity = db
    .prepare("PRAGMA table_info(images)")
    .all()
    .some((r) => r.name === "popularity");
  if (imagesHasPopularity) {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_images_popular ON images(category, status, popularity DESC, created_at DESC)",
    );
  }
  const albumsHasPopularity = db
    .prepare("PRAGMA table_info(albums)")
    .all()
    .some((r) => r.name === "popularity");
  if (albumsHasPopularity) {
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_albums_popular ON albums(status, popularity DESC, created_at DESC)",
    );
  }
  return added > 0;
}

export function initSchema(db) {
  // 先把可能存在的老库迁移到新表结构，再用 CREATE TABLE IF NOT EXISTS 跑常规 schema
  // —— 新表已经存在时这些 CREATE 是 no-op，索引也是 IF NOT EXISTS。
  migrateImagesUniqueHash(db);
  // 接着修一遍 FK 引用：处理上一版 migration 留下的损坏（生产数据库 schema 文本里
  // 仍有 images_legacy_unique_hash 引用）。新装的库走不到这一支。
  migrateBrokenFkReferences(db);
  // SCHEMA_SQL 用 CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS 跑一遍：
  // 新装库会建出含 likes/popularity 的表 + 新表 daily_like_quota；
  // 已装库 SCHEMA_SQL 是 no-op 但会建 daily_like_quota（IF NOT EXISTS）
  db.exec(SCHEMA_SQL);
  // 最后给已存在的 images/albums 加 likes/popularity 列（如果还没有）
  migrateAddLikesPopularity(db);
}

export {
  migrateImagesUniqueHash,
  migrateBrokenFkReferences,
  migrateAddLikesPopularity,
  detectLegacyHashUnique,
};

export function getDb() {
  if (dbInstance) return dbInstance;
  ensureDir(config.dataDir);
  const dbPath = path.join(config.dataDir, "community.sqlite");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL"); // 并发读 + 写者不阻塞读者
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  dbInstance = db;
  return db;
}

// 测试用：覆盖到内存库
export function setTestDb(db) {
  dbInstance = db;
}

export function buildInMemoryDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

/// 测试用：构造一个"老 schema"（file_hash 列级 UNIQUE）的库，用来覆盖
/// migrateImagesUniqueHash 的迁移路径。
export function buildLegacyInMemoryDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE images (
      id              TEXT PRIMARY KEY,
      device_id       TEXT NOT NULL,
      category        TEXT NOT NULL,
      file_hash       TEXT NOT NULL UNIQUE,
      file_ext        TEXT NOT NULL,
      mime            TEXT NOT NULL,
      size_bytes      INTEGER NOT NULL,
      width           INTEGER,
      height          INTEGER,
      prompt          TEXT,
      uploader_name   TEXT,
      status          TEXT NOT NULL,
      ai_verdict      TEXT,
      use_count       INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
  `);
  return db;
}
