/**
 * 交通工具与遥控骰子（design/engine.md §10.4；docs/research/r_items.md §5.5、§5.8、§5.12；g_arbitration.md §2.d）。
 *
 * 5 机车 / 6 汽车  装备：原交通工具（机车 / 汽车）退回背包（可以因此达到第 10 台），骰子数设为该交通工具上限；
 *                 已经是同一种或正开着工程车时不可用
 * 8 遥控骰子      选点数 1..6：本次强制只用 1 颗骰子走该步数，立即掷骰（终结 intent）；乌龟生效时不可用
 * 12 工程车       原交通工具退回背包，改为工程车、骰子 1 颗，持续 7 个自己的回合（含使用当回合，受困也计数）；
 *                 到期恢复原车（背包里还有才装备，否则步行）；已经在工程车模式不可用
 *                 落点拆房见 LAND 'tail'（PROGRAM：别人（或无主）已有建筑的地产清到 0 级）
 * 收起交通工具     真人回合菜单的 STOW_VEHICLE（原版道具欄右下角那一格，道具函数表第 14 项）：机车 / 汽车退回背包，
 *                 改回步行、1 颗骰子；不扣道具、不结束回合、不限次数；工程车不能收起。电脑从不收起
 */
import { CMB } from '../../../data/tables/combat';
import { ECON } from '../../../data/tables/economy';
import { VEHICLE_ITEM } from '../../../data/tables/setup';
import type { Ctx } from '../../core/ctx';
import { EngineRuleError } from '../../errors';
import { maxDice } from '../../rules/movement';
import type { DiceFace, SeatIndex, Vehicle } from '../../types/ids';
import type { PlayerState } from '../../types/state';
import { stowVehicle } from '../common';
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

/**
 * 能否收起身上的交通工具、改回步行：只有机车、汽车可以。原版真人打开道具欄时，模式字节为 1 / 2 才在右下角那一格
 * 画「机车 / 汽车 + 禁止圈」（Panel#11 图15 / 16）并把这一格登记为 14 号；工程车的模式字节是 0x1f 一类的值，这一格不出现。
 * @source v2.06 fcn.00446948 0x4469a7–0x4469e7（v3.11 0x447e24）
 */
export function canStowVehicle(p: Pick<PlayerState, 'vehicle'>): boolean {
  return p.vehicle === 'moto' || p.vehicle === 'car';
}

/**
 * 真人在回合菜单里收起交通工具（STOW_VEHICLE，非终结）：机车 / 汽车退回背包（同种最多 10 台，满了回共享库存），
 * 改回步行、1 颗骰子 → VEHICLE{walk,1,stowed}（stowed = 收回的那台）。不扣道具、不花点券、不结束回合、不限次数，
 * 也不看停留 / 乌龟；之后可以再用 5 / 6 号道具把车装回去。开局就骑车的人背包里没有车，照样能收起（那台车就是开局从库存
 * 扣掉的那台）。原版这一步只刷新外观、重画，不说台词（机车道具 0x445a77 会调台词函数 0x44d870），客户端据 stowed
 * 不弹「换乘」提示、不放音效，只记一行日志。
 * @source v2.06 道具函数表第 14 项 0x4467b1（指针在 0x473c31；v3.11 0x447c00）：模式 1 背包机车 +1、模式 2 背包汽车 +1，
 *   模式字节写 0、骰子数写 1，调 0x40b425 刷新外观、0x41cc56 重画，返回 1（0x445742；道具欄随即关闭 0x446b1d），
 *   其间没有 call 0x44d870；电脑挑道具只在 1–13 号里选（0x446b64–0x446baf），从不收起
 */
export function stowByHand(ctx: Ctx, seat: SeatIndex): void {
  const p = ctx.player(seat);
  if (!canStowVehicle(p)) {
    throw new EngineRuleError('NOT_USABLE', `cannot stow vehicle ${p.vehicle}`, { vehicle: p.vehicle });
  }
  stowVehicle(ctx, seat, true);
}

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
