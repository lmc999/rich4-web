/**
 * 四大恶人（docs/research/g_villains.md 全文为规格；design/engine.md §7.8、§10.9）。
 *
 * 雇用（BAIL 决策的 HIRE，300 点券）：恶人从关押格出发（雇主 = 保释人），home = 这次放出来的地方；关押格本身就是
 *   同类保释格（落点码 4/5）时直接记下「已离开过门口」。放出来的同一轮、所有玩家行动完之后开始行动（ROOT 'villains'）。
 * 移动（MOVE mode 'villain'，每落一格调用 onNpcStep(格, stopped)；stopped = 最后一步或被路障拦下）：
 *   ① 格上的物件：路上的神明无效；恶犬（stopped）→ 狗离场、恶人住院，本趟结束；
 *      礼物 / 宝箱：小偷（未梦游）每一步都拿（雇主按库存随机得一件道具 / 点券 +500）；
 *      路障：小偷拆掉（回库存后给雇主道具 2）；其他恶人路障回库存、当场停下（按 stopped 继续做 ② ③）；
 *      地雷：小偷拆掉给雇主道具 3；其他恶人只在 stopped 时爆炸（地雷回库存、恶人住院，本趟结束）；
 *      定时炸弹：只有小偷拆（给雇主道具 4）。梦游中的小偷不捡物（也不被路障拦下）⚑
 *   ② 在棋盘上且未梦游：
 *      小偷 / 强盗（每一步）：本格玩家中排除雇主后座位最小的那一个（他已出局即乞丐就作罢）：
 *        小偷偷走一半点券（>>1）给雇主；强盗随机抢一张卡给雇主（只抢卡）
 *      强盗停在或路过银行格：每位在场、非雇主的玩家 trunc(存款 × 0.2)，先存款后现金，进雇主现金（可能破产）
 *      流氓 / 间谍（stopped）：住宅：地主存在且非雇主 → 流氓收 Σ(同地主同路段地价) × PI、间谍取走 lastToll；
 *        设施：流氓收地价 × PI、间谍取走 lastFee；企业（间谍）：董事长存在且非雇主 → 取走本月盈余（为负时雇主反付）；
 *        钱由地主先现金后存款支付（可能破产），进雇主存款
 *   ③ 回老家检查（每一步，梦游也查）：home 为监狱且本格是监狱保释格（或医院同理）→ 已离开过门口就送回关押
 *      （VILLAIN_HOME，本趟结束）；否则只记下「已离开过门口」
 * 恶人不缴过路费、不触发格子事件、不开 ATM、不理会乞丐，也不查被动卡。雇主出局时恶人被送回（flow/liquidation.ts）。
 */
import { CMB } from '../../../data/tables/combat';
import { GOD, ITEM, type ItemId } from '../../../data/tables/ids';
import { addU16, mul32 } from '../../../util/int32';
import type { Ctx } from '../../core/ctx';
import { isOnBoard } from '../../decisions/targets';
import { receiveItem, returnCardToDeck } from '../../rules/inventory';
import type { FrameOf } from '../../types/frames';
import type { SeatIndex, TileId, VillainKind } from '../../types/ids';
import type { GameState, VillainState } from '../../types/state';
import { gainCard, takeObjectOff, timesPI } from '../common';
import { leaveGod, roadGodAt } from '../gods/lifecycle';
import { drawGiftItem } from '../objects';

type MoveFrame = FrameOf<'MOVE'>;

export function villainOf(s: GameState, kind: VillainKind): VillainState {
  const v = s.villains.find((x) => x.kind === kind);
  if (!v) throw new RangeError(`no villain ${kind}`);
  return v;
}

/** 可以在 where（监狱 / 医院）雇用的恶人：关在那里（home = where 且不在棋盘上） */
export function hireableVillains(s: GameState, where: 'jail' | 'hospital'): VillainState[] {
  return s.villains.filter((v) => !v.onBoard && v.home === where);
}

