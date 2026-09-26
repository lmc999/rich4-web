/**
 * 设施（大块地）落点与各决策的结算（design/engine.md §8 kind 0；docs/research/g_map.md §4.2、r_property.md §6）。
 * - 无主：满足 canBuyFacility → BUY_FACILITY（价 = 地价 × PI，与现有等级无关，只用现金）；否则 INVEST_BLOCKED / CANNOT_AFFORD
 * - 自己的 0 级：BUILD_FACILITY（再付一次 地价 × PI 并选类型）
 * - 自己的 ≥1 级且未到类型上限：UPGRADE_FACILITY（rate0 × PI）
 * - 别人的：FEE 帧（旅馆、购物中心、加油站；公园、研究所不收费）
 * - 梦游中：不买不盖，只付费
 * 福神附身（PROGRAM）：买设施、首建、加盖成功后多送 1 级（按类型封顶）；买下的是 0 级设施时改为免费首建（FACILITY_TYPE）。
 * 研究所：业主停在自己已建成、未查封的研究所（未梦游）→ RESEARCH（LAND 帧的 'lab' 阶段）。
 */
import { ECON } from '../../data/tables/economy';
import { FACILITY_TYPES, type FacilityType } from '../../data/tables/ids';
import type { Ctx } from '../core/ctx';
import { EngineRuleError } from '../errors';
import { pushFacilityFee } from '../flow/fee';
import { addTenure } from '../rules/calendar';
import {
  canBuildFacility,
  canBuyFacility,
  canUpgradeFacility,
  facilityLevelAfter,
  fortuneBonus,
} from '../rules/purchase';
import type { FacilityLotId, ResearchProject, SeatIndex } from '../types/ids';

export function facilitySquare(ctx: Ctx, seat: SeatIndex, lot: FacilityLotId, sleepwalk: boolean, steps: number): void {
  const i = ctx.map.facilityIdx(lot);
  if (i < 0) return;
  const fac = ctx.s.facilities[i]!;
  if (fac.owner === null) {
    if (sleepwalk) return;
    const chk = canBuyFacility(ctx.s, ctx.map, seat, i);
    if (chk.ok) ctx.push({ k: 'ASK', seat, kind: 'BUY_FACILITY', data: { lot }, stage: 'ask' });
    else if (chk.reason === 'investBlocked') ctx.emit('INVEST_BLOCKED', { seat, lot, god: chk.god });
    else if (chk.reason === 'notEnoughCash') ctx.emit('CANNOT_AFFORD', { seat, lot, price: chk.price });
    return;
  }
  if (fac.owner === seat) {
    if (sleepwalk) return;
    const chk = fac.level === 0 ? canBuildFacility(ctx.s, seat, i) : canUpgradeFacility(ctx.s, ctx.map, seat, i);
    const kind = fac.level === 0 ? 'BUILD_FACILITY' : 'UPGRADE_FACILITY';
    if (chk.ok) ctx.push({ k: 'ASK', seat, kind, data: { lot }, stage: 'ask' });
    else if (chk.reason === 'investBlocked') ctx.emit('INVEST_BLOCKED', { seat, lot, god: chk.god });
    else if (chk.reason === 'notEnoughCash') ctx.emit('CANNOT_AFFORD', { seat, lot, price: chk.price });
    return;
  }
  pushFacilityFee(ctx, seat, lot, steps);
}

function facility(ctx: Ctx, lot: FacilityLotId) {
  const i = ctx.map.facilityIdx(lot);
  const fac = ctx.s.facilities[i];
  if (!fac) throw new EngineRuleError('INVALID_TARGET', `${lot} is not a facility`);
  return { i, fac };
}

/** 福神多送的 1 级（按类型封顶） */
function fortuneLevel(ctx: Ctx, seat: SeatIndex, lot: FacilityLotId): void {
  const { fac } = facility(ctx, lot);
  const p = ctx.player(seat);
  if (fortuneBonus(ctx.s, p) === 0 || fac.level === 0) return;
  const from = fac.level;
  fac.level = facilityLevelAfter(from, 1, fac.type);
  if (fac.level !== from) {
    ctx.emit('LOT_LEVEL', { lot, from, to: fac.level, cause: { k: 'god', ref: p.god?.kind ?? null, by: seat } });
  }
}

/** BUY_FACILITY 的 CONFIRM */
export function confirmBuyFacility(ctx: Ctx, seat: SeatIndex, lot: FacilityLotId): void {
  const { i, fac } = facility(ctx, lot);
  if (fac.owner !== null) throw new EngineRuleError('NOT_ALLOWED', `${lot} is not for sale`);
  const chk = canBuyFacility(ctx.s, ctx.map, seat, i);
  if (!chk.ok) throw new EngineRuleError(chk.reason === 'notEnoughCash' ? 'CANNOT_AFFORD' : 'NOT_ALLOWED', chk.reason);
  const bonus = fortuneBonus(ctx.s, ctx.player(seat));
  if (!ctx.spendCash(seat, chk.price)) throw new EngineRuleError('CANNOT_AFFORD');
  fac.owner = seat;
  fac.tenure = addTenure(ctx.s.clock.date, ctx.s.config.tenure);
  ctx.emit('LAND_BOUGHT', { seat, lot, price: chk.price });
  if (bonus === 0) return;
  if (fac.level === 0) ctx.push({ k: 'ASK', seat, kind: 'FACILITY_TYPE', data: { lot }, stage: 'ask' });
  else fortuneLevel(ctx, seat, lot);
}

