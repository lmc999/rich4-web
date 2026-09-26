/**
 * 观战与聊天（architecture M5 验证；design/net.md §9、§11.3 integration/spectator-chat）：
 * - 观战者对局中随时加入，先收快照；只能发 chat / emote / time:ping；
 * - spectatorChat 三种模式（all / spectators / off）的投递范围与 chat:history；
 * - 表情：EMOTES 表、冷却、targetSeat、观战者表情的投递范围；
 * - 聊天清洗（NFC、零宽字符、≤200 字）与敏感词替换。
 */
import { CHAT_MAX_CHARS, type ChatMessage, EMOTE_COUNT, EMOTE_IDS, type EmoteMsg } from '@rich4/shared/net';
import { afterEach, describe, expect, it } from 'vitest';
import { type BotClient, connectBot } from '../helpers/botClient';
import { closeAll, setupRoom, startGame } from '../helpers/scenario';
import { startTestServer, type TestServer } from '../helpers/startTestServer';

let srv: TestServer | null = null;
const bots: BotClient[] = [];

afterEach(async () => {
  closeAll(bots.splice(0));
  await srv?.close();
  srv = null;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function chats(b: BotClient): ChatMessage[] {
  return b.received.filter((m) => m.event === 'chat:message').map((m) => m.payload as ChatMessage);
}

function texts(b: BotClient): string[] {
  return chats(b).flatMap((m) => (m.text !== undefined ? [m.text] : []));
}

function emotes(b: BotClient): EmoteMsg[] {
  return b.received.filter((m) => m.event === 'chat:emote').map((m) => m.payload as EmoteMsg);
}

async function gameWithSpectator(o: { badWords?: string[] } = {}) {
  srv = await startTestServer({ rateLimitScale: 0, ...o });
  const s = await setupRoom(srv.url, { humans: 2, settings: { timerPreset: 'off' } });
  bots.push(...s.bots);
  await startGame(s);
  const spec = await connectBot(srv.url, { nickname: 'W' });
  bots.push(spec);
  return { s, spec, host: s.host, p1: s.bots[1]! };
}

describe('integration/spectator-chat', () => {
  it('观战者对局中加入先收快照与聊天记录；看不到决策；game:act 返回 NOT_A_PLAYER', async () => {
    const { s, spec, host } = await gameWithSpectator();
    await host.req('chat:send', { text: '开局前说一句' });
    await host.req('debug:act', { op: { op: 'setPoints', seat: 0, points: 7 } });
    expect(await spec.req('room:join', { code: s.code, role: 'spectator' })).toMatchObject({
      ok: true,
      data: { you: { role: 'spectator', isHost: false } },
    });
    await spec.until(() => spec.view !== undefined, 3000, 'snapshot');
    const order = spec.received.map((m) => m.event);
    expect(order.indexOf('game:snapshot')).toBeLessThan(order.indexOf('chat:history'));
    expect(spec.lastSeq).toBe(1);
    expect(spec.yourDecision).toBeUndefined();
    const hist = spec.received.find((m) => m.event === 'chat:history')!.payload as { messages: ChatMessage[] };
    expect(hist.messages.some((m) => m.text === '开局前说一句')).toBe(true);
    const d = host.yourDecision ?? s.bots[1]!.yourDecision;
    expect(d).toBeDefined();
    expect(
      await spec.req('game:act', { decisionId: d!.decisionId, intent: { type: 'ROLL' }, clientActionId: 'w1' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'NOT_A_PLAYER' },
    });
    expect(await spec.req('game:autopilot', { on: true })).toMatchObject({
      ok: false,
      error: { code: 'NOT_A_PLAYER' },
    });
    expect((await spec.req('time:ping', { t0: 1 })).ok).toBe(true);
    // 之后的 batch 观战者照常收到（公开投影）
    await host.req('debug:act', { op: { op: 'setPoints', seat: 0, points: 9 } });
    await spec.until(() => spec.lastSeq === 2, 3000, 'batch');
    expect(spec.gaps).toEqual([]);
    expect(spec.batches.at(-1)!.yourDecision).toBeUndefined();
  });

  it('spectatorChat：all 全体可见；spectators 只发观战者且玩家的 chat:history 不含；off 返回 CHAT_DISABLED', async () => {
    const { s, spec, host, p1 } = await gameWithSpectator();
    const spec2 = await connectBot(srv!.url, { nickname: 'V' });
    bots.push(spec2);
    for (const w of [spec, spec2])
      expect((await w.req('room:join', { code: s.code, role: 'spectator' })).ok).toBe(true);

    expect((await spec.req('chat:send', { text: '观战者说：all' })).ok).toBe(true);
    for (const b of [host, p1, spec2]) await b.until(() => texts(b).includes('观战者说：all'), 3000, 'all mode');
    expect(chats(host).find((m) => m.text === '观战者说：all')).toMatchObject({
      from: { kind: 'spectator', nickname: 'W' },
      audience: 'all',
    });

    expect(await p1.req('room:updateSettings', { patch: { spectatorChat: 'spectators' } })).toMatchObject({
      ok: false,
      error: { code: 'NOT_HOST' },
    });
    expect((await host.req('room:updateSettings', { patch: { spectatorChat: 'spectators' } })).ok).toBe(true);
    expect(await host.req('room:updateSettings', { patch: { timerPreset: 'fast' } })).toMatchObject({
      ok: false,
      error: { code: 'ROOM_IN_GAME' },
    });
    expect((await spec.req('chat:send', { text: '只给观战者' })).ok).toBe(true);
    expect((await host.req('chat:send', { text: '玩家照常对全体' })).ok).toBe(true);
    await spec2.until(
      () => texts(spec2).includes('只给观战者') && texts(spec2).includes('玩家照常对全体'),
      3000,
      'spec',
    );
    await p1.until(() => texts(p1).includes('玩家照常对全体'), 3000, 'player msg');
    await sleep(50);
    expect(texts(p1)).not.toContain('只给观战者');
    expect(texts(host)).not.toContain('只给观战者');
    expect(chats(spec2).find((m) => m.text === '只给观战者')!.audience).toBe('spectators');

    // chat:history：玩家看不到观战者频道，观战者能看到全部
    const p1b = await connectBot(srv!.url, { token: p1.token, nickname: 'P1' });
    bots.push(p1b);
    expect((await p1b.req('room:resume', { code: s.code, lastSeq: 0, epoch: 0 })).ok).toBe(true);
    const ph = p1b.received.find((m) => m.event === 'chat:history')!.payload as { messages: ChatMessage[] };
    expect(ph.messages.map((m) => m.text)).toContain('观战者说：all');
    expect(ph.messages.map((m) => m.text)).not.toContain('只给观战者');
    const w3 = await connectBot(srv!.url, { token: spec2.token, nickname: 'V' });
    bots.push(w3);
    expect((await w3.req('room:resume', { code: s.code, lastSeq: 0, epoch: 0 })).ok).toBe(true);
    const sh = w3.received.find((m) => m.event === 'chat:history')!.payload as { messages: ChatMessage[] };
    expect(sh.messages.map((m) => m.text)).toContain('只给观战者');

    expect((await host.req('room:updateSettings', { patch: { spectatorChat: 'off' } })).ok).toBe(true);
    expect(await spec.req('chat:send', { text: '还能说吗' })).toMatchObject({
      ok: false,
      error: { code: 'CHAT_DISABLED' },
    });
    expect(await spec.req('chat:emote', { emoteId: 'laugh' })).toMatchObject({
      ok: false,
      error: { code: 'CHAT_DISABLED' },
    });
    expect((await host.req('chat:send', { text: '玩家不受影响' })).ok).toBe(true);
  });

  it('表情：EMOTES 表 16 个；未知 id、空座位拒绝；1.5 秒冷却；观战者在 spectators 模式下只发给观战者', async () => {
    expect(EMOTE_COUNT).toBe(16);
    expect(new Set(EMOTE_IDS).size).toBe(16);
    srv = await startTestServer();
    const s = await setupRoom(srv.url, { humans: 2, settings: { timerPreset: 'off' } });
    bots.push(...s.bots);
    await startGame(s);
    const [host, p1] = s.bots as [BotClient, BotClient];
    const spec = await connectBot(srv.url, { nickname: 'W' });
    const spec2 = await connectBot(srv.url, { nickname: 'V' });
    bots.push(spec, spec2);
    for (const w of [spec, spec2])
      expect((await w.req('room:join', { code: s.code, role: 'spectator' })).ok).toBe(true);

    // 限流按会话计：每人各用自己的额度（guard 令牌桶 1.5 秒 1 个，Room 另有同样的冷却）
    expect(await spec2.req('chat:emote', { emoteId: 'nope' })).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST', details: { reason: 'unknownEmote' } },
    });
    expect(await p1.req('chat:emote', { emoteId: 'money', targetSeat: 3 })).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST', details: { reason: 'emptySeat' } },
    });
    expect((await host.req('chat:emote', { emoteId: 'thumbsUp', targetSeat: 1 })).ok).toBe(true);
    for (const b of [p1, spec, spec2]) await b.until(() => emotes(b).length === 1, 3000, 'emote');
    expect(emotes(spec)[0]).toMatchObject({ emoteId: 'thumbsUp', targetSeat: 1, from: { kind: 'seat', seat: 0 } });
    // 冷却：1.5 秒内第二个表情被拒
    expect(await host.req('chat:emote', { emoteId: 'laugh' })).toMatchObject({
      ok: false,
      error: { code: 'RATE_LIMITED' },
    });

    expect((await host.req('room:updateSettings', { patch: { spectatorChat: 'spectators' } })).ok).toBe(true);
    expect((await spec.req('chat:emote', { emoteId: 'shock' })).ok).toBe(true);
    await spec2.until(() => emotes(spec2).some((e) => e.emoteId === 'shock'), 3000, 'spec emote');
    await sleep(50);
    expect(emotes(p1).some((e) => e.emoteId === 'shock')).toBe(false);
  });

  it('聊天清洗与敏感词：NFC、零宽与控制字符、截到 200 字、badwords 替换为 *；空文本拒绝', async () => {
    const { s, host, p1 } = await gameWithSpectator({ badWords: ['坏蛋', 'noob'] });
    void s;
    expect((await host.req('chat:send', { text: 'é​你这个坏‍蛋 NOOB\u0007' })).ok).toBe(true);
    await p1.until(() => texts(p1).length === 1, 3000, 'msg');
    expect(texts(p1)[0]).toBe('é你这个** ****');
    expect((await host.req('chat:send', { text: '长'.repeat(CHAT_MAX_CHARS + 50) })).ok).toBe(true);
    await p1.until(() => texts(p1).length === 2, 3000, 'long msg');
    expect(Array.from(texts(p1)[1]!)).toHaveLength(CHAT_MAX_CHARS);
    expect(await host.req('chat:send', { text: '​​' })).toMatchObject({
      ok: false,
      error: { code: 'BAD_REQUEST', details: { reason: 'emptyText' } },
    });
  });
});
