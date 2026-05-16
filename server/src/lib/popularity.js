// 人气算法 + 日配额 helpers。抽纯函数方便单测，路由只组装结果。
//
// 设计：
//   image popularity = use_count + 3 * likes
//   album popularity = 3 * likes（album 无 "use_count" 概念）
// 权重 1:3 的理由：点赞是主动行为（要确认 + 数有限 10/天），使用是被动行为；
// 3 倍权重让"被赞数量"成为主导信号但不淹没"被使用"。
// 不带时间衰减——衰减需要每次查询重算 + 索引失效，工程代价大；
// 新图按"按时间"排即可保证曝光机会。

export const LIKE_WEIGHT = 3;
export const DAILY_LIKE_LIMIT = 10;

/// 防御性：负数（理论不应出现）一律视为 0。
function nonNeg(n) {
  return Math.max(0, Math.floor(Number(n) || 0));
}

export function computeImagePopularity(useCount, likes) {
  return nonNeg(useCount) + LIKE_WEIGHT * nonNeg(likes);
}

export function computeAlbumPopularity(likes) {
  return LIKE_WEIGHT * nonNeg(likes);
}

/// 当前 UTC 日期字符串 YYYY-MM-DD。
/// 用 UTC 而不是 server 本地时区：让单元测试不受机器 TZ 影响、跨时区部署一致。
/// CST 用户实际感受为：每天早 8 点配额重置。
export function utcDateStr(date = new Date()) {
  return date.toISOString().slice(0, 10);
}
