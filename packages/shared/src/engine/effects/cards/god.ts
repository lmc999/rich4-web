/**
 * 送神符、请神符（design/engine.md §10.2 #22/23；docs/research/r_deities.md §8；g_arbitration.md §2.k）。
 *
 * 22 送神符  自己身上：有定时炸弹就送走（回库存）；神明属于坏神白名单 {5,6,7,8,10,15} 时送走
 *           （rules.deathGodDispellable=false 时死神除外），搭档在远处刷出；什么都没送走则不可用（卡不消耗）
 * 23 请神符  自动选择范围内欧氏距离最近、可附身、未附身的神（恶犬、死神除外；平手先比 y 再比 x，再按槽号）
 *           → GOD 帧（挤走旧神 → 附身 → 发威）；范围内没有则不可用
 */
import { GODS, isRoadAttachable } from '../../../data/tables/gods';
import { GOD, ITEM } from '../../../data/tables/ids';
import type { EngineMap } from '../../core/mapCache';
import { centerOf, inRange, tileWorld } from '../../decisions/targets';
import type { SeatIndex } from '../../types/ids';
import type { GameState, GodSlot } from '../../types/state';
import { attachedSlot, leaveGod } from '../gods/lifecycle';
import type { CardEffect } from '../types';
import { unusable, usable } from '../types';

/** 身上的神能否被送神符送走 */
export function dispellableGod(s: GameState, seat: SeatIndex): GodSlot | null {
  const slot = attachedSlot(s, seat);
  if (slot === null || !GODS[slot.kind].dispellable) return null;
  if (slot.kind === GOD.DEATH && !s.config.rules.deathGodDispellable) return null;
  return slot;
}

export const dispelGod: CardEffect = {
  menu(s, _em, seat) {
    const p = s.players.find((x) => x.seat === seat)!;
    return p.bomb !== null || dispellableGod(s, seat) !== null ? usable({ t: 'none' }) : unusable('nothingToDispel');
  },
  apply(ctx, seat) {
    const p = ctx.player(seat);
    if (p.bomb !== null) {
      p.bomb = null;
      ctx.s.pools.items[ITEM.TIME_BOMB] = (ctx.s.pools.items[ITEM.TIME_BOMB] ?? 0) + 1;
      ctx.emit('ITEM_LOST', { seat, item: ITEM.TIME_BOMB, qty: 1, cause: 'used' });
    }
    const slot = dispellableGod(ctx.s, seat);
    if (slot !== null) leaveGod(ctx, slot, 'dispelled');
  },
};

/** 请神符的目标：范围内最近的可附身路上神明；没有返回 null */
export function nearestSummonable(s: GameState, em: EngineMap, seat: SeatIndex): GodSlot | null {
  const c = centerOf(s, em, seat);
  let best: GodSlot | null = null;
  let bestKey: [number, number, number, number] | null = null;
  for (const g of s.gods) {
    if (g.where.t !== 'road' || !isRoadAttachable(g.kind)) continue;
    const w = tileWorld(em, g.where.node);
    if (!inRange(s, c, w)) continue;
    const dx = w.x - c.x;
    const dy = w.y - c.y;
    const key: [number, number, number, number] = [dx * dx + dy * dy, w.y, w.x, g.slot];
    if (bestKey === null || lessThan(key, bestKey)) {
      best = g;
      bestKey = key;
    }
  }
  return best;
}

function lessThan(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}

export const summonGod: CardEffect = {
  menu(s, em, seat) {
    return nearestSummonable(s, em, seat) !== null ? usable({ t: 'auto' }) : unusable('noTarget', { t: 'auto' });
  },
  apply(ctx, seat) {
    const g = nearestSummonable(ctx.s, ctx.map, seat);
    if (g === null) return;
    ctx.push({ k: 'GOD', seat, slot: g.slot, stage: 'displace', cursor: 0 });
  },
};
