// 极简内存滑窗限流：deviceId 维度 + IP 维度两层。生产规模大了再换 Redis。
//
// 设计意图：
//   - rateLimitWrite / rateLimitRead：deviceId-or-ip 维度，是"温柔的人均限速"，
//     主要挡正常用户行为偶发抖动。
//     ⚠️ deviceId 是 client-controlled header，攻击者轮换 deviceId 就能绕过，
//     **不要把它当成对抗暴力枚举 / 凭据穷举的安全护栏**。
//   - rateLimitByIp(limit)：纯 IP 维度，给敏感端点叠加一层硬上限——/admin/login 暴破、
//     /api/albums/manage 密钥试探都靠这层兜底。
//
// 写操作（上传 / use / report / 隐藏）：每分钟 30 次（device 维度）
// 读操作（list）：每分钟 120 次（device 维度）

const WINDOW_MS = 60_000;

const buckets = new Map(); // key -> [timestamps...]

function hit(key, limit) {
  const now = Date.now();
  const arr = buckets.get(key) ?? [];
  const fresh = arr.filter((t) => now - t < WINDOW_MS);
  if (fresh.length >= limit) {
    buckets.set(key, fresh);
    return false;
  }
  fresh.push(now);
  buckets.set(key, fresh);
  return true;
}

export function rateLimitWrite(req, res, next) {
  const key = `w:${req.deviceId ?? req.ip}`;
  if (!hit(key, 30)) {
    res.status(429).json({ error: "rate_limited", scope: "write" });
    return;
  }
  next();
}

export function rateLimitRead(req, res, next) {
  const key = `r:${req.query.deviceId ?? req.ip}`;
  if (!hit(key, 120)) {
    res.status(429).json({ error: "rate_limited", scope: "read" });
    return;
  }
  next();
}

/// 纯 IP 维度限速工厂——挡 deviceId 旋转绕过。
/// req.ip 由 Express `trust proxy` 解析；index.js 设置成 `loopback` 让 nginx 反代
/// 的 X-Forwarded-For 真实 IP 能拿到，但 nginx 之外的直连不能伪造。
/// 调用方传 limit（每 IP 每分钟次数）。例：rateLimitByIp(10) 用于 admin login。
export function rateLimitByIp(limit, scopeLabel = "ip") {
  return function rateLimitByIpMiddleware(req, res, next) {
    const ip = req.ip ?? "unknown";
    const key = `ip:${scopeLabel}:${ip}`;
    if (!hit(key, limit)) {
      res.status(429).json({ error: "rate_limited", scope: scopeLabel });
      return;
    }
    next();
  };
}

// 测试用：清空状态
export function _resetRateLimitForTests() {
  buckets.clear();
}
