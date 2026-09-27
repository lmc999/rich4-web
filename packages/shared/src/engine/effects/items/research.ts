/**
 * 研究所产物（design/engine.md §10.4；docs/research/r_items.md §5.9–§5.11）。
 *
 * 9  机器工人  范围内一块地产 +1 级，不看归属（住宅普通 5 级 / 连锁店 1 级封顶；设施按类型封顶；0 级设施需附带类型）
 * 10 时光机    M7（联机语义见 design/engine.md §10.10）；本期在菜单里不可用
 * 11 传送机    被传送物：范围内的演员（含自己、恶人）、未附身的神明、路面物件、房屋（有主或有建筑的地产）；
 *             目的地：范围内的空道路格（人物、神明、物件）或同类空地（房屋：连同地主、等级、类型、地契一起搬）⚑范围；
 *             被传送者不触发落点、过路费、炸弹倒数；对自己使用则本回合视为已掷骰（终结 intent）
 */
import { FACILITY_CAPS } from '../../../data/tables/facilities';
import type { EngineMap } from '../../core/mapCache';
import {
  actorsInRange,
  centerOf,
  emptyRoadTilesInRange,
  inRange,
  isFacilityLot,
  isLandLot,
  propertyLotsInRange,
  tileWorld,
} from '../../decisions/targets';
import { EngineInvariantError } from '../../errors';
import type { TeleportSource } from '../../types/decision';
import type { LotId, SeatIndex, TileId } from '../../types/ids';
import type { GameState } from '../../types/state';
import { raiseLot } from '../common';
import type { ItemEffect } from '../types';
import { unusable, usableIf } from '../types';

/** 还能 +1 级的地产（0 级设施也算，需附带类型） */
function raisable(s: GameState, em: EngineMap, lot: LotId): boolean {
  if (isLandLot(lot)) {
    const l = s.lands[em.landIdx(lot)]!;
    return l.level < (l.chain ? 1 : 5);
  }
  const f = s.facilities[em.facilityIdx(lot)]!;
  return f.level === 0 || f.level < FACILITY_CAPS[f.type];
}

export const robotWorker: ItemEffect = {
  consume: 'pool',
  menu(s, em, seat) {
    const lots = propertyLotsInRange(s, em, seat).filter((l) => raisable(s, em, l));
    const needType = lots.filter((l) => isFacilityLot(l) && s.facilities[em.facilityIdx(l)]!.level === 0);
    return usableIf({ t: 'lot', lots, needType }, lots.length === 0);
  },
  apply(ctx, seat, t) {
    if (t.t !== 'lot') return;
    raiseLot(ctx, t.lot, { k: 'item', ref: 9, by: seat }, t.facility);
  },
};

export const timeMachine: ItemEffect = {
  consume: 'pool',
  menu: () => unusable('noAnchor'),
  apply() {
    // TODO(M7)：恢复锚点世界（rng 与决策 id 不回退）→ TIME_REWOUND + SYNC
    throw new EngineInvariantError('NOT_IMPLEMENTED', 'time machine (M7)');
  },
};

/** 房屋（有东西可搬的地产）与同类空地 */
function houseSources(s: GameState, em: EngineMap, seat: SeatIndex): { houses: LotId[]; empty: LotId[] } {
  const houses: LotId[] = [];
  const empty: LotId[] = [];
  for (const lot of propertyLotsInRange(s, em, seat)) {
    const l = isLandLot(lot) ? s.lands[em.landIdx(lot)]! : s.facilities[em.facilityIdx(lot)]!;
    if (l.owner !== null || l.level > 0) houses.push(lot);
    else empty.push(lot);
  }
  return { houses, empty };
}

export function teleportCandidates(s: GameState, em: EngineMap, seat: SeatIndex) {
  const c = centerOf(s, em, seat);
  const sources: TeleportSource[] = actorsInRange(s, em, seat, { self: true, others: true, villains: true }).map(
    (actor) => ({ k: 'actor', actor }),
  );
  for (const g of s.gods) {
    if (g.where.t === 'road' && inRange(s, c, tileWorld(em, g.where.node))) sources.push({ k: 'god', slot: g.slot });
  }
  for (const o of s.objects) if (inRange(s, c, tileWorld(em, o.node))) sources.push({ k: 'object', object: o.id });
  const { houses, empty } = houseSources(s, em, seat);
  for (const lot of houses) {
    if (empty.some((e) => e[0] === lot[0])) sources.push({ k: 'house', lot });
  }
  const roads = emptyRoadTilesInRange(s, em, seat);
  return { sources: roads.length > 0 ? sources : sources.filter((x) => x.k === 'house'), roads, lands: empty };
}

/** 搬到 dest 后的来路：保持原来路（若与目的地相邻），否则取第一个邻格 */
function prevAt(em: EngineMap, dest: TileId, prev: TileId): TileId {
  const nb = em.neighbors(dest);
  return nb.includes(prev) ? prev : (nb[0] ?? dest);
}

export const teleporter: ItemEffect = {
  consume: 'pool',
  menu(s, em, seat) {
    const c = teleportCandidates(s, em, seat);
    return usableIf({ t: 'teleport', sources: c.sources, roads: c.roads, lands: c.lands }, c.sources.length === 0);
  },
  apply(ctx, seat, t) {
    if (t.t !== 'teleport') return;
    const s = ctx.s;
    const src = t.source;
    const dest = t.dest;
    if (dest.k === 'road') {
      const node = dest.node;
      if (src.k === 'actor') {
        const a = src.actor;
        if (a.t === 'seat') {
          const p = ctx.player(a.seat);
          p.prevNode = prevAt(ctx.map, node, p.prevNode);
          p.node = node;
          if (a.seat === seat) p.turn.teleportedSelf = true;
        } else {
          const v = s.villains.find((x) => x.kind === a.kind)!;
          v.prevNode = prevAt(ctx.map, node, v.prevNode);
          v.node = node;
        }
      } else if (src.k === 'god') {
        const g = s.gods.find((x) => x.slot === src.slot)!;
        g.where = { t: 'road', node };
      } else if (src.k === 'object') {
        const o = s.objects.find((x) => x.id === src.object)!;
        o.node = node;
      }
    } else if (src.k === 'house') {
      moveHouse(ctx.s, ctx.map, src.lot, dest.lot);
    }
    ctx.emit('TELEPORTED', { by: seat, source: src, dest });
  },
};

/** 房屋搬到同类空地：地主、等级、连锁店 / 类型、地契、研发一起搬，原地变无主空地 */
function moveHouse(s: GameState, em: EngineMap, from: LotId, to: LotId): void {
  if (isLandLot(from)) {
    const a = s.lands[em.landIdx(from)]!;
    const b = s.lands[em.landIdx(to)]!;
    b.owner = a.owner;
    b.level = a.level;
    b.chain = a.chain;
    b.tenure = a.tenure;
    a.owner = null;
    a.level = 0;
    a.chain = false;
    a.tenure = 0;
    return;
  }
  const a = s.facilities[em.facilityIdx(from)]!;
  const b = s.facilities[em.facilityIdx(to)]!;
  b.owner = a.owner;
  b.level = a.level;
  b.type = a.type;
  b.tenure = a.tenure;
  b.research = a.research;
  a.owner = null;
  a.level = 0;
  a.type = 'park';
  a.tenure = 0;
  a.research = null;
}
