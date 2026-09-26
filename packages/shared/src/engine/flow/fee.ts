/**
 * FEE 帧：设施费与企业格（design/engine.md §8；公式见 rules/fee.ts）。
 *
 * 设施（feeKind hotel / mall / gas）：
 *   compute  免收（查封、同盟、地主受阻…）→ TOLL_EXEMPT；旅馆、购物中心先转盘（purpose 'wheel'）
 *   free / scapegoat  被动卡（M6；旅馆不能用免费卡）
 *   pay      付给地主（先现金后存款，付不起即破产），计入月度意外损失 / 意外之财 → FEE_PAID；设施 lastFee
 *   after    旅馆：住 n 天（大财神使费用为 0 时不住）→ HOTEL_STAY
 * 企业（feeKind company；钱进公司盈余，没有董事长不收费）：
 *   compute  董事长本人：保险免费投保 d 天、建设公司免费加盖（CONSTRUCTION_PICK）；其余不收费
 *            非董事长：航空 / 保险先转盘；建设公司 → CONSTRUCTION_PICK（选地加盖 + 工程费，找不到目标收 1000×PI）
 *   pay      → COMPANY_FEE
 *   after    航空：消失 n 天；保险：投保 d 天（insuranceDays 累加，& 0x7f）
 *   subscribe  公司保留股 > 0 → SUBSCRIBE_SHARES（所有人都可以认购；梦游中、出国等受阻状态不问）
 */
import { AIRLINE_WHEEL, HOTEL_WHEEL, INSURANCE_WHEEL, MALL_WHEEL, type WheelDef } from '../../data/tables/facilities';
import type { Ctx } from '../core/ctx';
import type { FrameHandler } from '../core/frameHandler';
import { EngineInvariantError } from '../errors';
import { addCounterDays, mainBlockOf } from '../rules/counters';
import {
  checkFacilityFee,
  companyFeeAmount,
  companyFeeKind,
  constructionFee,
  facilityFeeAmount,
  facilityFeeKind,
} from '../rules/fee';
import type { FrameOf } from '../types/frames';
import type { CompanyLotId, FacilityLotId, SeatIndex } from '../types/ids';
import { applyConfinement } from './confine';

type FeeFrame = FrameOf<'FEE'>;

function spin(ctx: Ctx, w: WheelDef): number {
  return w.slots[ctx.pick('wheel', w.slots.length)]!;
}

function chairmanOf(ctx: Ctx, companyIdx: number): SeatIndex | null {
  const c = ctx.s.companies[companyIdx]!;
  return ctx.s.stocks[c.stock]?.chairman ?? null;
}

/** 停在别人的设施（旅馆、购物中心、加油站）：压 FEE 帧；公园、研究所不收费，不压帧 */
export function pushFacilityFee(ctx: Ctx, payer: SeatIndex, lot: FacilityLotId, steps: number): void {
  const fac = ctx.s.facilities[ctx.map.facilityIdx(lot)];
  const feeKind = fac ? facilityFeeKind(fac) : null;
  if (feeKind === null) return;
  ctx.push({ k: 'FEE', payer, lot, feeKind, steps, stage: 'compute', q: null });
}

/** 停在企业格（任何人）：压 FEE 帧（收费、董事长特权、现场认购） */
export function pushCompanyFee(ctx: Ctx, payer: SeatIndex, lot: CompanyLotId, steps: number): void {
  ctx.push({ k: 'FEE', payer, lot, feeKind: 'company', steps, stage: 'compute', q: null });
}

function computeFacility(ctx: Ctx, f: FeeFrame): void {
  const i = ctx.map.facilityIdx(f.lot);
  const r = checkFacilityFee(ctx.s, i, f.payer);
  if (r.kind === 'none') {
    f.stage = 'done';
    return;
  }
  if (r.kind === 'exempt') {
    f.stage = 'done';
    ctx.emit('TOLL_EXEMPT', { payer: f.payer, lot: f.lot, reason: r.reason });
    return;
  }
  f.feeKind = r.feeKind;
  const wheel = r.feeKind === 'hotel' ? spin(ctx, HOTEL_WHEEL) : r.feeKind === 'mall' ? spin(ctx, MALL_WHEEL) : null;
  const { amount, mods } = facilityFeeAmount(ctx.s, ctx.map, i, ctx.player(f.payer), r.feeKind, wheel, f.steps);
  f.q = { owner: r.owner, amount, wheel, mods, industry: null };
  f.stage = 'free';
}

