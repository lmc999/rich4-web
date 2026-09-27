/**
 * M6 的 ASK 决策（flow/ask.ts 的 ASK_HANDLERS 引用这里）：
 * - BAIL：停在监狱 / 医院保释格（squares/jail.ts）；HIRE 雇恶人属于 M7，本期拒绝。
 * - DISCARD_CARD：rules.handFull='choose' 时满手又得卡（effects/common.gainCard 先入手再压本帧），选一张弃掉（回牌堆）。
 * - USE_FREE_CARD / SCAPEGOAT：由持有付款或关押流程的帧（TOLL、FEE、PAYX、CONFINE、CARD）直接发出并在各自的 resume
 *   里处理，不经过 ASK 帧；这里的处理器只是为了让 ASK_HANDLERS 对 SimpleAskKind 穷举，被调用即为内部缺陷。
 */
import { cardDef } from '../../data/tables/cards';
import type { Ctx } from '../core/ctx';
import { EngineInvariantError, EngineRuleError } from '../errors';
import { HAND_MAX, returnCardToDeck } from '../rules/inventory';
import { bailOut, buildBail } from '../squares/jail';
import type { DiscardCardOptions } from '../types/decision';
import type { FrameOf } from '../types/frames';
import type { CardId } from '../types/ids';
import type { PlayerAction } from '../types/intent';
import type { AskBuild, AskHandler } from './ask';

type AskFrame = FrameOf<'ASK'>;

function whereOf(f: AskFrame): 'jail' | 'hospital' {
  return f.data.where === 'hospital' ? 'hospital' : 'jail';
}

export const BAIL_ASK: AskHandler<'BAIL'> = {
  build(ctx: Ctx, f: AskFrame): AskBuild<'BAIL'> | null {
    const options = buildBail(ctx.s, f.seat, whereOf(f));
    return options ? { options, defaultIntent: { type: 'SKIP' }, lot: null, amount: null } : null;
  },
  resolve(ctx: Ctx, f: AskFrame, a: PlayerAction): void {
    if (a.type === 'BAIL') bailOut(ctx, f.seat, whereOf(f), a.target);
    else if (a.type === 'HIRE') throw new EngineRuleError('NOT_ALLOWED', 'hiring villains is not available yet (M7)');
  },
};

function discardOptions(ctx: Ctx, f: AskFrame): DiscardCardOptions {
  const p = ctx.player(f.seat);
  const incoming = (typeof f.data.card === 'number' ? f.data.card : (p.cards[p.cards.length - 1] ?? 1)) as CardId;
  return { hand: p.cards.map((card, slot) => ({ slot, card, price: cardDef(card).price })), incoming };
}

export const DISCARD_ASK: AskHandler<'DISCARD_CARD'> = {
  build(ctx: Ctx, f: AskFrame): AskBuild<'DISCARD_CARD'> | null {
    const p = ctx.player(f.seat);
    if (p.cards.length <= HAND_MAX) return null;
    const options = discardOptions(ctx, f);
    let best = options.hand[0]!;
    for (const h of options.hand) if (h.price < best.price) best = h;
    return { options, defaultIntent: { type: 'DISCARD', slot: best.slot }, lot: null, amount: null };
  },
  resolve(ctx: Ctx, f: AskFrame, a: PlayerAction): void {
    if (a.type !== 'DISCARD') return;
    const p = ctx.player(f.seat);
    const card = p.cards[a.slot];
    if (card === undefined) throw new EngineRuleError('INVALID_TARGET', `slot ${a.slot}`);
    p.cards.splice(a.slot, 1);
    returnCardToDeck(ctx.s, card);
    ctx.emit('CARD_LOST', { seat: f.seat, card, cause: 'discard' });
  },
};

function ownedByFrame<K extends 'USE_FREE_CARD' | 'SCAPEGOAT'>(kind: K): AskHandler<K> {
  const fail = (): never => {
    throw new EngineInvariantError('ASK_KIND', `${kind} is asked by its owning frame, not by ASK`);
  };
  return { build: fail, resolve: fail };
}

export const USE_FREE_CARD_ASK = ownedByFrame('USE_FREE_CARD');
export const SCAPEGOAT_ASK = ownedByFrame('SCAPEGOAT');
