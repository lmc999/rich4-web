import { describe, expect, it } from 'vitest';
import { hashLog, isLogPrefix, isMinigameTicket, sameInput, spectatorTicket, ticksAt } from './session';
import { InputCode, type InputEvent, type MinigameTicket } from './types';

const A: InputEvent = [3, InputCode.Click, 10, 20];
const B: InputEvent = [4, InputCode.PickCell, 12];

const TICKET: MinigameTicket = {
  sessionId: 'mg-1-d9-0',
  decisionId: 'd9',
  seat: 2,
  minigameId: 'balloon',
  seed: 12345,
  params: { ruleset: 'exe311' },
  tickMs: 100,
  introTicks: 5,
  maxTicks: 300,
  startsAt: 1000,
  deadlineAt: 36000,
  role: 'player',
};

describe('minigame session helpers', () => {
  it('sameInput / isLogPrefix：第 4 项缺省与 undefined 相同', () => {
    expect(sameInput(B, [4, InputCode.PickCell, 12, undefined] as unknown as InputEvent)).toBe(true);
    expect(sameInput(A, [3, InputCode.Click, 10, 21])).toBe(false);
    expect(isLogPrefix([], [A])).toBe(true);
    expect(isLogPrefix([A], [A, B])).toBe(true);
    expect(isLogPrefix([A, B], [A])).toBe(false);
    expect(isLogPrefix([B], [A, B])).toBe(false);
  });

  it('hashLog 区分顺序与缺省项', () => {
    expect(hashLog([A, B])).not.toBe(hashLog([B, A]));
    expect(hashLog([B])).toBe(hashLog([[4, InputCode.PickCell, 12]]));
    expect(hashLog([])).toBe(hashLog([]));
    expect(hashLog([A]) >>> 0).toBe(hashLog([A]));
  });

  it('ticksAt 向下取整（开局前为负）', () => {
    expect(ticksAt(1000, 1000, 100)).toBe(0);
    expect(ticksAt(1099, 1000, 100)).toBe(0);
    expect(ticksAt(1100, 1000, 50)).toBe(2);
    expect(ticksAt(950, 1000, 100)).toBe(-1);
  });

  it('观战票据只改 role；形状检查', () => {
    const s = spectatorTicket(TICKET);
    expect(s).toEqual({ ...TICKET, role: 'spectator' });
    expect(TICKET.role).toBe('player');
    expect(isMinigameTicket(TICKET)).toBe(true);
    expect(isMinigameTicket({ ...TICKET, minigameId: 'fortune' })).toBe(false);
    expect(isMinigameTicket({ startsAt: 1 })).toBe(false);
    expect(isMinigameTicket(null)).toBe(false);
  });
});
