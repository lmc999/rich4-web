import type { GameEvent, SeatIndex } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { afterEach, describe, expect, it } from 'vitest';
import { type BotClient, connectBot } from '../helpers/botClient';
import { closeAll, FORBIDDEN_KEYS, findKeys, setupRoom, startGame } from '../helpers/scenario';
import { startTestServer, type TestServer } from '../helpers/startTestServer';

let srv: TestServer | null = null;
const bots: BotClient[] = [];

afterEach(async () => {
  closeAll(bots.splice(0));
  await srv?.close();
  srv = null;
});

async function spectator(code: string): Promise<BotClient> {
  const w = await connectBot(srv!.url, { nickname: 'W' });
  bots.push(w);
  const r = await w.req('room:join', { code, role: 'spectator' });
  if (!r.ok) throw new Error(r.error.code);
  return w;
}

/** 这个观察者收到的所有消息里，seat 以外的手牌都必须不可见 */
function assertHandsHidden(b: BotClient, own: SeatIndex | null): void {
  const views: GameView[] = [];
  const events: GameEvent[] = [];
  for (const m of b.received) {
    const p = m.payload as { view?: GameView; events?: GameEvent[]; batches?: { events: GameEvent[] }[] };
    if (p?.view) views.push(p.view);
    if (p?.events) events.push(...p.events);
    if (p?.batches) for (const x of p.batches) events.push(...x.events);
  }
  expect(views.length).toBeGreaterThan(0);
  for (const v of views) {
    for (const pl of v.players) {
      if (pl.seat !== own) expect(pl.cards).toBeNull();
      expect(typeof pl.cardCount).toBe('number');
    }
  }
  for (const e of events) {
    for (const pp of e.post?.players ?? [])
      if (pp.seat !== own && pp.set.cards !== undefined) expect(pp.set.cards).toBeNull();
    if ((e.type === 'CARD_GAINED' || e.type === 'CARD_LOST') && e.seat !== own) expect(e.card).toBeNull();
  }
}

