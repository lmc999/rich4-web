/**
 * 命运 37 条（design/engine.md §10.7，按 docs/research/events-from-exe.md §2、§4 修正）。
 *
 * - 牌堆 37 张：开局洗一次，游标循环；抽到后先按座驾替换（10↔11、12↔13、14/15/16），再判可行性，不可行就跳过
 *   （游标照样前进，最多试 37 次）。
 * - 地图组变体（v2.06 行为）：编号 33..36 的坐牢在 v2.06 恒可（v3.11 只在原版 4 张图可行），并按当前地图号选文案
 *   （表项 37..48，天数与基础条相同）；variants 只影响文案，不影响规则。
 * - 加持（exe 自动识别：处理函数调用加持函数 0x44b896 / 0x44a33c 的 33 条，除 0、1、4、5 外全部）：
 *   奖金类 reward（读财运：high ×2 / low 作废）、罚金类 penalty（读财运：high 免付 / low ×2）、
 *   劫难类 misfortune（读福运：high 逃过此劫 / low 天数 ×2）。handlesDouble=false 的 3、8、9、10、11、32 只处理
 *   「免付 / 逃过」，低档照常执行、不加倍。
 * - 罚金类（2、14–19、23、24、26、30）投保期间由保险公司赔同额（加持免付时不赔）。
 * - 命运 32 与魔法屋 0、8：卡片、道具按商店价**全价**折点券（座驾先折回道具），不乘 0.9。
 * - 坐牢 / 出国 / 住院类（6、7、12、13、33–36）的最终目标走免罪 → 嫁祸（g_villains §6，cardCheck）。
 * - 文案只存 i18n key（`fate:<id>`，客户端 locales/zh-CN/fate.json），不写原版文案。
 *
 * @source exe v2.06 fateHandlers 0x473d14（49 项 = 37 + 12 个地图组变体）；v3.11 0x475ef0
 * @source docs/research/events-from-exe.md §2、§4；docs/research/g_villains.md §6
 * @verify extract:fate[id]（.cache/extract/tables.v206.json，data/tables/events.test.ts 对照）
 */
import type { Sourced, Src } from '../source';
import { FATE_IDS, type FateId } from './ids';
import type { BlessingClass } from './news';

export type FateEffect =
  | 'demolishOwn'
  | 'expropriate'
  | 'fakeLoan'
  | 'bankRefuse'
  | 'embezzle'
  | 'birthday'
  | 'abroad'
  | 'stockDefault'
  | 'sellAllStocks'
  | 'loseVehicle'
  | 'ditch'
  | 'fine'
  | 'reward'
  | 'sellAllCardsTools'
  | 'jail';

/**
 * 可行条件（替换之后判定）：always 恒可；ownBuiltLand 自己有等级 > 0 的住宅；ownEmptyLand 自己有等级 0 的住宅；
 * rivalCards 有持卡的对手；ownHoldings 自己持股；moto / car / walk 当前座驾
 */
export type FateFeasibility =
  | 'always'
  | 'ownBuiltLand'
  | 'ownEmptyLand'
  | 'rivalCards'
  | 'ownHoldings'
  | 'moto'
  | 'car'
  | 'walk';

/** 座驾替换组：vehicleLoss（10 机车 / 11 汽车）、injury（12 步行 / 13 机车）、fine（14 步行 / 15 机车 / 16 汽车） */
export type FateSwapGroup = 'vehicleLoss' | 'injury' | 'trafficFine';

export interface FateBlessing {
  category: BlessingClass;
  /** false：只处理 high（免付 / 逃过），low 照常执行、不加倍 */
  handlesDouble: boolean;
}

export interface FateVariant {
  /** 地图组 1..3 */
  group: number;
  /** exe 表项 37..48 */
  slot: number;
  days: number;
}

