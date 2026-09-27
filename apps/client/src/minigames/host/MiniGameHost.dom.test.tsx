// 宿主与会话管理（client-dom，jsdom，不建 Pixi）：用假传输模拟服务器裁判，
// 走通 play（倒计时 → 开局 seq 0 → 分批上传 → 结束提交 → 权威分数 → 2 秒后关闭）、spectate（票据 → 帧 → 重放 → 结算）、
// 跳过即关与续玩。
import type { GameEvent } from '@rich4/shared/engine';
import {
  type InputEvent,
  isLogPrefix,
  type MinigameTicket,
  PENGUIN_BOT,
  PENGUIN_SIM,
  type PenguinState,
  penguin,
  playBot,
  replay,
  validateLog,
} from '@rich4/shared/minigames';
import type { GameBatchMsg, MinigameInputMsg, MinigameSubmitMsg } from '@rich4/shared/net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MinigameBacklogItem } from '../../net/client';
import { useRoomStore } from '../../store/roomStore';
import { FakeTransport } from '../../test/fakeTransport';
import { roomView } from '../../test/roomFixtures';
import { MinigameSessions } from '../index';

const P = { ruleset: 'exe311' } as const;
/** 首次加载小游戏模块（动态 import）在全量并行测试下可能超过默认的 1 秒 */
const READY = { timeout: 10_000 } as const;

function ticket(o: Partial<MinigameTicket> = {}): MinigameTicket {
  return {
    sessionId: 'mg-1-d7',
    decisionId: 'd7',
    seat: 0,
    minigameId: 'penguin',
    seed: 424242,
    params: { ...P },
    tickMs: 100,
    introTicks: 10,
    maxTicks: 170,
    startsAt: 10_000,
    deadlineAt: 10_000 + 17_000 + 5000,
    role: 'player',
    ...o,
  };
}

function batch(events: GameEvent[], pending: string[] = []): GameBatchMsg {
  return {
    epoch: 1,
    seq: 5,
    cause: { seat: 0, intentType: 'MINIGAME_RESULT', by: 'system' },
    events,
    animMs: 0,
    view: {} as GameBatchMsg['view'],
    pending: pending.map((decisionId) => ({
      decisionId,
      seat: 0,
      kind: 'MINIGAME',
      timing: 'minigame',
      deadlineAt: null,
      control: 'human',
      publicInfo: { kind: 'MINIGAME', seat: 0, lot: null, amount: null, labelKey: null },
    })),
    serverNow: 0,
  };
}

const ended = (score: number, mode: 'played' | 'skipped' = 'played'): GameEvent =>
  ({ type: 'MINIGAME_ENDED', seat: 0, minigameId: 'penguin', mode, score, speechSlot: null }) as GameEvent;

let sessions: MinigameSessions | null = null;

afterEach(() => {
  sessions?.uninstall();
  sessions = null;
  document.body.innerHTML = '';
});