describe('integration/anti-cheat', () => {
  it('NOT_YOUR_DECISION、STALE_DECISION、观战者 NOT_A_PLAYER、客户端伪造系统 action BAD_REQUEST', async () => {
    srv = await startTestServer();
    const s = await setupRoom(srv.url, { humans: 2, settings: { timerPreset: 'off' } });
    bots.push(...s.bots);
    const w = await spectator(s.code);
    await startGame(s, [w]);
    const [a, b] = s.bots as [BotClient, BotClient];
    const d = a.yourDecision!;
    expect(await b.act(d.decisionId, { type: 'ROLL' })).toMatchObject({
      ok: false,
      error: { code: 'NOT_YOUR_DECISION' },
    });
    expect(await w.act(d.decisionId, { type: 'ROLL' })).toMatchObject({ ok: false, error: { code: 'NOT_A_PLAYER' } });
    const forged = await a.rawReq('game:act', {
      decisionId: d.decisionId,
      intent: { type: 'MINIGAME_RESULT', seat: 0, decisionId: d.decisionId, score: 188, logHash: 1 },
      clientActionId: 'x1',
    });
    expect(forged).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    const withSeat = await a.rawReq('game:act', {
      decisionId: d.decisionId,
      intent: { type: 'ROLL' },
      clientActionId: 'x2',
      seat: 1,
    });
    expect(withSeat).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(await a.act(d.decisionId, { type: 'CONFIRM' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ACTION', details: { rule: 'INTENT_NOT_ALLOWED' } },
    });
    expect((await a.act(d.decisionId, { type: 'ROLL' }, 'same-id')).ok).toBe(true);
    // 同一 clientActionId 重发：直接返回上次结果（幂等）
    expect(await a.act(d.decisionId, { type: 'ROLL' }, 'same-id')).toMatchObject({ ok: true });
    expect(await a.act(d.decisionId, { type: 'ROLL' })).toMatchObject({ ok: false, error: { code: 'STALE_DECISION' } });
  });

  it('超大 payload 断开连接；刷消息 RATE_LIMITED', async () => {
    srv = await startTestServer();
    const s = await setupRoom(srv.url, { humans: 2 });
    bots.push(...s.bots);
    const [a, b] = s.bots as [BotClient, BotClient];
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await b.req('chat:send', { text: `hi ${i}` }));
    expect(results.slice(0, 5).every((r) => r.ok)).toBe(true);
    expect(results[5]).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
    await a.until(() => a.received.filter((m) => m.event === 'chat:message').length >= 5);
    a.socket.emit('chat:send', { text: 'x'.repeat(200_000) }, () => {});
    await a.until(() => !a.socket.connected, 5000, 'disconnect on oversize payload');
  });

  it('测试模式关闭时 debug:act 不注册', async () => {
    srv = await startTestServer({ testMode: false });
    const s = await setupRoom(srv.url, { humans: 2 });
    bots.push(...s.bots);
    await startGame(s);
    await expect(s.host.rawReq('debug:act', { op: { op: 'setPoints', seat: 0, points: 1 } }, 300)).rejects.toThrow();
  });

  it('深度扫描所有 S2C 消息：不出现 secret/rng/flow/counters/newsOrder 等；小游戏种子只给本人', async () => {
    srv = await startTestServer({ rateLimitScale: 0 });
    const s = await setupRoom(srv.url, { humans: 3, settings: { game: { timeLimitDays: 30, initialFund: 10000 } } });
    bots.push(...s.bots);
    const w = await spectator(s.code);
    await startGame(s, [w]);
    for (const b of s.bots) b.autoPlay();
    // 让 seat 0 走到小游戏格（stub：1→7），保证至少出现一次 MINIGAME 票据
    if (srv.engineKind === 'stub')
      await s.host.req('debug:act', { op: { op: 'forceNext', purpose: 'dice', values: [6] } });
    await w.until(() => w.over !== undefined, 60_000, 'game over');
    await new Promise((r) => setTimeout(r, 50));
    const everyone = [...s.bots, w];
    for (const b of everyone) {
      const hits = b.received.flatMap((m) => findKeys(m.payload, FORBIDDEN_KEYS, m.event));
      expect(hits).toEqual([]);
    }
    // live 观战（默认设置）按设计经 game:minigameWatch 下发带种子的观战票据（architecture §5.10 已接受的风险）；
    // 除此之外观战者不得收到任何种子，观战票据一律 role='spectator'
    const isWatch = (m: { event: string }) => m.event === 'game:minigameWatch';
    const watchTicketOk = (m: { event: string; payload: unknown }) => {
      const t = (m.payload as { ticket?: { role?: string } }).ticket;
      expect(t?.role).toBe('spectator');
    };
    expect(
      findKeys(
        w.received.filter((m) => !isWatch(m)),
        ['seed', 'yourDecision', 'minigame'],
      ),
    ).toEqual([]);
    for (const m of w.received.filter(isWatch)) watchTicketOk(m);
    let tickets = 0;
    for (const [i, b] of s.bots.entries()) {
      for (const m of b.received) {
        if (isWatch(m)) {
          watchTicketOk(m);
          expect((m.payload as { ticket: { seat: number } }).ticket.seat).not.toBe(i);
          continue;
        }
        for (const path of findKeys(m.payload, ['seed'], m.event)) {
          expect(path).toMatch(/\.yourDecision\.minigame\.seed$/);
          const yd = (m.payload as { yourDecision: { seat: number } }).yourDecision;
          expect(yd.seat).toBe(i);
          tickets++;
        }
      }
    }
    if (srv.engineKind === 'stub') expect(tickets).toBeGreaterThan(0);
  }, 90_000);

  it('私密模式：他人手牌、卡片事件与 post.cards 一律脱敏，本人可见', async () => {
    srv = await startTestServer({ rateLimitScale: 0 });
    const s = await setupRoom(srv.url, {
      humans: 3,
      settings: { handVisibility: 'private', game: { timeLimitDays: 30, initialFund: 10000 } },
    });
    bots.push(...s.bots);
    const w = await spectator(s.code);
    await startGame(s, [w]);
    const [a, b] = s.bots as [BotClient, BotClient];
    expect((await a.req('debug:act', { op: { op: 'give', seat: 0, cards: [3, 7], items: [] } })).ok).toBe(true);
    await b.until(() => b.lastSeq >= 1);
    await a.until(() => a.lastSeq >= 1);
    expect(a.view!.players.find((p) => p.seat === 0)!.cards).toEqual([3, 7]);
    expect(b.view!.players.find((p) => p.seat === 0)).toMatchObject({ cards: null, cardCount: 2 });
    for (const x of s.bots) x.autoPlay();
    await w.until(() => w.over !== undefined, 60_000, 'game over');
    assertHandsHidden(w, null);
    for (const [i, x] of s.bots.entries()) assertHandsHidden(x, i as SeatIndex);
  }, 90_000);
});
