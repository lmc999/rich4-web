import { afterEach, describe, expect, it } from 'vitest';
import { type BotClient, connectBot } from '../helpers/botClient';
import { closeAll, setupRoom, startGame } from '../helpers/scenario';
import { startTestServer, type TestServer } from '../helpers/startTestServer';

let srv: TestServer | null = null;
const bots: BotClient[] = [];

async function bot(nickname: string, token?: string): Promise<BotClient> {
  const b = await connectBot(srv!.url, { nickname, ...(token ? { token } : {}) });
  bots.push(b);
  return b;
}

afterEach(async () => {
  closeAll(bots.splice(0));
  await srv?.close();
  srv = null;
});

describe('integration/lobby', () => {
  it('建房、入房、选角色、准备、开局全流程', async () => {
    srv = await startTestServer();
    const s = await setupRoom(srv.url, { humans: 4 });
    bots.push(...s.bots);
    expect(s.code).toMatch(/^[1-9]\d{5}$/);
    await s.host.until(() => s.host.room?.seats.every((x) => x.occupant?.kind === 'human') ?? false);
    expect(s.host.room!.you).toEqual({ role: 'player', seat: 0, isHost: true });
    expect(s.bots[2]!.room!.you).toEqual({ role: 'player', seat: 2, isHost: false });
    expect(s.host.room!.inviteUrl).toBe(`http://rich4.test/r/${s.code}`);
    await startGame(s);
    for (const b of s.bots) {
      expect(b.epoch).toBe(1);
      expect(b.lastSeq).toBe(0);
      await b.until(() => b.room?.phase === 'playing');
    }
    // 只有轮到的座位拿到 yourDecision
    expect(s.bots.filter((b) => b.yourDecision !== undefined)).toHaveLength(1);
    expect(s.bots[0]!.yourDecision?.kind).toBe('TURN_MENU');
    expect(s.bots[1]!.pending[0]).toMatchObject({ seat: 0, kind: 'TURN_MENU', control: 'human' });
  });

  it('ROOM_FULL、观战者、CHARACTER_TAKEN、NOT_HOST、NOT_ALL_READY、NOT_ENOUGH_PLAYERS', async () => {
    srv = await startTestServer();
    const a = await bot('A');
    const c = await a.req('room:create', {});
    expect(c.ok).toBe(true);
    const code = c.ok ? c.data.code : '';
    expect(await a.req('room:start', {})).toMatchObject({ ok: false, error: { code: 'NOT_ENOUGH_PLAYERS' } });
    const b = await bot('B');
    expect(await b.req('room:join', { code, role: 'player' })).toEqual({
      ok: true,
      data: { you: { role: 'player', seat: 1, isHost: false } },
    });
    expect(await b.req('room:start', {})).toMatchObject({ ok: false, error: { code: 'NOT_HOST' } });
    expect(await b.req('room:setSeatAi', { seat: 2, ai: { preset: 'normal' } })).toMatchObject({
      ok: false,
      error: { code: 'NOT_HOST' },
    });
    expect(await a.req('room:selectCharacter', { characterId: 4 })).toEqual({ ok: true });
    expect(await b.req('room:selectCharacter', { characterId: 4 })).toMatchObject({
      ok: false,
      error: { code: 'CHARACTER_TAKEN' },
    });
    expect(await a.req('room:start', {})).toMatchObject({ ok: false, error: { code: 'NOT_ALL_READY' } });
    expect(await a.req('room:setSeatAi', { seat: 2, ai: { preset: 'cunning' } })).toEqual({ ok: true });
    expect(await a.req('room:setSeatAi', { seat: 1, ai: { preset: 'cunning' } })).toMatchObject({
      ok: false,
      error: { code: 'SEAT_TAKEN' },
    });
    const d = await bot('D');
    expect((await d.req('room:join', { code, role: 'player' })).ok).toBe(true);
    const e = await bot('E');
    expect(await e.req('room:join', { code, role: 'player' })).toMatchObject({
      ok: false,
      error: { code: 'ROOM_FULL' },
    });
    const spec = await e.req('room:join', { code, role: 'spectator' });
    expect(spec).toMatchObject({ ok: true, data: { you: { role: 'spectator', isHost: false } } });
    await a.until(() => a.room?.spectators.length === 1);
    await b.req('room:setReady', { ready: true });
    await d.req('room:setReady', { ready: true });
    expect(await a.req('room:start', {})).toEqual({ ok: true });
    await e.until(() => e.epoch === 1 && e.view !== undefined, 5000, 'spectator snapshot');
    expect(e.yourDecision).toBeUndefined();
    // 对局中以 player 身份加入：ROOM_IN_GAME；观战可以
    const f = await bot('F');
    expect(await f.req('room:join', { code, role: 'player' })).toMatchObject({
      ok: false,
      error: { code: 'ROOM_IN_GAME' },
    });
    expect((await f.req('room:join', { code, role: 'spectator' })).ok).toBe(true);
    await f.until(() => f.view !== undefined, 5000, 'late spectator snapshot');
  });

  it('房主在大厅离开后移交给座位号最小的真人', async () => {
    srv = await startTestServer();
    const s = await setupRoom(srv.url, { humans: 3 });
    bots.push(...s.bots);
    expect(await s.host.req('room:leave', {})).toEqual({ ok: true });
    const b1 = s.bots[1]!;
    await b1.until(() => b1.room?.you.role === 'player' && b1.room.you.isHost === true, 5000, 'host migrated');
    expect(b1.room!.seats[0]!.occupant).toBeNull();
    expect(b1.room!.seats[1]!.isHost).toBe(true);
    // 旧房主可以另建房间
    expect((await s.host.req('room:create', {})).ok).toBe(true);
  });

  it('lobby:list 只列公开房间；未知地图 MAP_UNAVAILABLE；对局中另建房间 ALREADY_IN_ROOM', async () => {
    srv = await startTestServer();
    const a = await bot('A');
    expect(await a.req('room:create', { settings: { game: { mapId: 'nope' } } })).toMatchObject({
      ok: false,
      error: { code: 'MAP_UNAVAILABLE' },
    });
    const pub = await a.req('room:create', { settings: { visibility: 'public' } });
    expect(pub.ok).toBe(true);
    const b = await bot('B');
    const priv = await b.req('room:create', {});
    expect(priv.ok).toBe(true);
    const list = await b.req('lobby:list', {});
    expect(list.ok && list.data.rooms.map((r) => r.code)).toEqual([pub.ok ? pub.data.code : '']);
    const s = await setupRoom(srv.url, { humans: 2 });
    bots.push(...s.bots);
    await startGame(s);
    expect(await s.bots[1]!.req('room:create', {})).toMatchObject({ ok: false, error: { code: 'ALREADY_IN_ROOM' } });
  });

  it('握手：协议版本不符 PROTOCOL_MISMATCH，token 不合法 BAD_HANDSHAKE', async () => {
    srv = await startTestServer();
    await expect(connectBot(srv.url, { protocolVersion: 999 })).rejects.toMatchObject({
      data: { code: 'PROTOCOL_MISMATCH' },
    });
    await expect(connectBot(srv.url, { token: 'short' })).rejects.toMatchObject({ data: { code: 'BAD_HANDSHAKE' } });
  });

  it('大厅无人 60 秒后回收（ManualScheduler）', async () => {
    srv = await startTestServer({ manual: true });
    const a = await bot('A');
    const c = await a.req('room:create', {});
    const code = c.ok ? c.data.code : '';
    a.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(srv.app.rooms.get(code)).toBeDefined();
    srv.sched!.advance(59_000);
    expect(srv.app.rooms.get(code)).toBeDefined();
    srv.sched!.advance(1_000);
    expect(srv.app.rooms.get(code)).toBeUndefined();
    const b = await bot('B');
    expect(await b.req('room:join', { code, role: 'player' })).toMatchObject({
      ok: false,
      error: { code: 'ROOM_NOT_FOUND' },
    });
  });

  it('对局结束后 rematch 回到大厅，epoch 加 1', async () => {
    srv = await startTestServer({ rateLimitScale: 0 });
    const s = await setupRoom(srv.url, { humans: 2, settings: { game: { timeLimitDays: 30 } } });
    bots.push(...s.bots);
    await startGame(s);
    for (const b of s.bots) b.autoPlay();
    await s.host.until(() => s.host.over !== undefined, 20_000, 'game over');
    await s.host.until(() => s.host.room?.phase === 'ended');
    expect(await s.host.req('room:rematch', {})).toEqual({ ok: true });
    await s.host.until(() => s.host.room?.phase === 'lobby' && s.host.room.epoch === 2);
    expect(s.host.room!.seats[1]!.occupant).toMatchObject({ kind: 'human', ready: false });
  });
});
