/**
 * 30 张卡的数据表（design/engine.md §10.2、§14）。
 *
 * @source exe v3.11 卡表 VA 0x47fdf2，30 × 8 字节（mytbk/rich4 asm；oama rich4-spec data/cards.ts 取自同一张表）
 * @source docs/research/g_arbitration.md §1（点券价 / 初始张数，NU 逐字节比较 Game 与 MultiverseJourney 两版一致）
 * @source docs/research/r_references.md §2.1（f7 = AI 凶狠度 0..2；Fandom 与 exe 的 4 处价格冲突已裁决为 exe 值）
 * @verify extract:cards[id]（V-E1：两版卡表逐字节比较）
 */
import type { Sourced, Src } from '../source';
import { CARD_IDS, CARD_KEYS, type CardId, isPassiveCard } from './ids';

/** 使用卡片时的目标形态（与 engine TargetCandidates.t 对应的粗分类，细节由 M6 的 effects/cards 计算） */
export type CardTargetKind =
  | 'none' // 无目标（均富、冬眠等作用于全体，或被动卡）
  | 'seat' // 视窗内对手
  | 'actor' // 视窗内演员（含自己、恶人）
  | 'underfoot' // 脚下地产
  | 'lotPair' // 脚下地块 + 视窗内同类地块
  | 'lot' // 视窗内地产
  | 'lotOrObject' // 视窗内建筑或路面物件
  | 'rob' // 视窗内对手 + 指定卡或道具
  | 'auto' // 自动选择（请神符）
  | 'stock'; // 任意股票

/** 电脑的凶狠度：d = f7 − personality，d ≥ 2 从不用，d == 1 时 1/3 概率（design/minigames-ai.md §8.2） */
export type Ferocity = 0 | 1 | 2;

export interface CardDef extends Sourced {
  id: CardId;
  /** i18n key 后缀（cards.json） */
  key: string;
  /** 点券价（商店买价；卖回价 = trunc(价 × 数量 × 0.9)） */
  price: number;
  /** 公共牌堆初始张数（合计 100） */
  deckCount: number;
  f7: Ferocity;
  /** 被动卡（复仇、嫁祸、免费、免罪）不能主动打出 */
  passive: boolean;
  targetKind: CardTargetKind;
}

const CARD_TABLE_VA = 0x47fdf2;
const CARD_ROW_BYTES = 8;

/** [点券价, 初始张数, f7, 目标形态]，下标 = 卡号 − 1 */
const ROWS: readonly (readonly [number, number, Ferocity, CardTargetKind])[] = [
  [200, 1, 2, 'none'], // 1 均富
  [200, 2, 2, 'seat'], // 2 均贫
  [35, 4, 1, 'underfoot'], // 3 购地
  [25, 4, 0, 'lotPair'], // 4 换地
  [20, 4, 0, 'lotPair'], // 5 换屋
  [20, 3, 0, 'actor'], // 6 转向
  [15, 8, 0, 'underfoot'], // 7 改建
  [20, 3, 1, 'underfoot'], // 8 拍卖
  [160, 2, 0, 'lot'], // 9 天使
  [180, 1, 2, 'lot'], // 10 恶魔
  [60, 2, 2, 'lot'], // 11 怪兽
  [15, 5, 1, 'lotOrObject'], // 12 拆除
  [25, 4, 2, 'rob'], // 13 抢夺
  [20, 4, 0, 'actor'], // 14 停留
  [100, 2, 2, 'none'], // 15 冬眠
  [25, 4, 1, 'actor'], // 16 梦游
  [20, 4, 2, 'actor'], // 17 陷害
  [20, 4, 0, 'none'], // 18 复仇（被动）
  [40, 4, 0, 'none'], // 19 嫁祸（被动；Fandom 误作 30）
  [25, 4, 0, 'none'], // 20 免费（被动）
  [25, 4, 0, 'none'], // 21 免罪（被动）
  [10, 3, 0, 'none'], // 22 送神符
  [20, 3, 0, 'auto'], // 23 请神符
  [50, 3, 0, 'stock'], // 24 红卡（Fandom 误作 30）
  [30, 3, 1, 'stock'], // 25 黑卡
  [35, 4, 1, 'seat'], // 26 查税
  [35, 3, 0, 'lot'], // 27 涨价（Fandom 误作 30）
  [35, 3, 1, 'lot'], // 28 查封
  [40, 2, 0, 'seat'], // 29 同盟（Fandom 误作 70）
  [70, 3, 0, 'actor'], // 30 乌龟
];

function cardSrc(id: CardId): Src[] {
  return [
    { exe: '3.11', va: `0x${(CARD_TABLE_VA + (id - 1) * CARD_ROW_BYTES).toString(16)}` },
    { research: 'docs/research/g_arbitration.md §1' },
    { research: 'docs/research/r_references.md §2.1' },
    { verify: `extract:cards[${id}]` },
  ];
}

/** 下标 = 卡号 − 1 */
export const CARDS: readonly CardDef[] = Object.freeze(
  CARD_IDS.map((id): CardDef => {
    const [price, deckCount, f7, targetKind] = ROWS[id - 1]!;
    return Object.freeze({
      id,
      key: CARD_KEYS[id],
      price,
      deckCount,
      f7,
      passive: isPassiveCard(id),
      targetKind,
      src: cardSrc(id),
      confidence: 'high',
    });
  }),
);

export function cardDef(id: CardId): CardDef {
  return CARDS[id - 1]!;
}

/** 牌堆总张数（100） */
export const DECK_TOTAL = CARDS.reduce((sum, c) => sum + c.deckCount, 0);

/** 下标 = 卡号（0 不用），开局牌堆张数 */
export function initialDeck(): number[] {
  const out = [0];
  for (const c of CARDS) out.push(c.deckCount);
  return out;
}