/** 雇用：扣 300 点券，恶人从关押格出发 → VILLAIN_HIRED */
export function hireVillain(
  ctx: Ctx,
  by: SeatIndex,
  kind: VillainKind,
  where: 'jail' | 'hospital',
  cost: number,
): void {
  const v = villainOf(ctx.s, kind);
  const idx = ctx.map.index;
  const hold = where === 'jail' ? idx.jailHold : idx.hospitalHold;
  const p = ctx.player(by);
  p.points -= cost;
  v.onBoard = true;
  v.home = where;
  v.node = hold;
  v.prevNode = hold;
  v.homeNode = hold;
  // 关押格本身就是同类保释格（落点码 4/5）时，放出来就算离开过门口（g_villains §1）
  v.leftHome = idx.tile(hold).kind === where;
  v.employer = by;
  v.st = { jail: 0, hospital: 0, hibernate: 0, sleepwalk: 0, stay: 0, tortoise: 0 };
  ctx.emit('VILLAIN_HIRED', { by, kind, cost });
}

/** 送回关押（回老家）：清掉雇主与计时器 → VILLAIN_HOME */
function sendHome(ctx: Ctx, v: VillainState): void {
  const hold = v.home === 'jail' ? ctx.map.index.jailHold : ctx.map.index.hospitalHold;
  v.onBoard = false;
  v.node = hold;
  v.prevNode = hold;
  v.homeNode = hold;
  v.leftHome = false;
  v.employer = null;
  v.st = { jail: 0, hospital: 0, hibernate: 0, sleepwalk: 0, stay: 0, tortoise: 0 };
  ctx.emit('VILLAIN_HOME', { kind: v.kind });
}

/** 恶人被恶犬、地雷送医院（本趟结束） */
function sendToHospital(ctx: Ctx, v: VillainState, cause: 'dog' | 'object'): void {
  const hold = ctx.map.index.hospitalHold;
  v.onBoard = false;
  v.home = 'hospital';
  v.node = hold;
  v.prevNode = hold;
  v.homeNode = hold;
  v.leftHome = false;
  v.employer = null;
  v.st = { jail: 0, hospital: 0, hibernate: 0, sleepwalk: 0, stay: 0, tortoise: 0 };
  ctx.emit('CONFINED', {
    actor: { t: 'villain', kind: v.kind },
    where: 'hospital',
    days: 0,
    total: 0,
    cause: cause === 'dog' ? { k: 'dog', ref: GOD.DOG, by: null } : { k: 'object', ref: 'mine', by: null },
  });
}

/** 本格玩家中排除雇主后座位最小的那一个；他是乞丐（已出局）时返回 null */
function victimAt(s: GameState, tile: TileId, employer: SeatIndex): SeatIndex | null {
  let lowest: { seat: SeatIndex; beggar: boolean } | null = null;
  const consider = (seat: SeatIndex, beggar: boolean) => {
    if (seat === employer) return;
    if (lowest === null || seat < lowest.seat) lowest = { seat, beggar };
  };
  for (const p of s.players) if (isOnBoard(p) && p.node === tile) consider(p.seat, false);
  for (const b of s.beggars) if (b.node === tile) consider(b.seat, true);
  const l = lowest as { seat: SeatIndex; beggar: boolean } | null;
  return l && !l.beggar ? l.seat : null;
}

/** 小偷把物件交给雇主：回库存后从库存发一件对应道具（库存为 0 或已满 9 个就不发） */
function thiefTakes(ctx: Ctx, v: VillainState, employer: SeatIndex, item: ItemId | null): void {
  const got = item === null ? 0 : receiveItem(ctx.s, employer, item, 1);
  if (item !== null && got > 0) ctx.emit('ITEM_GAINED', { seat: employer, item, qty: 1, source: 'villain' });
  ctx.emit('VILLAIN_ACTION', { kind: v.kind, employer, victim: null, what: 'stealObject', amount: 0 });
}

/**
 * 恶人走进一格后的结算。beforeEmit：发第一个事件前先公布已走的路段。
 * 返回 'end'（恶人被送医院 / 送回老家，本趟结束）或 'stop'（被路障拦下，按停下处理完本格后结束）或 'go'。
 */
