/**
 * 关押、住院、住旅馆、消失（design/engine.md §6.1 CONFINE、§11.3 保险理赔；docs/research/r_rules_map.md §10）。
 *
 * applyConfinement：直接施加（M4 的旅馆住宿、航空出国走这里，它们没有免罪 / 嫁祸环节）：
 *   坐牢 / 住院：首次关押同时清掉住宿、消失与另一种关押；棋子搬到关押格并保存朝向；
 *              已在押时 (旧值 + 天数) & 0x7f（原版加刑，可能回绕）
 *   消失（航空、出国）：计数器 = 天数（n 个受阻回合 + 1 个走回棋盘的回合）⚑
 *   住旅馆：原版写 +0x32 = n − 1；n = 1 时写 0x80（下一回合走回、不掷骰），使「住 n 天」= 失去 n 个回合 ⚑V-R1
 *   住旅馆另记「本月意外损失」2000 × 天数 × PI（r_property §6.2）
 *   投保中（insuranceDays ≠ 0）：赔 2000 × 天数 × PI，由地图上第一家保险公司（行业 4）的盈余付到现金
 * CONFINE 帧：hostility → exempt（免罪卡，M6）→ scapegoat（嫁祸卡，M6）→ bless（命运加持，M7）→ apply → revenge（M6）→ done。
 */
import { ECON } from '../../data/tables/economy';
import { add32, mul32 } from '../../util/int32';
import type { Ctx } from '../core/ctx';
import type { FrameHandler } from '../core/frameHandler';
import { insuranceCompanyIdx } from '../rules/bank';
import { addCounterDays, COUNTER_PENDING } from '../rules/counters';
import type { ConfineWhere, FrameOf } from '../types/frames';
import type { Cause, FacilityLotId, SeatIndex } from '../types/ids';

export interface ConfineOptions {
  /** 住旅馆时的设施（发 HOTEL_STAY 而不是 CONFINED） */
  hotelLot?: FacilityLotId;
}

/** 施加关押类状态并发事件；返回写入后的计数器原始值 */
export function applyConfinement(
  ctx: Ctx,
  seat: SeatIndex,
  where: ConfineWhere,
  days: number,
  cause: Cause,
  o: ConfineOptions = {},
): number {
  const s = ctx.s;
  const p = ctx.player(seat);
  const mode = s.config.rules.intOverflow;
  const pi = s.econ.priceIndex;
  let value: number;
  if (where === 'jail' || where === 'hospital') {
    const other = where === 'jail' ? 'hospital' : 'jail';
    if (p.st[where] === 0) {
      if (p.st.jail === 0 && p.st.hospital === 0 && p.st.hotel === 0 && p.st.away === 0) {
        p.savedPrevNode = p.prevNode;
      }
      p.st.hotel = 0;
      p.st.away = 0;
      p.st[other] = 0;
      value = days & ECON.COUNTER_MASK;
    } else value = addCounterDays(p.st[where], days);
    p.st[where] = value;
    const hold = where === 'jail' ? ctx.map.index.jailHold : ctx.map.index.hospitalHold;
    p.node = hold;
    p.prevNode = hold;
  } else if (where === 'hotel') {
    value = days > 1 ? (days - 1) & ECON.COUNTER_MASK : COUNTER_PENDING;
    p.st.hotel = value;
    p.monthly.loss = add32(p.monthly.loss, mul32(mul32(ECON.CONFINE_LOSS_PER_DAY, days, mode), pi, mode), mode);
  } else {
    value = p.st.away === 0 ? days & ECON.COUNTER_MASK : addCounterDays(p.st.away, days);
    p.st.away = value;
  }
  if (o.hotelLot !== undefined && where === 'hotel') ctx.emit('HOTEL_STAY', { seat, lot: o.hotelLot, days });
  else ctx.emit('CONFINED', { actor: { t: 'seat', seat }, where, days, total: value & ECON.COUNTER_MASK, cause });
  payInsurance(ctx, seat, days);
  return value;
}

/** 投保中被关押 / 出国 / 住旅馆：赔 2000 × 天数 × PI（首家保险公司的盈余 → 现金） */
function payInsurance(ctx: Ctx, seat: SeatIndex, days: number): void {
  const s = ctx.s;
  const p = ctx.player(seat);
  if (p.insuranceDays === 0 || days <= 0) return;
  const ci = insuranceCompanyIdx(ctx.map);
  if (ci < 0) return;
  const mode = s.config.rules.intOverflow;
  const amount = mul32(mul32(ECON.CONFINE_LOSS_PER_DAY, days, mode), s.econ.priceIndex, mode);
  if (amount <= 0) return;
  const company = s.companies[ci]!;
  ctx.pay({ t: 'company', company: company.id }, { t: 'seat', seat }, amount, {
    reason: 'insurance',
    cause: { k: 'system', ref: 'insurance', by: null },
  });
  ctx.emit('INSURANCE_PAYOUT', { seat, amount, days });
}

type ConfineFrame = FrameOf<'CONFINE'>;

export const CONFINE: FrameHandler<ConfineFrame> = {
  step(ctx, f) {
    switch (f.stage) {
      case 'hostility':
        // TODO(M6)：出卡者对目标的敌意（陷害 150×PI 等）
        f.stage = 'exempt';
        return;
      case 'exempt':
        // TODO(M6)：f.passive 且目标持免罪卡 → 用掉、取消本次关押
        f.stage = 'scapegoat';
        return;
      case 'scapegoat':
        // TODO(M6)：f.passive 且目标持嫁祸卡 → SCAPEGOAT 决策（改指一名在场玩家）
        f.stage = 'bless';
        return;
      case 'bless':
        // TODO(M7)：f.blessing（命运）→ 福运加持判定：免灾 / 天数加倍
        f.stage = 'apply';
        return;
      case 'apply': {
        f.stage = 'revenge';
        if (f.actor.t !== 'seat') return; // 恶人被关押属于 M7
        const p = ctx.player(f.actor.seat);
        if (!p.alive || f.days <= 0) return;
        applyConfinement(ctx, f.actor.seat, f.where, f.days, f.cause);
        return;
      }
      case 'revenge':
        // TODO(M6)：陷害被复仇卡反弹
        f.stage = 'done';
        return;
      case 'done':
        ctx.pop(f);
        return;
    }
  },
};
