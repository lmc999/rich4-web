export type DataErrorCode =
  | 'MAP_UNAVAILABLE' // 地图不存在或 mapHash 不符（DataRegistry.getMap）
  | 'MAP_INVALID' // 结构校验失败或缺少必需元素
  | 'MAP_DUPLICATE' // 注册表里出现重复的地图 id
  | 'MAP_HASH_MISMATCH' // meta.dataHash 与复算结果不符
  | 'TILE_NOT_FOUND'
  | 'LOT_NOT_FOUND'
  | 'STREET_NOT_FOUND';

export class DataError extends Error {
  override name = 'DataError';

  constructor(
    readonly code: DataErrorCode,
    message: string,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(`${code}: ${message}`);
  }
}
