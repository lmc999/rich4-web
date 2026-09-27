/**
 * 路面物件与定时炸弹（design/engine.md §7.5–§7.6、§10.11；docs/research/g_arbitration.md §2.e、§2.l；r_items.md §5）。
 *
 * 停下才触发（LAND 'object' 阶段，每格至多一样东西：物件或路上的神）：
 *   地雷       移除（回库存）→ 毁车 → 住院 3 天（不走被动卡）→ 本次落点结束
 *   恶犬       步行：被咬住院 3 天，恶犬离场（土地公刷出），本次落点结束；有车：撞飞（离场），继续结算
 *   地面炸弹   身上没有炸弹时拾取（引信 38），物件变成挂在身上
 *   礼物       按共享库存加权随机得 1 个道具（1..8；库存空或该道具已满 9 个则没有），礼物消失
 *   宝箱       点券 +500，宝箱消失
 *   神明       压 GOD 帧（挤走旧神 → 附身 → 发威）
 * 路过触发（MOVE 每一步）：
 *   身上的炸弹 引信 −1：到 0 爆炸（PROGRAM：携带者毁车、住院 5 天、所在格地产降 1 级；manual3x3：半宽 100 方窗内
 *              的人与地产），移动终止；否则同格有别的玩家（在棋盘上、身上没有炸弹）时转给座位号最小者，引信不重置
 *   路障       拦停：移除（回库存）→ ROADBLOCK_HIT，剩余步数作废，照常结算该格
 * 摆放：开局随机摆放小财神、小福神、小穷神、小衰神、天使、恶犬、礼物、宝箱（互不重叠的空道路格，purpose 'place'）；
 *       每月 1 日礼物、宝箱先收回再各随机摆放 1 个（OBJECTS_RESPAWNED）。
 */
import { CMB } from '../../data/tables/combat';
import { ECON } from '../../data/tables/economy';
import { INITIAL_GODS } from '../../data/tables/gods';
import { GOD, ITEM, type ItemId } from '../../data/tables/ids';
import { addU16 } from '../../util/int32';
import type { Ctx } from '../core/ctx';
import { nextObjectId } from '../core/ids';
import type { EngineMap } from '../core/mapCache';
import { pick } from '../core/random';
import { boardPlayers, emptyRoadTiles, isOnBoard } from '../decisions/targets';
import { applyConfinement } from '../flow/confine';
import { receiveItem } from '../rules/inventory';
import type { FrameOf } from '../types/frames';
import type { SeatIndex, TileId } from '../types/ids';
import type { GameState, RoadObject, RoadObjectKind } from '../types/state';
import { announceResearch, destroyVehicle, mutateLot, removeObject, takeObjectOff } from './common';
import { leaveGod, roadGodAt } from './gods/lifecycle';
import { strike } from './items/weapons';

// ───────────────────────── 摆放 ─────────────────────────

/** 在空道路格上随机放一个物件（不发事件）；没有空格返回 null */
export function placeRandomObject(
  s: GameState,
  em: EngineMap,
  kind: RoadObjectKind,
  pickN: (n: number) => number,
): RoadObject | null {
  const free = emptyRoadTiles(s, em);
  if (free.length === 0) return null;
  const obj: RoadObject = { id: nextObjectId(s), kind, node: free[pickN(free.length)]!, placedBy: null };
  s.objects.push(obj);
  return obj;
}

/** 开局摆放：小财神、小福神、小穷神、小衰神、天使、恶犬，然后礼物、宝箱（purpose 'place'） */
export function placeInitialObjects(s: GameState, em: EngineMap): void {
  const pickN = (n: number) => pick(s, 'place', n);
  for (const kind of INITIAL_GODS) {
    const slot = s.gods.find((g) => g.kind === kind);
    const free = emptyRoadTiles(s, em);
    if (!slot || free.length === 0) continue;
    slot.where = { t: 'road', node: free[pickN(free.length)]! };
  }
  placeRandomObject(s, em, 'gift', pickN);
  placeRandomObject(s, em, 'chest', pickN);
}

