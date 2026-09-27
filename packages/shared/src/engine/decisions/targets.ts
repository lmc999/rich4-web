/**
 * 卡片、道具的目标范围与候选（design/engine.md §9.3、§10.2、§10.4；architecture §7.2 视野）。
 *
 * - 范围：rules.targetRange='window' 时以使用者棋子的世界坐标为中心、半宽 rules.windowHalf 的方窗
 *   （geom/viewWindow，半开区间 −half ≤ d < half；DEV-04）；'global' 时全图。
 * - 「在棋盘上」的玩家：在场、已落地、没有主阻碍（坐牢、住院、住旅馆、消失时原版清掉了节点占位，不能被选中）。
 * - 空道路格：地图上的格、无禁放位（noItems）、不是关押格、无物件、无路上神明、无棋盘上的玩家与乞丐。
 * - targetMatches：提交的 UseTarget 是否落在候选里（引擎校验与 AI 自检共用）。
 * 纯函数：不改状态、不发事件。
 */
import type { TileDef, World } from '../../data/maps/types';
import { inViewWindow } from '../../geom/viewWindow';
import type { EngineMap } from '../core/mapCache';
import { mainBlockOf } from '../rules/counters';
import type { TargetCandidates, TeleportSource } from '../types/decision';
import type { ActorRef, LotId, SeatIndex, TileId } from '../types/ids';
import type { UseTarget } from '../types/intent';
import type { GameState, PlayerState, VillainState } from '../types/state';

/** 在棋盘上：在场、已落地、没有主阻碍（坐牢、住院、住旅馆、消失） */
export function isOnBoard(p: Pick<PlayerState, 'alive' | 'placed' | 'st'>): boolean {
  return p.alive && p.placed && mainBlockOf(p.st) === null;
}

export function tileWorld(em: EngineMap, tile: TileId): World {
  return em.index.tile(tile).world;
}

/** 目标范围的中心：使用者棋子所在格的世界坐标 */
export function centerOf(s: GameState, em: EngineMap, seat: SeatIndex): World {
  const p = s.players.find((x) => x.seat === seat);
  if (!p?.placed || !em.hasTile(p.node)) return { x: 0, y: 0 };
  return tileWorld(em, p.node);
}

/** 按 rules.targetRange 判断 p 是否在以 center 为中心的范围内 */
export function inRange(s: GameState, center: World, p: World): boolean {
  if (s.config.rules.targetRange === 'global') return true;
  return inViewWindow(center, p, s.config.rules.windowHalf);
}

export function tileInRange(s: GameState, em: EngineMap, center: World, tile: TileId): boolean {
  return em.hasTile(tile) && inRange(s, center, tileWorld(em, tile));
}

/** 棋盘上的玩家（按座位） */
export function boardPlayers(s: GameState): PlayerState[] {
  return s.players.filter(isOnBoard);
}

/** 棋盘上的恶人 */
export function boardVillains(s: GameState): VillainState[] {
  return s.villains.filter((v) => v.onBoard);
}

/** 范围内的对手座位（棋盘上、不含自己） */
export function opponentsInRange(s: GameState, em: EngineMap, seat: SeatIndex): SeatIndex[] {
  const c = centerOf(s, em, seat);
  return boardPlayers(s)
    .filter((p) => p.seat !== seat && tileInRange(s, em, c, p.node))
    .map((p) => p.seat);
}

export interface ActorFilter {
  self: boolean;
  others: boolean;
  villains: boolean;
}

/** 范围内的演员：玩家（按座位）在前，恶人（固定顺序）在后 */
export function actorsInRange(s: GameState, em: EngineMap, seat: SeatIndex, f: ActorFilter): ActorRef[] {
  const c = centerOf(s, em, seat);
  const out: ActorRef[] = [];
  for (const p of boardPlayers(s)) {
    if (p.seat === seat ? !f.self : !f.others) continue;
    if (tileInRange(s, em, c, p.node)) out.push({ t: 'seat', seat: p.seat });
  }
  if (f.villains) {
    for (const v of boardVillains(s)) if (tileInRange(s, em, c, v.node)) out.push({ t: 'villain', kind: v.kind });
  }
  return out;
}

export function sameActor(a: ActorRef, b: ActorRef): boolean {
  return a.t === 'seat' ? b.t === 'seat' && a.seat === b.seat : b.t === 'villain' && a.kind === b.kind;
}

/** 地产（住宅与设施，不含企业）的锚点世界坐标 */
export function lotWorld(em: EngineMap, lot: LotId): World {
  return em.index.lot(lot).world;
}

export function isLandLot(lot: LotId): boolean {
  return lot.startsWith('L');
}

export function isFacilityLot(lot: LotId): boolean {
  return lot.startsWith('F');
}

/** 范围内的住宅与设施（按地图 lots 顺序；企业不在内） */
export function propertyLotsInRange(s: GameState, em: EngineMap, seat: SeatIndex): LotId[] {
  const c = centerOf(s, em, seat);
  const out: LotId[] = [];
  for (const l of em.def.lots) if (inRange(s, c, l.world)) out.push(l.id);
  return out;
}

