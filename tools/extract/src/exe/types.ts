import type { Big5StringIndex, PeFile } from '../pe/scan';
import type { TableAnchors } from './anchors';
import type { CodeIndex } from './code';
import type { FateRow, MagicTables, NewsRow } from './events';

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

/** 新闻 / 命运 / 魔法屋的指针表与跳表（D2 第二部分；与固定表分开记录，定位失败不影响固定表） */
export const EVENT_TABLE_IDS = [
  'newsHandlers',
  'newsCategories',
  'fateHandlers',
  'magicEffects',
  'magicConditions',
  'magicEffectJump',
  'magicCondJump',
] as const;
export type EventTableId = (typeof EVENT_TABLE_IDS)[number];
export type AnyTableId = TableId | EventTableId;

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
  located: Partial<Record<AnyTableId, number>>;
  /** 代码节指令索引（按需构建） */
  code?: CodeIndex;
  /** 股票表推出的地图数（节日表按它分块） */
  maps?: number;
  /** 参考版本（v3.11）已定位的表，用于 xrefTransfer；本身就是参考版本时为空 */
  ref?: { file: PeFile; located: Partial<Record<AnyTableId, number>> } | undefined;
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

/** 农历表：摘要 + 逐日数据（派生数据，只写 .cache，供引擎代理做农历换算对照测试） */
export interface LunarSummary {
  days: number;
  firstSolar: string;
  lastSolar: string;
  firstLunar: string;
  lastLunar: string;
  /** 农历十二月出现过的最大日（节日表的「十二月三十一」能否命中） */
  maxDayMonth12: number;
  leapMonths: number;
  /** 逐日 u32：农历 (年 << 16 | 月 << 8 | 日)，下标 0 = 公历 1998-01-01；闰月沿用月号 */
  packed: number[];
  /** 按农历月归并：该月初一的公历日期、农历年月、是否闰月、天数 */
  months: { solarStart: string; year: number; month: number; leap: boolean; days: number }[];
}

export interface TableDigest {
  bytes: number;
  /** 表区域原始字节的 sha256（含指针，跨版本必然不同） */
  bytesSha256: string;
  /** 解析结果（去掉 hex 与指针值）的 sha256，用于跨版本比较内容 */
  contentSha256: string;
}

/** 常量锚点在本版本的读取结果（id → 值；供 shared 的 verify 测试对照） */
export type ConstantValues = Record<string, { value: number | number[] | null; va: string | null; ok: boolean }>;

/** 新闻 / 命运 / 魔法屋表的定位与函数入口 */
export interface EventTablesInfo {
  locate: Record<EventTableId, LocateInfo>;
  newsHandlers: string[];
  fateHandlers: string[];
  magicEffectJump: string[];
  magicCondJump: string[];
  newsCategoryNames: string[];
  /** 识别出的辅助函数入口（名称 → VA） */
  helpers: Record<string, string | null>;
}

/** 视野投影表（V-E10）：8 个视角 */
export interface ViewTables {
  /**
   * 29×29 相对格（dx, dy ∈ −14..14）→ 屏幕像素偏移，每视角一张（v3.11 0x46ccf0）。data[view] 按 [dy+14][dx+14] 展平
   * （**dy 在外层**，下标 (dy+14)·29 + (dx+14)），每项为 **(sy, sx)**（先纵后横，int16）。
   * 在台湾皮肤上核对：按此轴序拟合的仿射对 8 视角 × 841 格点最大误差约 2 px；按 dx 外层、(sx, sy) 读误差上千 px。
   * 用法见 assets/skin.ts（fitViewAffines、exactTables）与 shared mapskin ExactTablesSchema。
   */
  cellScreen: { va: string; dirs: number; size: number; data: [number, number][][] };
  /** 格内亚像素（x & 31, y & 31）的 2×2 投影矩阵 [a, b, c, d]：sx = (a·x + c·y) >> 5，sy = (b·x + d·y) >> 5（v3.11 0x474910） */
  subcell: { va: string; data: [number, number, number, number][] };
  /** 每视角的绘制顺序（相对格 (dx, dy)，−128 结束；v3.11 0x473610，每视角 0x260 字节） */
  drawOrder: { va: string; data: [number, number][][] };
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
  /** D2 第二部分：常量锚点读取值（抽取失败或缺参考版本时为 null） */
  constants: ConstantValues | null;
  eventTables: EventTablesInfo | null;
  news: NewsRow[] | null;
  fate: FateRow[] | null;
  magic: MagicTables | null;
  view: ViewTables | null;
  /** 定位与结构校验以外的事实核对（期望值来自调研文档） */
  facts: Check[];
}
