/**
 * PAYX 帧：带被动卡询问的一般付款（design/engine.md §6.1、§10.3）。
 * free（passive.free 且持免费卡、金额 ≥ 2000×PI 或 > 现金+存款 → USE_FREE_CARD，用了就免付）
 * → scapegoat（passive.scapegoat 且持嫁祸卡、同一门槛 → SCAPEGOAT，选定后由新人付）
 * → pay（先现金后存款，付不起就破产）→ done。发 MONEY 事件。
 * 使用者：新闻与命运的罚款（M7；rules.freeCardOnFines 决定 passive）。乞丐施舍、恶人勒索不走被动卡（直接付款）。
 */
import type { FrameHandler } from '../core/frameHandler';
import { EngineInvariantError } from '../errors';
import type { PassiveContext, ScapegoatOptions } from '../types/decision';
import type { FrameOf } from '../types/frames';
import type { CauseKind, MoneyReason, SeatIndex } from '../types/ids';
import {
  askFreeCard,
  askScapegoat,
  passiveThreshold,
  resolveFreeCard,
  resolveScapegoat,
  scapegoatCandidates,
} from './passive';

type PayFrame = FrameOf<'PAYX'>;

const REASON_CAUSE: Partial<Record<MoneyReason, CauseKind>> = {
  toll: 'toll',
  fee: 'fee',
  tax: 'tax',
  taxAudit: 'card',
  fine: 'fate',
  beggar: 'beggar',
  villain: 'villain',
  loanForced: 'loan',
  dividend: 'dividend',
};

function contextOf(f: PayFrame): PassiveContext {
  return f.reason === 'toll' ? 'toll' : f.reason === 'fee' ? 'fee' : f.reason === 'taxAudit' ? 'taxAudit' : 'fine';
}

/** 免费卡的对方（PASSIVE.other）：过路费、设施费、查税付给的那名玩家；罚款没有对方 */
function payeeOf(f: PayFrame): SeatIndex | null {
  return contextOf(f) !== 'fine' && f.to.t === 'seat' ? f.to.seat : null;
}

export const PAYX: FrameHandler<PayFrame> = {
  step(ctx, f) {
    switch (f.stage) {
      case 'free':
        if (!f.passive.free || !askFreeCard(ctx, f, f.payer, contextOf(f), f.amount, null)) f.stage = 'scapegoat';
        return;
      case 'scapegoat': {
        const p = ctx.player(f.payer);
        const exclude = f.to.t === 'seat' ? [f.to.seat] : [];
        const cands = scapegoatCandidates(ctx.s, f.payer, exclude);
        const asked =
          f.passive.scapegoat &&
          passiveThreshold(ctx.s, p, f.amount) &&
          askScapegoat(ctx, f, f.payer, contextOf(f), f.amount, null, cands);
        if (!asked) f.stage = 'pay';
        return;
      }
      case 'pay': {
        f.stage = 'done';
        const from = { t: 'seat', seat: f.payer } as const;
        const r = ctx.pay(from, f.to, f.amount, {
          reason: f.reason,
          accident: true,
          cause: { k: REASON_CAUSE[f.reason] ?? 'system', ref: null, by: null },
        });
        ctx.emit('MONEY', { from, to: f.to, amount: f.amount, paid: r.paid, reason: f.reason, ref: null });
        return;
      }
      default:
        ctx.pop(f);
        return;
    }
  },
  resume(ctx, f, a, d) {
    if (f.stage === 'free' && d.kind === 'USE_FREE_CARD') {
      f.stage = resolveFreeCard(ctx, f.payer, a, contextOf(f), payeeOf(f)) ? 'done' : 'scapegoat';
      return;
    }
    if (f.stage === 'scapegoat' && d.kind === 'SCAPEGOAT') {
      const t = resolveScapegoat(ctx, f.payer, a, (d.options as ScapegoatOptions).candidates, contextOf(f));
      if (t !== null) f.payer = t;
      f.stage = 'pay';
      return;
    }
    throw new EngineInvariantError('PAYX_RESUME', `${f.stage}/${d.kind}`);
  },
};
