/**
 * 放置与清障类道具（design/engine.md §10.4；docs/research/r_items.md §5.1–§5.4）。
 *
 * 1 机器娃娃  从脚下沿前进方向走 9 步（岔路随机，purpose 'fork'），清掉沿途格上的物件（路障、地雷、地面炸弹回库存；
 *            礼物、宝箱消失）与未附身的神明（含恶犬，离场后搭档刷出）；不影响玩家、恶人、乞丐与附身物。用完回库存
 * 2 路障 / 3 地雷 / 4 定时炸弹  放到范围内的空道路格（无人、无物件、无神明、非禁放位、非关押格），放置者记在 placedBy；
 *            道具从背包移到地图上（共享库存不变，拆除或触发后才回库存）
 */
import { ECON } from '../../../data/tables/economy';
import type { Ctx } from '../../core/ctx';
import { nextObjectId } from '../../core/ids';
import { emptyRoadTilesInRange } from '../../decisions/targets';
import { nextTile } from '../../rules/movement';
import type { SeatIndex, TileId } from '../../types/ids';
import type { RoadObject, RoadObjectKind } from '../../types/state';
import { takeObjectOff } from '../common';
import { leaveGod } from '../gods/lifecycle';
import type { ItemEffect } from '../types';
import { usable, usableIf } from '../types';

/** 娃娃的路径：从 seat 的位置沿前进方向走 steps 步 */
function dollPath(ctx: Ctx, seat: SeatIndex, steps: number): TileId[] {
  const p = ctx.player(seat);
  let at = p.node;
  let prev = p.prevNode;
  const path: TileId[] = [];
  for (let i = 0; i < steps; i++) {
    const next = nextTile(ctx.map.index, at, prev, (n) => ctx.pick('fork', n));
    prev = at;
    at = next;
    path.push(at);
  }
  return path;
}

export const robotDoll: ItemEffect = {
  consume: 'pool',
  menu: () => usable({ t: 'none' }),
  apply(ctx, seat) {
    const path = dollPath(ctx, seat, ECON.DOLL_STEPS);
    const clearedObjects: number[] = [];
    for (const o of ctx.s.objects.slice()) {
      if (!path.includes(o.node)) continue;
      takeObjectOff(ctx, o);
      clearedObjects.push(o.id);
    }
    const gods = ctx.s.gods.filter((g) => g.where.t === 'road' && path.includes(g.where.node));
    ctx.emit('DOLL_WALK', { seat, path, clearedObjects, clearedGods: gods.map((g) => g.kind) });
    for (const g of gods) leaveGod(ctx, g, 'swept');
  },
};

function placer(kind: RoadObjectKind): ItemEffect {
  return {
    consume: 'placed',
    menu(s, em, seat) {
      const nodes = emptyRoadTilesInRange(s, em, seat);
      return usableIf({ t: 'node', nodes }, nodes.length === 0);
    },
    apply(ctx, seat, t) {
      if (t.t !== 'node') return;
      const obj: RoadObject = { id: nextObjectId(ctx.s), kind, node: t.node, placedBy: seat };
      ctx.s.objects.push(obj);
      ctx.emit('OBJECT_PLACED', { obj });
    },
  };
}

export const roadblock: ItemEffect = placer('roadblock');
export const mine: ItemEffect = placer('mine');
export const timeBomb: ItemEffect = placer('bomb');
