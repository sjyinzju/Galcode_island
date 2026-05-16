// 入口：装配 routes + CORS + 静态目录 + 全局错误处理。

import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { getDb } from "./db.js";
import { createImagesRouter } from "./routes/images.js";
import { createAlbumsRouter } from "./routes/albums.js";
import { createAdminRouter } from "./routes/admin.js";
import { ValidationError } from "./lib/validate.js";
import { logModerationStatus } from "./lib/moderation/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  if (origin && config.allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, X-Device-Id, Authorization",
    );
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

export function buildApp() {
  // 数据目录 + 上传目录提前建好，避免首请求才发现写不进
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  // 触发 schema 初始化
  getDb();

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true); // nginx 反代时拿到真实 ip

  app.use(cookieParser(config.cookieSecret));
  app.use(corsMiddleware);

  // 静态图片：本机直出。生产建议让 nginx 直接 alias /uploads，提速 + 省 node
  // CPU；nginx 没配也不会爆，回退到这里。
  app.use(
    "/uploads",
    express.static(config.uploadsDir, {
      immutable: true,
      maxAge: "30d", // 文件名是 hash，永远不会变内容
      fallthrough: false,
    }),
  );

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });

  app.use("/api/images", createImagesRouter());
  app.use("/api/albums", createAlbumsRouter());

  // 复核网页：路由 + 静态 SPA 文件
  app.use("/admin", createAdminRouter());
  const adminStaticDir = path.resolve(__dirname, "..", "admin");
  if (fs.existsSync(adminStaticDir)) {
    // 注意 mount 顺序：先挂 createAdminRouter（处理 /admin/login 等 API），
    // 再挂 static —— express 路由匹配按声明顺序；static 兜底返回 admin.html / 静态资源。
    app.use("/admin", express.static(adminStaticDir, { index: "admin.html" }));
  }

  // 全局错误处理：ValidationError → 400，multer 体积超限 → 413，其它 → 500
  // 注意：必须 4 个参数，Express 才识别为错误中间件
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ValidationError) {
      res.status(err.status).json({
        error: "validation",
        message: err.message,
        field: err.field,
      });
      return;
    }
    if (err && err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({
        error: "file_too_large",
        message: `file exceeds ${config.maxUploadBytes} bytes`,
      });
      return;
    }
    // 其它不抛 stack 到客户端
    console.error("[server] unhandled error", err);
    res.status(500).json({ error: "internal" });
  });

  return app;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const app = buildApp();
  app.listen(config.port, () => {
    console.log(
      `[galcode-community] listening on :${config.port} ` +
        `data=${config.dataDir} uploads=${config.uploadsDir}`,
    );
    logModerationStatus();
  });
}
