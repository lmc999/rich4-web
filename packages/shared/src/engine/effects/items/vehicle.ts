/**
 * 交通工具与遥控骰子（design/engine.md §10.4；docs/research/r_items.md §5.5、§5.8、§5.12；g_arbitration.md §2.d）。
 *
 * 5 机车 / 6 汽车  装备：原交通工具（机车 / 汽车）退回背包（可以因此达到第 10 台），骰子数设为该交通工具上限；
 *                 已经是同一种时不可用。开着工程车时照样能用：直接顶掉工程车（剩余天数与到期要换回的座驾作废，
 *                 工程车不退还；开工程车时收进背包的车留在背包里）
 * 8 遥控骰子      选点数 1..6：本次强制只用 1 颗骰子走该步数，立即掷骰（终结 intent）；乌龟生效时不可用
 * 12 工程车       原交通工具退回背包，改为工程车、骰子 1 颗，持续 7 个自己的回合（含使用当回合，受困也计数）；
 *                 到期恢复原车（背包里还有才装备，骰子数恢复成开工程车之前的，否则步行）；已经在工程车模式不可用
 *                 落点拆房见 LAND 'tail'（PROGRAM：别人（或无主）已有建筑的地产清到 0 级）
 * 收起交通工具     真人回合菜单的 STOW_VEHICLE（原版道具欄右下角那一格，道具函数表第 14 项）：机车 / 汽车退回背包，
 *                 改回步行、1 颗骰子；不扣道具、不结束回合、不限次数；工程车不能收起。电脑从不收起
 * 梦游结束        wakeVehicle：装回梦游卡停放的座驾（PlayerState.parked，common.ts stowVehicle 'sleepwalk'）
 */
import { ECON } from '../../../data/tables/economy';
import { VEHICLE_ITEM } from '../../../data/tables/setup';
import type { Ctx } from '../../core/ctx';
import { EngineRuleError } from '../../errors';
import { maxDice } from '../../rules/movement';
import type { DiceFace, SeatIndex, Vehicle } from '../../types/ids';
import type { ParkedVehicle, PlayerState } from '../../types/state';
import { bagVehicle, stowVehicle } from '../common';
import type { ItemEffect } from '../types';
import { unusable, usable } from '../types';

/**
 * 机车 / 汽车道具：只在已经骑着同一种时不可用；身上的机车 / 汽车退回背包，开着工程车时直接顶掉（不退还、天数与到期要换回的
 * 座驾一并作废）。
 * @source exe v2.06 机车 0x4459e9（模式字节 +0x11 只比较 ==1 → 不可用、==2 → 背包汽车 +1，其余（步行、工程车 0x1f 一类的值）
 *   直接写 1、骰子 2，调 0x40b425 / 0x41cc56 后说道具台词 0x44d870、背包机车 −1）、汽车 0x445aa4（==2 不可用、==1 背包机车 +1，
 *   写 2、骰子 3）；v3.11 0x446e4a / 0x446f05 相同。工程车的天数就存在模式字节里，被覆盖即作废；到期要换回的座驾 +0x64
 *   只在工程车倒数 0x41c4a6（要求模式 & 3 == 3）时才读，之后再用工程车道具时重写，所以不会再起作用
 */
