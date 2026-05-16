// 设备级匿名 ID。
//
// 与其它 store 不同：**不**走 sharedStorage —— 桌面端和手机端各应该有自己独立的
// deviceId，不能跨设备同步。社区后端用这个 id 做"幂等使用计数"和"自助隐藏鉴权"，
// 同步了反而会破坏语义（A 设备在手机端选用的图被算到桌面端头上）。
//
// 持久化：纯 localStorage（zustand persist 默认）。首次启动生成 UUID，后续永久不变。
//
// 兼容浏览器（移动端 LAN）：window.localStorage 在浏览器里也有；用户在 A 手机和
// B 手机分别打开 LAN 客户端时各自生成 id，符合预期。

import { create } from "zustand";
import { persist } from "zustand/middleware";

function newDeviceId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

interface DeviceIdState {
  /// 永远是已生成的 UUID。组件直接 useDeviceIdStore(s => s.deviceId) 读。
  /// 不再提供 setter——一旦生成就不能改，否则会丢失"我的上传"鉴权。
  deviceId: string;
}

export const useDeviceIdStore = create<DeviceIdState>()(
  persist(
    () => ({
      deviceId: newDeviceId(),
    }),
    {
      name: "galcode-device-id",
      // 注意：不传 storage，让 zustand 用默认 localStorage（每设备各自一份）
      // 即使 LAN 客户端 hydrate 桌面端的其它 store，也不会被它覆盖这一项。
      // merge: 一旦本地已有 id 就坚决保留，不被外部覆盖
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<DeviceIdState>;
        if (typeof persisted.deviceId === "string" && persisted.deviceId.length >= 8) {
          return { ...currentState, deviceId: persisted.deviceId };
        }
        // persisted 没有 id（首次 / 旧版本）→ 保留 currentState 里 create 时生成的新 id
        return currentState;
      },
    },
  ),
);

/// 非 React 上下文（lib / 服务）里取 deviceId 的便利函数。
export function getDeviceId(): string {
  return useDeviceIdStore.getState().deviceId;
}
