/**
 * 从决策的 options 里均匀抽一个合法 intent（属性测试、fuzz、simulate --policy random 用）。
 * 使用独立的 xoshiro 流，不消耗引擎 RNG。M1 覆盖 TURN_MENU（掷骰颗数）、BUY_LAND、UPGRADE_LAND；
 * 其余 kind 退回 defaultIntent（它总是合法的），后续里程碑实现相应决策时在这里补上候选。
 */
import { seedFromHex, type XoshiroState, xoshiroInt } from '../../util/rng/xoshiro';
import { asAnyPending, type PendingDecision } from '../types/decision';
import type { GameAction, PlayerIntent } from '../types/intent';
import type { GameState } from '../types/state';

export interface IntentRng {
  /** 0..n-1 */
  int(n: number): number;
}

export function intentRng(seedHex: string): IntentRng {
  const st: XoshiroState = seedFromHex(seedHex);
  return { int: (n) => xoshiroInt(st, n) };
}

function choose<T>(rng: IntentRng, xs: readonly T[]): T {
  return xs[rng.int(xs.length)]!;
}

/** 当前决策的全部候选 intent（M1 范围内逐一枚举；其余只含 defaultIntent） */
export function candidateIntents(d: PendingDecision): PlayerIntent[] {
  const a = asAnyPending(d);
  switch (a.kind) {
    case 'TURN_MENU': {
      const o = a.options;
      if (o.dice.locked !== null) return [{ type: 'ROLL' }];
      return [{ type: 'ROLL' }, ...o.dice.allowed.map((n): PlayerIntent => ({ type: 'ROLL', dice: n }))];
    }
    case 'BUY_LAND':
      return a.options.price <= a.options.cash ? [{ type: 'CONFIRM' }, { type: 'DECLINE' }] : [{ type: 'DECLINE' }];
    case 'UPGRADE_LAND':
      return a.options.cost <= a.options.cash ? [{ type: 'CONFIRM' }, { type: 'DECLINE' }] : [{ type: 'DECLINE' }];
    default:
      return [d.defaultIntent];
  }
}

export function randomIntent(d: PendingDecision, rng: IntentRng): PlayerIntent {
  return choose(rng, candidateIntents(d));
}

/** 从当前待决策中随机挑一个（并发时也随机挑座位），生成合法的 GameAction；没有待决策返回 null */
export function randomAction(state: GameState, rng: IntentRng): GameAction | null {
  if (state.pending.length === 0) return null;
  const d = state.pending.length === 1 ? state.pending[0]! : choose(rng, state.pending);
  return { ...randomIntent(d, rng), seat: d.seat, decisionId: d.id } as GameAction;
}
