/**
 * 魔法屋：12 个条件 × 12 种效果（design/engine.md §10.8，按 docs/research/events-from-exe.md §3、§4 修正）。
 *
 * 流程：条件 rand % 12（真人与电脑相同），名单为空就重抽（不设上限）；名单上限 = 玩家数（没有另设 4 人上限）。
 * 效果：真人在转盘上点选（不因名单含自己而限制）；电脑名单含自己时固定选 6，否则 rand % 11、抽到 6 改为 7
 * （ai/decisions/magic.ts）。效果对名单逐人执行。
 * 条件判据：0 总资产最多（并列全选，0 也参选）；1–5 地产块数 / 有建筑地产 / 现金 / 存款 / 点券最多（并列全选，
 * 数值为 0 的不参选）；6–8 座驾为步行 / 机车 / 汽车；9 有神明附身；10 / 11 男生 / 女生。
 * 效果要点：0、8 全价折点券（座驾先折回道具）；2、10 先记敌意 90 × PI 再走免罪 → 嫁祸；3 停留计数 + 1；
 * 5、7、9、11 跳过受困（计数非 0）的目标；11 以目标玩家为卖方拍卖脚下地产（V-R7「钱归谁」代码上归目标）。
 * 文案只存 i18n key（`magic:condition.<id>`、`magic:effect.<id>.name|desc`）。
 *
 * @source exe v2.06 magicConditions 0x4734ec、magicEffects 0x47354c、条件跳表 0x430bfb、效果跳表 0x431063
 * @source exe v3.11 0x4756b8、0x475718、0x431812、0x431c7a
 * @source docs/research/events-from-exe.md §3、§4；docs/research/g_villains.md §6
 * @verify extract:magic（.cache/extract/tables.v206.json，data/tables/events.test.ts 对照）
 */
import type { Sourced, Src } from '../source';
import { MAGIC_CONDITION_IDS, MAGIC_EFFECT_IDS, type MagicConditionId, type MagicEffectId } from './ids';

export type MagicConditionKey =
  | 'maxWealth'
  | 'maxLots'
  | 'maxBuilt'
  | 'maxCash'
  | 'maxDeposit'
  | 'maxPoints'
  | 'walking'
  | 'bike'
  | 'car'
  | 'possessed'
  | 'male'
  | 'female';

export type MagicEffectKey =
  | 'sellCards'
  | 'drawFate3'
  | 'jail'
  | 'stay'
  | 'depositAll'
  | 'upgradeHere'
  | 'drawCard'
  | 'turnAround'
  | 'sellTools'
  | 'demolishHere'
  | 'hospital'
  | 'auctionHere';

export interface MagicConditionDef extends Sourced {
  id: MagicConditionId;
  key: MagicConditionKey;
  /** i18n key：`magic:condition.<id>` */
  textKey: string;
  /** 最多类：数值为 0 的玩家也参选（只有条件 0 总资产） */
  zeroCounts: boolean;
}

export interface MagicEffectDef extends Sourced {
  id: MagicEffectId;
  key: MagicEffectKey;
  /** i18n key 前缀：`magic:effect.<id>`（name / desc） */
  textKey: string;
  /** exe 参数：days（坐牢 / 住院天数）、hate（敌意 × PI） */
  params: Readonly<Record<string, number>>;
  /** 受困（坐牢、住院、住旅馆、消失）的目标跳过 */
  skipConfined: boolean;
  /** 目标走免罪 → 嫁祸（cardCheck） */
  passive: boolean;
}

const COND_ROWS: Readonly<Record<MagicConditionId, readonly [MagicConditionKey, string, string]>> = {
  0: ['maxWealth', '0x431867', '0x430c50'],
  1: ['maxLots', '0x4318b7', '0x430ca0'],
  2: ['maxBuilt', '0x431969', '0x430d52'],
  3: ['maxCash', '0x431a23', '0x430e0c'],
  4: ['maxDeposit', '0x431a7d', '0x430e66'],
  5: ['maxPoints', '0x431ad2', '0x430ebb'],
  6: ['walking', '0x431b2c', '0x430f15'],
  7: ['bike', '0x431b61', '0x430f4a'],
  8: ['car', '0x431b99', '0x430f82'],
  9: ['possessed', '0x431bcf', '0x430fb8'],
  10: ['male', '0x431c02', '0x430feb'],
  11: ['female', '0x431c31', '0x43101a'],
};

type EffectRow = readonly [
  MagicEffectKey,
  Readonly<Record<string, number>>,
  boolean,
  boolean,
  string,
  string,
  readonly (readonly [string, string])[],
];