/** 使用者脚下的地产（住宅或设施；企业、非地产格返回 null） */
export function underfootLot(s: GameState, em: EngineMap, seat: SeatIndex): LotId | null {
  const p = s.players.find((x) => x.seat === seat);
  if (!p?.placed) return null;
  const lot = em.lotOfTile(p.node);
  return lot !== null && (isLandLot(lot) || isFacilityLot(lot)) ? lot : null;
}

/** 地产的等级与地主（住宅或设施） */
export function lotState(
  s: GameState,
  em: EngineMap,
  lot: LotId,
): { owner: SeatIndex | null; level: number; kind: 'land' | 'facility' } | null {
  if (isLandLot(lot)) {
    const l = s.lands[em.landIdx(lot)];
    return l ? { owner: l.owner, level: l.level, kind: 'land' } : null;
  }
  if (isFacilityLot(lot)) {
    const f = s.facilities[em.facilityIdx(lot)];
    return f ? { owner: f.owner, level: f.level, kind: 'facility' } : null;
  }
  return null;
}

/** 格上是否有东西（物件、路上神明、棋盘上的玩家或恶人、乞丐） */
export function tileOccupied(s: GameState, tile: TileId): boolean {
  if (s.objects.some((o) => o.node === tile)) return true;
  if (s.gods.some((g) => g.where.t === 'road' && g.where.node === tile)) return true;
  if (s.players.some((p) => isOnBoard(p) && p.node === tile)) return true;
  if (s.villains.some((v) => v.onBoard && v.node === tile)) return true;
  return s.beggars.some((b) => b.node === tile);
}

/** 可以放物件的格（不看占用）：非禁放位、非关押格 */
export function placeableTile(t: TileDef): boolean {
  return !t.noItems && t.holdFor === undefined;
}

/** 全图空道路格（按 id 升序） */
export function emptyRoadTiles(s: GameState, em: EngineMap): TileId[] {
  const out: TileId[] = [];
  for (const id of em.index.placeableTiles()) if (!tileOccupied(s, id)) out.push(id);
  return out;
}

/** 范围内的空道路格 */
export function emptyRoadTilesInRange(s: GameState, em: EngineMap, seat: SeatIndex): TileId[] {
  const c = centerOf(s, em, seat);
  return emptyRoadTiles(s, em).filter((t) => inRange(s, c, tileWorld(em, t)));
}

// ───────────────────────── 目标匹配 ─────────────────────────

function sameSource(x: TeleportSource, y: TeleportSource): boolean {
  if (x.k === 'actor') return y.k === 'actor' && sameActor(x.actor, y.actor);
  if (x.k === 'god') return y.k === 'god' && y.slot === x.slot;
  if (x.k === 'object') return y.k === 'object' && y.object === x.object;
  return y.k === 'house' && y.lot === x.lot;
}

/**
 * 提交的目标是否属于候选。anyNode 需要 hasTile 判定格存在（AI 侧可省略）。
 * lot 候选：needType 里的地块必须附带设施类型，其余必须为 null。
 */
export function targetMatches(c: TargetCandidates, t: UseTarget, hasTile?: (tile: TileId) => boolean): boolean {
  switch (c.t) {
    case 'none':
    case 'auto':
      return t.t === 'none';
    case 'seat':
      return t.t === 'seat' && c.seats.includes(t.seat);
    case 'actor':
      return t.t === 'actor' && c.actors.some((a) => sameActor(a, t.actor));
    case 'lot':
      if (t.t !== 'lot' || !c.lots.includes(t.lot)) return false;
      return c.needType.includes(t.lot) ? t.facility !== null : t.facility === null;
    case 'underfoot':
      if (t.t !== 'underfoot') return false;
      return c.types === null ? t.facility === null : t.facility !== null && c.types.includes(t.facility);
    case 'lotPair':
      return t.t === 'lotPair' && t.from === c.from && c.to.includes(t.to);
    case 'lotOrObject':
      if (t.t === 'lot') return t.facility === null && c.lots.includes(t.lot);
      return t.t === 'object' && c.objects.includes(t.object);
    case 'stock':
      return t.t === 'stock' && c.stocks.includes(t.stock);
    case 'node':
      return t.t === 'node' && c.nodes.includes(t.node);
    case 'anyNode':
      return t.t === 'node' && (hasTile === undefined || hasTile(t.node));
    case 'dice':
      return t.t === 'dice' && c.values.includes(t.value);
    case 'rob': {
      if (t.t !== 'rob') return false;
      const v = c.victims.find((x) => x.seat === t.seat);
      if (!v) return false;
      const take = t.take;
      return take.k === 'card' ? v.cards.some((x) => x.slot === take.slot) : v.items.some((x) => x.item === take.item);
    }
    case 'teleport': {
      if (t.t !== 'teleport') return false;
      const src = t.source;
      const okSrc = c.sources.some((x) => sameSource(x, src));
      if (!okSrc) return false;
      // 房屋只能搬到同类空地；人物、神明、物件只能搬到空道路
      if (src.k === 'house') {
        return t.dest.k === 'lot' && c.lands.includes(t.dest.lot) && t.dest.lot[0] === src.lot[0];
      }
      return t.dest.k === 'road' && c.roads.includes(t.dest.node);
    }
  }
}