function setup() {
  let now = 0;
  const transport = new FakeTransport();
  const uploaded: MinigameInputMsg[] = [];
  const submits: MinigameSubmitMsg[] = [];
  let serverLog: InputEvent[] = [];
  transport.respond('game:minigameInput', (p) => {
    if (p.seq !== uploaded.length)
      return {
        ok: false,
        error: { code: 'MINIGAME_INVALID', message: '', details: { reason: 'seq', expected: uploaded.length } },
      };
    uploaded.push(p);
    serverLog = [...serverLog, ...p.events];
    return { ok: true, data: undefined };
  });
  transport.respond('game:minigameSubmit', (p) => {
    submits.push(p);
    if (!isLogPrefix(serverLog, p.inputs))
      return { ok: false, error: { code: 'MINIGAME_INVALID', message: '', details: { reason: 'notPrefix' } } };
    const t = ticket();
    return { ok: true, data: { score: replay(PENGUIN_SIM, t.seed, P, p.inputs).score } };
  });
  sessions = new MinigameSessions(
    { transport, clock: { serverNow: () => now } },
    { headless: true, clock: () => now, resultMs: 60 },
  );
  sessions.install();
  return {
    transport,
    uploaded,
    submits,
    s: sessions,
    get now() {
      return now;
    },
    set now(v: number) {
      now = v;
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('MiniGameHost（play）', () => {
  it('倒计时 → seq 0 开局 → 按 tick 记录与分批上传 → 结束提交完整日志 → 权威分数 → 关闭', async () => {
    const env = setup();
    const t = ticket();
    // 用 bot 的操作序列当作玩家的点击（在对应 tick 注入）
    const plan = playBot(PENGUIN_SIM, PENGUIN_BOT, t.seed, P, 3);
    env.now = t.startsAt - 1500;
    // 决策一出现就在后台创建（隐藏），到 startsAt 才显示
    const host = env.s.startPlayer(t, { revealAt: t.startsAt })!;
    expect(env.s.startPlayer(t)).toBe(host);
    await vi.waitFor(() => expect(host.isReady).toBe(true), READY);
    host.pump();
    expect(host.getSnapshot().phase).toBe('countdown');
    expect(host.revealed).toBe(false);
    expect(document.querySelector('[data-testid="minigame-countdown"]')).not.toBeNull();
    expect(env.uploaded).toEqual([]);

    let i = 0;
    for (let k = 0; k <= plan.endTick + 2; k++) {
      env.now = t.startsAt + k * t.tickMs;
      host.pump();
      expect(host.revealed).toBe(true);
      while (i < plan.log.length && plan.log[i]![0] === host.loop.curr.tick) host.sink.pick(plan.log[i++]![2]);
      await Promise.resolve();
    }
    await vi.waitFor(() => expect(env.submits.length).toBe(1));
    const sub = env.submits[0]!;
    expect(env.uploaded[0]).toEqual({ sessionId: t.sessionId, seq: 0, events: [] });
    expect(env.uploaded.map((u) => u.seq)).toEqual(env.uploaded.map((_, n) => n));
    expect(
      isLogPrefix(
        env.uploaded.flatMap((u) => u.events),
        sub.inputs,
      ),
    ).toBe(true);
    expect(validateLog(PENGUIN_SIM.spec, sub.inputs)).toBeNull();
    const r = replay(PENGUIN_SIM, t.seed, P, sub.inputs);
    expect(sub.claimedScore).toBe(r.score);
    expect(sub.finalHash).toBe(r.hash);
    expect(r.score).toBe(plan.score);
    await vi.waitFor(() => expect(host.getSnapshot().finalScore).toBe(plan.score));
    expect(host.getSnapshot().phase).toBe('result');
    const shown = document.querySelector('[data-testid="minigame-final-score"]');
    expect(shown?.getAttribute('data-value')).toBe(String(plan.score));
    env.transport.push('game:batch', batch([ended(plan.score)]));
    await host.whenClosed();
    expect(document.querySelector('[data-testid="minigame-host"]')).toBeNull();
    expect(env.s.isDone(t.sessionId)).toBe(true);
    expect(env.s.startPlayer(t)).toBeNull();
  });

  it('续玩：先收到自己的帧，开宿主时恢复日志，seq 接着走', async () => {
    const env = setup();
    const t = ticket();
    // 服务器已接受 seq 0、1
    env.uploaded.push({ sessionId: t.sessionId, seq: 0, events: [] });
    env.uploaded.push({ sessionId: t.sessionId, seq: 1, events: [[12, 1, 47]] });
    env.transport.push('game:minigameFrames', { sessionId: t.sessionId, seq: 0, events: [] });
    env.transport.push('game:minigameFrames', { sessionId: t.sessionId, seq: 1, events: [[12, 1, 47]] });
    env.now = t.startsAt + 3000;
    const host = env.s.startPlayer(t)!;
    await vi.waitFor(() => expect(host.isReady).toBe(true), READY);
    expect(host.recorder!.log).toEqual([[12, 1, 47]]);
    // 开局后的第一批接着 seq 2 发
    await vi.waitFor(() => expect(env.uploaded.length).toBeGreaterThanOrEqual(3));
    expect(env.uploaded[2]!.seq).toBe(2);
    for (let k = 0; k < 5; k++) {
      env.now += 100;
      host.pump();
      await Promise.resolve();
    }
    // 回放了已上传的点击：企鹅离开了起点或正在走
    expect(host.loop.curr.tick).toBeGreaterThan(12);
    const s = host.loop.curr as unknown as { cell: number; walk: unknown; digLeft: number };
    expect(s.cell !== penguin.START_CELL || s.walk !== null || s.digLeft > 0).toBe(true);
    host.close();
  });

  it('之前的页面已经开局、又没收到续玩帧：提示按已上传的输入结算并关闭，不再上传', async () => {
    const env = setup();
    const t = ticket();
    env.transport.respond('game:minigameInput', () => ({
      ok: false,
      error: { code: 'MINIGAME_INVALID', message: '', details: { reason: 'seq', expected: 3 } },
    }));
    env.now = t.startsAt + 2000;
    const host = env.s.startPlayer(t)!;
    await vi.waitFor(() => expect(host.isReady).toBe(true), READY);
    await vi.waitFor(() => expect(host.getSnapshot().notice).not.toBeNull());
    expect(host.getSnapshot().phase).toBe('waiting');
    const sent = env.transport.payloads('game:minigameInput').length;
    env.now += 5000;
    host.pump();
    expect(env.transport.payloads('game:minigameInput').length).toBe(sent);
    await host.whenClosed();
  });

  it('房间暂停时不开局、不推进、不上传（避免暂停期间本地空跑整局）；继续后照常开局', async () => {
    const env = setup();
    const t = ticket();
    useRoomStore.getState().setRoom(roomView({ phase: 'paused' }));
    env.now = t.startsAt + 500;
    const host = env.s.startPlayer(t)!;
    await vi.waitFor(() => expect(host.isReady).toBe(true), READY);
    for (let k = 0; k < 5; k++) {
      env.now += 100;
      host.pump();
      await Promise.resolve();
    }
    expect(host.loop.curr.tick).toBe(0);
    expect(host.getSnapshot()).toMatchObject({ phase: 'countdown', paused: true });
    expect(document.querySelector('[data-testid="minigame-paused"]')).not.toBeNull();
    expect(env.transport.payloads('game:minigameInput')).toEqual([]);
    useRoomStore.getState().setRoom(roomView({ phase: 'playing' }));
    env.now += 100;
    host.pump();
    expect(host.getSnapshot()).toMatchObject({ phase: 'playing', paused: false });
    await vi.waitFor(() => expect(env.uploaded[0]?.seq).toBe(0));
    host.close();
    useRoomStore.getState().clear();
  });

  it('玩家开局前跳过（MINIGAME_ENDED skipped）：宿主立即关闭', async () => {
    const env = setup();
    const t = ticket();
    env.now = t.startsAt - 500;
    const host = env.s.startPlayer(t)!;
    await vi.waitFor(() => expect(host.isReady).toBe(true), READY);
    env.transport.push('game:batch', batch([ended(57, 'skipped')]));
    await host.whenClosed();
    expect(host.isClosed).toBe(true);
  });
});

describe('MiniGameHost（spectate）', () => {
  it('收到观战票据 → 按帧重放 → 收到 MINIGAME_ENDED 快进并显示权威分数 → 关闭', async () => {
    const env = setup();
    const t = ticket({ role: 'spectator' });
    const plan = playBot(PENGUIN_SIM, PENGUIN_BOT, t.seed, P, 9);
    env.now = t.startsAt - 2000;
    env.transport.push('game:minigameWatch', { ticket: t, mode: 'live', log: null });
    await vi.waitFor(() => expect(env.s.active()).toHaveLength(1));
    const host = env.s.active()[0]!;
    expect(host.mode).toBe('spectate');
    await vi.waitFor(() => expect(host.isReady).toBe(true), READY);
    env.transport.push('game:minigameFrames', { sessionId: t.sessionId, seq: 0, events: [] });
    // 分三批送达
    const third = Math.ceil(plan.log.length / 3);
    for (let b = 0; b < 3; b++) {
      env.transport.push('game:minigameFrames', {
        sessionId: t.sessionId,
        seq: b + 1,
        events: plan.log.slice(b * third, (b + 1) * third),
      });
    }
    for (let k = 0; k < 40; k++) {
      env.now = t.startsAt + 300 + k * 100;
      // 玩家端每秒的心跳（空批）
      if (k % 10 === 9)
        env.transport.push('game:minigameFrames', { sessionId: t.sessionId, seq: 4 + (k - 9) / 10, events: [] });
      host.pump();
    }
    expect(host.feed!.log).toEqual(plan.log);
    const mid = replay(
      PENGUIN_SIM,
      t.seed,
      P,
      plan.log.filter((e) => e[0] < host.loop.curr.tick),
    );
    expect(host.loop.curr.tick).toBeGreaterThan(0);
    expect(mid.endTick).toBeGreaterThan(0);
    env.transport.push('game:batch', batch([ended(plan.score)]));
    expect(host.loop.canStep).toBe(false);
    expect(host.getSnapshot().finalScore).toBe(plan.score);
    expect(PENGUIN_SIM.hash(host.loop.curr as PenguinState)).toBe(plan.hash);
    await host.whenClosed();
  });

  it('决策已不在待决列表（例如快照重置）时关闭观战遮罩；开局前就跳过的票据作废', async () => {
    const env = setup();
    const t = ticket({ role: 'spectator', startsAt: 50_000 });
    env.now = 40_000;
    env.transport.push('game:minigameWatch', { ticket: t, mode: 'live', log: null });
    // 还没到弹出时间（开局前 3 秒）
    expect(env.s.active()).toHaveLength(0);
    env.transport.push('game:batch', batch([ended(60, 'skipped')]));
    expect(env.s.isDone(t.sessionId)).toBe(true);

    const t2 = ticket({ role: 'spectator', sessionId: 'mg-1-d9', decisionId: 'd9', startsAt: 40_500 });
    env.transport.push('game:minigameWatch', { ticket: t2, mode: 'live', log: null });
    await vi.waitFor(() => expect(env.s.active()).toHaveLength(1));
    const host = env.s.active()[0]!;
    env.transport.push('game:batch', batch([], ['d9']));
    expect(host.isClosed).toBe(false);
    env.transport.push('game:batch', batch([], []));
    expect(host.isClosed).toBe(true);
    await sleep(0);
  });

  it('replay：带完整日志的票据 2 倍速回放，结束时显示重放分数', async () => {
    const env = setup();
    const t = ticket({ role: 'spectator' });
    const plan = playBot(PENGUIN_SIM, PENGUIN_BOT, t.seed, P, 4);
    env.now = 100_000;
    env.transport.push('game:minigameWatch', { ticket: t, mode: 'replay', log: plan.log });
    await vi.waitFor(() => expect(env.s.active()).toHaveLength(1));
    const host = env.s.active()[0]!;
    expect(host.mode).toBe('replay');
    await vi.waitFor(() => expect(host.isReady).toBe(true), READY);
    for (let k = 0; k < 200 && host.loop.canStep; k++) {
      env.now += 60;
      host.pump();
    }
    expect(host.loop.canStep).toBe(false);
    expect(host.getSnapshot().finalScore).toBe(plan.score);
    await host.whenClosed();
  });
});

describe('MinigameSessions（刷新、重连与会话切换）', () => {
  it('安装前到达的票据与帧（刷新、中途加入）：安装时从 GameClient 的缓存取回——观战遮罩弹出，本人续玩拿到自己的帧', async () => {
    const env = setup();
    env.s.uninstall();
    const t = ticket();
    env.now = t.startsAt + 3000;
    const w = ticket({ role: 'spectator', sessionId: 'mg-1-d8', decisionId: 'd8', seat: 1, startsAt: env.now + 1000 });
    env.uploaded.push({ sessionId: t.sessionId, seq: 0, events: [] });
    env.uploaded.push({ sessionId: t.sessionId, seq: 1, events: [[12, 1, 47]] });
    const backlog: MinigameBacklogItem[] = [
      { event: 'game:minigameFrames', payload: { sessionId: t.sessionId, seq: 0, events: [] } },
      { event: 'game:minigameFrames', payload: { sessionId: t.sessionId, seq: 1, events: [[12, 1, 47]] } },
      { event: 'game:minigameWatch', payload: { ticket: w, mode: 'live', log: null } },
    ];
    const s2 = new MinigameSessions(
      { transport: env.transport, clock: { serverNow: () => env.now }, takeMinigameBacklog: () => backlog.splice(0) },
      { headless: true, clock: () => env.now, resultMs: 60 },
    );
    sessions = s2;
    s2.install();
    expect(backlog).toEqual([]);
    expect(s2.active().map((h) => [h.mode, h.sessionId])).toEqual([['spectate', 'mg-1-d8']]);
    const host = s2.startPlayer(t)!;
    await vi.waitFor(() => expect(host.isReady).toBe(true), READY);
    expect(host.recorder!.log).toEqual([[12, 1, 47]]);
    await vi.waitFor(() => expect(env.uploaded.length).toBeGreaterThanOrEqual(3));
    expect(env.uploaded[2]!.seq).toBe(2);
  });

  it('同一会话的观战票据收到两次（重连补发）只开一个遮罩；同一决策换了新会话时旧遮罩关闭', async () => {
    const env = setup();
    env.now = 40_000;
    const t = ticket({ role: 'spectator', sessionId: 'mg-1-d9', decisionId: 'd9', startsAt: 43_030 });
    env.transport.push('game:minigameWatch', { ticket: t, mode: 'live', log: null });
    env.transport.push('game:minigameWatch', { ticket: t, mode: 'live', log: null });
    await sleep(80);
    expect(document.querySelectorAll('[data-testid="minigame-host"]')).toHaveLength(1);
    const old = env.s.active()[0]!;
    // 暂停恢复：同一决策换新 sessionId
    const t2 = { ...t, sessionId: 'mg-1-d9.1', startsAt: 42_000 };
    env.transport.push('game:minigameWatch', { ticket: t2, mode: 'live', log: null });
    expect(old.isClosed).toBe(true);
    expect(env.s.active().map((h) => h.sessionId)).toEqual(['mg-1-d9.1']);
    expect(env.s.isDone('mg-1-d9')).toBe(true);
  });
});