function checkType(t: FacilityType): void {
  if (!(FACILITY_TYPES as readonly string[]).includes(t)) throw new EngineRuleError('BAD_ACTION', `type ${String(t)}`);
}

/** BUILD_FACILITY{facility}：付 地价 × PI 首建 1 级 */
export function buildFacility(ctx: Ctx, seat: SeatIndex, lot: FacilityLotId, type: FacilityType): void {
  checkType(type);
  const { i, fac } = facility(ctx, lot);
  if (fac.owner !== seat) throw new EngineRuleError('NOT_ALLOWED', `${lot} is not yours`);
  const chk = canBuildFacility(ctx.s, seat, i);
  if (!chk.ok) throw new EngineRuleError(chk.reason === 'notEnoughCash' ? 'CANNOT_AFFORD' : 'NOT_ALLOWED', chk.reason);
  if (!ctx.spendCash(seat, chk.price)) throw new EngineRuleError('CANNOT_AFFORD');
  fac.level = 1;
  fac.type = type;
  ctx.emit('FACILITY_BUILT', { lot, facility: type, seat });
  fortuneLevel(ctx, seat, lot);
}

/** FACILITY_TYPE 的 CHOOSE_FACILITY_TYPE：免费首建 1 级（福神、天使、魔法屋…） */
export function chooseFacilityType(ctx: Ctx, seat: SeatIndex, lot: FacilityLotId, type: FacilityType): void {
  checkType(type);
  const { fac } = facility(ctx, lot);
  if (fac.level !== 0) throw new EngineRuleError('NOT_ALLOWED', `${lot} is already built`);
  fac.level = 1;
  fac.type = type;
  ctx.emit('FACILITY_BUILT', { lot, facility: type, seat });
}

/** UPGRADE_FACILITY 的 CONFIRM：rate0 × PI 加盖一层（福神多送 1 级，按类型封顶） */
export function confirmUpgradeFacility(ctx: Ctx, seat: SeatIndex, lot: FacilityLotId): void {
  const { i, fac } = facility(ctx, lot);
  if (fac.owner !== seat) throw new EngineRuleError('NOT_ALLOWED', `${lot} is not yours`);
  const chk = canUpgradeFacility(ctx.s, ctx.map, seat, i);
  if (!chk.ok) throw new EngineRuleError(chk.reason === 'notEnoughCash' ? 'CANNOT_AFFORD' : 'NOT_ALLOWED', chk.reason);
  const p = ctx.player(seat);
  const from = fac.level;
  const to = facilityLevelAfter(from, 1 + fortuneBonus(ctx.s, p), fac.type);
  if (!ctx.spendCash(seat, chk.price)) throw new EngineRuleError('CANNOT_AFFORD');
  fac.level = to;
  ctx.emit('LOT_LEVEL', { lot, from, to, cause: { k: 'system', ref: 'upgrade', by: seat } });
}

/** 业主停在自己的研究所：是否发 RESEARCH（已建成、未查封、未梦游） */
export function wantsResearch(ctx: Ctx, seat: SeatIndex, lot: FacilityLotId): boolean {
  const i = ctx.map.facilityIdx(lot);
  const fac = ctx.s.facilities[i];
  if (!fac || fac.owner !== seat || fac.type !== 'lab' || fac.level < 1) return false;
  if (fac.mark?.kind === 'seal') return false;
  return ctx.player(seat).st.sleepwalk === 0;
}

/** RESEARCH{project}：研发 5 天（不收费）；与进行中的项目相同时保持进度，不同则改为新项目 */
export function startResearch(ctx: Ctx, seat: SeatIndex, lot: FacilityLotId, project: ResearchProject): void {
  const { fac } = facility(ctx, lot);
  if (fac.owner !== seat || fac.type !== 'lab') throw new EngineRuleError('NOT_ALLOWED', `${lot} is not your lab`);
  if (!Number.isInteger(project) || project < 1 || project > fac.level) {
    throw new EngineRuleError('OUT_OF_RANGE', `project ${project} needs level ${project}`);
  }
  const cur = fac.research;
  if (cur !== null && cur.project === project) return;
  if (cur !== null) {
    fac.research = null;
    ctx.emit('RESEARCH_CANCELLED', { seat, lot, project: cur.project });
  }
  fac.research = { project, days: ECON.RESEARCH_DAYS };
  ctx.emit('RESEARCH_STARTED', { seat, lot, project, days: ECON.RESEARCH_DAYS });
}
