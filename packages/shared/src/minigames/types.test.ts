import { describe, expect, expectTypeOf, it } from 'vitest';
import type { MinigameId as DataMinigameId, MinigameParams as DataMinigameParams } from '../data/tables/ids';
import { MINIGAME_IDS as DATA_MINIGAME_IDS } from '../data/tables/ids';
import type { PendingMinigame } from '../engine/types/decision';
import {
  DEFAULT_MINIGAME_PARAMS,
  InputCode,
  type InputEvent,
  MINIGAME_BY_LANDING_CODE,
  MINIGAME_IDS,
  MINIGAME_TIMING,
  type MinigameId,
  type MinigameParams,
  type MinigameTicket,
  minigameDeadlineAt,
} from './types';

describe('小游戏契约', () => {
  it('与 data/engine 的同名类型一致', () => {
    expectTypeOf<MinigameId>().toEqualTypeOf<DataMinigameId>();
    expectTypeOf<MinigameParams>().toEqualTypeOf<DataMinigameParams>();
    expectTypeOf<PendingMinigame['minigameId']>().toEqualTypeOf<MinigameId>();
    expectTypeOf<MinigameTicket['params']>().toEqualTypeOf<PendingMinigame['params']>();
    expect(MINIGAME_IDS).toEqual(DATA_MINIGAME_IDS);
    expect(DEFAULT_MINIGAME_PARAMS).toEqual({ ruleset: 'exe311' });
  });

  it('计时参数（architecture §5.10）', () => {
    expect(MINIGAME_TIMING.penguin).toMatchObject({ tickMs: 100, introTicks: 10, playTicks: 150, scoreSanityMax: 188 });
    expect(MINIGAME_TIMING.balloon).toMatchObject({ tickMs: 100, introTicks: 5, playTicks: 150, maxTicks: 300 });
    expect(MINIGAME_TIMING.xicong).toMatchObject({ tickMs: 50, introTicks: 10, playTicks: 360, maxTicks: 420 });
    for (const id of MINIGAME_IDS) {
      const t = MINIGAME_TIMING[id];
      expect(t.maxTicks).toBeGreaterThanOrEqual(t.introTicks + t.playTicks);
    }
    expect(minigameDeadlineAt(1000, 'xicong')).toBe(1000 + 420 * 50 + 5000);
    expect(MINIGAME_BY_LANDING_CODE).toEqual({ 6: 'penguin', 7: 'balloon', 8: 'xicong' });
  });

  it('InputEvent 是 [tick, code, a, b?]', () => {
    const e: InputEvent = [3, InputCode.Click, 320, 240];
    const f: InputEvent = [0, InputCode.CursorX, 100];
    expect(e).toHaveLength(4);
    expect(f).toHaveLength(3);
    expectTypeOf<InputCode>().toEqualTypeOf<1 | 2 | 3>();
  });
});
