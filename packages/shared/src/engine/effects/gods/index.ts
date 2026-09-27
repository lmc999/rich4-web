/**
 * 13 种神明的效果注册表（design/engine.md §10.5；docs/research/r_deities.md §7；g_arbitration.md §2.c、§2.k）。
 * GOD_EFFECTS 用 satisfies 对 GodKind 穷举：
 *   power    附身时立即发威（GOD 帧的 'power' 阶段）
 *   manifest 附身期间停在地产上的显灵（LAND 帧的 'tail' 阶段，只作用于落点那一格）
 * 过路费修正（付款方身上的神）在 rules/toll.ts applyPayerGod，投资禁令在 rules/purchase.ts。
 *
 * 发威（老虎机金额不乘 PI；每位 rand15()%10）：
 *   1 小财神  3 位 X：每位在场对手付 X 给他（进现金；对手付不起即破产）
 *   2 大财神  4 位 X：得 X（铸造进现金）
 *   3 小福神  从牌堆抽 1 张；4 大福神 抽 2 张（满手按 rules.handFull）
 *   5 小穷神  3 位 X：付给每位在场对手 X（进对方存款；付不起即破产）
 *   6 大穷神  4 位 X：付 X 给银行（销毁）
 *   7 小衰神  随机丢 1 张卡；8 大衰神 丢 floor(n/2) 张（n > 1 时）
 *   15 死神   没收全部卡片与背包道具（回牌堆、共享库存，研究所道具消失，不折点券；装备中的交通工具保留）
 *   9 天使 / 10 恶魔 / 12 土地公：附身时没有即时效果；11 恶犬不附身
 * 显灵（落点地产，住宅或设施；企业不算）：
 *   天使   +1 级（不看归属；0 级设施免费首建选类型；满级、1 级连锁店不动）
 *   恶魔   有建筑就 −1 级（自己的也拆；连锁店直接 0 级）；地主对他的敌意 +30×PI
 *   土地公 不是自己的地就强占（地主换人、等级保留、地契重算；先照付过路费，住旅馆时跳过）
 */
import { CMB } from '../../../data/tables/combat';
import { GODS } from '../../../data/tables/gods';
import { GOD, type GodKind, ITEM_IDS, isPoolItem } from '../../../data/tables/ids';
import type { Ctx } from '../../core/ctx';
import { drawCardId } from '../../core/random';
import { lotState } from '../../decisions/targets';
import { addTenure } from '../../rules/calendar';
import { returnCardToDeck } from '../../rules/inventory';
import type { LotId, SeatIndex } from '../../types/ids';
import { addHostility, gainCard, mutateLot, raiseLot, timesPI } from '../common';

export interface GodEffect {
  power: ((ctx: Ctx, seat: SeatIndex) => void) | null;
  manifest: ((ctx: Ctx, seat: SeatIndex, lot: LotId) => void) | null;
}

/** 老虎机：digits 位，每位 rand15()%10（purpose 'slot'） */
export function spinSlot(ctx: Ctx, digits: number): number {
  let v = 0;
  for (let i = 0; i < digits; i++) v = v * 10 + ctx.pick('slot', 10);
  return v;
}

function opponents(ctx: Ctx, seat: SeatIndex): SeatIndex[] {
  return ctx.s.players.filter((p) => p.alive && p.seat !== seat).map((p) => p.seat);
}

function smallWealth(ctx: Ctx, seat: SeatIndex): void {
  const digits = GODS[GOD.SMALL_WEALTH].slotDigits;
  const value = spinSlot(ctx, digits);
  const transfers: { seat: SeatIndex; amount: number }[] = [];
  let total = 0;
  if (value > 0) {
    for (const o of opponents(ctx, seat)) {
      const r = ctx.pay({ t: 'seat', seat: o }, { t: 'seat', seat }, value, {
        reason: 'godPower',
        accident: true,
        cause: { k: 'god', ref: GOD.SMALL_WEALTH, by: seat },
      });
      transfers.push({ seat: o, amount: -r.paid });
      total += r.paid;
    }
    transfers.unshift({ seat, amount: total });
  }
  ctx.emit('GOD_POWER', { seat, kind: GOD.SMALL_WEALTH, slot: { digits, value }, transfers });
}