export interface FateDef extends Sourced {
  id: FateId;
  /** i18n key 前缀：`fate:<id>`（title / text） */
  textKey: string;
  effect: FateEffect;
  /** exe 参数（键名与抽取结果一致）：amount / loan 要乘物价指数，days、pct 不乘 */
  params: Readonly<Record<string, number>>;
  feasible: FateFeasibility;
  swap: FateSwapGroup | null;
  blessing: FateBlessing | null;
  /** 投保期间保险公司赔同额 */
  insured: boolean;
  /** 最终目标走免罪 → 嫁祸（cardCheck） */
  passive: boolean;
  variants: readonly FateVariant[];
}

type Row = readonly [
  FateEffect,
  Readonly<Record<string, number>>,
  FateFeasibility,
  FateSwapGroup | null,
  BlessingClass | null,
  boolean,
  boolean,
  boolean,
  string,
  string,
  readonly (readonly [string, string])[],
];

// [效果, 参数, 可行条件, 替换组, 加持类别, 处理加倍, 投保理赔, 免罪嫁祸, v3.11, v2.06, 参数 VA（v3.11/v2.06）]
const ROWS: Readonly<Record<FateId, Row>> = {
  0: ['demolishOwn', {}, 'ownBuiltLand', null, null, false, false, false, '0x44be16', '0x44a86e', []],
  1: ['expropriate', {}, 'ownEmptyLand', null, null, false, false, false, '0x44bfb1', '0x44aa09', []],
  2: [
    'fakeLoan',
    { loan: 10000 },
    'always',
    null,
    'penalty',
    true,
    true,
    false,
    '0x44c0e8',
    '0x44ab40',
    [['0x44c0fe', '0x44ab50']],
  ],
  3: [
    'bankRefuse',
    { days: 30 },
    'always',
    null,
    'penalty',
    false,
    false,
    false,
    '0x44c229',
    '0x44ac78',
    [['0x44c2ba', '0x44ad09']],
  ],
  4: [
    'embezzle',
    { pct: 10 },
    'always',
    null,
    null,
    false,
    false,
    false,
    '0x44c2c2',
    '0x44ad11',
    [['0x44c2d4', '0x44ad1d']],
  ],
  5: ['birthday', {}, 'rivalCards', null, null, false, false, false, '0x44c3b7', '0x44adee', []],
  6: [
    'abroad',
    { days: 3 },
    'always',
    null,
    'misfortune',
    true,
    false,
    true,
    '0x44c5d8',
    '0x44b000',
    [['0x44c5eb', '0x44b00d']],
  ],
  7: [
    'abroad',
    { days: 3 },
    'always',
    null,
    'misfortune',
    true,
    false,
    true,
    '0x44c6ed',
    '0x44b10f',
    [['0x44c700', '0x44b11c']],
  ],
  8: [
    'stockDefault',
    { pct: 10 },
    'ownHoldings',
    null,
    'penalty',
    false,
    false,
    false,
    '0x44c7ef',
    '0x44b20b',
    [['0x44c802', '0x44b218']],
  ],
  9: ['sellAllStocks', {}, 'ownHoldings', null, 'penalty', false, false, false, '0x44c91f', '0x44b326', []],
  10: ['loseVehicle', {}, 'moto', 'vehicleLoss', 'misfortune', false, false, false, '0x44ca46', '0x44b44d', []],
  11: ['loseVehicle', {}, 'car', 'vehicleLoss', 'misfortune', false, false, false, '0x44cb53', '0x44b55a', []],
  12: [
    'ditch',
    { days: 3 },
    'walk',
    'injury',
    'misfortune',
    true,
    false,
    true,
    '0x44cc53',
    '0x44b65a',
    [['0x44cc67', '0x44b668']],
  ],
  13: [
    'ditch',
    { days: 3 },
    'moto',
    'injury',
    'misfortune',
    true,
    false,
    true,
    '0x44cd6c',
    '0x44b76d',
    [['0x44cd84', '0x44b77f']],
  ],
  14: [
    'fine',
    { amount: 3000 },
    'walk',
    'trafficFine',
    'penalty',
    true,
    true,
    false,
    '0x44cd99',
    '0x44b794',
    [['0x44cdb1', '0x44b7a6']],
  ],
  15: [
    'fine',
    { amount: 3000 },
    'moto',
    'trafficFine',
    'penalty',
    true,
    true,
    false,
    '0x44cf1e',
    '0x44b913',
    [['0x44cf5b', '0x44b947']],
  ],
  16: [
    'fine',
    { amount: 3000 },
    'car',
    'trafficFine',
    'penalty',
    true,
    true,
    false,
    '0x44d06d',
    '0x44ba59',
    [['0x44d0aa', '0x44ba8d']],
  ],
  17: [
    'fine',
    { amount: 6000 },
    'always',
    null,
    'penalty',
    true,
    true,
    false,
    '0x44d0d6',
    '0x44bab9',
    [['0x44d0ee', '0x44bacb']],
  ],
  18: [
    'fine',
    { amount: 600 },
    'always',
    null,
    'penalty',
    true,
    true,
    false,
    '0x44d1a5',
    '0x44bb82',
    [['0x44d1b9', '0x44bb90']],
  ],
  19: [
    'fine',
    { amount: 1500 },
    'always',
    null,
    'penalty',
    true,
    true,
    false,
    '0x44d1e0',
    '0x44bbb7',
    [['0x44d1f8', '0x44bbc5']],
  ],
  20: [
    'reward',
    { amount: 1000 },
    'always',
    null,
    'reward',
    true,
    false,
    false,
    '0x44d224',
    '0x44bbf1',
    [['0x44d237', '0x44bbfe']],
  ],
  21: [
    'reward',
    { amount: 2000 },
    'always',
    null,
    'reward',
    true,
    false,
    false,
    '0x44d33b',
    '0x44bd02',
    [['0x44d352', '0x44bd13']],
  ],
  22: [
    'reward',
    { amount: 3000 },
    'always',
    null,
    'reward',
    true,
    false,
    false,
    '0x44d3db',
    '0x44bd99',
    [['0x44d3f2', '0x44bdaa']],
  ],
  23: [
    'fine',
    { amount: 1000 },
    'always',
    null,
    'penalty',
    true,
    true,
    false,
    '0x44d41e',
    '0x44bdd6',
    [['0x44d436', '0x44bde8']],
  ],
  24: [
    'fine',
    { amount: 2000 },
    'always',
    null,
    'penalty',
    true,
    true,
    false,
    '0x44d462',
    '0x44be14',
    [['0x44d47a', '0x44be26']],
  ],
  25: [
    'reward',
    { amount: 10000 },
    'always',
    null,
    'reward',
    true,
    false,
    false,
    '0x44d4a6',
    '0x44be52',
    [['0x44d4bd', '0x44be63']],
  ],
  26: [
    'fine',
    { amount: 8000 },
    'always',
    null,
    'penalty',
    true,
    true,
    false,
    '0x44d4e7',
    '0x44be8d',
    [['0x44d4ff', '0x44be9f']],
  ],
  27: [
    'reward',
    { amount: 4000 },
    'always',
    null,
    'reward',
    true,
    false,
    false,
    '0x44d52b',
    '0x44becb',
    [['0x44d542', '0x44bedc']],
  ],
  28: [
    'reward',
    { amount: 6000 },
    'always',
    null,
    'reward',
    true,
    false,
    false,
    '0x44d56e',
    '0x44bf08',
    [['0x44d585', '0x44bf19']],
  ],
  29: [
    'reward',
    { amount: 8000 },
    'always',
    null,
    'reward',
    true,
    false,
    false,
    '0x44d5b1',
    '0x44bf45',
    [['0x44d5c8', '0x44bf56']],
  ],
  30: [
    'fine',
    { amount: 5000 },
    'always',
    null,
    'penalty',
    true,
    true,
    false,
    '0x44d5f4',
    '0x44bf82',
    [['0x44d60c', '0x44bf94']],
  ],
  31: [
    'reward',
    { amount: 5000 },
    'always',
    null,
    'reward',
    true,
    false,
    false,
    '0x44d636',
    '0x44bfbe',
    [['0x44d64d', '0x44bfcf']],
  ],
  32: ['sellAllCardsTools', {}, 'always', null, 'misfortune', false, false, false, '0x44d677', '0x44bff9', []],
  33: [
    'jail',
    { days: 3 },
    'always',
    null,
    'misfortune',
    true,
    false,
    true,
    '0x44d783',
    '0x44c105',
    [['0x44d797', '0x44c113']],
  ],
  34: [
    'jail',
    { days: 5 },
    'always',
    null,
    'misfortune',
    true,
    false,
    true,
    '0x44d8cf',
    '0x44c248',
    [['0x44d8e7', '0x44c25a']],
  ],
  35: [
    'jail',
    { days: 7 },
    'always',
    null,
    'misfortune',
    true,
    false,
    true,
    '0x44d8fd',
    '0x44c270',
    [['0x44d915', '0x44c282']],
  ],
  36: [
    'jail',
    { days: 9 },
    'always',
    null,
    'misfortune',
    true,
    false,
    true,
    '0x44d92b',
    '0x44c298',
    [['0x44d943', '0x44c2aa']],
  ],
};

