/**
 * 神明表（design/engine.md §10.5；docs/research/r_deities.md §1–§7；g_arbitration.md §2.b、§2.c、§2.k）。
 * 种类号沿用原版物件表：1..12 与死神 15；每对搭档同一时刻最多一个在场（离场即由搭档在远处刷出）。
 *
 * luck = 附身时加到玩家身上的三项运势（离身时减回）：
 *   bad     衰运：只用于 AI 估值与月结「悲情人物」评分
 *   wealth  财运 B：命运的奖金、罚金加持判定
 *   fortune 福运 C：命运的劫难加持判定
 * 加持判定（blessing）：值 > 100 必定 high；50 < 值 ≤ 100 时 rand & 1；0..50 无效果；< 0 为 low。
 *
 * @source docs/research/r_deities.md §6（三项运势表，oama 逆向）；g_arbitration.md §2.b（B/C 两列，与 r_deities 一致）
 * @source docs/research/g_arbitration.md §2.k（送神白名单 {5,6,7,8,10,15}；死神 13 天）
 * @verify extract:gods（种类号、搭档、天数）
 */
import type { Sourced, Src } from '../source';
import { GOD, GOD_KEYS, GOD_KINDS, type GodKind } from './ids';

export type GodNature = 'good' | 'bad' | 'dog';

export interface GodLuck {
  bad: number;
  wealth: number;
  fortune: number;
}

export interface GodDef extends Sourced {
  kind: GodKind;
  key: string;
  /** 好神 / 坏神；恶犬不附身 */
  nature: GodNature;
  /** 搭档（离场后由它刷出）；死神没有搭档 */
  partner: GodKind | null;
  /** 附身天数：7，死神 13；恶犬 0 */
  days: number;
  luck: GodLuck;
  /** 附身发威的老虎机位数（财神、穷神 3 / 4 位，不乘 PI）；没有老虎机为 0 */
  slotDigits: 0 | 3 | 4;
  /** 附身发威得到的卡片张数（小福神 1、大福神 2） */
  drawCards: number;
  /** 送神符能送走（坏神白名单）；死神另受 rules.deathGodDispellable 控制 */
  dispellable: boolean;
  /** 能附身（恶犬不能） */
  attachable: boolean;
  /** 开局随机摆放在路上（小财、小福、小穷、小衰、天使、恶犬） */
  initial: boolean;
}

const R6: Src = { research: 'docs/research/r_deities.md §6' };
const R7: Src = { research: 'docs/research/r_deities.md §7' };
const GA: Src = { research: 'docs/research/g_arbitration.md §2.b、§2.k' };

/** [好坏, 搭档, 天数, 衰运, 财运, 福运, 老虎机位数, 抽卡, 可送走, 开局摆放] */
type Row = readonly [GodNature, GodKind | null, number, number, number, number, 0 | 3 | 4, number, boolean, boolean];

const ROWS: Readonly<Record<GodKind, Row>> = {
  1: ['good', 2, 7, -100, 100, 0, 3, 0, false, true], // 小财神：每位对手付 X（3 位老虎机）；过路费 ÷2
  2: ['good', 1, 7, -200, 150, 0, 4, 0, false, false], // 大财神：得 X（4 位老虎机）；过路费免付
  3: ['good', 4, 7, -100, 0, 100, 0, 1, false, true], // 小福神：抽 1 张；投资多送 1 级
  4: ['good', 3, 7, -200, 0, 150, 0, 2, false, false], // 大福神：抽 2 张
  5: ['bad', 6, 7, 100, -60, 0, 3, 0, true, true], // 小穷神：付给每位对手 X（进对方存款）；过路费 ×1.5
  6: ['bad', 5, 7, 200, -100, 0, 4, 0, true, false], // 大穷神：付 X 给银行；过路费 ×2
  7: ['bad', 8, 7, 100, 0, -60, 0, 0, true, true], // 小衰神：随机丢 1 张；禁止投资
  8: ['bad', 7, 7, 200, 0, -100, 0, 0, true, false], // 大衰神：丢 floor(n/2) 张（n > 1）；禁止投资
  9: ['good', 10, 7, -100, 60, 60, 0, 0, false, true], // 天使：落点 +1 级
  10: ['bad', 9, 7, 100, -60, -60, 0, 0, true, false], // 恶魔：落点 −1 级
  11: ['dog', 12, 0, 0, 0, 0, 0, 0, false, true], // 恶犬：不附身，步行被咬住院 3 天
  12: ['good', 11, 7, -500, 0, 0, 0, 0, false, false], // 土地公：强占落点地产；禁买无主地
  15: ['bad', null, 13, 1000, -200, -200, 0, 0, true, false], // 死神：没收卡片道具；代付他人过路费
};

export const GODS: Readonly<Record<GodKind, GodDef>> = Object.freeze(
  Object.fromEntries(
    GOD_KINDS.map((kind): [GodKind, GodDef] => {
      const [nature, partner, days, bad, wealth, fortune, slotDigits, drawCards, dispellable, initial] = ROWS[kind];
      return [
        kind,
        Object.freeze({
          kind,
          key: GOD_KEYS[kind],
          nature,
          partner,
          days,
          luck: Object.freeze({ bad, wealth, fortune }),
          slotDigits,
          drawCards,
          dispellable,
          attachable: nature !== 'dog',
          initial,
          src: kind === GOD.DEATH ? [R6, R7, GA] : [R6, R7, GA, { verify: `extract:gods[${kind}]` }],
          confidence: kind === GOD.DEATH || kind === GOD.EARTH_GOD ? 'medium' : 'high',
        }),
      ];
    }),
  ) as Record<GodKind, GodDef>,
);

export function godDef(kind: GodKind): GodDef {
  return GODS[kind];
}

/** 开局随机摆放的神明（按种类号升序）：小财神、小福神、小穷神、小衰神、天使、恶犬 */
export const INITIAL_GODS: readonly GodKind[] = Object.freeze(GOD_KINDS.filter((k) => GODS[k].initial));

/** 请神符能请、路上踩到能附身的神（恶犬、死神除外；死神只能由投降召唤） */
export function isRoadAttachable(kind: GodKind): boolean {
  return GODS[kind].attachable && kind !== GOD.DEATH;
}
