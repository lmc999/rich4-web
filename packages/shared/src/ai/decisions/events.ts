/**
 * 事件类的其余决策（design/minigames-ai.md §9.7）：
 * - BIRTHDAY_PICK（命运「生日」，托管时由 AI 代选）：从每个对手手里随机拿一张（电脑座位由引擎直接随机）
 * - DEATH_GOD_TARGET：AI 永不投降；托管代答时选总资产最高的对手（并列取座位靠前）
 * - MINIGAME：一律放弃（不玩分支）
 */
import type { PlayerIntent, SeatIndex } from '../../engine/types/index';
import type { DecisionForYou } from '../../view/types';
import type { AiContext } from '../types';
import type { AiView } from '../view';

export function birthdayPick(d: DecisionForYou<'BIRTHDAY_PICK'>, ctx: AiContext): PlayerIntent {
  const picks = d.options.victims
    .filter((v) => v.cards.length > 0)
    .map((v) => ({ from: v.seat, slot: v.cards[ctx.rng.mod(v.cards.length)]!.slot }));
  return { type: 'PICK_CARDS', picks };
}

export function deathGodTarget(v: AiView, d: DecisionForYou<'DEATH_GOD_TARGET'>): PlayerIntent {
  let best: SeatIndex | null = null;
  let max = 0;
  for (const s of d.options.candidates) {
    const w = v.netWorth(s);
    if (best === null || w > max) {
      best = s;
      max = w;
    }
  }
  return best === null ? d.defaultIntent : { type: 'DEATH_GOD_TARGET', target: best };
}
