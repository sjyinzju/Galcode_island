// BlockStream 虚拟滚动的辅助纯函数。
//
// 抽出来的目的：把"是否接近底部"这种带阈值的判定逻辑独立成纯函数，能用 vitest
// 直接覆盖，不用拖 DOM / jsdom。BlockStream 主组件改成调这个函数就能享受测试保障。

/// 判断滚动容器是否处于"贴底"状态——离底部不超过 thresholdPx。
/// 用途：流式 block 到达时若 isNearBottom → 自动滚到最新；否则保留用户阅读位置。
///
/// 默认 32px 容差：用户在底部附近的轻微反向滚动不算"想看历史"，避免一动就停跟随。
export function isNearBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  thresholdPx = 32,
): boolean {
  const distance = scrollHeight - scrollTop - clientHeight;
  return distance < thresholdPx;
}
