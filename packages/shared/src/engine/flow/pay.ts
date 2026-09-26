/**
 * PAYX 帧：带被动卡询问的一般付款（design/engine.md §6.1、§10.3）。
 * free（免费卡，M6）→ scapegoat（嫁祸卡，M6）→ pay（先现金后存款，付不起就破产）→ done。发 MONEY 事件。
 * 使用者：乞丐施舍（M7）、新闻与命运的罚款（M7，freeCardOnFines 决定能否用免费卡）。
 */
import type { FrameHandler } from '../core/frameHandler';
import type { FrameOf } from '../types/frames';
import type { CauseKind, MoneyReason } from '../types/ids';

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

export const PAYX: FrameHandler<PayFrame> = {
  step(ctx, f) {
    switch (f.stage) {
      case 'free':
        // TODO(M6)：f.passive.free 且持免费卡 → USE_FREE_CARD
        f.stage = 'scapegoat';
        return;
      case 'scapegoat':
        // TODO(M6)：f.passive.scapegoat 且持嫁祸卡 → SCAPEGOAT
        f.stage = 'pay';
        return;
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
};
