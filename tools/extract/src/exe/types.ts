import type { Big5StringIndex, PeFile } from '../pe/scan';
import type { TableAnchors } from './anchors';

/** exe 固定表抽取结果（.cache/extract/tables.<edition>.json，派生数据，不入库；data-pipeline.md §6.3） */

export type ExeEdition = 'v206' | 'v311';

export const TABLE_IDS = [
  'cards',
  'tools',
  'characters',
  'stocks',
  'holidays',
  'setupFunds',
  'setupDays',
  'setupWealth',
  'facilityLevels',
  'lunar',
] as const;
export type TableId = (typeof TABLE_IDS)[number];

export type CheckLevel = 'error' | 'warn' | 'info';

export interface Check {
  id: string;
  level: CheckLevel;
  ok: boolean;
  detail: string;
}

export type LocateMethod = 'signature' | 'xref' | 'hint';

export interface LocateCandidate {
  method: LocateMethod;
  va: string | null;
  /** 结构校验（error 级）全部通过 */
  accepted: boolean;
  detail: string;
}

export interface LocateInfo {
  va: string;
  fileOffset: string;
  /** 采用的方法（按 signature → xref → hint 的顺序取第一个通过校验的） */
  method: LocateMethod;
  candidates: LocateCandidate[];
  checks: Check[];
}

export interface LocateContext {
  file: PeFile;
  strings: Big5StringIndex;
  edition: ExeEdition | 'unknown';
  anchors: TableAnchors;
  /** 已定位的表（后定位的表可以用「紧随某表」的签名） */
  located: Partial<Record<TableId, number>>;
  /** 股票表推出的地图数（节日表按它分块） */
  maps?: number;
  /** 参考版本（v3.11）已定位的表，用于 xrefTransfer；本身就是参考版本时为空 */
  ref?: { file: PeFile; located: Partial<Record<TableId, number>> } | undefined;
}

export interface CardRow {
  /** 原版编号 1..30 */
  id: number;
  name: string;
  initCount: number;
  price: number;
  f6: number;
  f7: number;
  hex: string;
}

export interface ToolRow {
  /** 原版编号 1..13 */
  id: number;
  name: string;
  stock: number;
  price: number;
  f6: number;
  f7: number;
  hex: string;
}

export interface CharacterRow {
  /** +0x13，原版编号 0..11 */
  id: number;
  name: string;
  nameNorm: string;
  /** +0x04 u32（0xRRGGBB 形式的颜色） */
  color: string;
  b12: number;
  /** +0x14：1 男、0 女 */
  gender: number;
  b15: number;
  /** +0x16：能力位（全为 3 = 用卡|用道具） */
  abilities: number;
  /** +0x17：0 乖宝宝、1 普通人、2 大老奸 */
  personality: number;
  loanRatio: number;
  cashRatio: number;
  stockRatio: number;
  /** 其余字节（+0x08..+0x11、+0x1b..+0x67）是否全 0 */
  restZero: boolean;
  hex: string;
}

export interface StockRow {
  /** 全局地图号（gm） */
  mapId: number;
  /** 该图内的股票行号 0..11（企业 +0x19 引用它） */
  index: number;
  name: string;
  nameNorm: string;
  hasCompany: number;
  u6: number;
  /** +0x08 u16 流通股 */
  float: number;
  u10: number;
  priceF32: string;
  /** +0x10/+0x14 与 +0x0c 相等 */
  pricesEqual: boolean;
  price: number;
  /** price × 100，断言为整数 */
  initPriceCents: number;
  volatilityF32: string;
  /** f32 的最短十进制表示 */
  volatility: number;
  tailZero: boolean;
  hex: string;
}

export interface HolidayRow {
  mapId: number;
  slot: number;
  /** 12 字节全 0（未使用的槽） */
  empty: boolean;
  /** +0 字节 bit7：查找时跳过（0x4521f0） */
  disabled: boolean;
  /** +0 字节：bit0 休市（0x4523d5 判「非 0」）、bit7 停用 */
  flags0: number;
  /** +1：0 公历固定日、1 农历、2 某月第 n 个星期几 */
  kind: number;
  month: number;
  /** kind 0/1 为日；kind 2 为第 n 个 */
  day: number;
  /** +4：kind 2 的星期（0 = 星期日） */
  weekday: number;
  /** +5 事件位：bit0 显示图片、bit1 代码未引用、bit2 换 BGM、bit3 每人发 1 张卡 */
  event: number;
  /** +6 u16 图片资源号、+8 u16 图片参数、+10 u16 BGM 曲号 */
  picture: number;
  pictureParam: number;
  bgm: number;
  closed: boolean;
  giveCard: boolean;
  bgmChange: boolean;
  lunar: boolean;
  hex: string;
}

export interface DefaultIndex {
  /** 保存当前档位下标的全局变量 */
  var: string | null;
  /** 该变量在数据节中的静态初值 */
  staticValue: number | null;
  /** 代码里 `mov dword [var], imm32` 写入的立即数（去重、升序） */
  immWrites: number[];
  /** 推定的默认下标：唯一的立即数写入，否则取静态初值 */
  index: number | null;
  value: number | null;
  detail: string;
}

export interface SetupTables {
  funds: number[];
  days: number[];
  wealthMultipliers: number[];
  defaults: { funds: DefaultIndex; days: DefaultIndex; wealthMultipliers: DefaultIndex };
}

/** 节日表字段在代码中的用法（佐证布局解读） */
export interface HolidayCode {
  fieldRefs: number[];
  flags0Tests: number[];
  flags0Cmps: number[];
  eventTests: number[];
}

/** 农历表摘要（不输出逐日数据） */
export interface LunarSummary {
  days: number;
  firstSolar: string;
  lastSolar: string;
  firstLunar: string;
  lastLunar: string;
  /** 农历十二月出现过的最大日（节日表的「十二月三十一」能否命中） */
  maxDayMonth12: number;
  leapMonths: number;
}

export interface TableDigest {
  bytes: number;
  /** 表区域原始字节的 sha256（含指针，跨版本必然不同） */
  bytesSha256: string;
  /** 解析结果（去掉 hex 与指针值）的 sha256，用于跨版本比较内容 */
  contentSha256: string;
}

export interface ExtractedTables {
  schema: 'rich4.exe-tables/1';
  edition: ExeEdition | 'unknown';
  exe: { file: string; sha256: string; bytes: number; knownFileId: string | null };
  locate: Record<TableId, LocateInfo>;
  digests: Record<TableId, TableDigest>;
  cards: CardRow[];
  tools: ToolRow[];
  characters: CharacterRow[];
  stocks: { maps: number; rows: StockRow[] };
  holidays: { maps: number; rows: HolidayRow[]; code: HolidayCode };
  setup: SetupTables;
  facilityLevels: { types: string[]; max: number[] };
  lunar: LunarSummary;
  /** 定位与结构校验以外的事实核对（期望值来自调研文档） */
  facts: Check[];
}
