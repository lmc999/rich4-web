/**
 * 新闻 36 条（design/engine.md §10.6，按 docs/research/events-from-exe.md §1、§4 修正）。
 *
 * - 牌堆 36 张：开局洗一次，游标循环；抽到不可行的跳过、游标照样前进（最多试 36 次）。
 * - 文案只存 i18n key（`news:<id>.headline` / `news:<id>.body`，客户端 locales/zh-CN/news.json），不写原版文案。
 * - params 为 exe 读出的数值（键名与 `.cache/extract/tables.<edition>.json` 的 news[id].params 相同，由测试对照）：
 *   趋势字节 trend 的低半字节 = 下跌天数、高半字节 = 上涨天数；factor / rate 是 exe 里的 double 常量。
 * - 新闻不查神明加持（exe 中新闻代码对加持函数 0 处调用）；blessing 只在 rules.blessingOnNews（MANUAL）时使用。
 * - 与 engine.md 的出入以 events-from-exe §4 为准：新闻 9 在全体在场玩家中取最少（含 0 块、并列取座位最小）；
 *   12 的基数含设施；15 的可行条件收紧为「有等级 > 0 的住宅」（原版与 4、5 共用判定，只有设施有建筑时会除以 0）；
 *   27 写入 15 天（文案 10 天）；29 在全部有董事长的公司中抽（抽到受困的董事长也照样坐牢）；30/33/34 不要求有董事长；
 *   35 累计盈余加 2 × 原盈余、上涨天数 = trunc(原盈余 / 10000) & 0xF。
 *
 * @source exe v2.06 newsHandlers 0x473c48、newsCategories 0x473cd8；v3.11 0x475e24、0x475eb4
 * @source docs/research/events-from-exe.md §1、§4
 * @verify extract:news[id]（.cache/extract/tables.v206.json，data/tables/events.test.ts 对照）
 */
import type { Sourced, Src } from '../source';
import { NEWS_IDS, type NewsId } from './ids';

/** 事件加持类别（奖金读财运、罚金读财运、劫难读福运；docs/research/g_arbitration.md §2.b） */
export type BlessingClass = 'reward' | 'penalty' | 'misfortune';

export type NewsEffect =
  | 'releaseAll'
  | 'extendAll'
  | 'alienAttack'
  | 'monster'
  | 'streetPrice'
  | 'publicAuction'
  | 'rewardTopLandlord'
  | 'subsidyFewest'
  | 'rewardTopShareholder'
  | 'incomeTax'
  | 'landTax'
  | 'stockTax'
  | 'gasExplosion'
  | 'stayByVehicle'
  | 'earthquake'
  | 'flood'
  | 'typhoon'
  | 'tornado'
  | 'bankRun'
  | 'bonusInterest'
  | 'marketAll'
  | 'marketHalt'
  | 'suspend'
  | 'resume'
  | 'overLoanJail'
  | 'companyFine'
  | 'overseas'
  | 'doubleProfit';

/**
 * 可行条件（引擎 effects/news 按它判定）：
 * always 恒可；jailed / hospitalized 有玩家在押 / 住院；builtLot 有等级 > 0 的住宅或设施；builtLand 有等级 > 0 的住宅；
 * ownerlessLot 有无主的住宅或设施；anyOwner 有人拥有住宅或设施；anyHolding 有人持股；walker / rider 有步行 / 乘车的玩家；
 * suspended 有停牌股；chairmanFree 有在场、未受困的董事长；profitable 有本月盈余 > threshold 的公司
 */
export type NewsFeasibility =
  | 'always'
  | 'jailed'
  | 'hospitalized'
  | 'builtLot'
  | 'builtLand'
  | 'ownerlessLot'
  | 'anyOwner'
  | 'anyHolding'
  | 'walker'
  | 'rider'
  | 'suspended'
  | 'chairmanFree'
  | 'profitable';

/** 新闻分类（exe newsCategories）：0 奇闻、1 政府公告、2 社会、3 路况、4 气象、5 财经 */
export type NewsCategory = 0 | 1 | 2 | 3 | 4 | 5;

export interface NewsDef extends Sourced {
  id: NewsId;
  /** i18n key 前缀：`news:<id>`（headline / body） */
  textKey: string;
  category: NewsCategory;
  effect: NewsEffect;
  /** exe 参数（键名与抽取结果一致） */
  params: Readonly<Record<string, number>>;
  feasible: NewsFeasibility;
  /** 作用对象：玩家 jail / hospital（0–3）、步行 / 乘车（16/17）；其余为 null */
  scope: 'jail' | 'hospital' | 'walker' | 'rider' | null;
  /** rules.blessingOnNews=true（MANUAL）时对受影响玩家做的加持判定类别；PROGRAM 下不用 */
  blessing: BlessingClass | null;
}

