/**
 * 效果系统的共用原语（design/engine.md §10；docs/research/r_cards.md §9–§10、r_items.md §5）。
 * 这些函数都「先改状态再 emit」，调用方拿到的事件顺序即演出顺序。
 *
 * - addHostility：被害者对加害者的敌意（AI 用）；对盟友产生正敌意时同盟当场解除（ALLIANCE_BROKEN{hostility}）。
 * - destroyVehicle：地雷、炸弹、飞弹、核弹毁车：机车 / 汽车回共享库存，工程车作废，改回步行、1 颗骰子。
 * - stowVehicle：梦游卡、真人收起交通工具（STOW_VEHICLE，items/vehicle.ts stowByHand）：机车 / 汽车退回背包（可以因此
 *   达到第 10 台），工程车作废（只有梦游卡会遇到），改回步行、1 颗骰子。
 * - gainCard：得卡（满手时按 rules.handFull：autoCheapest 自动弃最便宜的一张；choose 先入手再压 DISCARD_CARD）。
 * - mutateLot / raiseLot：地产等级变化（研究所被拆到低于项目等级或清为无主时发 RESEARCH_CANCELLED）。
 * - removeObject：路面物件离开地图（路障、地雷、定时炸弹回共享库存；礼物、宝箱直接消失）。
 */
import { cardDef } from '../../data/tables/cards';
import { CMB } from '../../data/tables/combat';
import { ITEM } from '../../data/tables/ids';
import { VEHICLE_ITEM } from '../../data/tables/setup';
import { add32, mul32 } from '../../util/int32';
import type { Ctx } from '../core/ctx';
import { HAND_MAX, makeRoomForCard } from '../rules/inventory';
import { type MutateMode, mutateFacility, mutateLand } from '../rules/landMutation';
import { facilityLevelAfter, MAX_LEVEL } from '../rules/purchase';
import type { CardSource, StatusKey } from '../types/events';
import type { ActorRef, CardId, Cause, FacilityType, LotId, LotLevel, SeatIndex } from '../types/ids';
import type { RoadObject, RoadObjectKind } from '../types/state';

/** mul32(n, PI) */
export function timesPI(ctx: Ctx, n: number): number {
  return mul32(n, ctx.s.econ.priceIndex, ctx.s.config.rules.intOverflow);
}

// ───────────────────────── 敌意与同盟 ─────────────────────────

/** 解除 seat 的同盟（双方同时解除）；没有同盟返回 false */
export function breakAlliance(ctx: Ctx, seat: SeatIndex, reason: 'hostility' | 'newAlliance' | 'bankrupt'): boolean {
  const p = ctx.player(seat);
  const ally = p.alliance?.seat ?? null;
  if (ally === null) return false;
  p.alliance = null;
  const q = ctx.s.players.find((x) => x.seat === ally);
  if (q?.alliance?.seat === seat) q.alliance = null;
  ctx.emit('ALLIANCE_BROKEN', { a: seat, b: ally, reason });
  return true;
}

/**
 * 被害者 victim 对加害者 by 的敌意 += amount（by 为 null 或就是 victim 时不记）。
 * 对盟友产生正敌意时同盟当场解除（r_cards §9）。敌意随 post 公布，本函数不单独发事件。
 */
export function addHostility(ctx: Ctx, victim: SeatIndex, by: SeatIndex | null, amount: number): void {
  if (by === null || by === victim || amount === 0) return;
  const v = ctx.s.players.find((x) => x.seat === victim);
  if (!v?.alive) return;
  v.hostility[by] = add32(v.hostility[by] ?? 0, amount, ctx.s.config.rules.intOverflow);
  if (amount > 0 && v.alliance?.seat === by) breakAlliance(ctx, victim, 'hostility');
}

// ───────────────────────── 交通工具 ─────────────────────────

/** 毁车：机车 / 汽车回共享库存；工程车作废；改回步行、1 颗骰子 → VEHICLE_DESTROYED。步行时什么都不做 */
export function destroyVehicle(ctx: Ctx, seat: SeatIndex): void {
  const p = ctx.player(seat);
  if (p.vehicle === 'walk') return;
  const old = p.vehicle;
  const item = VEHICLE_ITEM[old];
  if (item !== null) ctx.s.pools.items[item] = (ctx.s.pools.items[item] ?? 0) + 1;
  p.vehicle = 'walk';
  p.diceCount = 1;
  p.engineer = null;
  ctx.emit('VEHICLE_DESTROYED', { seat, vehicle: old });
}

