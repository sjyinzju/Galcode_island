// 社区 API DTO 与前端类型。
// 与 server/README.md "API" 表对齐；改这里的字段记得 server 同步改。

import type { PetCategory } from "../stores/usePetAssetsStore";

export type CommunityImageStatus =
  | "pending_ai"
  | "approved"
  | "rejected"
  | "hidden_by_owner"
  | "hidden_by_admin";

/// 单张社区图的对外形态。url 是绝对地址（server 端拼好）。
export interface CommunityImageDto {
  id: string;
  deviceId: string;
  category: PetCategory;
  mime: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  prompt: string | null;
  uploaderName: string | null;
  status: CommunityImageStatus;
  useCount: number;
  /// 总点赞数（所有 device 累计）
  likes: number;
  /// 人气值（= useCount + 3*likes，物化在 server）
  popularity: number;
  createdAt: number;
  updatedAt: number;
  url: string;
  /// 该图所属的图集 id 列表（仅 active 图集；不含 hidden）。空数组 = 游离图。
  /// CommunityPickerModal 据此决定是否显示"查看所属图集"按钮。
  albumIds: string[];
}

export type AlbumStatus = "active" | "hidden_by_owner" | "hidden_by_admin";

export interface AlbumDto {
  id: string;
  deviceId: string;
  name: string;
  description: string | null;
  uploaderName: string | null;
  status: AlbumStatus;
  imageCount: number;
  likes: number;
  popularity: number;
  /// 图集封面 url（第一张图的 url）。从 /api/albums 列表返回时填；
  /// /api/albums/:id 详情可能为 null（图列表已含完整图，无需再返封面）。
  coverUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AlbumDetailResponse {
  album: AlbumDto;
  images: CommunityImageDto[];
}

export interface AlbumsByImageResponse {
  albums: AlbumDto[];
}

export interface CreateAlbumResult {
  album: AlbumDto;
  /// 上传者一次性管理密钥——**仅在创建响应里出现**，server 之后任何 GET / 列表 / DTO
  /// 都不会再带上它。前端要把这串字符显示给用户保存，丢了就没法重置。
  managementKey: string;
}

/// POST /api/albums/manage 用密钥反查的响应（形状与 GET /:id 一致）
export type ManagedAlbumResponse = AlbumDetailResponse;

/// PATCH /api/albums/:id 元数据更新的响应
export interface UpdateAlbumResult {
  album: AlbumDto;
}

/// PATCH /api/albums/:id/visibility 的响应
export interface AlbumVisibilityResult {
  status: AlbumStatus;
}

export interface CreateAlbumInput {
  name: string;
  description?: string | null;
  imageIds: string[];
  uploaderName?: string | null;
}

/// 新版分页排序的图片列表响应（/api/images?sort=&page=&pageSize=）
export interface PagedImagesResponse {
  items: CommunityImageDto[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  sort: "popular" | "time";
}

/// 图集维度的分页列表响应（/api/albums?sort=&page=&pageSize=）
export interface PagedAlbumsResponse {
  items: AlbumDto[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  sort: "popular" | "time";
}

/// 点赞操作的响应。dailyRemaining = 当日该目标的剩余可点次数（[0,10]）。
export interface LikeResult {
  likes: number;
  dailyRemaining: number;
}

export type SortMode = "popular" | "time";
export type ViewDimension = "images" | "albums";

/// GET /api/images 返回。
/// - 首页 cursor=空：topHot 最多 10 条 + timeline 一页；nextCursor 非空则可继续翻
/// - 翻页 cursor 非空：topHot=[]，timeline 一页；前端需要把首次拿到的 topHotIds
///   原样回传 (`exclude`)，让 server 不重复返回 Top10 已展示过的图。
export interface CommunityListResponse {
  topHot: CommunityImageDto[];
  timeline: CommunityImageDto[];
  nextCursor: string | null;
  topHotIds: string[];
}

export interface CommunityUploadResult {
  duplicate: boolean;
  image: CommunityImageDto;
}

export interface CommunityUseResult {
  useCount: number;
  counted: boolean;
}

/// 统一抛错类型；UI 据 code 决定文案 / 重试策略。
export class CommunityError extends Error {
  readonly code: string;
  readonly status: number;
  readonly field: string | null;

  constructor(opts: {
    message: string;
    code: string;
    status: number;
    field?: string | null;
  }) {
    super(opts.message);
    this.name = "CommunityError";
    this.code = opts.code;
    this.status = opts.status;
    this.field = opts.field ?? null;
  }
}
