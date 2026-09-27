/**
 * 各种决策的 defaultIntent（design/engine.md §9.2 最后一列；architecture §5.4）。
 * 超时（timeoutPolicy='default'）或兜底时服务器提交它，所以必须对 options 合法。
 * 原则：不买、不用卡、不借贷、PASS、掷骰。
 */
import { cardDef } from '../../data/tables/cards';
import { MAGIC_EFFECT } from '../../data/tables/ids';
import type { DecisionKind, DecisionOptionsMap } from '../types/decision';
import type { SeatIndex } from '../types/ids';
import type { PlayerIntent } from '../types/intent';

type DefaultFn<K extends DecisionKind> = (o: DecisionOptionsMap[K], seat: SeatIndex) => PlayerIntent;

export const DEFAULT_INTENTS = Object.freeze({
  TURN_MENU: () => ({ type: 'ROLL' }),
  BANK_ATM: () => ({ type: 'SKIP' }),
  BANK_COUNTER: () => ({ type: 'SKIP' }),
  BUY_LAND: () => ({ type: 'DECLINE' }),
  UPGRADE_LAND: () => ({ type: 'DECLINE' }),
  BUY_FACILITY: () => ({ type: 'DECLINE' }),
  BUILD_FACILITY: () => ({ type: 'DECLINE' }),
  UPGRADE_FACILITY: () => ({ type: 'DECLINE' }),
  FACILITY_TYPE: (o) => ({ type: 'CHOOSE_FACILITY_TYPE', facility: o.types[0]?.type ?? 'park' }),
  RESEARCH: (o) => {
    const last = o.projects[o.projects.length - 1];
    return last ? { type: 'RESEARCH', project: last.project } : { type: 'SKIP' };
  },
  SHOP: () => ({ type: 'LEAVE' }),
  LOTTERY: () => ({ type: 'SKIP' }),
  BAIL: () => ({ type: 'SKIP' }),
  MINIGAME: () => ({ type: 'MINIGAME_DECLINE' }),
  MAGIC_CAST: (o, seat) => ({
    type: 'MAGIC_CAST',
    effect: o.targets.includes(seat) ? MAGIC_EFFECT.GAIN_CARD : MAGIC_EFFECT.STAY,
  }),
  CONSTRUCTION_PICK: (o) => {
    if (o.canSkip || o.lots.length === 0) return { type: 'SKIP' };
    let best = o.lots[0]!;
    for (const l of o.lots) if (l.cost < best.cost) best = l;
    return { type: 'PICK_LOT', lot: best.lot };
  },
  SUBSCRIBE_SHARES: () => ({ type: 'SKIP' }),
  USE_FREE_CARD: () => ({ type: 'CONFIRM' }),
  SCAPEGOAT: () => ({ type: 'DECLINE' }),
  AUCTION_BID: () => ({ type: 'PASS' }),
  BIRTHDAY_PICK: (o) => ({
    type: 'PICK_CARDS',
    picks: o.victims.filter((v) => v.cards.length > 0).map((v) => ({ from: v.seat, slot: v.cards[0]!.slot })),
  }),
  DISCARD_CARD: (o) => {
    let best = o.hand[0];
    for (const h of o.hand) if (best === undefined || cardDef(h.card).price < cardDef(best.card).price) best = h;
    return { type: 'DISCARD', slot: best?.slot ?? 0 };
  },
  DEATH_GOD_TARGET: (o) => ({ type: 'DEATH_GOD_TARGET', target: o.candidates[0] ?? 0 }),
} satisfies { readonly [K in DecisionKind]: DefaultFn<K> });

export function defaultIntentFor<K extends DecisionKind>(
  kind: K,
  options: DecisionOptionsMap[K],
  seat: SeatIndex,
): PlayerIntent {
  return (DEFAULT_INTENTS[kind] as DefaultFn<K>)(options, seat);
}
