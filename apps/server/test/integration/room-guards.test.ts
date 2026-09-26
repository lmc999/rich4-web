/**
 * 房间入口的防护回归：resume 防扫号、限流按会话、加入 / 建房失败不丢原座位、rematch 保留暂时断线的座位。
 */
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('integration/room-guards', () => {
  it('room:resume：不存在与不是成员返回同一错误码，并计入按 IP 的 join 失败额度', async () => {
    srv = await startTestServer();
    const s = await setupRoom(srv.url, { humans: 1 });
    bots.push(...s.bots);
    const probe1 = await bot('X1');
    const probe2 = await bot('X2');
    for (let i = 0; i < 10; i++) {
      expect(await probe1.req('room:resume', { code: s.code, lastSeq: 0, epoch: 0 })).toMatchObject({
        ok: false,
        error: { code: 'ROOM_NOT_FOUND' },
      });
      expect(await probe2.req('room:resume', { code: '999999', lastSeq: 0, epoch: 0 })).toMatchObject({
        ok: false,
        error: { code: 'ROOM_NOT_FOUND' },
      });
    }
    // 同一 IP 已失败 20 次：join 与 resume 都被限流（真实房间号也一样）
    const probe3 = await bot('X3');
    expect(await probe3.req('room:join', { code: s.code, role: 'spectator' })).toMatchObject({
      ok: false,
      error: { code: 'RATE_LIMITED' },
    });
    expect(await probe3.req('room:resume', { code: s.code, lastSeq: 0, epoch: 0 })).toMatchObject({
      ok: false,
      error: { code: 'RATE_LIMITED' },
    });
  });

  it('限流按会话计：同一 token 重连后额度不重置', async () => {
    srv = await startTestServer();
    const s = await setupRoom(srv.url, { humans: 1 });
    bots.push(...s.bots);
    const sp = await bot('S');
    expect((await sp.req('room:join', { code: s.code, role: 'spectator' })).ok).toBe(true);
    const codes: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await sp.req('chat:send', { text: `hi ${i}` });
      codes.push(r.ok ? 'ok' : r.error.code);
    }
    expect(codes).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'RATE_LIMITED', 'RATE_LIMITED']);
    expect((await sp.reconnect(s.code)).ok).toBe(true);
    const again: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await sp.req('chat:send', { text: `again ${i}` });
      again.push(r.ok ? 'ok' : r.error.code);
    }
    // 重连只用了几十毫秒，按 0.5 条/秒补充最多补回 1 条
    expect(again.filter((c) => c === 'ok').length).toBeLessThanOrEqual(1);
  });

  it('room:join 目标满员 / room:create 设置非法：不离开原大厅房间，原座位与房主保留', async () => {
    srv = await startTestServer();
    const a = await bot('A');
    const c = await a.req('room:create', {});
    expect(c.ok).toBe(true);
    const home = c.ok ? c.data.code : '';
    const full = await setupRoom(srv.url, { humans: 4 });
    bots.push(...full.bots);
    expect(await a.req('room:join', { code: full.code, role: 'player' })).toMatchObject({
      ok: false,
      error: { code: 'ROOM_FULL' },
    });
    const room = srv.app.rooms.get(home)!;
    expect(room.seats[0]!.occupant).toMatchObject({ kind: 'human', nickname: 'A' });
    expect(room.hostToken).not.toBeNull();
    expect(await a.req('room:create', { settings: { game: { mapId: 'no-such-map' } } })).toMatchObject({
      ok: false,
      error: { code: 'MAP_UNAVAILABLE' },
    });
    expect(room.seats[0]!.occupant).toMatchObject({ kind: 'human', nickname: 'A' });
    // 仍然在原房间里：房间级操作照常可用
    expect(await a.req('room:setReady', { ready: true })).toEqual({ ok: true });
    // 目标可以加入时照旧自动离开原大厅房间
    const open = await bot('O');
    const oc = await open.req('room:create', {});
    expect(await a.req('room:join', { code: oc.ok ? oc.data.code : '', role: 'player' })).toMatchObject({ ok: true });
    expect(room.seats[0]!.occupant).toBeNull();
  });

  it('rematch：暂时断线的座位保留，对局中 room:leave 的座位释放', async () => {
    srv = await startTestServer({ rateLimitScale: 0 });
    const s = await setupRoom(srv.url, { humans: 3, settings: { game: { timeLimitDays: 30 } } });
    bots.push(...s.bots);
    await startGame(s);
    const [host, p1, p2] = s.bots as [BotClient, BotClient, BotClient];
    expect(await p2.req('room:leave', {})).toEqual({ ok: true });
    host.autoPlay();
    p1.autoPlay();
    await host.until(() => host.over !== undefined, 20_000, 'game over');
    await host.until(() => host.room?.phase === 'ended');
    p1.close(); // 模拟刷新页面
    await sleep(50);
    expect(await host.req('room:rematch', {})).toEqual({ ok: true });
    await host.until(() => host.room?.phase === 'lobby');
    expect(host.room!.seats[1]!.occupant).toMatchObject({ kind: 'human', connected: false });
    expect(host.room!.seats[2]!.occupant).toBeNull();
    const back = await bot('P1', p1.token);
    expect(await back.req('room:resume', { code: s.code, lastSeq: 0, epoch: 0 })).toMatchObject({ ok: true });
    await back.until(() => back.room?.phase === 'lobby');
    expect(back.room!.you).toEqual({ role: 'player', seat: 1, isHost: false });
  });
});