/** [分类, 效果, 参数, 可行条件, 作用对象, MANUAL 加持, v3.11 处理函数, v2.06 处理函数, 参数 VA（v3.11/v2.06，按参数顺序）] */
type Row = readonly [
  NewsCategory,
  NewsEffect,
  Readonly<Record<string, number>>,
  NewsFeasibility,
  NewsDef['scope'],
  BlessingClass | null,
  string,
  string,
  readonly (readonly [string, string])[],
];

const ROWS: Readonly<Record<NewsId, Row>> = {
  0: [0, 'releaseAll', {}, 'jailed', 'jail', null, '0x448eca', '0x447a80', []],
  1: [0, 'extendAll', { days: 3 }, 'jailed', 'jail', 'misfortune', '0x448f45', '0x447afb', [['0x448f5b', '0x447b0b']]],
  2: [0, 'releaseAll', {}, 'hospitalized', 'hospital', null, '0x449006', '0x447bad', []],
  3: [
    0,
    'extendAll',
    { days: 3 },
    'hospitalized',
    'hospital',
    'misfortune',
    '0x449081',
    '0x447c28',
    [['0x449097', '0x447c38']],
  ],
  4: [
    0,
    'alienAttack',
    { halfWidth: 100, hospitalDays: 3 },
    'builtLot',
    null,
    null,
    '0x44913d',
    '0x447cd8',
    [
      ['0x44922b', '0x447dc6'],
      ['0x449282', '0x447e1d'],
    ],
  ],
  5: [0, 'monster', {}, 'builtLot', null, null, '0x4492a0', '0x447e3b', []],
  6: [
    1,
    'streetPrice',
    { factor: 1.3, factorFacility: 1.3 },
    'always',
    null,
    null,
    '0x4494e0',
    '0x44807b',
    [
      ['0x449662', '0x4481eb'],
      ['0x449708', '0x448285'],
    ],
  ],
  7: [1, 'publicAuction', {}, 'ownerlessLot', null, null, '0x449735', '0x4482a9', []],
  8: [
    1,
    'rewardTopLandlord',
    { reward: 10000 },
    'anyOwner',
    null,
    'reward',
    '0x4498b3',
    '0x448427',
    [['0x449994', '0x4484f6']],
  ],
  9: [
    1,
    'subsidyFewest',
    { subsidy: 5000 },
    'anyOwner',
    null,
    'reward',
    '0x449a8a',
    '0x4485e6',
    [['0x449b6a', '0x4486b4']],
  ],
  10: [
    1,
    'rewardTopShareholder',
    { reward: 10000 },
    'anyHolding',
    null,
    'reward',
    '0x449b9c',
    '0x4486e3',
    [['0x449c4a', '0x448782']],
  ],
  11: [1, 'incomeTax', { rate: 0.05 }, 'always', null, 'penalty', '0x449c7c', '0x4487b1', [['0x449cf4', '0x448823']]],
  12: [1, 'landTax', { rate: 0.05 }, 'anyOwner', null, 'penalty', '0x449de6', '0x448909', [['0x449f22', '0x448a24']]],
  13: [
    1,
    'stockTax',
    { rate: 0.05 },
    'anyHolding',
    null,
    'penalty',
    '0x44a029',
    '0x448b15',
    [['0x44a11c', '0x448bea']],
  ],
  14: [2, 'streetPrice', { factor: 0.7 }, 'always', null, null, '0x44a220', '0x448cdb', [['0x44a3a2', '0x448e4b']]],
  15: [2, 'gasExplosion', {}, 'builtLand', null, null, '0x44a453', '0x448ef0', []],
  16: [3, 'stayByVehicle', {}, 'walker', 'walker', 'misfortune', '0x44a5d6', '0x449073', []],
  17: [3, 'stayByVehicle', {}, 'rider', 'rider', 'misfortune', '0x44a657', '0x4490f4', []],
  18: [4, 'earthquake', {}, 'always', null, null, '0x44a6e0', '0x44917d', []],
  19: [4, 'flood', {}, 'always', null, null, '0x44a91e', '0x4493ac', []],
  20: [4, 'typhoon', { halfWidth: 100 }, 'always', null, null, '0x44ab2c', '0x44959f', [['0x44ac41', '0x44969c']]],
  21: [4, 'tornado', {}, 'always', null, null, '0x44ac99', '0x4496f1', []],
  22: [5, 'bankRun', { days: 15 }, 'always', null, null, '0x44ae89', '0x4498c9', [['0x44aeb6', '0x4498f6']]],
  23: [5, 'bonusInterest', { rate: 0.1 }, 'always', null, 'reward', '0x44aedb', '0x44991b', [['0x44af4a', '0x449984']]],
  24: [5, 'marketAll', { trend: 1 }, 'always', null, null, '0x44b00a', '0x449a3d', [['0x44b033', '0x449a66']]],
  25: [5, 'marketAll', { trend: 16 }, 'always', null, null, '0x44b055', '0x449a88', [['0x44b07e', '0x449ab1']]],
  26: [5, 'marketHalt', { days: 10 }, 'always', null, null, '0x44b0a0', '0x449ad3', [['0x44b0c6', '0x449af9']]],
  27: [
    5,
    'suspend',
    { days: 15, pick: 12 },
    'always',
    null,
    null,
    '0x44b0d1',
    '0x449b04',
    [
      ['0x44b154', '0x449b7b'],
      ['0x44b0ee', '0x449b1b'],
    ],
  ],
  28: [5, 'resume', {}, 'suspended', null, null, '0x44b1a3', '0x449bc7', []],
  29: [
    5,
    'overLoanJail',
    { days: 5 },
    'chairmanFree',
    null,
    'misfortune',
    '0x44b25b',
    '0x449c79',
    [['0x44b35f', '0x449d77']],
  ],
  30: [
    5,
    'companyFine',
    { fine: 10000, trend: 3 },
    'always',
    null,
    null,
    '0x44b374',
    '0x449d8c',
    [
      ['0x44b3d9', '0x449deb'],
      ['0x44b3fa', '0x449e0c'],
    ],
  ],
  31: [
    5,
    'overseas',
    { gain: 20000, trend: 48 },
    'always',
    null,
    null,
    '0x44b419',
    '0x449e28',
    [
      ['0x44b47a', '0x449e87'],
      ['0x44b49b', '0x449ea8'],
    ],
  ],
  32: [
    5,
    'overseas',
    { loss: 20000, trend: 4 },
    'always',
    null,
    null,
    '0x44b4a8',
    '0x449ec4',
    [
      ['0x44b50d', '0x449f23'],
      ['0x44b532', '0x449f44'],
    ],
  ],
  33: [
    5,
    'companyFine',
    { fine: 10000, trend: 3 },
    'always',
    null,
    null,
    '0x44b53f',
    '0x449f60',
    [
      ['0x44b3d9', '0x449deb'],
      ['0x44b3fa', '0x449e0c'],
    ],
  ],
  34: [
    5,
    'companyFine',
    { fine: 5000, trend: 3 },
    'always',
    null,
    null,
    '0x44b57d',
    '0x449ffc',
    [
      ['0x44b5e2', '0x44a05b'],
      ['0x44b3fa', '0x449e0c'],
    ],
  ],
  35: [
    5,
    'doubleProfit',
    { threshold: 10000, divisor: 10000 },
    'profitable',
    null,
    null,
    '0x44b5f5',
    '0x44a098',
    [
      ['0x44b623', '0x44a0c0'],
      ['0x44b6a1', '0x44a138'],
    ],
  ],
};