export function onNpcStep(
  ctx: Ctx,
  f: MoveFrame,
  v: VillainState,
  tile: TileId,
  beforeEmit: () => void,
): 'end' | 'stop' | 'go' {
  const s = ctx.s;
  const employer = v.employer;
  if (employer === null) return 'end';
  let stopped = f.remaining === 0;
  const sleepwalk = v.st.sleepwalk !== 0;
  const isThief = v.kind === 'thief';
  let result: 'stop' | 'go' = 'go';

  // ① 物件（每格至多一样：路上的神或路面物件）
  const god = roadGodAt(s, tile);
  if (god !== null) {
    if (god.kind === GOD.DOG && stopped) {
      beforeEmit();
      leaveGod(ctx, god, 'bitten');
      sendToHospital(ctx, v, 'dog');
      return 'end';
    }
  } else {
    const obj = s.objects.find((o) => o.node === tile);
    if (obj && !(isThief && sleepwalk)) {
      switch (obj.kind) {
        case 'gift':
        case 'chest':
          if (isThief) {
            beforeEmit();
            takeObjectOff(ctx, obj);
            if (obj.kind === 'gift') thiefTakes(ctx, v, employer, drawGiftItem(ctx));
            else {
              const e = ctx.player(employer);
              e.points = addU16(e.points, CMB.THIEF_CHEST_POINTS, s.config.rules.intOverflow);
              ctx.emit('VILLAIN_ACTION', {
                kind: v.kind,
                employer,
                victim: null,
                what: 'stealObject',
                amount: CMB.THIEF_CHEST_POINTS,
              });
            }
          }
          break;
        case 'roadblock':
          beforeEmit();
          takeObjectOff(ctx, obj);
          if (isThief) thiefTakes(ctx, v, employer, ITEM.ROADBLOCK);
          else {
            ctx.emit('ROADBLOCK_HIT', { actor: { t: 'villain', kind: v.kind }, node: tile });
            f.remaining = 0;
            stopped = true;
            result = 'stop';
          }
          break;
        case 'mine':
          if (isThief) {
            beforeEmit();
            takeObjectOff(ctx, obj);
            thiefTakes(ctx, v, employer, ITEM.MINE);
          } else if (stopped) {
            beforeEmit();
            takeObjectOff(ctx, obj);
            ctx.emit('OBJECT_REMOVED', { obj, cause: { k: 'object', ref: 'mine', by: obj.placedBy } });
            sendToHospital(ctx, v, 'object');
            return 'end';
          }
          break;
        case 'bomb':
          if (isThief) {
            beforeEmit();
            takeObjectOff(ctx, obj);
            thiefTakes(ctx, v, employer, ITEM.TIME_BOMB);
          }
          break;
      }
    }
  }

  // ② 偷、抢、勒索（在棋盘上且未梦游）
  if (v.onBoard && !sleepwalk) {
    if (v.kind === 'thief' || v.kind === 'robber') {
      const victim = victimAt(s, tile, employer);
      if (victim !== null) {
        const q = ctx.player(victim);
        if (v.kind === 'thief') {
          const amt = q.points >> 1;
          if (amt > 0) {
            beforeEmit();
            q.points -= amt;
            const e = ctx.player(employer);
            e.points = addU16(e.points, amt, s.config.rules.intOverflow);
            ctx.emit('VILLAIN_ACTION', { kind: v.kind, employer, victim, what: 'stealPoints', amount: amt });
          }
        } else if (q.cards.length > 0) {
          beforeEmit();
          const slot = ctx.pick('steal', q.cards.length);
          const card = q.cards[slot]!;
          q.cards.splice(slot, 1);
          ctx.emit('CARD_LOST', { seat: victim, card, cause: 'stolen' });
          const e = ctx.s.players.find((x) => x.seat === employer);
          if (e?.alive) gainCard(ctx, employer, card, 'villain');
          else returnCardToDeck(s, card);
          ctx.emit('VILLAIN_ACTION', { kind: v.kind, employer, victim, what: 'stealCard', amount: 0 });
        }
      }
    }
    if (v.kind === 'robber' && ctx.map.index.tile(tile).kind === 'bank') {
      beforeEmit();
      let total = 0;
      for (const q of s.players) {
        if (!q.alive || q.seat === employer) continue;
        const amt = Math.trunc(q.deposit * CMB.ROBBER_BANK_RATE);
        if (amt <= 0) continue;
        const r = ctx.pay({ t: 'seat', seat: q.seat }, { t: 'seat', seat: employer }, amt, {
          order: 'depositFirst',
          reason: 'villain',
          accident: true,
          cause: { k: 'villain', ref: v.kind, by: employer },
        });
        total += r.paid;
      }
      ctx.emit('VILLAIN_ACTION', { kind: v.kind, employer, victim: null, what: 'robDeposit', amount: total });
    }
    if ((v.kind === 'thug' || v.kind === 'spy') && stopped) extortAt(ctx, v, employer, tile, beforeEmit);
  }

  // ③ 回老家检查（每一步，梦游也查）
  if (v.onBoard && ctx.map.index.tile(tile).kind === v.home) {
    if (v.leftHome) {
      beforeEmit();
      sendHome(ctx, v);
      return 'end';
    }
    v.leftHome = true;
  }
  return result;
}

