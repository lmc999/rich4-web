/**
 * 范围攻击（design/engine.md §10.4 飞弹 / 核子飞弹；docs/research/r_items.md §5.6–§5.7；g_villains.md §4）。
 *
 * strike：以目标格的世界坐标为中心、半宽 half 的方窗（geom/viewWindow 半开区间）：
 *   地产（住宅与设施，锚点在窗内；企业不受影响）按 lotMode 改写：0 拆一级（飞弹、炸弹 3×3）/ 1 清为无主（核弹、外星人）；
 *   路面物件全部清除（路障、地雷、地面炸弹回共享库存；礼物、宝箱消失）；未附身的神明（含恶犬）离场，搭档刷出；
 *   hospitalDays > 0 时，窗内棋盘上的玩家毁车、住院（施放者本人也在判定范围内），窗内的恶人送医院。
 * 敌意：地主对施放者 +30×PI，被炸的人对施放者 +90×PI。
 * 事件：STRIKE（携带地产与物件的变化）→ GOD_LEFT / GOD_SPAWNED → RESEARCH_CANCELLED → 逐人 VEHICLE_DESTROYED、CONFINED。
 * 新闻 4（外星人：清为无主、伤人）与 20（台风：拆一级、不伤人）复用本函数（effects/news），以地产锚点为中心。
 */
import type { World } from '../../../data/maps/types';
import { CMB } from '../../../data/tables/combat';
import { ECON } from '../../../data/tables/economy';
import { inViewWindow } from '../../../geom/viewWindow';
import type { Ctx } from '../../core/ctx';
import { boardPlayers, boardVillains, tileWorld } from '../../decisions/targets';
import { applyConfinement } from '../../flow/confine';
import type { StrikeKind } from '../../types/events';
import type { ActorRef, Cause, LotId, SeatIndex, TileId } from '../../types/ids';
import {
  addHostility,
  announceResearch,
  destroyVehicle,
  type LotChange,
  mutateLot,
  takeObjectOff,
  timesPI,
} from '../common';
import { leaveGod } from '../gods/lifecycle';
import type { ItemEffect } from '../types';
import { usable } from '../types';
import { confineVillain } from '../villainState';

export interface StrikeSpec {
  kind: StrikeKind;
  center: TileId;
  half: number;
  lotMode: 0 | 1;
  /** 0 表示不伤人（台风） */
  hospitalDays: number;
  by: SeatIndex | null;
  cause: Cause;
  /** 不在棋盘上、但也要受伤的座位（炸弹携带者本人） */
  extraVictims?: readonly SeatIndex[];
  /** 方窗中心的世界坐标（新闻 4 / 20 以地产的锚点为中心）；缺省取 center 格的坐标 */
  world?: World;
}

export function strike(ctx: Ctx, spec: StrikeSpec): void {
  const s = ctx.s;
  const c = spec.world ?? tileWorld(ctx.map, spec.center);
  const inWin = (tile: TileId) => ctx.map.hasTile(tile) && inViewWindow(c, tileWorld(ctx.map, tile), spec.half);
  const pi = (n: number) => timesPI(ctx, n);

  // 地产
  const changes: LotChange[] = [];
  for (const lot of ctx.map.index.lotsInWindow(c, spec.half)) {
    if (lot.startsWith('C')) continue;
    const ch = mutateLot(ctx, lot, spec.lotMode, spec.cause, false);
    if (!ch) continue;
    changes.push(ch);
    if (ch.owner !== null) addHostility(ctx, ch.owner, spec.by, pi(CMB.HATE_DEMOLISH_PI));
  }
  // 物件
  for (const o of s.objects.slice()) if (inWin(o.node)) takeObjectOff(ctx, o);
  // 受害者（先收集，STRIKE 之后再逐个结算）
  const victims: SeatIndex[] = [];
  if (spec.hospitalDays > 0) {
    for (const p of boardPlayers(s)) if (inWin(p.node)) victims.push(p.seat);
    for (const seat of spec.extraVictims ?? []) if (!victims.includes(seat)) victims.push(seat);
  }
  const villains = spec.hospitalDays > 0 ? boardVillains(s).filter((v) => inWin(v.node)) : [];
  const gods = s.gods.filter((g) => g.where.t === 'road' && inWin(g.where.node));
  const actors: ActorRef[] = [
    ...victims.map((seat): ActorRef => ({ t: 'seat', seat })),
    ...villains.map((v): ActorRef => ({ t: 'villain', kind: v.kind })),
  ];
  const lots: LotId[] = changes.map((x) => x.lot);
  ctx.emit('STRIKE', { kind: spec.kind, center: spec.center, half: spec.half, lots, actors });
  for (const g of gods) leaveGod(ctx, g, 'struck');
  announceResearch(ctx, changes);
  for (const seat of victims) {
    const p = ctx.player(seat);
    if (!p.alive) continue;
    addHostility(ctx, seat, spec.by, pi(CMB.HATE_STRIKE_VICTIM_PI));
    destroyVehicle(ctx, seat);
    applyConfinement(ctx, seat, 'hospital', spec.hospitalDays, spec.cause);
  }
  for (const v of villains) confineVillain(ctx, v.kind, 'hospital', spec.cause);
}

function strikeItem(kind: 'missile' | 'nuke', half: number, lotMode: 0 | 1, item: 7 | 13): ItemEffect {
  return {
    consume: 'pool',
    menu: () => usable({ t: 'anyNode' }),
    check: (_s, em, _seat, t) =>
      t.t === 'node' && em.hasTile(t.node) ? null : { rule: 'INVALID_TARGET', msg: 'need a tile on the map' },
    apply(ctx, seat, t) {
      if (t.t !== 'node') return;
      strike(ctx, {
        kind,
        center: t.node,
        half,
        lotMode,
        hospitalDays: CMB.STRIKE_HOSPITAL_DAYS,
        by: seat,
        cause: { k: 'item', ref: item, by: seat },
      });
    },
  };
}

/** 7 飞弹：任意格，半宽 100，地产拆一级，窗内的人住院 3 天、毁车 */
export const missile: ItemEffect = strikeItem('missile', ECON.MISSILE_HALF, 0, 7);

/** 13 核子飞弹：任意格，半宽 220，地产清为无主，窗内的人（含施放者）住院 3 天、毁车 */
export const nuke: ItemEffect = strikeItem('nuke', ECON.NUKE_HALF, 1, 13);
