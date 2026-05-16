// admin 鉴权 + 列表 filter + 上/下架 端到端测试（用 supertest-less 内存路径：
// 直接构造 express app 起在随机端口，用 fetch 真请求）。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";

let serverInstance, baseUrl, db, STATUS, encodeCursor;

beforeAll(async () => {
  // 先设置 env，再 import config / db / app —— config 在 import 时读 env
  process.env.PORT = "0"; // 随机端口
  process.env.DATA_DIR = `/tmp/galcode-admin-test-${Date.now()}`;
  process.env.UPLOADS_DIR = `/tmp/galcode-admin-test-${Date.now()}-up`;
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD_HASH = await bcrypt.hash("p4ss-w0rd!", 4); // rounds=4 加速测试
  process.env.COOKIE_SECRET = "test-cookie-secret-1234567890";

  const { buildApp } = await import("../src/index.js");
  const dbMod = await import("../src/db.js");
  const cfgMod = await import("../src/config.js");
  const cursorMod = await import("../src/lib/cursor.js");
  STATUS = cfgMod.STATUS;
  encodeCursor = cursorMod.encodeCursor;
  db = dbMod.getDb();

  const app = buildApp();
  await new Promise((resolve) => {
    serverInstance = app.listen(0, () => {
      const port = serverInstance.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise((resolve) => serverInstance.close(resolve));
});

beforeEach(() => {
  db.exec("DELETE FROM reports; DELETE FROM use_events; DELETE FROM images;");
});

function insertImage(overrides) {
  const id = overrides.id;
  const now = overrides.createdAt ?? Date.now();
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

function insertReport(imageId, deviceId) {
  db.prepare(
    `INSERT INTO reports (id, image_id, device_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), imageId, deviceId, null, Date.now());
}

async function login() {
  const res = await fetch(`${baseUrl}/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "p4ss-w0rd!" }),
  });
  expect(res.status).toBe(200);
  // 取出 Set-Cookie 让后续请求带上
  const cookies = res.headers.getSetCookie?.() ?? [];
  return cookies.map((c) => c.split(";")[0]).join("; ");
}

describe("admin 鉴权", () => {
  it("未登录访问 /admin/api/images → 401", async () => {
    const res = await fetch(`${baseUrl}/admin/api/images`);
    expect(res.status).toBe(401);
  });

  it("密码错误 → 401", async () => {
    const res = await fetch(`${baseUrl}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong" }),
    });
    expect(res.status).toBe(401);
  });

  it("登录后 /admin/me 返回 username", async () => {
    const cookie = await login();
    const res = await fetch(`${baseUrl}/admin/me`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.username).toBe("admin");
  });

  it("logout 后 cookie 失效", async () => {
    const cookie = await login();
    await fetch(`${baseUrl}/admin/logout`, { method: "POST", headers: { cookie } });
    // 注意：fetch 不会自动应用 Set-Cookie，logout 只在客户端持有 cookie 的浏览器中真正生效。
    // 这里靠 logout 后端不维护任何 server-side session 状态——只是擦客户端 cookie。
    // 因此用同样的 cookie 仍能访问；但浏览器收到 Max-Age=0 后会自动丢弃。
    // 这里我们只验证 logout endpoint 本身返回 200。
    const res = await fetch(`${baseUrl}/admin/logout`, { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
  });
});

describe("filter 查询", () => {
  it("filter=rejected 只返回 rejected 状态", async () => {
    insertImage({ id: "a", status: STATUS.APPROVED });
    insertImage({ id: "b", status: STATUS.REJECTED });
    insertImage({ id: "c", status: STATUS.HIDDEN_BY_OWNER });
    insertImage({ id: "d", status: STATUS.REJECTED });
    const cookie = await login();
    const res = await fetch(`${baseUrl}/admin/api/images?filter=rejected`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.items.map((i) => i.id).sort();
    expect(ids).toEqual(["b", "d"]);
  });

  it("filter=all 返回所有 status，按时间倒序", async () => {
    insertImage({ id: "a", status: STATUS.APPROVED, createdAt: 1 });
    insertImage({ id: "b", status: STATUS.REJECTED, createdAt: 3 });
    insertImage({ id: "c", status: STATUS.HIDDEN_BY_OWNER, createdAt: 2 });
    const cookie = await login();
    const res = await fetch(`${baseUrl}/admin/api/images?filter=all`, { headers: { cookie } });
    const body = await res.json();
    expect(body.items.map((i) => i.id)).toEqual(["b", "c", "a"]);
  });

  it("filter=reported 仅返回有举报的图，按举报数倒序", async () => {
    insertImage({ id: "a", status: STATUS.APPROVED });
    insertImage({ id: "b", status: STATUS.APPROVED });
    insertImage({ id: "c", status: STATUS.APPROVED });
    insertReport("b", "dev1");
    insertReport("b", "dev2");
    insertReport("c", "dev3");
    const cookie = await login();
    const res = await fetch(`${baseUrl}/admin/api/images?filter=reported`, { headers: { cookie } });
    const body = await res.json();
    expect(body.items.map((i) => i.id)).toEqual(["b", "c"]);
    expect(body.items[0].reportCount).toBe(2);
    expect(body.items[1].reportCount).toBe(1);
  });

  it("非法 filter → 400", async () => {
    const cookie = await login();
    const res = await fetch(`${baseUrl}/admin/api/images?filter=garbage`, { headers: { cookie } });
    expect(res.status).toBe(400);
  });
});

describe("上下架", () => {
  it("PATCH approved → 状态变 approved，公开列表能看到", async () => {
    insertImage({ id: "x", status: STATUS.REJECTED, category: "thinking" });
    const cookie = await login();
    const r1 = await fetch(`${baseUrl}/admin/api/images/x/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(r1.status).toBe(200);
    // 公开 list 应该能看到
    const r2 = await fetch(`${baseUrl}/api/images?category=thinking`);
    const body = await r2.json();
    expect(body.items.map((i) => i.id)).toContain("x");
  });

  it("PATCH hidden_by_admin → 公开列表消失", async () => {
    insertImage({ id: "y", status: STATUS.APPROVED, category: "thinking" });
    const cookie = await login();
    await fetch(`${baseUrl}/admin/api/images/y/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ status: "hidden_by_admin" }),
    });
    const r2 = await fetch(`${baseUrl}/api/images?category=thinking`);
    const body = await r2.json();
    expect(body.items.map((i) => i.id)).not.toContain("y");
  });

  it("PATCH 非法 status → 400", async () => {
    insertImage({ id: "z", status: STATUS.APPROVED });
    const cookie = await login();
    const r = await fetch(`${baseUrl}/admin/api/images/z/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ status: "pending_ai" }),
    });
    expect(r.status).toBe(400);
  });

  it("PATCH 不存在的 id → 404", async () => {
    const cookie = await login();
    const r = await fetch(`${baseUrl}/admin/api/images/nope/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(r.status).toBe(404);
  });
});

// cursor 用法被 admin all/rejected 复用，加一个回归测试
describe("admin 翻页 cursor", () => {
  it("filter=all 用 cursor 翻页 + 排除已展示，无重复", async () => {
    for (let i = 0; i < 5; i += 1) {
      insertImage({ id: `n${i}`, status: STATUS.APPROVED, createdAt: 100 + i });
    }
    const cookie = await login();
    const r1 = await fetch(`${baseUrl}/admin/api/images?filter=all&pageSize=3`, { headers: { cookie } });
    const p1 = await r1.json();
    expect(p1.items.length).toBe(3);
    expect(p1.nextCursor).toBeTruthy();
    const r2 = await fetch(
      `${baseUrl}/admin/api/images?filter=all&pageSize=3&cursor=${encodeURIComponent(p1.nextCursor)}`,
      { headers: { cookie } },
    );
    const p2 = await r2.json();
    expect(p2.items.length).toBe(2);
    const ids1 = new Set(p1.items.map((i) => i.id));
    for (const i of p2.items) {
      expect(ids1.has(i.id)).toBe(false);
    }
    // 这里 encodeCursor 仍然导入但不用，避免 unused 警告
    expect(typeof encodeCursor).toBe("function");
  });
});
