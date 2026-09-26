import type { RawName } from '../bin/big5';

export type { RawName } from '../bin/big5';

export type EditionId = 'v206' | 'v311' | 'unknown';
export type RawSourceId = 'v206-mapdat' | 'v206-mapmkf' | 'v311-mapmkf';
export type TableName = 'nodes' | 'lands' | 'facilities' | 'companies' | 'landscapes';

export interface TableRef {
  count: number;
  offset: number;
  stride: number;
}

export type Quad = [number, number, number, number];
export type Six = [number, number, number, number, number, number];

export interface RawNode {
  id: number;
  x: number;
  y: number;
  name: RawName;
  adj: Quad;
  type: number;
  decor: number;
  flags: number;
  hex: string;
}

export interface RawLand {
  id: number;
  x: number;
  y: number;
  name: RawName;
  b17: number;
  b18: number;
  b19: number;
  b1a: number;
  facing: number;
  landPrice: number;
  housePrice: number;
  rent: Six;
  u2c: number;
  u30: number;
  hex: string;
}

export interface RawFacility {
  id: number;
  x: number;
  y: number;
  name: RawName;
  b18: number;
  b19: number;
  b1a: number;
  facing: number;
  b1c: number;
  b1d: number;
  b1e: number;
  /** 规格外补充：0x1f，未知用途 */
  b1f: number;
  /** 规格外补充：0x20 u16，未知用途 */
  u20: number;
  landPrice: number;
  /** 下标 0 = housePrice，1..5 = 各级费率 */
  rateWindow: Six;
  u30: number;
  u34: number;
  hex: string;
}

export interface RawCompany {
  id: number;
  x: number;
  y: number;
  name: RawName;
  owner: number;
  /** 0 基 */
  stockIndex: number;
  industry: number;
  facing: number;
  ranking: Quad;
  spriteRes: number;
  tollBase: number;
  assetValue: number;
  /** 0x28 i32 本月盈余（运行期） */
  funds: number;
  /** 0x2c i32 累计盈余（运行期） */
  profit: number;
  /** 0x30 u32 自留股（运行期） */
  shares: number;
  hex: string;
}

export interface RawLandscape {
  id: number;
  x: number;
  y: number;
  name: RawName;
  facing: number;
  b19: number;
  spriteRes: number;
  hex: string;
}

export interface RawCheck {
  ok: boolean;
  /** error 失败即 exit 1；warn 只报告（规格外补充字段） */
  severity: 'error' | 'warn';
  detail?: string;
}

export interface RawSource {
  id: RawSourceId;
  edition: EditionId;
  /** 相对 original/ 的路径（保留实际大小写） */
  file: string;
  fileSha256: string;
  /** known-files.json 中的 id；未登记为 null（规格外补充） */
  knownFileId: string | null;
  container: 'MapDat.mkf' | 'map.mkf';
  resource: number;
  compressed: boolean;
  byteLength: number;
  resourceSha256: string;
}

export interface MapDataRaw {
  schema: 'rich4.map-raw/1';
  source: RawSource;
  globalMapId: number;
  header: Record<TableName, TableRef>;
  nodes: RawNode[];
  lands: RawLand[];
  facilities: RawFacility[];
  companies: RawCompany[];
  landscapes: RawLandscape[];
  checks: Record<string, RawCheck>;
}