/** 坐牢类（33–36）的地图组变体：表项 = 编号 + 4 × 组序号（组 1..3），天数与基础条相同 */
function variantsOf(id: FateId, effect: FateEffect, days: number | undefined): FateVariant[] {
  if (effect !== 'jail' || days === undefined) return [];
  return [1, 2, 3].map((group) => ({ group, slot: id + 4 * group, days }));
}

const DOC: Src = { research: 'docs/research/events-from-exe.md §2、§4' };
const VILLAINS: Src = { research: 'docs/research/g_villains.md §6' };

export const FATE_TABLE: readonly FateDef[] = Object.freeze(
  FATE_IDS.map((id): FateDef => {
    const [effect, params, feasible, swap, category, handlesDouble, insured, passive, v311, v206, paramVa] = ROWS[id];
    const src: Src[] = [
      { exe: '2.06', va: v206 },
      { exe: '3.11', va: v311 },
    ];
    for (const [a, b] of paramVa) src.push({ exe: '2.06', va: b }, { exe: '3.11', va: a });
    src.push(DOC);
    if (passive) src.push(VILLAINS);
    src.push({ verify: `extract:fate[${id}]` });
    return Object.freeze({
      id,
      textKey: `fate:${id}`,
      effect,
      params: Object.freeze({ ...params }),
      feasible,
      swap,
      blessing: category === null ? null : Object.freeze({ category, handlesDouble }),
      insured,
      passive,
      variants: Object.freeze(variantsOf(id, effect, params.days)),
      src,
      confidence: 'high',
    });
  }),
);

