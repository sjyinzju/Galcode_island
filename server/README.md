# Galcode 桌宠社区后端

Node + Express + SQLite + 本地磁盘。负责接收桌面端上传的桌宠图、按"前 10 热度 + 时间倒序"出列表、记录"使用"幂等计数、举报、上传者自助隐藏。AI 审核当前是 stub（始终通过），Phase 4 再接真实第三方。

> 仅供 Galcode Island 桌面端调用。不是独立公开 API。

## 目录

```
server/
  package.json
  src/
    index.js              # 入口
    config.js             # 环境变量 + 常量
    db.js                 # SQLite schema + 启动建表
    routes/images.js      # 上传 / 列表 / 计数 / 举报 / 隐藏
    lib/
      validate.js         # 校验（纯函数，可测）
      cursor.js           # 翻页游标 encode/decode
      listing.js          # Top10 + 时间倒序合并
      serialize.js        # row → DTO
      hash.js             # sha256
      ids.js              # uuid
      moderation.js       # AI 审核 stub
      rateLimit.js        # 极简 deviceId 限流
      baseUrl.js          # 拼图片绝对 URL
  test/                   # vitest
  deploy/                 # nginx / systemd / env 样板
  data/                   # SQLite 文件（.gitignore）
  uploads/                # 上传图片，文件名 = <hash>.<ext>（.gitignore）
```

## 本地起服务

```bash
cd server
npm install
npm test           # 38 个单元测试
npm run dev        # PORT=8787 起服务
```

启动后：

```bash
curl http://127.0.0.1:8787/healthz

# 上传
curl -X POST http://127.0.0.1:8787/api/images \
  -F file=@/path/to/img.png \
  -F deviceId=test-device-1234 \
  -F category=thinking \
  -F 'prompt=温柔姐姐风格' \
  -F uploaderName=tester

# 列表（首页：Top10 + 后续时间倒序）
curl 'http://127.0.0.1:8787/api/images?category=thinking'

# 使用计数（同 deviceId 多次幂等）
curl -X POST http://127.0.0.1:8787/api/images/<id>/use \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"viewer-abcdefgh"}'

# 自助隐藏（仅本人）
curl -X PATCH http://127.0.0.1:8787/api/images/<id>/visibility \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"<上传者 deviceId>","hidden":true}'

# 举报
curl -X POST http://127.0.0.1:8787/api/images/<id>/report \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"reporter-12345","reason":"违规说明"}'
```

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/healthz` | 健康检查 |
| GET | `/uploads/<hash>.<ext>` | 上传图直出（生产由 nginx alias） |
| POST | `/api/images` | multipart 上传：`file`/`category`/`deviceId`[/`prompt`/`uploaderName`]。同 hash 已存在返回 `duplicate:true`。 |
| GET | `/api/images?category=&cursor=&pageSize=&exclude=id1,id2` | 列表；首页（cursor 空）返回 `topHot`（最多 10）+ `timeline`（按时间倒序），翻页带 `cursor` + `exclude=topHotIds` 继续按时间倒序。 |
| POST | `/api/images/:id/use` | body `{deviceId}`，每设备每图幂等加 1。 |
| POST | `/api/images/:id/report` | body `{deviceId, reason?}`，每设备每图幂等。 |
| PATCH | `/api/images/:id/visibility` | body `{deviceId, hidden}`，仅本人。被 admin 下架 / AI 拒绝的图返回 403 locked_by_admin。 |

错误格式：`{"error":"validation","message":"...","field":"..."}` / `{"error":"not_found"}` / `{"error":"forbidden"}` / `{"error":"rate_limited"}` / `{"error":"file_too_large"}` / `{"error":"internal"}`。

## 环境变量

| 名字 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | 8787 | HTTP 端口 |
| `DATA_DIR` | `./data` | SQLite 所在目录 |
| `UPLOADS_DIR` | `./uploads` | 上传图所在目录 |
| `ALLOWED_ORIGINS` | `tauri://localhost,http://tauri.localhost,http://localhost:1420` | CORS 白名单（逗号分隔） |
| `MAX_UPLOAD_BYTES` | 8388608 | 单文件上限（8MB） |
| `DEFAULT_PAGE_SIZE` | 24 | 列表默认页大小 |
| `MAX_PAGE_SIZE` | 60 | 列表最大页大小 |
| `TOP_HOT_COUNT` | 10 | 首页前 N 热门 |

## 部署到 VPS（Ubuntu / Debian 示例）

