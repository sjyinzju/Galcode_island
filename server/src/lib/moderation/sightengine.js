// Sightengine 审核 provider。
//
// 协议：POST https://api.sightengine.com/1.0/check.json
//   - multipart 上传 media（图片）+ models=nudity-2.1,offensive
//   - 需要 api_user + api_secret（query string 或 form field）
// 文档：https://sightengine.com/docs/image-moderation-api
//
// 返回 JSON 关键字段（仅取我们用到的）：
//   nudity: { sexual_activity, sexual_display, erotica, very_suggestive, suggestive, mildly_suggestive, none }
//   offensive: { prob, ... }  或  offensive.nazi/.confederate/... （新版细分）
//
// 我们的判定（守住底线为目标，宁松勿严，让人工复核兜底）：
//   - sexual_activity / sexual_display / erotica 任一 > config.sightengineNudityThreshold → 拒绝
//   - offensive.prob > config.sightengineOffensiveThreshold → 拒绝
//   - 其它情况 → 通过
//
// 网络错误 / 解析失败 / 字段缺失 → 抛错（index.js 会降级 pass）。

import fs from "node:fs";
import { config } from "../../config.js";

const API_URL = "https://api.sightengine.com/1.0/check.json";

export async function moderateSightengine(filePath, _meta) {
  const form = new FormData();
  const buf = await fs.promises.readFile(filePath);
  const blob = new Blob([buf]);
  form.append("media", blob, "img");
  form.append("models", "nudity-2.1,offensive");
  form.append("api_user", config.sightengineUser);
  form.append("api_secret", config.sightengineSecret);

  const res = await fetch(API_URL, { method: "POST", body: form });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`sightengine returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (body.status !== "success") {
    throw new Error(`sightengine status=${body.status}: ${body.error?.message ?? "unknown"}`);
  }

  const result = evaluateSightengine(body, {
    nudityThreshold: config.sightengineNudityThreshold,
    offensiveThreshold: config.sightengineOffensiveThreshold,
  });
  return result;
}

/// 纯函数：把 sightengine 响应映射到我们的 {verdict, approved, reasons}。
/// 抽出来便于测试 —— 不接真实 API 也能验证阈值逻辑。
export function evaluateSightengine(body, { nudityThreshold, offensiveThreshold }) {
  const reasons = [];
  const nudity = body.nudity ?? {};
  // 2.1 版字段名；老版 raw/safe/partial 也兼容
  const nudityScore = Math.max(
    Number(nudity.sexual_activity ?? 0),
    Number(nudity.sexual_display ?? 0),
    Number(nudity.erotica ?? 0),
    Number(nudity.raw ?? 0),
    Number(nudity.partial ?? 0),
  );
  if (nudityScore > nudityThreshold) {
    reasons.push(`nudity=${nudityScore.toFixed(2)}`);
  }

  const offensive = body.offensive ?? {};
  const offensiveScore = Number(offensive.prob ?? 0);
  if (offensiveScore > offensiveThreshold) {
    reasons.push(`offensive=${offensiveScore.toFixed(2)}`);
  }

  const approved = reasons.length === 0;
  return {
    verdict: approved
      ? `sightengine_pass(n=${nudityScore.toFixed(2)},o=${offensiveScore.toFixed(2)})`
      : `sightengine_reject:${reasons.join(",")}`,
    approved,
    reasons,
  };
}
