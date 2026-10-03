/**
 * 出局的共用环节（破产 BANKRUPT 与投降 SURRENDER 共用；design/engine.md §6.2、§7.10、§9.5；docs/research/r_property.md §9.4；
 * g_villains.md §4）。
 *
 * markOut      标记出局；作废乐透号码、撤下公布栏挂牌、清掉别人对他的敌意（状态变化随调用方随后的事件公布）
 * detachCombat 身上的炸弹放回所在格（格上已有东西或不可放置时回库存）⚑；附身的神明离场（搭档刷出）；解除同盟；
 *              他雇的恶人被强制送回（小偷、强盗回监狱，流氓、间谍回医院）
 * liquidate    股票按市价卖出（所得进公库）并重排董事长；名下住宅与设施变无主、等级保留、地契清零；卡片回牌堆、道具回库存；
 *              现金、存款、贷款、点券、状态清零 → LIQUIDATION；释放的地产 > 3 处时随机抽 3 处（purpose 'auction'）供拍卖
 * becomeBeggar 棋子留在原节点成为乞丐 → BECAME_BEGGAR
 */
import { CMB } from '../../data/tables/combat';
import { ITEM, ITEM_IDS, isPoolItem, VILLAIN_HOME } from '../../data/tables/ids';
import { VEHICLE_ITEM } from '../../data/tables/setup';
import type { Ctx } from '../core/ctx';
import { nextObjectId } from '../core/ids';
import { placeableTile } from '../decisions/targets';
import { breakAlliance } from '../effects/common';
import { attachedSlot, leaveGod } from '../effects/gods/lifecycle';
import { confineVillain } from '../effects/villainState';
import { emptyCounters } from '../rules/counters';
import { returnCardToDeck } from '../rules/inventory';
import { releaseLot } from '../rules/landMutation';
import { addMoney, zeroOutMoney } from '../rules/payment';
import { updateChairman } from '../rules/stock';
import type { Cause, LotId, SeatIndex, TileId } from '../types/ids';
import type { GameState } from '../types/state';

/** 标记出局（不发事件） */
export function markOut(ctx: Ctx, seat: SeatIndex, out: 'bankrupt' | 'surrender'): void {
  const s = ctx.s;
  const p = ctx.player(seat);
  p.alive = false;
  p.out = out;
  s.lottery.owners = s.lottery.owners.map((o) => (o === seat ? null : o));
  s.noticeBoard = s.noticeBoard.filter((l) => l.seller !== seat);
  for (const q of s.players) q.hostility[seat] = 0;
}

function tileHasObjectOrGod(s: GameState, tile: TileId): boolean {
  return s.objects.some((o) => o.node === tile) || s.gods.some((g) => g.where.t === 'road' && g.where.node === tile);
}

/** 出局者身上的炸弹、神明、同盟与他雇的恶人 */
export function detachCombat(ctx: Ctx, seat: SeatIndex, cause: Cause): void {
  const s = ctx.s;
  const p = ctx.player(seat);
  if (p.bomb !== null) {
    p.bomb = null;
    const tile = p.node;
    const ok =
      p.placed && ctx.map.hasTile(tile) && placeableTile(ctx.map.index.tile(tile)) && !tileHasObjectOrGod(s, tile);
    if (ok) {
      const obj = { id: nextObjectId(s), kind: 'bomb' as const, node: tile, placedBy: null };
      s.objects.push(obj);
      ctx.emit('OBJECT_PLACED', { obj });
    } else {
      s.pools.items[ITEM.TIME_BOMB] = (s.pools.items[ITEM.TIME_BOMB] ?? 0) + 1;
      ctx.emit('ITEM_LOST', { seat, item: ITEM.TIME_BOMB, qty: 1, cause: 'bankrupt' });
    }
  }
  // 炸弹先落地，搭档刷出时才会避开它
  const slot = attachedSlot(s, seat);
  if (slot !== null) leaveGod(ctx, slot, 'bankrupt');
  else p.god = null;
  breakAlliance(ctx, seat, 'bankrupt');
  // 雇主出局：他雇的恶人被强制送回（按种类：小偷、强盗回监狱，流氓、间谍回医院；g_villains §4）
  for (const v of s.villains) {
    if (v.onBoard && v.employer === seat) confineVillain(ctx, v.kind, VILLAIN_HOME[v.kind], cause);
  }
}

/** 清算：返回释放的地产与要拍卖的地产（> 3 处时随机抽 3 处，按抽中顺序） */
export function liquidate(ctx: Ctx, seat: SeatIndex): { lots: LotId[]; auctionLots: LotId[] } {
  const s = ctx.s;
  const p = ctx.player(seat);
  const stocks: number[] = [];
  s.stocks.forEach((st, i) => {
    const h = p.holdings[i];
    if (!h || h.shares <= 0) return;
    const value = Math.trunc((h.shares * st.priceCents) / 100);
    st.float += h.shares;
    s.econ.pool = addMoney(s, s.econ.pool, value);
    s.econ.ledger.minted += value;
    p.holdings[i] = { shares: 0, costCents: 0 };
    stocks.push(i);
  });
  const lots: LotId[] = [];
  for (const l of [...s.lands, ...s.facilities]) {
    if (l.owner !== seat) continue;
    releaseLot(l);
    lots.push(l.id);
  }
  for (const c of p.cards) returnCardToDeck(s, c);
  p.cards = [];
  for (const it of ITEM_IDS) {
    const n = p.items[it] ?? 0;
    if (n > 0 && isPoolItem(it)) s.pools.items[it] = (s.pools.items[it] ?? 0) + n;
    p.items[it] = 0;
  }
  const vehicleItem = VEHICLE_ITEM[p.vehicle];
  if (vehicleItem !== null) s.pools.items[vehicleItem] = (s.pools.items[vehicleItem] ?? 0) + 1;
  p.vehicle = 'walk';
  p.diceCount = 1;
  p.engineer = null;
  p.parked = null;
  zeroOutMoney(s, seat);
  p.loan = 0;
  p.loanDue = 0;
  p.finance = 0;
  p.points = 0;
  p.st = emptyCounters();
  p.returning = false;
  p.bankReject = 0;
  p.insuranceDays = 0;
  p.quota = p.quota.map(() => 0);
  // 释放的地产 > 3 处时随机抽 3 处依次拍卖（≤ 3 处一处都不拍；r_property §9.4）
  const auctionLots: LotId[] = [];
  if (lots.length > CMB.LIQUIDATION_AUCTIONS) {
    const pool = lots.slice();
    for (let i = 0; i < CMB.LIQUIDATION_AUCTIONS; i++) {
      const k = ctx.pick('auction', pool.length);
      auctionLots.push(pool[k]!);
      pool.splice(k, 1);
    }
  }
  ctx.emit('LIQUIDATION', { seat, stocks, lots, auctionLots: auctionLots.slice() });
  // 股票退回市场后重排董事长
  for (const i of stocks) {
    const ch = updateChairman(s, i);
    if (ch) ctx.emit('CHAIRMAN_CHANGED', ch);
  }
  return { lots, auctionLots };
}

/** 棋子留在原节点成为乞丐 */
export function becomeBeggar(ctx: Ctx, seat: SeatIndex): void {
  const p = ctx.player(seat);
  if (!p.placed) return;
  ctx.s.beggars.push({ seat, node: p.node });
  ctx.emit('BECAME_BEGGAR', { seat, node: p.node });
}
