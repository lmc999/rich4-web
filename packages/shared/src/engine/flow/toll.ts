/**
 * TOLL 帧：住宅过路费（design/engine.md §8、§10.3；docs/research/r_property.md §4.4）。
 * compute（报价与九种免收）→ free（免费卡，M6）→ scapegoat（嫁祸卡，M6）→ pay（先现金后存款，不足即破产）→ done。
 * 付款计入月度「意外损失 / 意外之财」；地块记下 lastToll（间谍偷租金用 ⚑）。
 */
import type { FrameHandler } from '../core/frameHandler';
import { EngineInvariantError } from '../errors';
import { quoteLandToll } from '../rules/toll';
import type { FrameOf } from '../types/frames';

type TollFrame = FrameOf<'TOLL'>;

export const TOLL: FrameHandler<TollFrame> = {
  step(ctx, f) {
    switch (f.stage) {
      case 'compute': {
        const i = ctx.map.landIdx(f.lot);
        if (i < 0)
          throw new EngineInvariantError('NOT_IMPLEMENTED', `toll on ${f.lot} (facility / company fees are M4)`);
        const r = quoteLandToll(ctx.s, ctx.map, i, f.payer);
        if (r.kind === 'none') {
          ctx.pop(f);
          return;
        }
        if (r.kind === 'exempt') {
          f.stage = 'done';
          ctx.emit('TOLL_EXEMPT', { payer: f.payer, lot: f.lot, reason: r.reason });
          return;
        }
        f.q = r.q;
        f.stage = 'free';
        return;
      }
      case 'free':
        // TODO(M6)：持免费卡且（金额 ≥ 2000×PI 或 > 现金+存款）→ USE_FREE_CARD
        f.stage = 'scapegoat';
        return;
      case 'scapegoat':
        // TODO(M6)：持嫁祸卡 → SCAPEGOAT；死神附身者代付（改写 q.payer）
        f.stage = 'pay';
        return;
      case 'pay': {
        const q = f.q;
        if (!q) throw new EngineInvariantError('TOLL_NO_QUOTE');
        f.stage = 'done';
        const r = ctx.pay({ t: 'seat', seat: q.payer }, { t: 'seat', seat: q.owner }, q.amount, {
          reason: 'toll',
          accident: true,
          cause: { k: 'toll', ref: f.lot, by: q.owner },
        });
        const land = ctx.s.lands[ctx.map.landIdx(f.lot)]!;
        land.lastToll = r.paid;
        ctx.emit('TOLL_PAID', {
          payer: q.payer,
          owner: q.owner,
          ally: q.ally,
          amount: r.paid,
          allyAmount: q.allyAmount,
          lots: q.lots,
          mods: q.mods,
        });
        return;
      }
      case 'done':
        ctx.pop(f);
        return;
    }
  },
};
