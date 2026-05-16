// 内容审核统一入口。
//
// 按 config.moderationProvider 路由到具体 provider。
// 所有 provider 实现：
//   async moderate(filePath, meta) → { verdict, approved, reasons? }
//   - verdict: 字符串描述（写入 images.ai_verdict 列）
//   - approved: bool —— 通过 / 拒绝
//   - reasons: 可选，详细原因数组
//
// 网络 / 配置错误：**降级**为 stub_pass（写 verdict='degraded_pass'，让管理员能看出来）。
// 不让审核服务挂掉就阻塞上传：上传者体验优先，管理员还能在复核台手动下架。

import { config } from "../../config.js";
import { moderateStub } from "./stub.js";
import { moderateSightengine } from "./sightengine.js";

export async function moderateImage(filePath, meta) {
  const provider = config.moderationProvider;
  try {
    switch (provider) {
      case "none":
      case "stub":
        return await moderateStub(filePath, meta);
      case "sightengine":
        if (!config.sightengineUser || !config.sightengineSecret) {
          console.warn(
            "[moderation] sightengine selected but SIGHTENGINE_USER/SECRET missing — degraded pass",
          );
          return { verdict: "degraded_missing_credentials", approved: true };
        }
        return await moderateSightengine(filePath, meta);
      default:
        console.warn(`[moderation] unknown provider '${provider}', falling back to stub`);
        return await moderateStub(filePath, meta);
    }
  } catch (err) {
    console.error("[moderation] provider error, degrading to pass:", err);
    return {
      verdict: "degraded_error",
      approved: true,
      reasons: [String(err?.message ?? err)],
    };
  }
}

/// 启动时打印审核 provider 状态，方便排查"为什么所有图都直接通过"。
export function logModerationStatus() {
  const p = config.moderationProvider;
  if (p === "none" || p === "stub") {
    console.log("[moderation] provider=none (stub_pass，所有上传图直接 approved)");
  } else if (p === "sightengine") {
    const ok = Boolean(config.sightengineUser && config.sightengineSecret);
    console.log(
      `[moderation] provider=sightengine credentials=${ok ? "ok" : "MISSING — degraded pass"} ` +
        `nudity_threshold=${config.sightengineNudityThreshold} ` +
        `offensive_threshold=${config.sightengineOffensiveThreshold}`,
    );
  } else {
    console.log(`[moderation] provider=${p} (unknown — falling back to stub)`);
  }
}