```bash
# 1) 装运行时
sudo apt-get install nodejs npm nginx

# 2) 建用户和数据目录
sudo useradd -r -s /usr/sbin/nologin galcode
sudo mkdir -p /var/lib/galcode-community/{data,uploads}
sudo chown -R galcode:galcode /var/lib/galcode-community

# 3) 部署代码
sudo mkdir -p /opt/galcode-community
sudo rsync -av --exclude=node_modules --exclude=data --exclude=uploads \
  server/ /opt/galcode-community/
sudo chown -R galcode:galcode /opt/galcode-community
sudo -u galcode npm --prefix /opt/galcode-community ci --omit=dev

# 4) systemd unit + env
sudo cp deploy/galcode-community.service /etc/systemd/system/
sudo cp deploy/galcode-community.env.example /etc/galcode-community.env
sudo chmod 640 /etc/galcode-community.env
sudo $EDITOR /etc/galcode-community.env  # 至少把 ALLOWED_ORIGINS 改成线上域名

sudo systemctl daemon-reload
sudo systemctl enable --now galcode-community
sudo systemctl status galcode-community

# 5) nginx
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/galcode-community
# 改域名、ssl 路径、uploads 路径
sudo ln -s /etc/nginx/sites-available/galcode-community /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

升级：

```bash
sudo rsync -av --exclude=node_modules --exclude=data --exclude=uploads \
  server/ /opt/galcode-community/
sudo -u galcode npm --prefix /opt/galcode-community ci --omit=dev
sudo systemctl restart galcode-community
```

## 备份建议

- `/var/lib/galcode-community/data/community.sqlite` — 元数据，~MB 量级，每天 cron 拷一份
- `/var/lib/galcode-community/uploads/` — 大头，建议 rclone 同步到 R2 / S3 做异地

## /admin 复核台（Phase 3）

后端挂在同一服务的 `/admin`，零依赖 vanilla JS 单页。需要 systemd EnvironmentFile 配 3 项：

```bash
ADMIN_USERNAME=admin
# 用 scripts/admin-hash.mjs 生成 bcrypt hash：node scripts/admin-hash.mjs '<password>'
ADMIN_PASSWORD_HASH=$2b$12$...
# cookie 签名密钥；建议 32+ 字节随机串。重启会让所有 admin session 失效（默认安全）
COOKIE_SECRET=...
```

启动后浏览器打开 `https://community.example.com/admin/`，登录即可看到：

- "AI 拒绝（待复核）" tab：仅显示 status=rejected，Phase 4 大量出现
- "被举报" tab：reportCount ≥ 1 的图，按举报数倒序
- "全部" tab：所有 status
- 每行支持 上架（→ approved）/ 下架（→ hidden_by_admin）

API：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/admin/login` | `{username, password}` → httpOnly cookie |
| POST | `/admin/logout` | 清 cookie |
| GET | `/admin/me` | 登录态探针，401 = 未登录 |
| GET | `/admin/api/images?filter=rejected\|reported\|all&cursor=&pageSize=&offset=` | 列表 |
| PATCH | `/admin/api/images/:id/status` | `{status: approved\|hidden_by_admin}` |

## 内容审核（Phase 4）

启动时打印当前 provider：`[moderation] provider=... credentials=...`。

配 `MODERATION_PROVIDER` 选 provider：

| 值 | 行为 |
| --- | --- |
| `none` / `stub` / 未配 | 默认。所有上传同步 approve（ai_verdict=`stub_pass`） |
| `sightengine` | 调 Sightengine API；上传**异步**审核，先返回 `pending:true` + status=`pending_ai`，审核完成后管理员日志可见。需要 `SIGHTENGINE_USER` / `SIGHTENGINE_SECRET`；缺凭据自动降级 pass |

降级策略：网络错误 / 配置缺失 / 解析失败 → status=approved + ai_verdict=`degraded_*`，复核台可手动下架。审核挂掉**不阻塞**用户上传。

环境变量：

| 名字 | 默认值 | 说明 |
| --- | --- | --- |
| `MODERATION_PROVIDER` | `none` | none / stub / sightengine |
| `SIGHTENGINE_USER` | `""` | Sightengine api_user |
| `SIGHTENGINE_SECRET` | `""` | Sightengine api_secret |
| `SIGHTENGINE_NUDITY_THRESHOLD` | `0.5` | 超过即拒绝 |
| `SIGHTENGINE_OFFENSIVE_THRESHOLD` | `0.5` | 超过即拒绝 |

接入新 provider（如 Hive、Cloudflare AI）：在 `src/lib/moderation/` 加 `xxx.js` 实现 `moderate(filePath, meta)` → `{verdict, approved, reasons?}`，在 `index.js` 的 switch 里加分支即可。
