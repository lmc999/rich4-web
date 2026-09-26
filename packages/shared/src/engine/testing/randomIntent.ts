/**
 * 从决策的 options 里均匀抽一个合法 intent（属性测试、fuzz、simulate --policy random 用）。
 * 使用独立的 xoshiro 流，不消耗引擎 RNG。覆盖 M1 的 TURN_MENU（掷骰颗数）、BUY_LAND、UPGRADE_LAND，
 * M4 的股票买卖、银行、设施、研究所、百货、乐透、认购、建设公司；
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

function half(n: number): number {
  return Math.max(1, Math.trunc(n / 2));
}

/** 当前决策的全部候选 intent（已实现的 kind 逐一枚举；其余只含 defaultIntent） */
export function candidateIntents(d: PendingDecision): PlayerIntent[] {
  const a = asAnyPending(d);
  switch (a.kind) {
    case 'TURN_MENU': {
      const o = a.options;
      const out: PlayerIntent[] =
        o.dice.locked !== null
          ? [{ type: 'ROLL' }]
          : [{ type: 'ROLL' }, ...o.dice.allowed.map((n): PlayerIntent => ({ type: 'ROLL', dice: n }))];
      if (o.menuActions.used < o.menuActions.limit) {
        for (const r of o.stock.rows) {
          if (r.maxBuy > 0) out.push({ type: 'STOCK_BUY', stock: r.idx, shares: half(r.maxBuy) });
          if (r.maxSell > 0) out.push({ type: 'STOCK_SELL', stock: r.idx, shares: r.maxSell });
        }
      }
      return out;
    }
    case 'BUY_LAND':
      return a.options.price <= a.options.cash ? [{ type: 'CONFIRM' }, { type: 'DECLINE' }] : [{ type: 'DECLINE' }];
    case 'UPGRADE_LAND':
      return a.options.cost <= a.options.cash ? [{ type: 'CONFIRM' }, { type: 'DECLINE' }] : [{ type: 'DECLINE' }];
    case 'BUY_FACILITY':
      return a.options.price <= a.options.cash ? [{ type: 'CONFIRM' }, { type: 'DECLINE' }] : [{ type: 'DECLINE' }];
    case 'UPGRADE_FACILITY':
      return a.options.cost <= a.options.cash ? [{ type: 'CONFIRM' }, { type: 'DECLINE' }] : [{ type: 'DECLINE' }];
    case 'BUILD_FACILITY':
      return [
        { type: 'DECLINE' },
        ...a.options.types.map((t): PlayerIntent => ({ type: 'BUILD_FACILITY', facility: t.type })),
      ];
    case 'FACILITY_TYPE':
      return a.options.types.map((t): PlayerIntent => ({ type: 'CHOOSE_FACILITY_TYPE', facility: t.type }));
    case 'RESEARCH':
      return [
        { type: 'SKIP' },
        ...a.options.projects.map((p): PlayerIntent => ({ type: 'RESEARCH', project: p.project })),
      ];
    case 'BANK_ATM': {
      const o = a.options;
      const out: PlayerIntent[] = [{ type: 'SKIP' }];
      if (o.cash > 0) {
        out.push({ type: 'ATM', op: 'deposit', amount: o.cash }, { type: 'ATM', op: 'deposit', amount: half(o.cash) });
      }
      if (o.canWithdraw && o.deposit > 0) {
        out.push(
          { type: 'ATM', op: 'withdraw', amount: o.deposit },
          { type: 'ATM', op: 'withdraw', amount: half(o.deposit) },
        );
      }
      return out;
    }
    case 'BANK_COUNTER': {
      const o = a.options;
      const out: PlayerIntent[] = [{ type: 'SKIP' }];
      if (o.loanBlocked === null && o.loanLimit > 0) {
        out.push({ type: 'LOAN', amount: o.loanLimit }, { type: 'LOAN', amount: half(o.loanLimit) });
      }
      if (o.repayMax > 0) out.push({ type: 'REPAY', amount: o.repayMax }, { type: 'REPAY', amount: half(o.repayMax) });
      if ((o.financeLimit ?? 0) > 0) out.push({ type: 'FINANCE', amount: o.financeLimit! });
      return out;
    }
    case 'SHOP': {
      const o = a.options;
      const out: PlayerIntent[] = [{ type: 'LEAVE' }];
      if (o.visit.remaining <= 0) return out;
      for (const r of o.shelf) if (r.buyable) out.push({ type: 'SHOP_BUY_CARD', shelfIdx: r.idx });
      for (const r of o.items) if (r.maxQty > 0) out.push({ type: 'SHOP_BUY_ITEM', item: r.item, qty: 1 });
      for (const r of o.sell.cards) out.push({ type: 'SHOP_SELL_CARD', slot: r.slot });
      for (const r of o.sell.items) out.push({ type: 'SHOP_SELL_ITEM', item: r.item, qty: r.count });
      return out;
    }
    case 'LOTTERY': {
      const out: PlayerIntent[] = [{ type: 'SKIP' }];
      a.options.sold.forEach((o, i) => {
        if (o === null && out.length < 4) out.push({ type: 'LOTTERY_BUY', number: i });
      });
      return out;
    }
    case 'SUBSCRIBE_SHARES':
      return [
        { type: 'SKIP' },
        { type: 'SUBSCRIBE', shares: a.options.max },
        { type: 'SUBSCRIBE', shares: half(a.options.max) },
      ];
    case 'CONSTRUCTION_PICK':
      return [
        ...(a.options.canSkip ? [{ type: 'SKIP' } as PlayerIntent] : []),
        ...a.options.lots.map((l): PlayerIntent => ({ type: 'PICK_LOT', lot: l.lot })),
      ];
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