// [效果, 参数, 跳过受困, 免罪嫁祸, v3.11, v2.06, 参数 VA（v3.11/v2.06）]
const EFFECT_ROWS: Readonly<Record<MagicEffectId, EffectRow>> = {
  0: ['sellCards', {}, false, false, '0x431cd6', '0x4310b6', []],
  1: ['drawFate3', {}, false, false, '0x431d65', '0x431145', []],
  2: [
    'jail',
    { days: 3, hate: 90 },
    false,
    true,
    '0x431dcc',
    '0x4311ac',
    [
      ['0x431e65', '0x431242'],
      ['0x431e21', '0x431201'],
    ],
  ],
  3: ['stay', {}, false, false, '0x431e75', '0x431252', []],
  4: ['depositAll', {}, false, false, '0x431eef', '0x4312cc', []],
  5: ['upgradeHere', {}, true, false, '0x431f67', '0x431344', []],
  6: ['drawCard', {}, false, false, '0x4320dd', '0x4314a8', []],
  7: ['turnAround', {}, true, false, '0x432160', '0x431523', []],
  8: ['sellTools', {}, false, false, '0x4321f0', '0x4315b3', []],
  9: ['demolishHere', {}, true, false, '0x432259', '0x43161c', []],
  10: [
    'hospital',
    { days: 3, hate: 90 },
    false,
    true,
    '0x432384',
    '0x43173b',
    [
      ['0x43241e', '0x4317d2'],
      ['0x4323d9', '0x431790'],
    ],
  ],
  11: ['auctionHere', {}, true, false, '0x43242b', '0x4317df', []],
};

const DOC: Src = { research: 'docs/research/events-from-exe.md §3、§4' };

export const MAGIC_CONDITIONS: readonly MagicConditionDef[] = Object.freeze(
  MAGIC_CONDITION_IDS.map((id): MagicConditionDef => {
    const [key, v311, v206] = COND_ROWS[id];
    return Object.freeze({
      id,
      key,
      textKey: `magic:condition.${id}`,
      zeroCounts: id === 0,
      src: [
        { exe: '2.06', va: v206 },
        { exe: '3.11', va: v311 },
        DOC,
        { verify: `extract:magic.conditions[${id}]` },
      ] satisfies Src[] as Src[],
      confidence: 'high',
    });
  }),
);

export const MAGIC_EFFECTS: readonly MagicEffectDef[] = Object.freeze(
  MAGIC_EFFECT_IDS.map((id): MagicEffectDef => {
    const [key, params, skipConfined, passive, v311, v206, paramVa] = EFFECT_ROWS[id];
    const src: Src[] = [
      { exe: '2.06', va: v206 },
      { exe: '3.11', va: v311 },
    ];
    for (const [a, b] of paramVa) src.push({ exe: '2.06', va: b }, { exe: '3.11', va: a });
    src.push(DOC);
    if (passive) src.push({ research: 'docs/research/g_villains.md §6' });
    src.push({ verify: `extract:magic.effects[${id}]` });
    return Object.freeze({
      id,
      key,
      textKey: `magic:effect.${id}`,
      params: Object.freeze({ ...params }),
      skipConfined,
      passive,
      src,
      // 效果 11 拍卖款归属（V-R7）与 0、8 全价折点券按 exe 代码，尚待实机
      confidence: id === 11 ? 'medium' : 'high',
    });
  }),
);

export interface MagicFlowConst extends Sourced {
  value: number;
}

function flow(value: number, v311: string, v206: string): MagicFlowConst {
  return Object.freeze({
    value,
    src: [
      { exe: '2.06', va: v206 },
      { exe: '3.11', va: v311 },
      DOC,
      { research: 'docs/research/events-from-exe.md §5' },
    ] satisfies Src[] as Src[],
    confidence: 'high',
  });
}

/** 流程常量：条件 rand % 12（真人、电脑）；电脑名单含自己选 6，否则 rand % 11（抽到 6 改为 7） */
export const MAGIC_FLOW = Object.freeze({
  condPickHuman: flow(12, '0x431812', '0x430bfb'),
  condPickAi: flow(12, '0x433917', '0x432cc8'),
  aiSelfEffect: flow(6, '0x43395a', '0x432d0b'),
  aiEffectPick: flow(11, '0x43396d', '0x432d1e'),
});

export function magicEffectDef(id: MagicEffectId): MagicEffectDef {
  return MAGIC_EFFECTS[id]!;
}

export function magicParam(id: MagicEffectId, key: string): number {
  const v = MAGIC_EFFECTS[id]?.params[key];
  if (v === undefined) throw new RangeError(`magic effect ${id} has no param ${key}`);
  return v;
}
