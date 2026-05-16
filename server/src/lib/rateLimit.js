// 极简内存滑窗限流：deviceId 维度。生产规模大了再换 Redis。
//
// 写操作（上传 / use / report / 隐藏）：每分钟 30 次
// 读操作（list）：每分钟 120 次

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

// 测试用：清空状态
export function _resetRateLimitForTests() {
  buckets.clear();
}