const DOC: Src = { research: 'docs/research/events-from-exe.md §1、§4' };

/** 可信度：新闻 15 的可行条件按 events-from-exe §4 的建议收紧（medium），其余与 exe 一致（high） */
const MEDIUM: readonly NewsId[] = [15];

export const NEWS_TABLE: readonly NewsDef[] = Object.freeze(
  NEWS_IDS.map((id): NewsDef => {
    const [category, effect, params, feasible, scope, blessing, v311, v206, paramVa] = ROWS[id];
    const src: Src[] = [
      { exe: '2.06', va: v206 },
      { exe: '3.11', va: v311 },
    ];
    for (const [a, b] of paramVa) src.push({ exe: '2.06', va: b }, { exe: '3.11', va: a });
    src.push(DOC, { verify: `extract:news[${id}]` });
    return Object.freeze({
      id,
      textKey: `news:${id}`,
      category,
      effect,
      params: Object.freeze({ ...params }),
      feasible,
      scope,
      blessing,
      src,
      confidence: MEDIUM.includes(id) ? 'medium' : 'high',
    });
  }),
);

export function newsDef(id: NewsId): NewsDef {
  return NEWS_TABLE[id]!;
}

/** 读取一条新闻的数值参数；缺失即数据缺陷（抛 RangeError） */
export function newsParam(id: NewsId, key: string): number {
  const v = NEWS_TABLE[id]?.params[key];
  if (v === undefined) throw new RangeError(`news ${id} has no param ${key}`);
  return v;
}

/** 趋势字节：低半字节 = 下跌天数，高半字节 = 上涨天数（新闻 24/25/30–32） */
export function decodeTrend(trend: number): { up: number; down: number } {
  return { up: (trend >> 4) & 0xf, down: trend & 0xf };
}
