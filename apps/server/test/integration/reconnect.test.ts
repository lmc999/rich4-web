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

describe('integration/reconnect', () => {
  it('短断线：lastSeq 在环形缓冲内，收到 catchup 且事件范围正确', async () => {
    srv = await startTestServer({ roomDefaults: { reconnectGraceSec: 30 } });
    const s = await setupRoom(srv.url, { humans: 2, settings: { timerPreset: 'off' } });
    bots.push(...s.bots);
    await startGame(s);
    const [a, b] = s.bots as [BotClient, BotClient];
    b.drop();
    await a.until(
      () => a.room?.seats[1]?.occupant?.kind === 'human' && !a.room.seats[1].occupant.connected,
      3000,
      'b away',
    );
    for (let i = 0; i < 3; i++) {
      expect((await a.req('debug:act', { op: { op: 'setPoints', seat: 0, points: i + 1 } })).ok).toBe(true);
    }
    const res = await b.reconnect(s.code);
    expect(res).toEqual({ ok: true, data: { mode: 'events' } });
    const cu = b.received.findLast((m) => m.event === 'game:catchup')!.payload as { batches: { seq: number }[] };
    expect(cu.batches.map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(b.lastSeq).toBe(3);
    expect(b.gaps).toEqual([]);
    await a.until(() => a.room?.seats[1]?.occupant?.kind === 'human' && a.room.seats[1].occupant.connected, 3000);
    // 之后的 batch 正常衔接
    await a.req('debug:act', { op: { op: 'setPoints', seat: 0, points: 9 } });
    await b.until(() => b.lastSeq === 4);
    expect(b.gaps).toEqual([]);
  });

  it('长断线超过宽限：AI 代打（cause.by=autopilot），重连后控制权还给真人', async () => {
    srv = await startTestServer({ rateLimitScale: 0 });
    const s = await setupRoom(srv.url, { humans: 2, settings: { timerPreset: 'slow' } });
    bots.push(...s.bots);
    await startGame(s);
    const [a, b] = s.bots as [BotClient, BotClient];
    a.autoPlay();
    await b.until(() => b.yourDecision?.kind === 'TURN_MENU', 5000, 'b turn');
    const seqBefore = b.lastSeq;
    b.drop();
    await a.until(
      () => a.batches.some((x) => x.seq > seqBefore && x.cause.seat === 1 && x.cause.by === 'autopilot'),
      5000,
      'autopilot batch',
    );
    expect(a.room!.seats[1]!.control).toBe('autopilot:disconnect');
    const res = await b.reconnect(s.code);
    expect(res.ok).toBe(true);
    const got = b.received.filter((m) => m.event === 'game:catchup' || m.event === 'game:snapshot').at(-1)!;
    if (got.event === 'game:catchup') {
      const cu = got.payload as { batches: { seq: number; cause: { seat: number | null; by: string } }[] };
      expect(cu.batches[0]!.seq).toBe(seqBefore + 1);
      expect(cu.batches.some((x) => x.cause.seat === 1 && x.cause.by === 'autopilot')).toBe(true);
    }
    await a.until(() => a.room?.seats[1]?.control === 'human', 3000, 'control back to human');
    expect(b.gaps).toEqual([]);
  });

  it('刷新页面（lastSeq=0、epoch=0）收到 snapshot', async () => {
    srv = await startTestServer();
    const s = await setupRoom(srv.url, { humans: 2, settings: { timerPreset: 'off' } });
    bots.push(...s.bots);
    await startGame(s);
    const [a, b] = s.bots as [BotClient, BotClient];
    await a.req('debug:act', { op: { op: 'setPoints', seat: 0, points: 5 } });
    b.close();
    const b2 = await connectBot(srv.url, { token: b.token, nickname: 'P1' });
    bots.push(b2);
    expect(await b2.req('room:resume', { code: s.code, lastSeq: 0, epoch: 0 })).toEqual({
      ok: true,
      data: { mode: 'snapshot' },
    });
    await b2.until(() => b2.view !== undefined && b2.lastSeq === 1);
    expect(b2.received.some((m) => m.event === 'chat:history')).toBe(true);
    expect(b2.room?.you).toEqual({ role: 'player', seat: 1, isHost: false });
    // 不在房间里的 token 与不存在的房间返回同一个错误码（不泄露房间是否存在）
    const c = await connectBot(srv.url);
    bots.push(c);
    expect(await c.req('room:resume', { code: s.code, lastSeq: 0, epoch: 0 })).toMatchObject({
      ok: false,
      error: { code: 'ROOM_NOT_FOUND' },
    });
    expect(await c.req('room:resume', { code: '999999', lastSeq: 0, epoch: 0 })).toMatchObject({
      ok: false,
      error: { code: 'ROOM_NOT_FOUND' },
    });
  });

  it('同一 token 开两个标签页：旧的收到 session:replaced', async () => {
    srv = await startTestServer();
    const s = await setupRoom(srv.url, { humans: 2 });
    bots.push(...s.bots);
    const a = s.bots[0]!;
    const a2 = await connectBot(srv.url, { token: a.token, nickname: 'P0' });
    bots.push(a2);
    await a.until(() => a.replaced, 3000, 'session:replaced');
    await a.until(() => !a.socket.connected, 3000, 'old socket closed');
    expect((await a2.req('room:resume', { code: s.code, lastSeq: 0, epoch: 0 })).ok).toBe(true);
    await a2.until(() => a2.room?.you.role === 'player' && a2.room.you.isHost === true);
  });

  it('全员断线则暂停，回来一个就恢复', async () => {
    srv = await startTestServer({ roomDefaults: { reconnectGraceSec: 30 } });
    const s = await setupRoom(srv.url, { humans: 2 });
    bots.push(...s.bots);
    const spec = await connectBot(srv.url, { nickname: 'W' });
    bots.push(spec);
    expect((await spec.req('room:join', { code: s.code, role: 'spectator' })).ok).toBe(true);
    await startGame(s, [spec]);
    const [a, b] = s.bots as [BotClient, BotClient];
    a.drop();
    await spec.until(() => spec.room?.seats[0]?.occupant?.kind === 'human' && !spec.room.seats[0].occupant.connected);
    expect(spec.room!.phase).toBe('playing');
    b.drop();
    await spec.until(() => spec.room?.phase === 'paused', 3000, 'paused');
    expect(spec.room!.paused?.reason).toBe('all_away');
    expect(spec.pending.every((p) => p.deadlineAt === null)).toBe(true);
    const r = await a.reconnect(s.code);
    expect(r.ok).toBe(true);
    await spec.until(() => spec.room?.phase === 'playing', 3000, 'resumed');
    expect(spec.room!.paused).toBeUndefined();
  });
});
