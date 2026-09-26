import { describe, expect, expectTypeOf, it } from 'vitest';
import { defaultGameConfig } from '../engine/types/config';
import type { DecisionTimingClass } from '../engine/types/decision';
import type { MinigameTicket } from '../minigames/types';
import { appError, ERROR_CODES, ERROR_MESSAGES_ZH, type ErrorCode, fail, isErrorCode, ok } from './errors';
import { CHAT_MAX_CHARS, CHAT_RATE, RATE_LIMITS, ROOM_CODE_RE, TOKEN_RE } from './limits';
import {
  C2S_EVENTS,
  type C2SAckData,
  type C2SPayload,
  type ClientToServerEvents,
  PROTOCOL_VERSION,
  S2C_EVENTS,
  type S2CPayload,
  type ServerToClientEvents,
  type YourDecision,
} from './protocol';
import { DEFAULT_ROOM_SETTINGS, defaultRoomSettings, IN_GAME_MUTABLE_SETTINGS, SOLO_ROOM_OVERRIDES } from './room';
import {
  AI_THINK_MS,
  DECISION_TIMEOUT_S,
  decisionTimeoutMs,
  MENU_CHAIN_MIN_S,
  MENU_TURN_CAP_S,
  NET_GRACE_MS,
  PRESET_SCALE,
  RELEASE_MIN_S,
  RESUME_MIN_S,
} from './timing';

describe('错误码', () => {
  it('每个 ErrorCode 都有中文默认文案', () => {
    expectTypeOf<keyof typeof ERROR_MESSAGES_ZH>().toEqualTypeOf<ErrorCode>();
    for (const c of ERROR_CODES) expect(ERROR_MESSAGES_ZH[c].length).toBeGreaterThan(0);
    expect(isErrorCode('STALE_DECISION')).toBe(true);
    expect(isErrorCode('NOPE')).toBe(false);
  });

  it('Result 构造', () => {
    expect(ok({ seq: 3 })).toEqual({ ok: true, data: { seq: 3 } });
    expect(fail('INVALID_ACTION', { rule: 'MENU_LIMIT' })).toEqual({
      ok: false,
      error: { code: 'INVALID_ACTION', message: ERROR_MESSAGES_ZH.INVALID_ACTION, details: { rule: 'MENU_LIMIT' } },
    });
    expect(appError('ROOM_FULL')).toEqual({ code: 'ROOM_FULL', message: '房间已满' });
  });
});

describe('计时（architecture §5.9）', () => {
  it('超时表覆盖除 minigame 外的全部计时类别', () => {
    expectTypeOf<keyof typeof DECISION_TIMEOUT_S>().toEqualTypeOf<Exclude<DecisionTimingClass, 'minigame'>>();
    expect(DECISION_TIMEOUT_S).toEqual({
      menu: 30,
      confirm: 15,
      pick: 20,
      shop: 30,
      bank: 20,
      auction: 15,
      lottery: 15,
    });
    expect(PRESET_SCALE).toEqual({ fast: 0.5, normal: 1, slow: 2, off: null });
    expect([NET_GRACE_MS, MENU_CHAIN_MIN_S, MENU_TURN_CAP_S, RESUME_MIN_S, RELEASE_MIN_S]).toEqual([800, 8, 90, 5, 10]);
    expect(AI_THINK_MS.normal).toEqual([400, 1200]);
  });

  it('decisionTimeoutMs 按档位缩放，off 不限时', () => {
    expect(decisionTimeoutMs('menu', 'normal')).toBe(30_000);
    expect(decisionTimeoutMs('confirm', 'fast')).toBe(7_500);
    expect(decisionTimeoutMs('pick', 'slow')).toBe(40_000);
    expect(decisionTimeoutMs('auction', 'off')).toBeNull();
  });
});

describe('限流与大小', () => {
  it('聊天 200 字、每 10 秒 5 条', () => {
    expect(CHAT_MAX_CHARS).toBe(200);
    expect(CHAT_RATE).toEqual({ count: 5, windowMs: 10_000 });
    expect(RATE_LIMITS['chat:send']).toMatchObject({ count: 5, perMs: 10_000 });
    expect(RATE_LIMITS['game:act']).toEqual({ count: 10, perMs: 1000, burst: 20 });
  });

  it('房间号与 token 格式', () => {
    expect(ROOM_CODE_RE.test('482913')).toBe(true);
    expect(ROOM_CODE_RE.test('082913')).toBe(false);
    expect(TOKEN_RE.test('AAAAAAAAAAAAAAAAAAAAAA')).toBe(true);
    expect(TOKEN_RE.test('short')).toBe(false);
  });
});

describe('房间设置（architecture §5.8）', () => {
  it('默认值', () => {
    expect(DEFAULT_ROOM_SETTINGS).toMatchObject({
      handVisibility: 'public',
      timerPreset: 'normal',
      timeoutPolicy: 'default',
      minigameSpectate: 'live',
      allowMinigameDecline: true,
      reconnectGraceSec: 15,
      maxSpectators: 10,
    });
    const s = defaultRoomSettings(defaultGameConfig('test'));
    expect(s.game.mapId).toBe('test');
    expect(s.game.initialFund).toBe(200000);
    expect(SOLO_ROOM_OVERRIDES).toEqual({ visibility: 'private', allowSpectators: false, timerPreset: 'off' });
    expect(IN_GAME_MUTABLE_SETTINGS).toEqual(['spectatorChat', 'allowSpectators']);
  });
});

describe('Socket.IO 事件表（architecture §5.8 最终清单）', () => {
  it('C2S / S2C 事件名穷举', () => {
    expectTypeOf<(typeof C2S_EVENTS)[number]>().toEqualTypeOf<keyof ClientToServerEvents>();
    expectTypeOf<(typeof S2C_EVENTS)[number]>().toEqualTypeOf<keyof ServerToClientEvents>();
    for (const e of ['game:minigameInput', 'game:minigameSubmit', 'debug:act', 'room:setSeatAi', 'game:autopilot']) {
      expect(C2S_EVENTS).toContain(e);
    }
    for (const e of ['game:minigameWatch', 'game:minigameFrames', 'game:pending', 'app:error']) {
      expect(S2C_EVENTS).toContain(e);
    }
    expect(C2S_EVENTS).not.toContain('room:assignSeat');
    expect(C2S_EVENTS.every((e) => /^[a-z]+:[a-z][A-Za-z]*$/.test(e))).toBe(true);
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('payload 与 ack 类型', () => {
    expectTypeOf<C2SPayload<'room:setSeatAi'>['ai']>().toEqualTypeOf<{
      preset: 'character' | 'gentle' | 'normal' | 'cunning';
      overrides?: Partial<import('../ai/types').AiTraits>;
    } | null>();
    expectTypeOf<C2SAckData<'game:act'>>().toEqualTypeOf<{ seq: number }>();
    expectTypeOf<C2SAckData<'game:minigameSubmit'>>().toEqualTypeOf<{ score: number }>();
    expectTypeOf<C2SPayload<'game:act'>>().not.toHaveProperty('seat');
    expectTypeOf<S2CPayload<'game:batch'>['yourDecision']>().toEqualTypeOf<YourDecision | undefined>();
    expectTypeOf<NonNullable<YourDecision['minigame']>>().toEqualTypeOf<MinigameTicket>();
  });
});
