import { describe, expect, it } from 'vitest';
import { GAME_EVENT_TYPES, type GameEvent } from '../engine/types/events';
import { EVENT_BUDGET_MS, estimateAnimMs, eventBudgetMs, STEP_MS } from './pacing';

describe('pacing', () => {
  it('EVENT_BUDGET_MS 覆盖全部事件类型且没有多余键', () => {
    expect(Object.keys(EVENT_BUDGET_MS).sort()).toEqual([...GAME_EVENT_TYPES].sort());
  });

  it('architecture §5.9 的示例值', () => {
    expect(STEP_MS).toBe(180);
    expect(EVENT_BUDGET_MS.DICE_ROLLED).toBe(900);
    expect(EVENT_BUDGET_MS.TOLL_PAID).toBe(1100);
    expect(EVENT_BUDGET_MS.NEWS).toBe(3800);
    expect(EVENT_BUDGET_MS.LOTTERY_DRAW).toBe(4200);
    const move: GameEvent = { type: 'MOVE_SEGMENT', actor: { t: 'seat', seat: 0 }, path: [1, 2, 3, 4], remaining: 0 };
    expect(eventBudgetMs(move)).toBe(4 * 180 + 250);
  });

  it('MINIGAME_ENDED 按 mode 取值', () => {
    const base = { type: 'MINIGAME_ENDED', seat: 0, minigameId: 'penguin', score: 60 } as const;
    expect(eventBudgetMs({ ...base, mode: 'played', speechSlot: null })).toBeLessThan(
      eventBudgetMs({ ...base, mode: 'skipped', speechSlot: 1 }),
    );
  });

  it('estimateAnimMs 为各事件预算之和，空批为 0', () => {
    const events: GameEvent[] = [
      { type: 'DICE_ROLLED', seat: 0, dice: [3], steps: 3, forced: false, diceCount: 1 },
      { type: 'MOVE_SEGMENT', actor: { t: 'seat', seat: 0 }, path: [2, 3, 4], remaining: 0 },
      { type: 'SYNC', reason: 'flush' },
    ];
    expect(estimateAnimMs(events)).toBe(900 + 3 * 180 + 250);
    expect(estimateAnimMs([])).toBe(0);
  });
});