export function fateDef(id: FateId): FateDef {
  return FATE_TABLE[id]!;
}

export function fateParam(id: FateId, key: string): number {
  const v = FATE_TABLE[id]?.params[key];
  if (v === undefined) throw new RangeError(`fate ${id} has no param ${key}`);
  return v;
}

/**
 * 按座驾替换抽到的命运（exe：先替换再判可行）：
 *   vehicleLoss 机车 → 10、汽车 → 11；injury 步行 → 12、机车 → 13；trafficFine 步行 → 14、机车 → 15、汽车 → 16。
 *   不在对应列表里的座驾（步行丢车、汽车摔伤、工程车）保持原号，随后由可行条件挡掉 ⚑工程车。
 */
export function swapFateByVehicle(id: FateId, vehicle: 'walk' | 'moto' | 'car' | 'engineer'): FateId {
  const g = FATE_TABLE[id]?.swap ?? null;
  if (g === 'vehicleLoss') return vehicle === 'moto' ? 10 : vehicle === 'car' ? 11 : id;
  if (g === 'injury') return vehicle === 'walk' ? 12 : vehicle === 'moto' ? 13 : id;
  if (g === 'trafficFine') return vehicle === 'walk' ? 14 : vehicle === 'moto' ? 15 : vehicle === 'car' ? 16 : id;
  return id;
}