/** 流氓收保护费 / 间谍取走过路费或企业盈余（只在停下的那一格） */
function extortAt(ctx: Ctx, v: VillainState, employer: SeatIndex, tile: TileId, beforeEmit: () => void): void {
  const s = ctx.s;
  const lot = ctx.map.lotOfTile(tile);
  if (lot === null) return;
  const cause = { k: 'villain', ref: v.kind, by: employer } as const;
  const collect = (owner: SeatIndex, amount: number, what: 'extort' | 'spyToll') => {
    if (amount <= 0) return;
    beforeEmit();
    const r = ctx.pay({ t: 'seat', seat: owner }, { t: 'seat', seat: employer }, amount, {
      credit: 'deposit',
      reason: 'villain',
      accident: true,
      cause,
    });
    ctx.emit('VILLAIN_ACTION', { kind: v.kind, employer, victim: owner, what, amount: r.paid });
  };
  if (lot.startsWith('L')) {
    const i = ctx.map.landIdx(lot);
    const land = s.lands[i];
    if (!land || land.owner === null || land.owner === employer) return;
    const owner = land.owner;
    if (v.kind === 'thug') {
      let sum = 0;
      for (const j of ctx.map.streetOf(i)) {
        const l = s.lands[j]!;
        if (l.owner === owner) sum += l.landPrice;
      }
      collect(owner, timesPI(ctx, sum), 'extort');
    } else collect(owner, land.lastToll, 'spyToll');
    return;
  }
  if (lot.startsWith('F')) {
    const fac = s.facilities[ctx.map.facilityIdx(lot)];
    if (!fac || fac.owner === null || fac.owner === employer) return;
    if (v.kind === 'thug')
      collect(fac.owner, mul32(fac.landPrice, s.econ.priceIndex, s.config.rules.intOverflow), 'extort');
    else collect(fac.owner, fac.lastFee, 'spyToll');
    return;
  }
  if (lot.startsWith('C') && v.kind === 'spy') {
    const c = s.companies[ctx.map.companyIdx(lot)];
    if (!c) return;
    const chairman = s.stocks[c.stock]?.chairman ?? null;
    if (chairman === null || chairman === employer) return;
    const amt = c.surplusMonth;
    if (amt === 0) return;
    beforeEmit();
    if (amt > 0) {
      ctx.pay({ t: 'company', company: c.id }, { t: 'seat', seat: employer }, amt, {
        credit: 'deposit',
        reason: 'villain',
        cause,
      });
    } else {
      // 盈余为负：雇主存款反而减少（先存款后现金，扣不出来即破产 ⚑）
      ctx.pay({ t: 'seat', seat: employer }, { t: 'company', company: c.id }, -amt, {
        order: 'depositFirst',
        reason: 'villain',
        cause,
      });
    }
    ctx.emit('VILLAIN_ACTION', { kind: v.kind, employer, victim: chairman, what: 'spySurplus', amount: amt });
  }
}