/** 每月 1 日：收回礼物、宝箱，再各随机摆放 MONTHLY_GIFTS / MONTHLY_CHESTS 个 → OBJECTS_RESPAWNED */
export function respawnMonthlyObjects(ctx: Ctx): void {
  const s = ctx.s;
  s.objects = s.objects.filter((o) => o.kind !== 'gift' && o.kind !== 'chest');
  const placed: number[] = [];
  const pickN = (n: number) => ctx.pick('place', n);
  for (let i = 0; i < CMB.MONTHLY_GIFTS; i++) {
    const o = placeRandomObject(s, ctx.map, 'gift', pickN);
    if (o) placed.push(o.id);
  }
  for (let i = 0; i < CMB.MONTHLY_CHESTS; i++) {
    const o = placeRandomObject(s, ctx.map, 'chest', pickN);
    if (o) placed.push(o.id);
  }
  ctx.emit('OBJECTS_RESPAWNED', { objects: placed });
}

// ───────────────────────── 停下：物件结算 ─────────────────────────

/** 按共享库存加权抽 1..8 中的一种（库存全空返回 null；purpose 'gift'） */
export function drawGiftItem(ctx: Ctx): ItemId | null {
  const items = ctx.s.pools.items;
  let total = 0;
  for (let i = 1; i <= 8; i++) total += Math.max(0, items[i] ?? 0);
  if (total <= 0) return null;
  let r = ctx.pick('gift', total);
  for (let i = 1; i <= 8; i++) {
    r -= Math.max(0, items[i] ?? 0);
    if (r < 0) return i as ItemId;
  }
  return null;
}

/**
 * LAND 'object' 阶段：结算落点格上的物件或神。返回 'stop' 时本次落点到此结束（地雷、恶犬咬人），
 * 'god' 时已压 GOD 帧，'continue' 时照常进入格子事件。
 */
export function settleLandingObjects(ctx: Ctx, f: FrameOf<'LAND'>): 'stop' | 'god' | 'continue' {
  if (f.actor.t !== 'seat') return 'continue';
  const seat = f.actor.seat;
  const p = ctx.player(seat);
  if (!p.alive) return 'continue';
  const node = f.node;
  const god = roadGodAt(ctx.s, node);
  if (god !== null) {
    if (god.kind === GOD.DOG) {
      if (p.vehicle === 'walk') {
        ctx.emit('DOG_BITE', { seat, node });
        leaveGod(ctx, god, 'bitten');
        applyConfinement(ctx, seat, 'hospital', CMB.DOG_HOSPITAL_DAYS, { k: 'dog', ref: GOD.DOG, by: null });
        return 'stop';
      }
      ctx.emit('DOG_KNOCKED', { seat, node });
      leaveGod(ctx, god, 'struck');
      return 'continue';
    }
    if (god.kind === GOD.DEATH) return 'continue';
    ctx.push({ k: 'GOD', seat, slot: god.slot, stage: 'displace', cursor: 0 });
    return 'god';
  }
  const obj = ctx.s.objects.find((o) => o.node === node);
  if (!obj) return 'continue';
  const cause = { k: 'object', ref: obj.kind, by: obj.placedBy } as const;
  switch (obj.kind) {
    case 'mine':
      removeObject(ctx, obj, cause);
      destroyVehicle(ctx, seat);
      applyConfinement(ctx, seat, 'hospital', CMB.MINE_HOSPITAL_DAYS, cause);
      return 'stop';
    case 'bomb':
      if (p.bomb !== null) return 'continue';
      // 地面炸弹变成挂在身上（道具池守恒：地面 → 身上，库存不变）
      ctx.s.objects = ctx.s.objects.filter((o) => o.id !== obj.id);
      p.bomb = { fuse: ECON.BOMB_FUSE };
      ctx.emit('BOMB_ATTACHED', { seat, fuse: ECON.BOMB_FUSE });
      return 'continue';
    case 'gift': {
      takeObjectOff(ctx, obj);
      const item = drawGiftItem(ctx);
      const got = item === null ? 0 : receiveItem(ctx.s, seat, item, 1);
      if (item !== null && got > 0) ctx.emit('ITEM_GAINED', { seat, item, qty: 1, source: 'gift' });
      else ctx.emit('OBJECT_REMOVED', { obj, cause: { k: 'object', ref: 'gift', by: seat } });
      return 'continue';
    }
    case 'chest':
      takeObjectOff(ctx, obj);
      p.points = addU16(p.points, ECON.CHEST_POINTS, ctx.s.config.rules.intOverflow);
      ctx.emit('POINTS_GAINED', { seat, amount: ECON.CHEST_POINTS, source: 'chest' });
      return 'continue';
    case 'roadblock':
      // 路障在移动途中就拦停并移除；停在上面（例如传送、走回棋盘）不触发
      return 'continue';
  }
}

