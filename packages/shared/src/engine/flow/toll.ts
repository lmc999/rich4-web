/**
 * TOLL 帧：住宅过路费（design/engine.md §8、§10.3；docs/research/r_property.md §4.4；r_cards.md §5「过路费」）。
 *
 * compute    报价与九种免收（查封、同盟、地主死神 / 住旅馆 / 消失 / 坐牢 / 住院 / 冬眠 / 梦游）→ TOLL_EXEMPT
 * free       付款人持免费卡且（金额 ≥ 2000×PI 或 > 现金+存款）→ USE_FREE_CARD；用了就免付（PASSIVE），结束
 * scapegoat  付款人持嫁祸卡（同一门槛）→ SCAPEGOAT（候选：在场、不是付款人也不是地主或盟友）；选定后由新人代付
 * pay        死神代付：场上有人被死神附身、且不是付款人时由他代付（deathPays）；
 *            先付地主（总额 − 盟友份），再付盟友（先现金后存款，不足即破产）→ TOLL_PAID
 * 付款计入月度「意外损失 / 意外之财」；地块记下 lastToll（间谍偷租金用 ⚑）。
 */
import type { Ctx } from '../core/ctx';
import type { FrameHandler } from '../core/frameHandler';
import { EngineInvariantError } from '../errors';
import { quoteLandToll } from '../rules/toll';
import type { ScapegoatOptions } from '../types/decision';
import type { FrameOf, TollQuote } from '../types/frames';
import {
  askFreeCard,
  askScapegoat,
  deathGodPayer,
  passiveThreshold,
  resolveFreeCard,
  resolveScapegoat,
  scapegoatCandidates,
} from './passive';

type TollFrame = FrameOf<'TOLL'>;

function quoteOf(f: TollFrame): TollQuote {
  if (!f.q) throw new EngineInvariantError('TOLL_NO_QUOTE');
  return f.q;
}

function pay(ctx: Ctx, f: TollFrame): void {
  const q = quoteOf(f);
  f.stage = 'done';
  const death = deathGodPayer(ctx.s, q.payer);
  if (death !== null && death !== q.owner) {
    q.payer = death;
    if (!q.mods.includes('deathPays')) q.mods.push('deathPays');
  }
  const cause = { k: 'toll', ref: f.lot, by: q.owner } as const;
  const ownerAmount = q.amount - q.allyAmount;
  let paid = 0;
  const r = ctx.pay({ t: 'seat', seat: q.payer }, { t: 'seat', seat: q.owner }, ownerAmount, {
    reason: 'toll',
    accident: true,
    cause,
  });
  paid += r.paid;
  let allyPaid = 0;
  if (!r.bankrupt && q.ally !== null && q.allyAmount > 0) {
    const r2 = ctx.pay({ t: 'seat', seat: q.payer }, { t: 'seat', seat: q.ally }, q.allyAmount, {
      reason: 'toll',
      accident: true,
      cause: { k: 'toll', ref: f.lot, by: q.ally },
    });
    allyPaid = r2.paid;
    paid += r2.paid;
  }
  const land = ctx.s.lands[ctx.map.landIdx(f.lot)]!;
  land.lastToll = paid;
  ctx.emit('TOLL_PAID', {
    payer: q.payer,
    owner: q.owner,
    ally: q.ally,
    amount: paid,
    allyAmount: allyPaid,
    lots: q.lots,
    mods: q.mods,
  });
}

export const TOLL: FrameHandler<TollFrame> = {
  step(ctx, f) {
    switch (f.stage) {
      case 'compute': {
        const i = ctx.map.landIdx(f.lot);
        if (i < 0) throw new EngineInvariantError('TOLL_NOT_LAND', `toll on ${f.lot}`);
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
        f.stage = r.q.amount > 0 ? 'free' : 'pay';
        return;
      }
      case 'free': {
        const q = quoteOf(f);
        if (!askFreeCard(ctx, f, q.payer, 'toll', q.amount, f.lot)) f.stage = 'scapegoat';
        return;
      }
      case 'scapegoat': {
        const q = quoteOf(f);
        const p = ctx.player(q.payer);
        const cands = scapegoatCandidates(ctx.s, q.payer, [q.owner, q.ally]);
        if (!passiveThreshold(ctx.s, p, q.amount) || !askScapegoat(ctx, f, q.payer, 'toll', q.amount, null, cands)) {
          f.stage = 'pay';
        }
        return;
      }
      case 'pay':
        pay(ctx, f);
        return;
      case 'done':
        ctx.pop(f);
        return;
    }
  },
  resume(ctx, f, a, d) {
    const q = quoteOf(f);
    if (f.stage === 'free' && d.kind === 'USE_FREE_CARD') {
      f.stage = resolveFreeCard(ctx, q.payer, a, 'toll') ? 'done' : 'scapegoat';
      return;
    }
    if (f.stage === 'scapegoat' && d.kind === 'SCAPEGOAT') {
      const t = resolveScapegoat(ctx, q.payer, a, (d.options as ScapegoatOptions).candidates, 'toll');
      if (t !== null) q.payer = t;
      f.stage = 'pay';
      return;
    }
    throw new EngineInvariantError('TOLL_RESUME', `${f.stage}/${d.kind}`);
  },
};
