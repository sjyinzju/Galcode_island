// 根据 req 推断对外 base URL（用于拼图片绝对地址）。
// 优先 X-Forwarded-* 头（nginx 反代），否则用 host header。

export function inferBaseUrl(req) {
  const proto =
    req.headers["x-forwarded-proto"]?.toString().split(",")[0].trim() ??
    req.protocol;
  const host =
    req.headers["x-forwarded-host"]?.toString().split(",")[0].trim() ??
    req.headers.host;
  return `${proto}://${host}`;
}