/**
 * 梦游 / 真人收起：机车 / 汽车退回背包，工程车作废，改回步行、1 颗骰子 → VEHICLE（步行时只把骰子改为 1）。
 * byHand：真人从回合菜单收起（stowByHand），VEHICLE 带 stowed = 收回背包的那台，客户端按原版不弹提示、不放音效
 */
export function stowVehicle(ctx: Ctx, seat: SeatIndex, byHand = false): void {
  const p = ctx.player(seat);
  const old = p.vehicle;
  const item = VEHICLE_ITEM[p.vehicle];
  if (item !== null) {
    // 背包里同种交通工具最多 10 台（原版特例），满了就回共享库存
    if ((p.items[item] ?? 0) < CMB.VEHICLE_BAG_MAX) p.items[item] = (p.items[item] ?? 0) + 1;
    else ctx.s.pools.items[item] = (ctx.s.pools.items[item] ?? 0) + 1;
  }
  const changed = p.vehicle !== 'walk' || p.diceCount !== 1;
  p.vehicle = 'walk';
  p.diceCount = 1;
  p.engineer = null;
  if (!changed) return;
  if (byHand && (old === 'moto' || old === 'car')) ctx.emit('VEHICLE', { seat, vehicle: 'walk', dice: 1, stowed: old });
  else ctx.emit('VEHICLE', { seat, vehicle: 'walk', dice: 1 });
}

// ───────────────────────── 卡片 ─────────────────────────

/**
 * 卡片进手牌（卡已离开牌堆或他人手牌）。announce 在卡入手后发得卡事件（默认 CARD_GAINED{source}）。
 * 满手：autoCheapest 先弃最便宜的一张（同价取靠前卡槽，回牌堆，CARD_LOST{discard}）；
 *       choose 先入手（手牌暂时超过 15 张），再压 ASK DISCARD_CARD 让玩家选一张弃掉。
 */
export function gainCard(ctx: Ctx, seat: SeatIndex, card: CardId, source: CardSource, announce?: () => void): void {
  const p = ctx.player(seat);
  const emitGain = announce ?? (() => ctx.emit('CARD_GAINED', { seat, card, source }));
  if (p.cards.length >= HAND_MAX && ctx.s.config.rules.handFull === 'choose') {
    p.cards.push(card);
    emitGain();
    ctx.push({ k: 'ASK', seat, kind: 'DISCARD_CARD', data: { card }, stage: 'ask' });
    return;
  }
  const discarded = makeRoomForCard(ctx.s, seat);
  if (discarded !== null) ctx.emit('CARD_LOST', { seat, card: discarded, cause: 'discard' });
  p.cards.push(card);
  emitGain();
}

/** 手里第一张 card 的卡槽；没有返回 -1 */
export function slotOfCard(cards: readonly CardId[], card: CardId): number {
  return cards.indexOf(card);
}

export function cardPrice(card: CardId): number {
  return cardDef(card).price;
}

// ───────────────────────── 状态 ─────────────────────────

/** 写入演员的状态计数（停留、乌龟、冬眠、梦游）→ STATUS_SET */
export function setActorStatus(
  ctx: Ctx,
  actor: ActorRef,
  status: 'stay' | 'tortoise' | 'hibernate' | 'sleepwalk',
  value: number,
): void {
  if (actor.t === 'seat') ctx.player(actor.seat).st[status] = value;
  else {
    const v = ctx.s.villains.find((x) => x.kind === actor.kind);
    if (!v) return;
    v.st[status] = value;
  }
  ctx.emit('STATUS_SET', { actor, status: status as StatusKey, value });
}

// ───────────────────────── 地产 ─────────────────────────

export interface LotChange {
  lot: LotId;
  from: LotLevel;
  to: LotLevel;
  /** 变化前的地主 */
  owner: SeatIndex | null;
  /** 因此作废的研发（研究所被拆到低于项目等级或清为无主）；没有为 null */
  research: { seat: SeatIndex; project: 1 | 2 | 3 | 4 | 5 } | null;
}

/**
 * 按 mode 改写地产（0 拆一级 / 1 清为无主 / 2 夷平保留地主）；没有变化返回 null。
 * emit=true 时发 LOT_MUTATED，研发作废另发 RESEARCH_CANCELLED；批量效果传 false，由调用方的汇总事件携带 post，
 * 再调用 announceResearch 补发 RESEARCH_CANCELLED。
 */
