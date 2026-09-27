/**
 * 被动卡的共用环节（design/engine.md §10.3；docs/research/g_villains.md §6；r_cards.md §5）。
 *
 * 触发点与顺序：
 *   陷害卡、梦游卡命中玩家：免罪（自动，优先，消耗后结束）→ 嫁祸（问目标）→ 施加 → 复仇（最终目标 == 原目标时自动）
 *   新闻 29、魔法屋坐牢 / 住院、命运坐牢（CONFINE passive）：（命运先做福运加持）→ 免罪 → 嫁祸 → 施加
 *   住宅过路费、设施费、企业收费、查税卡：金额 ≥ 2000×PI 或 > 现金+存款 时 → 先问免费卡 → 再问嫁祸卡
 *     （旅馆费不能用免费卡；命运、新闻的罚款按 rules.freeCardOnFines）
 * 改嫁后的新目标不会再被检查。只在手里有卡、确实可以选择时才发决策。
 * 嫁祸候选：在场、不是当事人的玩家（陷害、梦游、查税可以嫁祸回出卡者；过路费与设施费不含收款的地主）。
 */

import { ECON } from '../../data/tables/economy';
import { CARD, type CardId } from '../../data/tables/ids';
import { mul32 } from '../../util/int32';
import type { Ctx } from '../core/ctx';
import { EngineRuleError } from '../errors';
import { returnCardToDeck } from '../rules/inventory';
import type { PassiveContext } from '../types/decision';
import type { Frame } from '../types/frames';
import type { LotId, SeatIndex } from '../types/ids';
import type { PlayerAction } from '../types/intent';
import type { GameState, PlayerState } from '../types/state';

export function holdsCard(p: Pick<PlayerState, 'cards'>, card: CardId): boolean {
  return p.cards.includes(card);
}

/** 消耗手里第一张 card（回牌堆）→ PASSIVE */
export function consumePassive(ctx: Ctx, seat: SeatIndex, card: CardId, context: PassiveContext): void {
  const p = ctx.player(seat);
  const i = p.cards.indexOf(card);
  if (i < 0) return;
  p.cards.splice(i, 1);
  returnCardToDeck(ctx.s, card);
  ctx.emit('PASSIVE', { seat, card, context });
}

/** 免费卡 / 嫁祸卡的询问门槛：金额 ≥ 2000×PI，或金额 > 现金 + 存款（@0x419e34、@0x41a60e） */
export function passiveThreshold(s: GameState, p: Pick<PlayerState, 'cash' | 'deposit'>, amount: number): boolean {
  if (amount <= 0) return false;
  const floor = mul32(ECON.FREE_CARD_THRESHOLD, s.econ.priceIndex, s.config.rules.intOverflow);
  return amount >= floor || amount > p.cash + p.deposit;
}

/** 嫁祸候选：在场、不是当事人、不在 exclude 里 */
export function scapegoatCandidates(s: GameState, target: SeatIndex, exclude: readonly (SeatIndex | null)[] = []) {
  return s.players.filter((p) => p.alive && p.seat !== target && !exclude.includes(p.seat)).map((p) => p.seat);
}

/** 持免费卡时问 USE_FREE_CARD（由 frame 的 resume 处理）；返回是否发出了决策 */
export function askFreeCard(
  ctx: Ctx,
  frame: Frame,
  seat: SeatIndex,
  context: PassiveContext,
  amount: number,
  lot: LotId | null,
): boolean {
  const p = ctx.player(seat);
  const slot = p.cards.indexOf(CARD.FREE);
  if (slot < 0 || !passiveThreshold(ctx.s, p, amount)) return false;
  ctx.ask(
    frame,
    seat,
    'USE_FREE_CARD',
    { context, amount, payer: seat, lot, slot },
    { type: 'CONFIRM' },
    { lot, amount },
  );
  return true;
}

/** 持嫁祸卡且有候选时问 SCAPEGOAT；返回是否发出了决策 */
export function askScapegoat(
  ctx: Ctx,
  frame: Frame,
  seat: SeatIndex,
  context: PassiveContext,
  amount: number | null,
  days: number | null,
  candidates: readonly SeatIndex[],
): boolean {
  const p = ctx.player(seat);
  const slot = p.cards.indexOf(CARD.SCAPEGOAT);
  if (slot < 0 || candidates.length === 0) return false;
  ctx.ask(
    frame,
    seat,
    'SCAPEGOAT',
    { context, amount, days, candidates: candidates.slice(), slot },
    { type: 'DECLINE' },
    { amount },
  );
  return true;
}

/** USE_FREE_CARD 的回答：CONFIRM 消耗免费卡并返回 true */
export function resolveFreeCard(ctx: Ctx, seat: SeatIndex, a: PlayerAction, context: PassiveContext): boolean {
  if (a.type !== 'CONFIRM') return false;
  if (!holdsCard(ctx.player(seat), CARD.FREE)) throw new EngineRuleError('NOT_ALLOWED', 'no free card in hand');
  consumePassive(ctx, seat, CARD.FREE, context);
  return true;
}

/**
 * SCAPEGOAT 的回答：SCAPEGOAT{target} 须在候选里，消耗嫁祸卡并返回新目标；DECLINE 返回 null。
 * 候选取自决策的 options（引擎发出时算好的名单）。
 */
export function resolveScapegoat(
  ctx: Ctx,
  seat: SeatIndex,
  a: PlayerAction,
  candidates: readonly SeatIndex[],
  context: PassiveContext,
): SeatIndex | null {
  if (a.type !== 'SCAPEGOAT') return null;
  if (!candidates.includes(a.target)) {
    throw new EngineRuleError('INVALID_TARGET', `seat ${a.target} is not a scapegoat candidate`);
  }
  if (!holdsCard(ctx.player(seat), CARD.SCAPEGOAT)) throw new EngineRuleError('NOT_ALLOWED', 'no scapegoat card');
  const t = ctx.s.players.find((p) => p.seat === a.target);
  if (!t?.alive) throw new EngineRuleError('INVALID_TARGET', `seat ${a.target} is out`);
  consumePassive(ctx, seat, CARD.SCAPEGOAT, context);
  return a.target;
}

/** 死神代付：场上有人被死神附身、且不是 payer 时由他代付（@_rich4_find_other_death_attached_player） */
export function deathGodPayer(s: GameState, payer: SeatIndex): SeatIndex | null {
  for (const p of s.players) if (p.alive && p.seat !== payer && p.god?.kind === 15) return p.seat;
  return null;
}
