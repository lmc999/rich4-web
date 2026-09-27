/**
 * 交通工具与遥控骰子（design/engine.md §10.4；docs/research/r_items.md §5.5、§5.8、§5.12；g_arbitration.md §2.d）。
 *
 * 5 机车 / 6 汽车  装备：原交通工具（机车 / 汽车）退回背包（可以因此达到第 10 台），骰子数设为该交通工具上限；
 *                 已经是同一种或正开着工程车时不可用
 * 8 遥控骰子      选点数 1..6：本次强制只用 1 颗骰子走该步数，立即掷骰（终结 intent）；乌龟生效时不可用
 * 12 工程车       原交通工具退回背包，改为工程车、骰子 1 颗，持续 7 个自己的回合（含使用当回合，受困也计数）；
 *                 到期恢复原车（背包里还有才装备，否则步行）；已经在工程车模式不可用
 *                 落点拆房见 LAND 'tail'（PROGRAM：别人（或无主）已有建筑的地产清到 0 级）
 */
import { CMB } from '../../../data/tables/combat';
import { ECON } from '../../../data/tables/economy';
import { VEHICLE_ITEM } from '../../../data/tables/setup';
import type { Ctx } from '../../core/ctx';
import { maxDice } from '../../rules/movement';
import type { DiceFace, SeatIndex, Vehicle } from '../../types/ids';
import type { PlayerState } from '../../types/state';
import type { ItemEffect } from '../types';
import { unusable, usable } from '../types';

/** 当前的机车 / 汽车退回背包（不超过 10 台；超出的回库存） */
function stowCurrent(ctx: Ctx, seat: SeatIndex): void {
  const p = ctx.player(seat);
  const item = VEHICLE_ITEM[p.vehicle];
  if (item === null) return;
  if ((p.items[item] ?? 0) < CMB.VEHICLE_BAG_MAX) p.items[item] = (p.items[item] ?? 0) + 1;
  else ctx.s.pools.items[item] = (ctx.s.pools.items[item] ?? 0) + 1;
}

function equip(to: 'moto' | 'car'): ItemEffect {
  return {
    consume: 'placed',
    menu(s, _em, seat) {
      const p = s.players.find((x) => x.seat === seat)!;
      return p.vehicle === to || p.vehicle === 'engineer' ? unusable('alreadyEquipped') : usable({ t: 'none' });
    },
    apply(ctx, seat) {
      stowCurrent(ctx, seat);
      const p = ctx.player(seat);
      p.vehicle = to;
      p.diceCount = maxDice(to);
      ctx.emit('VEHICLE', { seat, vehicle: to, dice: p.diceCount });
    },
  };
}

export const motorcycle: ItemEffect = equip('moto');
export const car: ItemEffect = equip('car');

const FACES: readonly DiceFace[] = [1, 2, 3, 4, 5, 6];

export const remoteDice: ItemEffect = {
  consume: 'pool',
  menu(s, _em, seat) {
    const p = s.players.find((x) => x.seat === seat)!;
    return p.st.tortoise !== 0
      ? unusable('tortoise', { t: 'dice', values: [] })
      : usable({ t: 'dice', values: FACES.slice() });
  },
  apply(ctx, seat, t) {
    if (t.t !== 'dice') return;
    ctx.player(seat).turn.forcedSteps = t.value;
  },
};

export const engineeringVehicle: ItemEffect = {
  consume: 'pool',
  menu(s, _em, seat) {
    const p = s.players.find((x) => x.seat === seat)!;
    return p.vehicle === 'engineer' ? unusable('alreadyEquipped') : usable({ t: 'none' });
  },
  apply(ctx, seat) {
    const p = ctx.player(seat);
    const restore = p.vehicle === 'engineer' ? 'walk' : (p.vehicle as Exclude<Vehicle, 'engineer'>);
    stowCurrent(ctx, seat);
    p.vehicle = 'engineer';
    p.diceCount = 1;
    p.engineer = { days: ECON.ENGINEER_TURNS, restore };
    ctx.emit('VEHICLE', { seat, vehicle: 'engineer', dice: 1 });
  },
};

/** 回合开始（TURN_STARTED 之前）：工程车倒数；到 0 返回 true，由 restoreEngineer 在 TURN_STARTED 之后恢复原车 */
export function tickEngineer(p: PlayerState): boolean {
  if (p.engineer === null) return false;
  const days = p.engineer.days - 1;
  p.engineer = { days: days > 0 ? days : 0, restore: p.engineer.restore };
  return days <= 0;
}

/** 工程车到期：恢复原车（背包里有才装备，否则步行）→ VEHICLE */
export function restoreEngineer(ctx: Ctx, seat: SeatIndex): void {
  const p = ctx.player(seat);
  if (p.engineer === null) return;
  const restore = p.engineer.restore;
  p.engineer = null;
  const item = VEHICLE_ITEM[restore];
  let to: Vehicle = 'walk';
  if (item !== null && (p.items[item] ?? 0) > 0) {
    p.items[item] = p.items[item]! - 1;
    to = restore;
  }
  p.vehicle = to;
  p.diceCount = maxDice(to);
  ctx.emit('VEHICLE', { seat, vehicle: to, dice: p.diceCount });
}