export function mutateLot(ctx: Ctx, lot: LotId, mode: MutateMode, cause: Cause, emit = true): LotChange | null {
  let ch: LotChange | null = null;
  if (lot.startsWith('L')) {
    const l = ctx.s.lands[ctx.map.landIdx(lot)];
    if (!l) return null;
    const before = { level: l.level, chain: l.chain, owner: l.owner };
    const r = mutateLand(l, mode);
    if (before.level === l.level && before.chain === l.chain && before.owner === l.owner) return null;
    ch = { lot, from: r.from, to: r.to, owner: before.owner, research: null };
  } else if (lot.startsWith('F')) {
    const f = ctx.s.facilities[ctx.map.facilityIdx(lot)];
    if (!f) return null;
    const before = { level: f.level, type: f.type, owner: f.owner, research: f.research };
    const r = mutateFacility(f, mode);
    if (before.level === f.level && before.type === f.type && before.owner === f.owner) return null;
    const lost = before.research !== null && f.research === null && before.owner !== null;
    ch = {
      lot,
      from: r.from,
      to: r.to,
      owner: before.owner,
      research: lost ? { seat: before.owner!, project: before.research!.project } : null,
    };
  }
  if (ch !== null && emit) {
    ctx.emit('LOT_MUTATED', { lot, mode, cause });
    announceResearch(ctx, [ch]);
  }
  return ch;
}

/** 补发地产变化导致的 RESEARCH_CANCELLED */
export function announceResearch(ctx: Ctx, changes: readonly LotChange[]): void {
  for (const c of changes) {
    if (c.research !== null) {
      ctx.emit('RESEARCH_CANCELLED', {
        seat: c.research.seat,
        lot: c.lot as `F${number}`,
        project: c.research.project,
      });
    }
  }
}

/**
 * 地产 +1 级（天使、机器工人、魔法屋）：住宅按普通 5 级 / 连锁店 1 级封顶；设施按类型封顶。
 * 0 级设施需要 type（首建，调用方保证）。没有变化返回 null；有变化发 LOT_LEVEL（首建发 FACILITY_BUILT）。
 */
export function raiseLot(
  ctx: Ctx,
  lot: LotId,
  cause: Cause,
  type: FacilityType | null = null,
): { from: LotLevel; to: LotLevel } | null {
  if (lot.startsWith('L')) {
    const l = ctx.s.lands[ctx.map.landIdx(lot)];
    if (!l) return null;
    const from = l.level;
    const cap = l.chain ? 1 : MAX_LEVEL;
    if (from >= cap) return null;
    l.level = (from + 1) as LotLevel;
    ctx.emit('LOT_LEVEL', { lot, from, to: l.level, cause });
    return { from, to: l.level };
  }
  if (lot.startsWith('F')) {
    const f = ctx.s.facilities[ctx.map.facilityIdx(lot)];
    if (!f) return null;
    const from = f.level;
    if (from === 0) {
      if (type === null) return null;
      f.level = 1;
      f.type = type;
      ctx.emit('FACILITY_BUILT', { lot: f.id, facility: type, seat: cause.by });
      return { from, to: 1 };
    }
    const to = facilityLevelAfter(from, 1, f.type);
    if (to === from) return null;
    f.level = to;
    ctx.emit('LOT_LEVEL', { lot, from, to, cause });
    return { from, to };
  }
  return null;
}

// ───────────────────────── 路面物件 ─────────────────────────

/** 物件种类 → 道具号（回共享库存的那几种） */
export const OBJECT_ITEM: Readonly<Record<RoadObjectKind, number | null>> = Object.freeze({
  roadblock: ITEM.ROADBLOCK,
  mine: ITEM.MINE,
  bomb: ITEM.TIME_BOMB,
  gift: null,
  chest: null,
});

/** 物件离开地图（不发事件）：路障、地雷、定时炸弹回共享库存 */
export function takeObjectOff(ctx: Ctx, obj: RoadObject): void {
  ctx.s.objects = ctx.s.objects.filter((o) => o.id !== obj.id);
  const item = OBJECT_ITEM[obj.kind];
  if (item !== null) ctx.s.pools.items[item] = (ctx.s.pools.items[item] ?? 0) + 1;
}

/** 物件离开地图 → OBJECT_REMOVED */
export function removeObject(ctx: Ctx, obj: RoadObject, cause: Cause): void {
  takeObjectOff(ctx, obj);
  ctx.emit('OBJECT_REMOVED', { obj, cause });
}

/** 被害者对出卡者的敌意常数（×PI） */
export function hatePI(ctx: Ctx, key: 'HATE_HARM_PI' | 'HATE_DEMOLISH_PI' | 'HATE_STRIKE_VICTIM_PI'): number {
  return timesPI(ctx, CMB[key]);
}