function bigWealth(ctx: Ctx, seat: SeatIndex): void {
  const digits = GODS[GOD.BIG_WEALTH].slotDigits;
  const value = spinSlot(ctx, digits);
  if (value > 0) ctx.mint(seat, value, 'cash', true);
  ctx.emit('GOD_POWER', {
    seat,
    kind: GOD.BIG_WEALTH,
    slot: { digits, value },
    transfers: value > 0 ? [{ seat, amount: value }] : [],
  });
}

function smallPoor(ctx: Ctx, seat: SeatIndex): void {
  const digits = GODS[GOD.SMALL_POOR].slotDigits;
  const value = spinSlot(ctx, digits);
  const transfers: { seat: SeatIndex; amount: number }[] = [];
  let total = 0;
  if (value > 0) {
    for (const o of opponents(ctx, seat)) {
      const r = ctx.pay({ t: 'seat', seat }, { t: 'seat', seat: o }, value, {
        reason: 'godPower',
        accident: true,
        credit: 'deposit',
        cause: { k: 'god', ref: GOD.SMALL_POOR, by: null },
      });
      transfers.push({ seat: o, amount: r.paid });
      total += r.paid;
      if (r.bankrupt) break;
    }
    transfers.unshift({ seat, amount: -total });
  }
  ctx.emit('GOD_POWER', { seat, kind: GOD.SMALL_POOR, slot: { digits, value }, transfers });
}

function bigPoor(ctx: Ctx, seat: SeatIndex): void {
  const digits = GODS[GOD.BIG_POOR].slotDigits;
  const value = spinSlot(ctx, digits);
  let paid = 0;
  if (value > 0) {
    paid = ctx.burn(seat, value, {
      reason: 'godPower',
      accident: true,
      cause: { k: 'god', ref: GOD.BIG_POOR, by: null },
    }).paid;
  }
  ctx.emit('GOD_POWER', {
    seat,
    kind: GOD.BIG_POOR,
    slot: { digits, value },
    transfers: value > 0 ? [{ seat, amount: -paid }] : [],
  });
}

function fortune(kind: GodKind) {
  return (ctx: Ctx, seat: SeatIndex): void => {
    ctx.emit('GOD_POWER', { seat, kind, slot: null, transfers: [] });
    for (let i = 0; i < GODS[kind].drawCards; i++) {
      const card = drawCardId(ctx.s, 'deck');
      if (card === null) return;
      ctx.s.pools.cards[card] = ctx.s.pools.cards[card]! - 1;
      gainCard(ctx, seat, card, 'god');
    }
  };
}

/** 随机丢一张（purpose 'steal'）→ CARD_LOST{badLuckGod} */
function dropRandomCard(ctx: Ctx, seat: SeatIndex): void {
  const p = ctx.player(seat);
  if (p.cards.length === 0) return;
  const slot = ctx.pick('steal', p.cards.length);
  const card = p.cards[slot]!;
  p.cards.splice(slot, 1);
  returnCardToDeck(ctx.s, card);
  ctx.emit('CARD_LOST', { seat, card, cause: 'badLuckGod' });
}

function smallMisfortune(ctx: Ctx, seat: SeatIndex): void {
  ctx.emit('GOD_POWER', { seat, kind: GOD.SMALL_MISFORTUNE, slot: null, transfers: [] });
  dropRandomCard(ctx, seat);
}

function bigMisfortune(ctx: Ctx, seat: SeatIndex): void {
  ctx.emit('GOD_POWER', { seat, kind: GOD.BIG_MISFORTUNE, slot: null, transfers: [] });
  const n = ctx.player(seat).cards.length;
  if (n <= 1) return;
  for (let i = 0; i < Math.trunc(n / 2); i++) dropRandomCard(ctx, seat);
}

/** 死神：没收全部卡片与背包道具（不折点券） */
function death(ctx: Ctx, seat: SeatIndex): void {
  const s = ctx.s;
  const p = ctx.player(seat);
  for (const c of p.cards) returnCardToDeck(s, c);
  p.cards = [];
  for (const it of ITEM_IDS) {
    const n = p.items[it] ?? 0;
    if (n > 0 && isPoolItem(it)) s.pools.items[it] = (s.pools.items[it] ?? 0) + n;
    p.items[it] = 0;
  }
  ctx.emit('GOD_POWER', { seat, kind: GOD.DEATH, slot: null, transfers: [] });
}