function computeCompany(ctx: Ctx, f: FeeFrame): void {
  const ci = ctx.map.companyIdx(f.lot);
  const chairman = chairmanOf(ctx, ci);
  const company = ctx.s.companies[ci]!;
  const def = ctx.map.companies[ci]!;
  const kind = companyFeeKind(ctx.map, ci);
  const p = ctx.player(f.payer);
  const sleepwalk = p.st.sleepwalk !== 0;
  f.stage = 'subscribe';
  if (chairman === null) return;
  if (chairman === f.payer) {
    if (sleepwalk) return;
    if (kind === 'insurance') {
      const d = spin(ctx, INSURANCE_WHEEL);
      f.q = { owner: chairman, amount: 0, wheel: d, mods: [], industry: def.industry };
      ctx.emit('COMPANY_FEE', { seat: f.payer, company: company.id, industry: def.industry, amount: 0, wheel: d });
      f.stage = 'after';
    } else if (kind === 'construction') {
      ctx.push({
        k: 'ASK',
        seat: f.payer,
        kind: 'CONSTRUCTION_PICK',
        data: { company: company.id, chairman: true },
        stage: 'ask',
      });
    }
    return;
  }
  switch (kind) {
    case 'airline': {
      const n = spin(ctx, AIRLINE_WHEEL);
      if (n === 0) {
        // 「不用出國！」
        ctx.emit('COMPANY_FEE', { seat: f.payer, company: company.id, industry: def.industry, amount: 0, wheel: 0 });
        return;
      }
      const { amount, mods } = companyFeeAmount(ctx.s, ctx.map, ci, p, n, f.steps);
      f.q = { owner: chairman, amount, wheel: n, mods, industry: def.industry };
      f.stage = 'free';
      return;
    }
    case 'insurance': {
      const d = spin(ctx, INSURANCE_WHEEL);
      const { amount, mods } = companyFeeAmount(ctx.s, ctx.map, ci, p, d, f.steps);
      f.q = { owner: chairman, amount, wheel: d, mods, industry: def.industry };
      f.stage = 'free';
      return;
    }
    case 'electronics':
    case 'vehicle':
    case 'sect': {
      const { amount, mods } = companyFeeAmount(ctx.s, ctx.map, ci, p, null, f.steps);
      if (amount === 0 && kind === 'vehicle') return; // 步行免费
      f.q = { owner: chairman, amount, wheel: null, mods, industry: def.industry };
      f.stage = 'free';
      return;
    }
    case 'construction': {
      if (sleepwalk) return;
      // 有目标 → CONSTRUCTION_PICK（选定后在 ASK 里加盖并付工程费）；没有目标 → 收 1000 × PI
      ctx.push({
        k: 'ASK',
        seat: f.payer,
        kind: 'CONSTRUCTION_PICK',
        data: { company: company.id, chairman: false },
        stage: 'ask',
      });
      return;
    }
    default:
      return;
  }
}

/** 建设公司没有可加盖的目标时直接收 1000 × PI（由 ASK CONSTRUCTION_PICK 的 build 在无目标时调用） */
export function chargeConstructionNoTarget(ctx: Ctx, seat: SeatIndex, company: CompanyLotId): void {
  const ci = ctx.map.companyIdx(company);
  const def = ctx.map.companies[ci]!;
  const amount = constructionFee(ctx.s, ctx.player(seat), null);
  payCompany(ctx, seat, company, def.industry, amount, null);
}

