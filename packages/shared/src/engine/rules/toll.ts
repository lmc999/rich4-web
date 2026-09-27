/**
 * 住宅过路费（design/engine.md §8、§16.1；docs/research/r_property.md §4、§5）。
 *
 * 基数（calculate_land_toll，VA 0x419744）：
 *   落点是普通住宅 → Σ rent[level]，对象 = 同一地主、同名路段、非连锁店的全部地块（空地只要有主也收 rent[0]）
 *   落点是连锁店   → 2000 × 该地主在全图拥有的连锁店数
 * toll = 基数 × PI；落点处于涨价中 → 地主那一份 ×2。
 * 付款方身上的神（必定生效）：小财神 ÷2（>>1）、大财神 0、小穷神 ×1.5（或 ×2，smallPoorToll）、大穷神 ×2。
 * 免收（VA 0x41d559，按判定顺序）：查封中、同盟、地主被死神附身、地主住旅馆 / 消失 / 坐牢 / 住院 / 冬眠 / 梦游。
 * 同盟分账（r_property §4.2）：地主有盟友（且付款人不是盟友）时，按同样规则算出盟友名下同名路段地块（落点是连锁店时为
 *   盟友的连锁店）的租金，加进总额；涨价只翻倍地主那一份；神明修正作用于合并后的总额；
 *   盟友应得 = trunc(总额 × float32(盟友份 / 两份合计))，地主应得 = 总额 − 盟友应得；先付地主，再付盟友。
 * 死神代付在 TOLL 帧里改写 q.payer。
 */
import { ECON } from '../../data/tables/economy';
import { GOD } from '../../data/tables/ids';
import { add32, mul32 } from '../../util/int32';
import type { EngineMap } from '../core/mapCache';
import type { TollExemptReason, TollMod, TollQuote } from '../types/frames';
import type { LotId, LotLevel, SeatIndex } from '../types/ids';
import { findPlayer, modeOf, playerOf, type RulePlayer, type RuleWorld } from './world';

/** 把第 landIdx 块假设为 owner 的 level 级（用于买地 / 加盖后的过路费预览） */
export interface TollOverride {
  landIdx: number;
  owner: SeatIndex;
  level: LotLevel;
}

function ownerOf(w: RuleWorld, i: number, o: TollOverride | null): SeatIndex | null {
  return o !== null && o.landIdx === i ? o.owner : w.lands[i]!.owner;
}

function levelOf(w: RuleWorld, i: number, o: TollOverride | null): LotLevel {
  return o !== null && o.landIdx === i ? o.level : w.lands[i]!.level;
}

/** 盟友那一份：落点是连锁店时为盟友的连锁店数 × 2000，否则为盟友名下同名路段非连锁店的租金之和 */
function allyRent(
  w: RuleWorld,
  em: EngineMap,
  landIdx: number,
  ally: SeatIndex,
): { owner: SeatIndex | null; base: number; lots: LotId[]; chain: boolean } {
  const mode = modeOf(w);
  const land = w.lands[landIdx]!;
  const lots: LotId[] = [];
  let base = 0;
  if (land.chain) {
    let n = 0;
    for (const l of w.lands) {
      if (l.chain && l.owner === ally) {
        n++;
        lots.push(l.id);
      }
    }
    return { owner: ally, base: mul32(ECON.CHAIN_TOLL, n, mode), lots, chain: true };
  }
  for (const i of em.streetOf(landIdx)) {
    const l = w.lands[i]!;
    if (l.chain || l.owner !== ally) continue;
    base = add32(base, em.lands[i]!.rent[l.level], mode);
    lots.push(l.id);
  }
  return { owner: ally, base, lots, chain: false };
}

/** 过路费基数（不乘 PI）与参与累加的地块 */
export function landRentBase(
  w: RuleWorld,
  em: EngineMap,
  landIdx: number,
  override: TollOverride | null = null,
  /** 指定按谁的地产累加（同盟：盟友那一份，落点本身不算） */
  forOwner: SeatIndex | null = null,
): { owner: SeatIndex | null; base: number; lots: LotId[]; chain: boolean } {
  const mode = modeOf(w);
  const land = w.lands[landIdx]!;
  if (forOwner !== null) return allyRent(w, em, landIdx, forOwner);
  const owner = ownerOf(w, landIdx, override);
  if (owner === null) return { owner: null, base: 0, lots: [], chain: land.chain };
  const lots: LotId[] = [];
  let base = 0;
  if (land.chain) {
    let n = 0;
    for (let i = 0; i < w.lands.length; i++) {
      if (w.lands[i]!.chain && ownerOf(w, i, override) === owner) {
        n++;
        lots.push(w.lands[i]!.id);
      }
    }
    base = mul32(ECON.CHAIN_TOLL, n, mode);
    return { owner, base, lots, chain: true };
  }
  for (const i of em.streetOf(landIdx)) {
    const l = w.lands[i]!;
    if (l.chain || ownerOf(w, i, override) !== owner) continue;
    base = add32(base, em.lands[i]!.rent[levelOf(w, i, override)], mode);
    lots.push(l.id);
  }
  return { owner, base, lots, chain: false };
}