function equip(to: 'moto' | 'car'): ItemEffect {
  return {
    consume: 'placed',
    menu(s, _em, seat) {
      const p = s.players.find((x) => x.seat === seat)!;
      return p.vehicle === to ? unusable('alreadyEquipped') : usable({ t: 'none' });
    },
    apply(ctx, seat) {
      const p = ctx.player(seat);
      bagVehicle(ctx, seat, p.vehicle);
      p.vehicle = to;
      p.diceCount = maxDice(to);
      p.engineer = null;
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
  stowVehicle(ctx, seat, 'hand');
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
  /**
   * 原座驾退回背包，记下到期要换回的座驾与当时的骰子数，改为工程车、1 颗骰子。
   * @source exe v2.06 0x446583（模式 1 / 2 背包 +1，+0x64 / +0x65 = 原模式 / 原骰子数，模式写 0x1f、骰子写 1，0x4465f4–0x446613）；
   *   v3.11 0x4479d2
   */
  apply(ctx, seat) {
    const p = ctx.player(seat);
    const restore = p.vehicle === 'engineer' ? 'walk' : (p.vehicle as Exclude<Vehicle, 'engineer'>);
    const dice = p.diceCount;
    bagVehicle(ctx, seat, p.vehicle);
    p.vehicle = 'engineer';
    p.diceCount = 1;
    p.engineer = { days: ECON.ENGINEER_TURNS, restore, dice };
    ctx.emit('VEHICLE', { seat, vehicle: 'engineer', dice: 1 });
  },
};

/**
 * 回合开始（TURN_STARTED 之前）：工程车倒数；到 0 返回 true，由 restoreEngineer 在 TURN_STARTED 之后恢复原车。
 * 梦游期间工程车停放在 parked 里（engineer 为 null），不倒数——原版天数存在模式字节里，梦游时模式是 0（步行），
 * 倒数 0x41c4a6 要求模式 & 3 == 3
 */
export function tickEngineer(p: PlayerState): boolean {
  if (p.engineer === null) return false;
  const days = p.engineer.days - 1;
  p.engineer = { ...p.engineer, days: days > 0 ? days : 0 };
  return days <= 0;
}

/**
 * 工程车到期：恢复原车（背包里有才装备，背包 −1，骰子数恢复成开工程车之前的；否则步行、1 颗）→ VEHICLE{via:'expire'}。
 * 原版只刷新外观（0x40b425），不说台词、不出对话框，客户端不提示、不放音效。
 * @source exe v2.06 0x41c4a6–0x41c58c（模式 −4，天数位为 0 时按 +0x64 & 3 换回：1 / 2 要背包里有，模式 = +0x64、骰子 = +0x65
 *   （0x41c51d–0x41c52f），否则模式 0、骰子 1；之后只调 0x40b425）；v3.11 0x41cca3–0x41cd8c
 */
export function restoreEngineer(ctx: Ctx, seat: SeatIndex): void {
  const p = ctx.player(seat);
  if (p.engineer === null) return;
  const { restore, dice } = p.engineer;
  p.engineer = null;
  const item = VEHICLE_ITEM[restore];
  let to: Vehicle = 'walk';
  if (item !== null && (p.items[item] ?? 0) > 0) {
    p.items[item] = p.items[item]! - 1;
    to = restore;
  }
  p.vehicle = to;
  p.diceCount = to === 'walk' ? 1 : dice;
  ctx.emit('VEHICLE', { seat, vehicle: to, dice: p.diceCount, via: 'expire', from: 'engineer' });
}

/**
 * 梦游结束（回合开始时梦游计数 0x80 → 0，flow/turn.ts start；调用方已把停放记录 k 从 PlayerState.parked 取下、随
 * TURN_STARTED 公布）：装回梦游卡停放的座驾 → VEHICLE{via:'wake'}，返回装回的工程车是否本回合到期（到期由调用方接着
 * restoreEngineer）。
 * - 机车 / 汽车：背包里还有才装回（背包 −1，骰子数恢复成中卡时的），梦游期间被魔法屋 / 命运卖掉、被抢夺卡抢走、出局清算
 *   等原因不在了就仍是步行（不发事件）；
 * - 工程车：不看背包，连同停放时的剩余天数直接装回，并照常算本回合的一天——原版回合开始先装回、后倒数工程车，
 *   同一个回合里 0x41c1aa 在 0x41c4a6 之前；所以梦游的那几个回合不计入工程车的 7 个回合，醒来这一回合计入。
 * 原版只刷新外观（0x40b425），不说台词、不出对话框，客户端不提示、不放音效。
 * @source exe v2.06 0x41c1aa–0x41c27b（梦游计数 +0x37 带 0x80 时清 0；+0x66 & 3 为 1 / 2 时要求背包机车 / 汽车 ≠ 0、为 3 时
 *   直接装回：模式 = +0x66（含工程车天数）、骰子 = +0x67，模式 1 / 2 背包 −1；否则模式 0、骰子 1；调 0x40b425），
 *   整段在主阻碍计数为 0 时才执行（0x41c161，关押期间梦游暂停倒数）；v3.11 0x41c9a7–0x41ca77
 */
export function wakeVehicle(ctx: Ctx, seat: SeatIndex, k: ParkedVehicle): boolean {
  const p = ctx.player(seat);
  if (k.vehicle === 'engineer') {
    p.vehicle = 'engineer';
    p.diceCount = k.dice;
    p.engineer = k.engineer;
    const due = tickEngineer(p);
    ctx.emit('VEHICLE', { seat, vehicle: 'engineer', dice: p.diceCount, via: 'wake', from: 'walk' });
    return due;
  }
  const item = VEHICLE_ITEM[k.vehicle]!;
  if ((p.items[item] ?? 0) <= 0) return false;
  p.items[item] = p.items[item]! - 1;
  p.vehicle = k.vehicle;
  p.diceCount = k.dice;
  ctx.emit('VEHICLE', { seat, vehicle: k.vehicle, dice: p.diceCount, via: 'wake', from: 'walk' });
  return false;
}
