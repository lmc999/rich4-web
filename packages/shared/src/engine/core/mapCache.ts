/**
 * 引擎侧的地图索引补充（按 MapDef 引用用 WeakMap 缓存，纯函数、只读）。
 * MapIndex（data/maps/mapIndex.ts）提供格、邻接、街道、方窗；这里补上 state 数组下标与地块的对应关系。
 * state.lands / facilities / companies 的顺序分别与 lands / facilities / companies 相同（MapDef.lots 中的出现顺序）。
 */
import type { MapIndex } from '../../data/maps/mapIndex';
import type { CompanyDef, FacilityLot, LandLot, LotId, MapDef, TileId } from '../../data/maps/types';

export interface EngineMap {
  readonly index: MapIndex;
  readonly def: MapDef;
  readonly lands: readonly LandLot[];
  readonly facilities: readonly FacilityLot[];
  readonly companies: readonly CompanyDef[];
  /** 住宅地 LotId → state.lands 下标；不存在为 -1 */
  landIdx(id: LotId): number;
  facilityIdx(id: LotId): number;
  companyIdx(id: LotId): number;
  /** 同街（同名）住宅地的下标，含自己，按地图顺序 */
  streetOf(landIdx: number): readonly number[];
  /** 格所属的地块（TileDef.ref.lot）；无则 null */
  lotOfTile(tile: TileId): LotId | null;
  /** 按槽号顺序的邻格 */
  neighbors(tile: TileId): readonly TileId[];
  hasTile(tile: TileId): boolean;
}

const cache = new WeakMap<MapDef, EngineMap>();

export function engineMap(index: MapIndex): EngineMap {
  const def = index.def;
  const hit = cache.get(def);
  if (hit) return hit;

  const lands: LandLot[] = [];
  const facilities: FacilityLot[] = [];
  for (const l of def.lots) {
    if (l.kind === 'land') lands.push(l);
    else facilities.push(l);
  }
  const companies = def.companies.slice();
  const landPos = new Map<LotId, number>();
  lands.forEach((l, i) => {
    landPos.set(l.id, i);
  });
  const facilityPos = new Map<LotId, number>();
  facilities.forEach((l, i) => {
    facilityPos.set(l.id, i);
  });
  const companyPos = new Map<LotId, number>();
  companies.forEach((c, i) => {
    companyPos.set(c.id, i);
  });

  const byStreet = new Map<string, number[]>();
  lands.forEach((l, i) => {
    const list = byStreet.get(l.streetId);
    if (list) list.push(i);
    else byStreet.set(l.streetId, [i]);
  });
  const streets: (readonly number[])[] = lands.map((l) => Object.freeze(byStreet.get(l.streetId)!.slice()));

  const tileLot = new Map<TileId, LotId>();
  const neigh = new Map<TileId, readonly TileId[]>();
  for (const t of def.tiles) {
    if (t.ref?.lot !== undefined) tileLot.set(t.id, t.ref.lot);
    neigh.set(t.id, Object.freeze(t.links.map((l) => l.to)));
  }

  const em: EngineMap = {
    index,
    def,
    lands,
    facilities,
    companies,
    landIdx: (id) => landPos.get(id) ?? -1,
    facilityIdx: (id) => facilityPos.get(id) ?? -1,
    companyIdx: (id) => companyPos.get(id) ?? -1,
    streetOf: (i) => streets[i] ?? [],
    lotOfTile: (tile) => tileLot.get(tile) ?? null,
    neighbors: (tile) => neigh.get(tile) ?? [],
    hasTile: (tile) => neigh.has(tile),
  };
  Object.freeze(em);
  cache.set(def, em);
  return em;
}
