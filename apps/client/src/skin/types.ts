// 原版皮肤的公共类型（只含类型与少量常量，不引入 shared/assets 的运行时代码，首屏可以放心依赖）。
import type { MapSkinMismatch, PackManifestV1 } from '@rich4/shared/assets';

/** 用户设置：auto = 有素材包且地图匹配时用原版；original = 强制原版（棋盘不匹配时仍回退）；procedural = 程序化 */
export type SkinPref = 'auto' | 'original' | 'procedural';
export const SKIN_PREFS: readonly SkinPref[] = ['auto', 'original', 'procedural'];

export type SkinKind = 'original' | 'procedural';

/** 素材包不可用的原因 */
export type PackAbsentReason =
  /** 404：本站没有素材包（/pack/* 已注册但未启用） */
  | 'not-found'
  /** 204：服务器明确表示没有素材包 */
  | 'no-content'
  /** 响应不是 JSON（例如旧服务器把 /pack/ 回退成 SPA 页面） */
  | 'not-json'
  /** JSON 但 zod / 一致性校验失败 */
  | 'invalid'
  /** 其他 HTTP 错误 */
  | 'http'
  /** 网络错误或超时 */
  | 'network';

export type PackState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'absent'; reason: PackAbsentReason; detail: string | null }
  | { status: 'access-required' }
  | { status: 'ready'; manifest: PackManifestV1 };

/** 当前地图与素材包的匹配结果（由 PackClient.checkMap 计算） */
export interface MapCheck {
  mapId: string;
  status: 'ok' | 'no-board' | 'missing' | 'mismatch' | 'group-missing';
  mismatches: MapSkinMismatch[];
  /** 地图皮肤所在的组（status 为 missing 时为 null） */
  group: string | null;
}

/** 皮肤回退（或棋盘回退）的原因；设置页按 hud:skin.reason.<reason> 显示 */
export type SkinReason =
  | 'setting'
  | 'pack-loading'
  | 'pack-absent'
  | 'pack-invalid'
  | 'pack-error'
  | 'access-required'
  | 'no-board'
  | 'map-missing'
  | 'map-mismatch'
  | 'group-missing'
  | 'renderer-unavailable'
  | 'renderer-failed';

export const SKIN_REASONS: readonly SkinReason[] = [
  'setting',
  'pack-loading',
  'pack-absent',
  'pack-invalid',
  'pack-error',
  'access-required',
  'no-board',
  'map-missing',
  'map-mismatch',
  'group-missing',
  'renderer-unavailable',
  'renderer-failed',
];

export interface SkinResolution {
  pref: SkinPref;
  /** 总皮肤：决定界面语言（original → zh-TW）与主题 */
  skin: SkinKind;
  /** 棋盘渲染器 */
  board: SkinKind;
  /** skin 为 procedural 的原因（original 时为 null） */
  reason: SkinReason | null;
  /** board 为 procedural 的原因（没有地图时为 null） */
  boardReason: SkinReason | null;
  /** 地图绑定不匹配的明细（设置页显示） */
  mismatches: MapSkinMismatch[];
  mapId: string | null;
  packId: string | null;
}
