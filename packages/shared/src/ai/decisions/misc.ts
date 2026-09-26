/**
 * 其余经济类决策（design/minigames-ai.md §9.7）：
 * - LOTTERY：现金 > 1000 → 买，号码 = 未售号码[rng%n]（@0x43169e）
 * - SUBSCRIBE_SHARES：n = min(max, trunc((现金 − trunc(开局资金 × 0.3) × PI) / 单价))；n ≤ 0 不买（@0x41d267 / 0x41d839）
 * - DISCARD_CARD：丢价格最低的一张，同价取靠前的槽（@0x44128f）
 */
import { cardDef } from '../../data/tables/cards';
import type { PlayerIntent } from '../../engine/types/index';
import type { DecisionForYou } from '../../view/types';
import { LOTTERY_MIN_CASH, SUBSCRIBE_RESERVE_PCT } from '../constants';
import type { AiContext } from '../types';
import type { AiView } from '../view';

export function lottery(v: AiView, d: DecisionForYou<'LOTTERY'>, ctx: AiContext): PlayerIntent {
  const free: number[] = [];
  d.options.sold.forEach((o, i) => {
    if (o === null) free.push(i);
  });
  if (v.me.cash <= LOTTERY_MIN_CASH || free.length === 0 || v.me.cash < d.options.price) return { type: 'SKIP' };
  return { type: 'LOTTERY_BUY', number: free[ctx.rng.mod(free.length)]! };
}

export function subscribe(v: AiView, d: DecisionForYou<'SUBSCRIBE_SHARES'>): PlayerIntent {
  const o = d.options;
  const reserve = Math.trunc((v.initialFund * SUBSCRIBE_RESERVE_PCT) / 100) * v.pi;
  const n = Math.min(o.max, Math.trunc((o.cash - reserve) / o.unitPrice));
  return n > 0 ? { type: 'SUBSCRIBE', shares: n } : { type: 'SKIP' };
}

export function discard(_v: AiView, d: DecisionForYou<'DISCARD_CARD'>): PlayerIntent {
  let best = d.options.hand[0];
  for (const h of d.options.hand) if (best === undefined || cardDef(h.card).price < cardDef(best.card).price) best = h;
  return best === undefined ? d.defaultIntent : { type: 'DISCARD', slot: best.slot };
}