/** 付给公司（可用存款，付不起即破产）→ COMPANY_FEE；返回是否破产 */
export function payCompany(
  ctx: Ctx,
  seat: SeatIndex,
  company: CompanyLotId,
  industry: number,
  amount: number,
  wheel: number | null,
): boolean {
  const r = ctx.pay({ t: 'seat', seat }, { t: 'company', company }, amount, {
    reason: 'companyFee',
    accident: true,
    cause: { k: 'fee', ref: company, by: null },
  });
  ctx.emit('COMPANY_FEE', { seat, company, industry, amount: r.paid, wheel });
  return r.bankrupt;
}

function pay(ctx: Ctx, f: FeeFrame): void {
  const q = f.q;
  if (!q) throw new EngineInvariantError('FEE_NO_QUOTE');
  f.stage = 'after';
  if (f.feeKind === 'company') {
    payCompany(ctx, f.payer, f.lot as CompanyLotId, q.industry ?? 0, q.amount, q.wheel);
    return;
  }
  if (q.owner === null) throw new EngineInvariantError('FEE_NO_OWNER');
  const r = ctx.pay({ t: 'seat', seat: f.payer }, { t: 'seat', seat: q.owner }, q.amount, {
    reason: 'fee',
    accident: true,
    cause: { k: 'fee', ref: f.lot, by: q.owner },
  });
  const fac = ctx.s.facilities[ctx.map.facilityIdx(f.lot)];
  if (fac) fac.lastFee = r.paid;
  ctx.emit('FEE_PAID', {
    payer: f.payer,
    lot: f.lot,
    feeKind: f.feeKind as 'hotel' | 'mall' | 'gas',
    wheel: q.wheel,
    amount: r.paid,
  });
}

function after(ctx: Ctx, f: FeeFrame): void {
  const q = f.q;
  f.stage = f.feeKind === 'company' ? 'subscribe' : 'done';
  if (!q || q.wheel === null) return;
  const p = ctx.player(f.payer);
  if (!p.alive) return;
  if (f.feeKind === 'hotel') {
    // 大财神使费用为 0 时不必住宿
    if (q.amount === 0 && q.mods.includes('bigWealth')) return;
    applyConfinement(
      ctx,
      f.payer,
      'hotel',
      q.wheel,
      { k: 'hotel', ref: f.lot, by: q.owner },
      {
        hotelLot: f.lot as FacilityLotId,
      },
    );
    return;
  }
  if (f.feeKind !== 'company') return;
  const kind = companyFeeKind(ctx.map, ctx.map.companyIdx(f.lot));
  if (kind === 'airline') {
    applyConfinement(ctx, f.payer, 'away', q.wheel, { k: 'airline', ref: f.lot, by: q.owner });
  } else if (kind === 'insurance') {
    p.insuranceDays = addCounterDays(p.insuranceDays, q.wheel);
    ctx.emit('STATUS_SET', { actor: { t: 'seat', seat: f.payer }, status: 'insurance', value: p.insuranceDays });
  }
}

export const FEE: FrameHandler<FeeFrame> = {
  step(ctx, f) {
    switch (f.stage) {
      case 'compute':
        if (f.feeKind === 'company') computeCompany(ctx, f);
        else computeFacility(ctx, f);
        return;
      case 'free':
        // TODO(M6)：持免费卡且（金额 ≥ 2000×PI 或 > 现金+存款）→ USE_FREE_CARD（旅馆不能用免费卡）
        f.stage = 'scapegoat';
        return;
      case 'scapegoat':
        // TODO(M6)：持嫁祸卡 → SCAPEGOAT；死神附身者代付
        f.stage = 'pay';
        return;
      case 'pay':
        pay(ctx, f);
        return;
      case 'after':
        after(ctx, f);
        return;
      case 'subscribe': {
        f.stage = 'done';
        const p = ctx.player(f.payer);
        // 梦游中、刚被航空送出国（消失）等受阻状态不问认购
        if (!p.alive || p.st.sleepwalk !== 0 || mainBlockOf(p.st) !== null) return;
        ctx.push({ k: 'ASK', seat: f.payer, kind: 'SUBSCRIBE_SHARES', data: { company: f.lot }, stage: 'ask' });
        return;
      }
      case 'done':
        ctx.pop(f);
        return;
    }
  },
};
