import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import { C2S_EVENTS, type C2SEventName, type C2SPayload } from './protocol';
import {
  C2S_SCHEMAS,
  HandshakeAuthSchema,
  RoomSettingsPatchSchema,
  RoomSettingsSchema,
  sanitizeChatText,
  sanitizeNickname,
  TrusteeSettingsSchema,
} from './schemas';

describe('C2S_SCHEMAS', () => {
  it('对全部 C2S 事件穷举', () => {
    expect(Object.keys(C2S_SCHEMAS).sort()).toEqual([...C2S_EVENTS].sort());
    expectTypeOf<keyof typeof C2S_SCHEMAS>().toEqualTypeOf<C2SEventName>();
    expectTypeOf<z.infer<(typeof C2S_SCHEMAS)['game:act']>>().toExtend<C2SPayload<'game:act'>>();
  });

  it('game:act：intent 走 PlayerIntentSchema，系统 action 与未知字段被拒绝', () => {
    const act = C2S_SCHEMAS['game:act'];
    expect(act.safeParse({ decisionId: 'd1', intent: { type: 'ROLL' }, clientActionId: 'a1' }).success).toBe(true);
    expect(act.safeParse({ decisionId: 'd1', intent: { type: 'ROLL', dice: 2 }, clientActionId: 'a1' }).success).toBe(
      true,
    );
    const bad = [
      { decisionId: 'd1', intent: { type: 'MINIGAME_RESULT', seat: 0, score: 999 }, clientActionId: 'a' },
      { decisionId: 'd1', intent: { type: 'ROLL' }, clientActionId: 'a', seat: 1 },
      { decisionId: 'd1', intent: { type: 'ROLL', dice: 4 }, clientActionId: 'a' },
      { decisionId: '', intent: { type: 'ROLL' }, clientActionId: 'a' },
      { decisionId: 'd1', intent: { type: 'SYS_DEBUG', op: { op: 'setCash' } }, clientActionId: 'a' },
    ];
    for (const p of bad) expect(act.safeParse(p).success).toBe(false);
  });

  it('空 payload 只接受 {}', () => {
    expect(C2S_SCHEMAS['lobby:list'].safeParse({}).success).toBe(true);
    expect(C2S_SCHEMAS['lobby:list'].safeParse({ x: 1 }).success).toBe(false);
  });

  it('房间号、座位、角色', () => {
    expect(C2S_SCHEMAS['room:join'].safeParse({ code: '482913', role: 'player' }).success).toBe(true);
    expect(C2S_SCHEMAS['room:join'].safeParse({ code: '082913', role: 'player' }).success).toBe(false);
    expect(C2S_SCHEMAS['room:takeSeat'].safeParse({ seat: 4 }).success).toBe(false);
    expect(C2S_SCHEMAS['room:selectCharacter'].safeParse({ characterId: 11 }).success).toBe(true);
    expect(C2S_SCHEMAS['room:selectCharacter'].safeParse({ characterId: 12 }).success).toBe(false);
    expect(C2S_SCHEMAS['room:kick'].safeParse({ target: { spectatorId: 'x' } }).success).toBe(true);
    expect(C2S_SCHEMAS['room:setSeatAi'].safeParse({ seat: 1, ai: { preset: 'cunning' } }).success).toBe(true);
    expect(C2S_SCHEMAS['room:setSeatAi'].safeParse({ seat: 1, ai: null }).success).toBe(true);
  });

  it('房间设置补丁：可以只改部分字段，game 与 rules 也可部分提交', () => {
    const p = RoomSettingsPatchSchema.safeParse({
      handVisibility: 'private',
      game: { mapId: 'test', timeLimitDays: 30, rules: { handFull: 'choose' } },
    });
    expect(p.success).toBe(true);
    expect(RoomSettingsPatchSchema.safeParse({ game: { startDate: 20000101 } }).success).toBe(false);
    expect(RoomSettingsPatchSchema.safeParse({ game: { debug: true } }).success).toBe(false);
    expect(RoomSettingsPatchSchema.safeParse({ reconnectGraceSec: 1 }).success).toBe(false);
    expect(RoomSettingsPatchSchema.safeParse({ maxSpectators: 21 }).success).toBe(false);
    expect(RoomSettingsSchema.shape.reconnectGraceSec.safeParse(0.3).success).toBe(true);
  });

  it('托管设置：比例必须是 10 的倍数', () => {
    const ok = { personality: 1, useCards: true, useItems: false, cashRatio: 30, stockRatio: 0 };
    expect(TrusteeSettingsSchema.safeParse(ok).success).toBe(true);
    expect(TrusteeSettingsSchema.safeParse({ ...ok, cashRatio: 35 }).success).toBe(false);
  });

  it('小游戏输入', () => {
    const s = C2S_SCHEMAS['game:minigameInput'];
    expect(s.safeParse({ sessionId: 's', seq: 0, events: [] }).success).toBe(true);
    expect(s.safeParse({ sessionId: 's', seq: 1, events: [[3, 1, 12]] }).success).toBe(true);
    expect(s.safeParse({ sessionId: 's', seq: 1, events: [[3, 2, 100, 200]] }).success).toBe(true);
    expect(s.safeParse({ sessionId: 's', seq: 1, events: [[3, 9, 100]] }).success).toBe(false);
    expect(s.safeParse({ sessionId: 's', seq: 1, events: [[1.5, 1, 1]] }).success).toBe(false);
  });
});

describe('握手与文本清洗', () => {
  it('握手 auth', () => {
    const ok = { token: 'abcdefghijklmnopqrstuv', nickname: '阿土伯', protocolVersion: 1, clientVersion: 'dev' };
    expect(HandshakeAuthSchema.safeParse(ok).success).toBe(true);
    expect(HandshakeAuthSchema.safeParse({ ...ok, token: 'short' }).success).toBe(false);
    expect(HandshakeAuthSchema.safeParse({ ...ok, extra: 1 }).success).toBe(true);
  });

  it('sanitizeNickname：去控制和零宽字符、合并空白、按字截断', () => {
    expect(sanitizeNickname('  阿​土\u0000伯  ')).toBe('阿土伯');
    expect(sanitizeNickname('a   b')).toBe('a b');
    expect(sanitizeNickname('一二三四五六七八九十甲乙丙')).toBe('一二三四五六七八九十甲乙');
    expect(sanitizeNickname('​‌')).toBe('');
  });

  it('sanitizeChatText：换行变空格，截到 200 字', () => {
    expect(sanitizeChatText('你好\n世界')).toBe('你好 世界');
    expect(Array.from(sanitizeChatText('字'.repeat(300))).length).toBe(200);
    expect(sanitizeChatText('‮​ ')).toBe('');
  });
});
