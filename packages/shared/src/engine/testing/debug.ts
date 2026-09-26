/**
 * SYS_DEBUG 的构造助手（要求 config.debug=true；服务器 debug:act 只在 RICH4_TEST_MODE=1 时注册）。
 *
 *   engine.applyAction(state, dbg.forceNext('dice', 3, 4));   // 接下来两颗骰子为 3、4
 *   engine.applyAction(state, dbg.forceNext('fork', 1));      // 下一次岔路取候选下标 1
 *   engine.applyAction(state, dbg.teleport(0, 12, 11));       // 0 号座位放到 12 号格，来路 11（向 13 方向走）
 *
 * forceNext 的值按 purpose 解释：dice = 点数 1..6；fork / parachute 等 = 候选下标；deck = 卡号；
 * quota / market 等 = rand15 原始值 0..32767（见 core/random.ts）。
 */
import type { CardId, DateNum, ItemId, RandPurpose, SeatIndex, TileId } from '../types/ids';
import type { DebugOp, SystemAction } from '../types/intent';

export function sysDebug(op: DebugOp): SystemAction {
  return { type: 'SYS_DEBUG', op };
}

export const dbg = Object.freeze({
  forceNext(purpose: RandPurpose, ...values: number[]): SystemAction {
    return sysDebug({ op: 'forceNext', purpose, values });
  },
  setCash(seat: SeatIndex, cash: number, deposit: number | null = null): SystemAction {
    return sysDebug({ op: 'setCash', seat, cash, deposit });
  },
  setPoints(seat: SeatIndex, points: number): SystemAction {
    return sysDebug({ op: 'setPoints', seat, points });
  },
  teleport(seat: SeatIndex, node: TileId, prev?: TileId): SystemAction {
    return sysDebug(prev === undefined ? { op: 'teleport', seat, node } : { op: 'teleport', seat, node, prev });
  },
  give(seat: SeatIndex, cards: CardId[] = [], items: { item: ItemId; qty: number }[] = []): SystemAction {
    return sysDebug({ op: 'give', seat, cards, items });
  },
  setDate(date: DateNum): SystemAction {
    return sysDebug({ op: 'setDate', date });
  },
});