/** 免收判定（按原版顺序）；需要收费返回 null */
export function tollExemption(
  w: RuleWorld,
  payer: RulePlayer,
  owner: RulePlayer,
  mark: { kind: 'raise' | 'seal' } | null,
): TollExemptReason | null {
  if (mark?.kind === 'seal') return 'sealed';
  if (owner.alliance?.seat === payer.seat || payer.alliance?.seat === owner.seat) return 'ally';
  if (owner.god?.kind === GOD.DEATH) return 'ownerDeathGod';
  if (owner.st.hotel !== 0) return 'ownerHotel';
  if (owner.st.away !== 0) return 'ownerAway';
  if (owner.st.jail !== 0) return 'ownerJail';
  if (owner.st.hospital !== 0) return 'ownerHospital';
  if (owner.st.hibernate !== 0) return 'ownerHibernate';
  if (owner.st.sleepwalk !== 0) return 'ownerSleepwalk';
  void w;
  return null;
}

/** 付款方身上的神对过路费的修正（作用于合并后的总额） */
export function applyPayerGod(w: RuleWorld, payer: RulePlayer, amount: number, mods: TollMod[]): number {
  const mode = modeOf(w);
  switch (payer.god?.kind) {
    case GOD.SMALL_WEALTH:
      mods.push('smallWealth');
      return amount >> 1;
    case GOD.BIG_WEALTH:
      mods.push('bigWealth');
      return 0;
    case GOD.SMALL_POOR:
      mods.push('smallPoor');
      return w.config.rules.smallPoorToll === 'x2' ? mul32(amount, 2, mode) : add32(amount, amount >> 1, mode);
    case GOD.BIG_POOR:
      mods.push('bigPoor');
      return mul32(amount, 2, mode);
    default:
      return amount;
  }
}

export type LandTollResult =
  | { kind: 'none' }
  | { kind: 'exempt'; reason: TollExemptReason }
  | { kind: 'toll'; q: TollQuote };

/**
 * 停在别人住宅上的过路费报价。无主或自己的地返回 none。
 * payer = 落点者（M6 的死神代付在 TOLL 帧里改写 q.payer）。
 */
export function quoteLandToll(w: RuleWorld, em: EngineMap, landIdx: number, payerSeat: SeatIndex): LandTollResult {
  const mode = modeOf(w);
  const land = w.lands[landIdx]!;
  if (land.owner === null || land.owner === payerSeat) return { kind: 'none' };
  const payer = playerOf(w.players, payerSeat);
  const owner = findPlayer(w.players, land.owner);
  if (!owner) return { kind: 'none' };
  const exempt = tollExemption(w, payer, owner, land.mark);
  if (exempt) return { kind: 'exempt', reason: exempt };
  const { base, lots, chain } = landRentBase(w, em, landIdx);
  const mods: TollMod[] = [chain ? 'chain' : 'street', 'priceIndex'];
  let ownerPart = mul32(base, w.econ.priceIndex, mode);
  if (land.mark?.kind === 'raise') {
    ownerPart = mul32(ownerPart, 2, mode);
    mods.push('raise');
  }
  // 同盟：盟友名下同名路段（或连锁店）的租金并入总额
  const allySeat = owner.alliance?.seat ?? null;
  const ally = allySeat === null || allySeat === payerSeat ? null : findPlayer(w.players, allySeat);
  let allyPart = 0;
  if (ally?.alive) {
    const a = landRentBase(w, em, landIdx, null, ally.seat);
    allyPart = mul32(a.base, w.econ.priceIndex, mode);
    for (const l of a.lots) if (!lots.includes(l)) lots.push(l);
    if (allyPart !== 0) mods.push('alliance');
  }
  const parts = add32(ownerPart, allyPart, mode);
  const amount = applyPayerGod(w, payer, parts, mods);
  const allyAmount = allyPart !== 0 && parts !== 0 ? Math.trunc(amount * Math.fround(allyPart / parts)) : 0;
  return {
    kind: 'toll',
    q: {
      owner: land.owner,
      lots,
      base,
      amount,
      ally: allyPart !== 0 && ally ? ally.seat : null,
      allyAmount,
      mods,
      payer: payerSeat,
    },
  };
}

/** 不计免收与神明的「地主应收」金额（买地、加盖预览用）：基数 × PI，涨价 ×2 */
export function landTollPreview(w: RuleWorld, em: EngineMap, landIdx: number, override: TollOverride | null): number {
  const mode = modeOf(w);
  const { owner, base } = landRentBase(w, em, landIdx, override);
  if (owner === null) return 0;
  const amount = mul32(base, w.econ.priceIndex, mode);
  return w.lands[landIdx]!.mark?.kind === 'raise' ? mul32(amount, 2, mode) : amount;
}
