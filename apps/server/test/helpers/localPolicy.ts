/**
 * 本地最简策略（packages/shared/src/ai/basic.ts 的 BasicAiPolicy 尚未出现时的替身）：
 * 只处理 stubEngine 会出现的决策，其余一律 defaultIntent，保证对真实引擎也总是合法。
 * pickIntent 同时给 botClient.autoPlay 用。
 */
import type { AiPolicy } from '@rich4/shared/ai';
import type { PlayerIntent } from '@rich4/shared/engine';
import { asAnyDecision, type DecisionForYou } from '@rich4/shared/view';

/** rand01：[0,1) 的随机数（AI 用 ctx.rng 派生，bot 用自己的种子） */
export function pickIntent(d: DecisionForYou, rand01: () => number): PlayerIntent {
  const a = asAnyDecision(d);
  switch (a.kind) {
    case 'TURN_MENU':
      return { type: 'ROLL' };
    case 'BUY_LAND':
      return a.options.cash - a.options.price >= 1000 ? { type: 'CONFIRM' } : { type: 'DECLINE' };
    case 'UPGRADE_LAND':
      return a.options.cash - a.options.cost >= 3000 ? { type: 'CONFIRM' } : { type: 'DECLINE' };
    case 'AUCTION_BID': {
      const inc = a.options.increments[0];
      const price = a.options.leader === null ? a.options.start : a.options.price;
      if (inc !== undefined && a.options.cash - (price + inc) > 4000 && rand01() < 0.5) return { type: 'BID', inc };
      return { type: 'PASS' };
    }
    case 'MINIGAME':
      return { type: 'MINIGAME_DECLINE' };
    default:
      return d.defaultIntent;
  }
}

export const localPolicy: AiPolicy = Object.freeze({
  id: 'basic' as const,
  decide: (_view, d, ctx) => pickIntent(d, () => ctx.rng.next15() / 32768),
} satisfies AiPolicy);
