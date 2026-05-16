// 桌宠图社区后端地址 —— 硬编码，不让用户配置。
//
// 历史：早期版本通过 useSettingsStore.communityBaseUrl + 设置面板让用户填，
// 后来产品决定走"统一官方后端"路线，地址固定为下面这个值。原来的 store 字段
// 仍保留（避免 zustand persist hydrate 报错），但不再被读取。
//
// 如果以后社区机房迁移，改这里一行即可；客户端下次启动就指向新地址。

export const COMMUNITY_BASE_URL = "https://gcbackend.haruyuki.cn";