// ───────────────────────── 路过：炸弹与路障 ─────────────────────────

/** 同格可以接炸弹的玩家：在棋盘上、身上没有炸弹、座位号最小；没有返回 null */
export function bombReceiver(s: GameState, carrier: SeatIndex, tile: TileId): SeatIndex | null {
  for (const q of boardPlayers(s)) {
    if (q.seat !== carrier && q.node === tile && q.bomb === null) return q.seat;
  }
  return null;
}

/**
 * 携带者走一步后的炸弹倒数（已在 tile 上）。返回 'exploded' 时移动必须终止（携带者已住院）；
 * 'transferred' / 'ticked' / 'none' 时继续。调用方在事件前先公布已走的路段（beforeEmit）。
 */
export function tickCarriedBomb(
  ctx: Ctx,
  seat: SeatIndex,
  tile: TileId,
  beforeEmit: () => void,
): 'exploded' | 'transferred' | 'ticked' | 'none' {
  const p = ctx.player(seat);
  if (p.bomb === null) return 'none';
  const fuse = p.bomb.fuse - 1;
  if (fuse <= 0) {
    beforeEmit();
    explodeBomb(ctx, seat, tile);
    return 'exploded';
  }
  p.bomb = { fuse };
  const to = bombReceiver(ctx.s, seat, tile);
  if (to === null) return 'ticked';
  beforeEmit();
  p.bomb = null;
  ctx.player(to).bomb = { fuse };
  ctx.emit('BOMB_TRANSFERRED', { from: seat, to, fuse });
  return 'transferred';
}

/**
 * 身上的炸弹爆炸（炸弹回库存）。PROGRAM：只影响携带者（毁车、住院 5 天）与所在格那块地产（降 1 级）；
 * manual3x3：以所在格为中心、半宽 100 的方窗内所有人住院 5 天、毁车，地产降 1 级（STRIKE kind 'bomb3x3'）。
 */
export function explodeBomb(ctx: Ctx, seat: SeatIndex, tile: TileId): void {
  const s = ctx.s;
  const p = ctx.player(seat);
  p.bomb = null;
  s.pools.items[ITEM.TIME_BOMB] = (s.pools.items[ITEM.TIME_BOMB] ?? 0) + 1;
  const lot = ctx.map.lotOfTile(tile);
  const propertyLot = lot !== null && !lot.startsWith('C') ? lot : null;
  const cause = { k: 'bomb', ref: null, by: null } as const;
  if (s.config.rules.bombBlast === 'manual3x3') {
    ctx.emit('BOMB_EXPLODED', { seat, node: tile, lot: propertyLot });
    strike(ctx, {
      kind: 'bomb3x3',
      center: tile,
      half: ECON.MISSILE_HALF,
      lotMode: 0,
      hospitalDays: CMB.BOMB_HOSPITAL_DAYS,
      by: null,
      cause,
      extraVictims: isOnBoard(p) ? [] : [seat],
    });
    return;
  }
  const ch = propertyLot !== null ? mutateLot(ctx, propertyLot, 0, cause, false) : null;
  ctx.emit('BOMB_EXPLODED', { seat, node: tile, lot: propertyLot });
  // 研究所被拆到低于项目等级（或 0 级）时研发作废，与 STRIKE 路径一致补发 RESEARCH_CANCELLED
  if (ch !== null) announceResearch(ctx, [ch]);
  destroyVehicle(ctx, seat);
  applyConfinement(ctx, seat, 'hospital', CMB.BOMB_HOSPITAL_DAYS, cause);
}

/** 走到 tile 上的路障：移除（回库存）→ ROADBLOCK_HIT；没有路障返回 false */
export function hitRoadblock(ctx: Ctx, seat: SeatIndex, tile: TileId): boolean {
  const obj = ctx.s.objects.find((o) => o.node === tile && o.kind === 'roadblock');
  if (!obj) return false;
  takeObjectOff(ctx, obj);
  ctx.emit('ROADBLOCK_HIT', { actor: { t: 'seat', seat }, node: tile });
  return true;
}