function angelManifest(ctx: Ctx, seat: SeatIndex, lot: LotId): void {
  const st = lotState(ctx.s, ctx.map, lot);
  if (!st) return;
  const cause = { k: 'god', ref: GOD.ANGEL, by: seat } as const;
  if (st.kind === 'facility' && st.level === 0) {
    // 空的商业用地：免费首建，真人选类型（FACILITY_TYPE），电脑随机
    ctx.emit('GOD_MANIFEST', { seat, kind: GOD.ANGEL, lot, effect: 'levelUp' });
    ctx.push({ k: 'ASK', seat, kind: 'FACILITY_TYPE', data: { lot }, stage: 'ask' });
    return;
  }
  const fac = st.kind === 'facility' ? ctx.s.facilities[ctx.map.facilityIdx(lot)]! : null;
  const land = st.kind === 'land' ? ctx.s.lands[ctx.map.landIdx(lot)]! : null;
  const full = land ? (land.chain ? land.level >= 1 : land.level >= 5) : fac!.level >= capOf(fac!.type);
  if (full) return;
  ctx.emit('GOD_MANIFEST', { seat, kind: GOD.ANGEL, lot, effect: 'levelUp' });
  raiseLot(ctx, lot, cause);
}

function capOf(type: 'park' | 'hotel' | 'mall' | 'gas' | 'lab'): number {
  return type === 'park' || type === 'gas' ? 1 : 5;
}

function devilManifest(ctx: Ctx, seat: SeatIndex, lot: LotId): void {
  const st = lotState(ctx.s, ctx.map, lot);
  if (!st || st.level <= 0) return;
  ctx.emit('GOD_MANIFEST', { seat, kind: GOD.DEVIL, lot, effect: 'levelDown' });
  if (st.owner !== null) addHostility(ctx, st.owner, seat, timesPI(ctx, CMB.HATE_DEMOLISH_PI));
  mutateLot(ctx, lot, 0, { k: 'god', ref: GOD.DEVIL, by: seat });
}

function earthGodManifest(ctx: Ctx, seat: SeatIndex, lot: LotId): void {
  const p = ctx.player(seat);
  if (p.st.hotel !== 0) return;
  const s = ctx.s;
  const target = lot.startsWith('L') ? s.lands[ctx.map.landIdx(lot)] : s.facilities[ctx.map.facilityIdx(lot)];
  if (!target || target.owner === seat) return;
  const prev = target.owner;
  target.owner = seat;
  target.tenure = addTenure(s.clock.date, s.config.tenure);
  let cancelled: number | null = null;
  if ('research' in target && target.research !== null) {
    cancelled = target.research.project;
    target.research = null;
  }
  ctx.emit('GOD_MANIFEST', { seat, kind: GOD.EARTH_GOD, lot, effect: 'seize' });
  if (cancelled !== null && prev !== null) {
    ctx.emit('RESEARCH_CANCELLED', { seat: prev, lot: lot as `F${number}`, project: cancelled as 1 | 2 | 3 | 4 | 5 });
  }
}

const none: GodEffect = { power: null, manifest: null };

export const GOD_EFFECTS = Object.freeze({
  1: { power: smallWealth, manifest: null },
  2: { power: bigWealth, manifest: null },
  3: { power: fortune(GOD.SMALL_FORTUNE), manifest: null },
  4: { power: fortune(GOD.BIG_FORTUNE), manifest: null },
  5: { power: smallPoor, manifest: null },
  6: { power: bigPoor, manifest: null },
  7: { power: smallMisfortune, manifest: null },
  8: { power: bigMisfortune, manifest: null },
  9: { power: null, manifest: angelManifest },
  10: { power: null, manifest: devilManifest },
  11: none,
  12: { power: null, manifest: earthGodManifest },
  15: { power: death, manifest: null },
} satisfies { readonly [G in GodKind]: GodEffect });

export function godEffect(kind: GodKind): GodEffect {
  return GOD_EFFECTS[kind];
}
