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
 * CONFINE 帧（带被动卡的关押：陷害卡、新闻 29、魔法屋坐牢 / 住院、命运坐牢；docs/research/g_villains.md §6）：
 *   hostility  原目标对 cause.by 的敌意 += hate（对盟友产生正敌意即解除同盟）；敌意随本链下一个事件公布
 *              （紧接着问 SCAPEGOAT 时没有事件可以携带，所以推迟到下一次 emit 之前记上，见 settleHate）
 *   bless      blessing（命运）：福运加持 high → 逃过此劫（结束）；low → 天数 ×2（BLESSING）
 *   exempt     passive 且持免罪卡 → 自动消耗（PASSIVE），本次关押取消
 *   scapegoat  passive、未改嫁过且持嫁祸卡 → SCAPEGOAT（候选：在场的其他玩家，可以是 cause.by）；
 *              选定后消耗卡、目标改为新人（不再检查他的被动卡）；新目标就是 cause.by 时天数改为 selfDays（陷害卡 4）
 *   apply      施加（恶人：关进监狱 / 送医院，不查被动卡）
 *   revenge    revenge（陷害卡）、没被改嫁、原目标持复仇卡 → 消耗，出卡者本人也坐牢 5 天（直接施加 ⚑）
 */
import { CMB } from '../../data/tables/combat';
import { ECON } from '../../data/tables/economy';
import { CARD } from '../../data/tables/ids';
import { add32, mul32 } from '../../util/int32';
import type { Ctx } from '../core/ctx';
import type { FrameHandler } from '../core/frameHandler';
import { addHostility } from '../effects/common';
import { confineVillain } from '../effects/villainState';
import { EngineInvariantError } from '../errors';
import { insuranceCompanyIdx } from '../rules/bank';
import { evalBlessing, luckFor } from '../rules/blessing';
import { addCounterDays, COUNTER_PENDING } from '../rules/counters';
import type { PassiveContext, ScapegoatOptions } from '../types/decision';
import type { ConfineWhere, FrameOf } from '../types/frames';
import type { ActorRef, Cause, FacilityLotId, SeatIndex } from '../types/ids';
import { askScapegoat, consumePassive, holdsCard, resolveScapegoat, scapegoatCandidates } from './passive';

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

/** 陷害卡为 'frame'，其余（新闻、魔法屋、命运）为 'confine' */
function contextOf(f: ConfineFrame): PassiveContext {
  return f.cause.k === 'card' && f.cause.ref === CARD.FRAME ? 'frame' : 'confine';
}

export interface ConfineChain {
  where: ConfineWhere;
  days: number;
  cause: Cause;
  passive: boolean;
  blessing?: boolean;
  hate?: number;
  selfDays?: number | null;
  revenge?: boolean;
}

/** 压 CONFINE 帧（actor 为玩家时 orig 记为原目标） */
export function pushConfine(ctx: Ctx, actor: ActorRef, c: ConfineChain): void {
  ctx.push({
    k: 'CONFINE',
    actor,
    where: c.where,
    days: c.days,
    cause: c.cause,
    passive: c.passive,
    blessing: c.blessing ?? false,
    hate: c.hate ?? 0,
    orig: actor.t === 'seat' ? actor.seat : null,
    selfDays: c.selfDays ?? null,
    revenge: c.revenge ?? false,
    scapegoated: false,
    stage: 'hostility',
  });
}

/** 记上推迟的敌意（每条链只记一次）；调用方随后必须 emit */
function settleHate(ctx: Ctx, f: ConfineFrame): void {
  if (f.hate <= 0) return;
  const hate = f.hate;
  f.hate = 0;
  if (f.orig !== null) addHostility(ctx, f.orig, f.cause.by, hate);
}

export const CONFINE: FrameHandler<ConfineFrame> = {
  step(ctx, f) {
    const seat = f.actor.t === 'seat' ? f.actor.seat : null;
    const p = seat === null ? null : (ctx.s.players.find((x) => x.seat === seat) ?? null);
    switch (f.stage) {
      case 'hostility':
        f.stage = 'bless';
        return;
      case 'bless': {
        f.stage = 'exempt';
        if (!f.blessing || p === null || !p.alive) return;
        const r = evalBlessing(luckFor(p, 'misfortune'), () => ctx.rand15('bless') & 1);
        if (r === 'none') return;
        if (r === 'low') f.days = f.days * 2;
        settleHate(ctx, f);
        ctx.emit('BLESSING', { seat: p.seat, category: 'misfortune', result: r });
        if (r === 'high') f.stage = 'done';
        return;
      }
      case 'exempt':
        f.stage = 'scapegoat';
        if (!f.passive || p === null || !p.alive) return;
        if (holdsCard(p, CARD.PARDON)) {
          settleHate(ctx, f);
          consumePassive(ctx, p.seat, CARD.PARDON, contextOf(f));
          f.stage = 'done';
        }
        return;
      case 'scapegoat': {
        if (!f.passive || f.scapegoated || p === null || !p.alive) {
          f.stage = 'apply';
          return;
        }
        const cands = scapegoatCandidates(ctx.s, p.seat);
        if (!askScapegoat(ctx, f, p.seat, contextOf(f), null, f.days, cands)) f.stage = 'apply';
        return;
      }
      case 'apply': {
        f.stage = 'revenge';
        settleHate(ctx, f);
        if (f.days <= 0) {
          ctx.emit('CONFINED', { actor: f.actor, where: f.where, days: 0, total: 0, cause: f.cause });
          return;
        }
        if (f.actor.t === 'villain') {
          confineVillain(ctx, f.actor.kind, f.where === 'hospital' ? 'hospital' : 'jail', f.cause);
          return;
        }
        if (p === null || !p.alive) return;
        applyConfinement(ctx, p.seat, f.where, f.days, f.cause);
        return;
      }
      case 'revenge': {
        f.stage = 'done';
        const by = f.cause.by;
        if (!f.revenge || f.scapegoated || p === null || !p.alive || by === null || p.seat !== f.orig) return;
        const user = ctx.s.players.find((x) => x.seat === by);
        if (!user?.alive || !holdsCard(p, CARD.REVENGE)) return;
        consumePassive(ctx, p.seat, CARD.REVENGE, contextOf(f));
        applyConfinement(ctx, by, f.where, CMB.REVENGE_DAYS, { k: 'card', ref: CARD.REVENGE, by: p.seat });
        return;
      }
      case 'done':
        ctx.pop(f);
        return;
    }
  },
  resume(ctx, f, a, d) {
    if (f.stage !== 'scapegoat' || f.actor.t !== 'seat' || d.kind !== 'SCAPEGOAT') {
      throw new EngineInvariantError('CONFINE_RESUME', f.stage);
    }
    const from = f.actor.seat;
    const cands = (d.options as ScapegoatOptions).candidates;
    if (a.type === 'SCAPEGOAT') settleHate(ctx, f);
    const t = resolveScapegoat(ctx, from, a, cands, contextOf(f));
    f.stage = 'apply';
    if (t === null) return;
    f.actor = { t: 'seat', seat: t };
    f.scapegoated = true;
    if (f.selfDays !== null && t === f.cause.by) f.days = f.selfDays;
  },
};
