import { inViewWindow } from '../../geom/viewWindow';
import { DataError } from '../errors';
import { LANDING_HOSPITAL, LANDING_JAIL } from './kinds';
import type { AnyLot, LotId, MapDef, TileDef, TileId, World } from './types';

/**
 * 地图的只读索引（纯函数，按 MapDef 引用用 WeakMap 缓存）。
 * 返回的数组都是新副本，调用方可以随意修改。
 */
export interface MapIndex {
  def: MapDef;
  tile(id: TileId): TileDef;
  lot(id: LotId): AnyLot;
  /** 按槽号顺序去掉来路（prev）与 blocked 的出边；为空返回 []，由引擎决定掉头 */
  forwardCandidates(at: TileId, prev: TileId): TileId[];
  streetLots(streetId: string): LotId[];
  /** 住宅地、设施、企业中 world 锚点落在方窗内的（按 lots 再 companies 的顺序） */
  lotsInWindow(c: World, half: number): LotId[];
  /** 可随机放置物件、神明、礼物的格：排除 noItems 与关押格，按 id 升序 */
  placeableTiles(): TileId[];
  /** 落点码 4 的格（保释格） */
  jailGate: TileId;
  /** 落点码 5 的格（出院手续格） */
  hospitalGate: TileId;
  /** 监狱关押格（jail 地标的 holdTile，引擎的关押与释放以它为准） */
  jailHold: TileId;
  /** 医院关押格（hospital 地标的 holdTile） */
  hospitalHold: TileId;
}

const cache = new WeakMap<MapDef, MapIndex>();

function firstTileWithCode(def: MapDef, code: number): TileId {
  let best: TileId | null = null;
  for (const t of def.tiles) if (t.landingCode === code && (best === null || t.id < best)) best = t.id;
  if (best === null) throw new DataError('MAP_INVALID', `map ${def.id} has no tile with landing code ${code}`);
  return best;
}

function holdTileOf(def: MapDef, kind: 'jail' | 'hospital'): TileId {
  const m = def.landmarks.find((x) => x.kind === kind && x.holdTile !== undefined);
  if (m?.holdTile !== undefined) return m.holdTile;
  throw new DataError('MAP_INVALID', `map ${def.id} has no ${kind} hold tile`);
}

export function buildMapIndex(def: MapDef): MapIndex {
  const hit = cache.get(def);
  if (hit) return hit;

  const tiles = new Map<TileId, TileDef>();
  const forward = new Map<TileId, { to: TileId; blocked: boolean }[]>();
  for (const t of def.tiles) {
    tiles.set(t.id, t);
    forward.set(
      t.id,
      t.links.map((l) => ({ to: l.to, blocked: l.blocked })),
    );
  }
  const lots = new Map<LotId, AnyLot>();
  for (const l of def.lots) lots.set(l.id, l);
  for (const c of def.companies) lots.set(c.id, c);
  const streets = new Map<string, LotId[]>();
  for (const s of def.streets) streets.set(s.id, s.lots.slice());
  const windowLots: { id: LotId; world: World }[] = [...def.lots, ...def.companies].map((l) => ({
    id: l.id,
    world: l.world,
  }));
  const placeable = def.tiles
    .filter((t) => !t.noItems && t.holdFor === undefined)
    .map((t) => t.id)
    .sort((a, b) => a - b);

  const index: MapIndex = {
    def,
    tile(id) {
      const t = tiles.get(id);
      if (!t) throw new DataError('TILE_NOT_FOUND', `map ${def.id} has no tile ${id}`);
      return t;
    },
    lot(id) {
      const l = lots.get(id);
      if (!l) throw new DataError('LOT_NOT_FOUND', `map ${def.id} has no lot ${id}`);
      return l;
    },
    forwardCandidates(at, prev) {
      const links = forward.get(at);
      if (!links) throw new DataError('TILE_NOT_FOUND', `map ${def.id} has no tile ${at}`);
      const out: TileId[] = [];
      for (const l of links) if (l.to !== prev && !l.blocked) out.push(l.to);
      return out;
    },
    streetLots(streetId) {
      const s = streets.get(streetId);
      if (!s) throw new DataError('STREET_NOT_FOUND', `map ${def.id} has no street ${streetId}`);
      return s.slice();
    },
    lotsInWindow(c, half) {
      return windowLots.filter((l) => inViewWindow(c, l.world, half)).map((l) => l.id);
    },
    placeableTiles() {
      return placeable.slice();
    },
    jailGate: firstTileWithCode(def, LANDING_JAIL),
    hospitalGate: firstTileWithCode(def, LANDING_HOSPITAL),
    jailHold: holdTileOf(def, 'jail'),
    hospitalHold: holdTileOf(def, 'hospital'),
  };
  Object.freeze(index);
  cache.set(def, index);
  return index;
}
