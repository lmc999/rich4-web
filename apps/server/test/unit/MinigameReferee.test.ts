/**
 * 小游戏裁判（architecture §5.10、M8 验证 3；design/minigames-ai.md §6.2）：
 * 伪造分数以服务器重放为准；来自未来的 tick 被拒；中途断线按已收到的输入结算；从未开局而到期走 decline；
 * 开局后再发 decline 被拒；提交的日志不以已上传的流为前缀时被拒；seq、过早提交、暂停恢复。
 * stubEngine 的 7 号格是企鹅挖宝（种子来自 secret.rng），GameRunner 用 ManualScheduler 精确推进时间。
 */
import {
  hashLog,
  InputCode,
  type InputEvent,
  type MinigameTicket,
  PENGUIN_BOT,
  PENGUIN_SIM,
  playBot,
  replay,
} from '@rich4/shared/minigames';
import type { MinigameFramesMsg } from '@rich4/shared/net';
import { describe, expect, it } from 'vitest';
import { renewSeed } from '../../src/game/GameRunner';
import { MinigameReferee } from '../../src/game/MinigameReferee';
import { silentLogger } from '../../src/infra/logger';
import { makeRunner } from '../helpers/runnerHarness';

const GRACE = 800;
const P = { ruleset: 'exe311' } as const;

type Harness = ReturnType<typeof makeRunner>;

/** 座位 0 从起点掷 6 → 7 号小游戏格，返回票据 */
function toMinigame(o: Parameters<typeof makeRunner>[0] = {}): { h: Harness; t: MinigameTicket } {
  const h = makeRunner(o);
  h.forceDice(6);
  expect(h.act(0, { type: 'ROLL' }).ok).toBe(true);
  const you = h.runner.decisionFor(0);
  expect(you?.kind).toBe('MINIGAME');
  return { h, t: you!.minigame! };
}

/** 把时钟推进到第 tick 个 tick 开始的时刻 */
function at(h: Harness, t: MinigameTicket, tick: number): void {
  const target = t.startsAt + tick * t.tickMs;
  if (target > h.sched.now()) h.sched.advance(target - h.sched.now());
}

/** 按 tick 顺序分批上传（每批时钟先推进到该批最后一条的 tick） */
function upload(h: Harness, t: MinigameTicket, log: readonly InputEvent[], firstSeq = 0): number {
  let seq = firstSeq;
  if (seq === 0) {
    at(h, t, 0);
    expect(h.runner.minigameInput(0, { sessionId: t.sessionId, seq: seq++, events: [] }).ok).toBe(true);
  }
  for (let i = 0; i < log.length; i += 3) {
    const chunk = log.slice(i, i + 3);
    at(h, t, chunk[chunk.length - 1]![0]);
    const r = h.runner.minigameInput(0, { sessionId: t.sessionId, seq: seq++, events: chunk.slice() });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  }
  return seq;
}

function bot(t: MinigameTicket, botSeed = 7) {
  return playBot(PENGUIN_SIM, PENGUIN_BOT, t.seed, t.params, botSeed);
}

function ended(h: Harness) {
  return h.rec.batches.at(-1)!.events.find((e) => e.type === 'MINIGAME_ENDED');
}

describe('MinigameReferee（GameRunner 接入）', () => {
  it('伪造分数：以服务器重放为准，并记一次不一致', () => {
    const { h, t } = toMinigame();
    const run = bot(t);
    expect(run.score).toBeLessThan(188);
    upload(h, t, run.log);
    at(h, t, run.endTick);
    const r = h.runner.minigameSubmit(0, {
      sessionId: t.sessionId,
      inputs: run.log,
      claimedScore: 188,
      finalHash: 1,
      clientElapsedMs: run.endTick * 100,
    });
    expect(r).toEqual({ ok: true, data: { score: run.score } });
    expect(ended(h)).toMatchObject({ seat: 0, mode: 'played', score: run.score });
    const cause = h.rec.batches.at(-1)!.cause;
    expect(cause).toEqual({ seat: 0, intentType: 'MINIGAME_RESULT', by: 'system' });
    const journal = h.runner.journal().at(-1)!.action;
    expect(journal).toEqual({
      type: 'MINIGAME_RESULT',
      seat: 0,
      decisionId: t.decisionId,
      score: run.score,
      logHash: hashLog(run.log),
    });
    expect(h.runner.minigames.stats.mismatches).toBe(1);
    // 会话随决策关闭
    expect(h.runner.minigames.sessionById(t.sessionId)).toBeUndefined();
    expect(h.runner.minigames.recentSettled().at(-1)).toMatchObject({ score: run.score, log: run.log });
  });

  it('提交时补上未上传的尾部也可以；分数一致时不计不一致', () => {
    const { h, t } = toMinigame();
    const run = bot(t, 3);
    const half = Math.floor(run.log.length / 2);
    upload(h, t, run.log.slice(0, half));
    at(h, t, run.endTick);
    const r = h.runner.minigameSubmit(0, {
      sessionId: t.sessionId,
      inputs: run.log,
      claimedScore: run.score,
      finalHash: run.hash,
      clientElapsedMs: 1,
    });
    expect(r).toEqual({ ok: true, data: { score: run.score } });
    expect(h.runner.minigames.stats.mismatches).toBe(0);
  });

  it('来自未来的 tick 被拒（容差 20 tick）；seq 必须连续', () => {
    const { h, t } = toMinigame();
    at(h, t, 10);
    const s = t.sessionId;
    expect(h.runner.minigameInput(0, { sessionId: s, seq: 0, events: [] }).ok).toBe(true);
    const future = h.runner.minigameInput(0, { sessionId: s, seq: 1, events: [[31, InputCode.PickCell, 30]] });
    expect(future).toMatchObject({ ok: false, error: { code: 'MINIGAME_INVALID', details: { reason: 'futureTick' } } });
    expect(h.runner.minigameInput(0, { sessionId: s, seq: 1, events: [[30, InputCode.PickCell, 30]] }).ok).toBe(true);
    expect(h.runner.minigameInput(0, { sessionId: s, seq: 5, events: [] })).toMatchObject({
      ok: false,
      error: { code: 'MINIGAME_INVALID', details: { reason: 'seq', expected: 2, logLength: 1 } },
    });
    // tick 回退、非法格号、别人的座位、未知会话
    expect(h.runner.minigameInput(0, { sessionId: s, seq: 2, events: [[29, InputCode.PickCell, 30]] })).toMatchObject({
      ok: false,
      error: { details: { reason: 'notMonotonic' } },
    });
    expect(h.runner.minigameInput(0, { sessionId: s, seq: 2, events: [[31, InputCode.PickCell, 81]] })).toMatchObject({
      ok: false,
      error: { details: { reason: 'badInput' } },
    });
    expect(h.runner.minigameInput(1, { sessionId: s, seq: 2, events: [] })).toMatchObject({
      ok: false,
      error: { code: 'NOT_YOUR_DECISION' },
    });
    expect(h.runner.minigameInput(0, { sessionId: 'nope', seq: 0, events: [] })).toMatchObject({
      ok: false,
      error: { details: { reason: 'noSession' } },
    });
    // 同一 tick 超过 maxInputsPerTick（企鹅 2）
    expect(
      h.runner.minigameInput(0, {
        sessionId: s,
        seq: 2,
        events: [
          [30, InputCode.PickCell, 31],
          [30, InputCode.PickCell, 32],
        ],
      }),
    ).toMatchObject({ ok: false, error: { details: { reason: 'badLog', code: 'TOO_MANY_PER_TICK' } } });
  });

  it('开局太早（startsAt 前超过 1 秒）与到期之后的输入被拒', () => {
    const { h, t } = toMinigame();
    expect(h.runner.minigameInput(0, { sessionId: t.sessionId, seq: 0, events: [] })).toMatchObject({
      ok: false,
      error: { code: 'MINIGAME_TOO_EARLY' },
    });
    // 开局前 1 秒以内（时钟偏差）可以
    h.sched.advance(t.startsAt - 900 - h.sched.now());
    expect(h.runner.minigameInput(0, { sessionId: t.sessionId, seq: 0, events: [] }).ok).toBe(true);
  });

  it('中途断线：按已收到的输入结算（断线后 AI 不代答 decline）', () => {
    const { h, t } = toMinigame({ settings: { reconnectGraceSec: 1 } });
    const run = bot(t, 11);
    const part = run.log.slice(0, Math.max(1, run.log.length - 2));
    upload(h, t, part);
    h.runner.setConnected(0, false);
    h.sched.advance(1500);
    expect(h.runner.controlOf(0)).toBe('autopilot:disconnect');
    // 断线托管后仍在等：没有新 batch
    const n = h.rec.batches.length;
    h.sched.advance(5000);
    expect(h.rec.batches.length).toBe(n);
    // 到期（加网络宽限）按已收到的输入重放结算
    h.sched.advance(t.deadlineAt + GRACE - h.sched.now());
    const expected = replay(PENGUIN_SIM, t.seed, P, part);
    expect(ended(h)).toMatchObject({ seat: 0, mode: 'played', score: expected.score });
    expect(h.rec.batches.at(-1)!.cause).toEqual({ seat: 0, intentType: 'MINIGAME_RESULT', by: 'system' });
    expect(h.rec.timedOut).toEqual([]);
  });

  it('从未开局而到期：按 decline 结算（不玩分支），cause.by=timeout', () => {
    const { h, t } = toMinigame();
    h.sched.advance(t.deadlineAt + GRACE - 1 - h.sched.now());
    expect(ended(h)).toBeUndefined();
    h.sched.advance(1);
    expect(ended(h)).toMatchObject({ seat: 0, mode: 'skipped' });
    expect(h.rec.batches.at(-1)!.cause.by).toBe('timeout');
  });

  it('开局后再发 MINIGAME_DECLINE 被拒；开局前可以跳过', () => {
    const a = toMinigame();
    at(a.h, a.t, 0);
    expect(a.h.runner.minigameInput(0, { sessionId: a.t.sessionId, seq: 0, events: [] }).ok).toBe(true);
    expect(a.h.act(0, { type: 'MINIGAME_DECLINE' })).toMatchObject({
      ok: false,
      error: { code: 'MINIGAME_INVALID', details: { reason: 'started' } },
    });
    const b = toMinigame();
    expect(b.h.act(0, { type: 'MINIGAME_DECLINE' }).ok).toBe(true);
    expect(ended(b.h)).toMatchObject({ mode: 'skipped' });
    // 会话已关闭：之后的输入报 noSession
    expect(b.h.runner.minigameInput(0, { sessionId: b.t.sessionId, seq: 0, events: [] })).toMatchObject({
      ok: false,
      error: { details: { reason: 'noSession' } },
    });
  });

  it('提交的日志不以已上传的流为前缀：拒绝，之后仍可按正确日志提交', () => {
    const { h, t } = toMinigame();
    const run = bot(t, 5);
    expect(run.log.length).toBeGreaterThan(2);
    upload(h, t, run.log.slice(0, 2));
    at(h, t, run.endTick);
    const forged: InputEvent[] = [[run.log[0]![0], InputCode.PickCell, (run.log[0]![2] + 1) % 81], ...run.log.slice(1)];
    const bad = h.runner.minigameSubmit(0, {
      sessionId: t.sessionId,
      inputs: forged,
      claimedScore: 0,
      finalHash: 0,
      clientElapsedMs: 0,
    });
    expect(bad).toMatchObject({ ok: false, error: { code: 'MINIGAME_INVALID', details: { reason: 'notPrefix' } } });
    const short = h.runner.minigameSubmit(0, {
      sessionId: t.sessionId,
      inputs: run.log.slice(0, 1),
      claimedScore: 0,
      finalHash: 0,
      clientElapsedMs: 0,
    });
    expect(short).toMatchObject({ ok: false, error: { details: { reason: 'notPrefix' } } });
    const good = h.runner.minigameSubmit(0, {
      sessionId: t.sessionId,
      inputs: run.log,
      claimedScore: run.score,
      finalHash: run.hash,
      clientElapsedMs: 0,
    });
    expect(good).toEqual({ ok: true, data: { score: run.score } });
  });

  it('提交过早返回 MINIGAME_TOO_EARLY（时序 ≥ endTick × tickMs × 0.85 − 500）', () => {
    const { h, t } = toMinigame();
    const log: InputEvent[] = [[11, InputCode.PickCell, 47]];
    const r = replay(PENGUIN_SIM, t.seed, P, log);
    const need = r.endTick * t.tickMs * 0.85 - 500;
    h.sched.advance(t.startsAt + need - 1 - h.sched.now());
    const msg = { sessionId: t.sessionId, inputs: log, claimedScore: r.score, finalHash: r.hash, clientElapsedMs: 0 };
    expect(h.runner.minigameSubmit(0, msg)).toMatchObject({ ok: false, error: { code: 'MINIGAME_TOO_EARLY' } });
    h.sched.advance(1);
    expect(h.runner.minigameSubmit(0, msg)).toEqual({ ok: true, data: { score: r.score } });
  });

  it('非法日志（密度超限）被拒', () => {
    const { h, t } = toMinigame();
    at(h, t, 150);
    const dense: InputEvent[] = [];
    for (let k = 0; k < 11; k++) dense.push([100 + Math.floor(k / 2), InputCode.PickCell, 20 + k]);
    const r = h.runner.minigameSubmit(0, {
      sessionId: t.sessionId,
      inputs: dense,
      claimedScore: 0,
      finalHash: 0,
      clientElapsedMs: 0,
    });
    expect(r).toMatchObject({
      ok: false,
      error: { code: 'MINIGAME_INVALID', details: { reason: 'badLog', code: 'TOO_DENSE' } },
    });
  });

  it('暂停恢复：未开局的会话换新窗口、新 sessionId 与新种子（旧种子可能已被本地空跑）；已开局的按已收到的输入结算', () => {
    const a = toMinigame();
    a.h.runner.pause();
    expect(a.h.runner.minigameInput(0, { sessionId: a.t.sessionId, seq: 0, events: [] })).toMatchObject({
      ok: false,
      error: { code: 'GAME_PAUSED' },
    });
    a.h.sched.advance(60_000);
    a.h.runner.resume();
    const t2 = a.h.runner.decisionFor(0)!.minigame!;
    expect(t2.sessionId).not.toBe(a.t.sessionId);
    expect(t2.decisionId).toBe(a.t.decisionId);
    expect(t2.seed).not.toBe(a.t.seed);
    expect(t2.seed).toBe(renewSeed(a.t.seed, t2.sessionId));
    expect(t2.seed >= 0 && t2.seed <= 0x7fffffff).toBe(true);
    expect(t2.startsAt).toBe(a.h.sched.now() + 3000);
    expect(a.h.runner.minigames.sessionById(a.t.sessionId)).toBeUndefined();
    expect(a.h.runner.minigames.sessionById(t2.sessionId)).toBeDefined();

    const b = toMinigame();
    const run = bot(b.t, 13);
    const part = run.log.slice(0, 2);
    upload(b.h, b.t, part);
    b.h.runner.pause();
    b.h.sched.advance(5_000);
    b.h.runner.resume();
    expect(ended(b.h)).toMatchObject({ mode: 'played', score: replay(PENGUIN_SIM, b.t.seed, P, part).score });
  });

  it('托管座位：开局前由 AI 跳过；真人先开局则解除托管，AI 不再代答', () => {
    const { h, t } = toMinigame({ thinkMs: [8000, 8000] });
    expect(h.runner.setAutopilot(0, true).ok).toBe(true);
    at(h, t, 0);
    expect(h.runner.minigameInput(0, { sessionId: t.sessionId, seq: 0, events: [] }).ok).toBe(true);
    expect(h.runner.controlOf(0)).toBe('human');
    const n = h.rec.batches.length;
    h.sched.advance(10_000);
    expect(h.rec.batches.length).toBe(n);

    const b = toMinigame({ thinkMs: [0, 0] });
    expect(b.h.runner.setAutopilot(0, true).ok).toBe(true);
    b.h.sched.advance(b.h.rec.batches.at(-1)!.animMs + 1);
    expect(ended(b.h)).toMatchObject({ mode: 'skipped' });
    expect(b.h.rec.batches.at(-1)!.cause.by).toBe('autopilot');
  });
});

describe('MinigameReferee（纯逻辑）', () => {
  const ticket = (o: Partial<MinigameTicket> = {}): MinigameTicket => ({
    sessionId: 'mg-1-d1',
    decisionId: 'd1',
    seat: 2,
    minigameId: 'penguin',
    seed: 99,
    params: { ...P },
    tickMs: 100,
    introTicks: 10,
    maxTicks: 170,
    startsAt: 10_000,
    deadlineAt: 32_000,
    role: 'player',
    ...o,
  });

  it('被接受的消息原样作为帧转发，并留作迟到者的积压帧；settle 前后状态', () => {
    const ref = new MinigameReferee({ log: silentLogger, graceMs: GRACE });
    const s = ref.open(ticket());
    expect(ref.open(ticket())).toBe(s);
    expect(ref.settle('d1')).toEqual({ kind: 'decline' });
    const f0 = ref.input(2, { sessionId: 'mg-1-d1', seq: 0, events: [] }, 10_000);
    expect(f0).toEqual({ ok: true, data: { sessionId: 'mg-1-d1', seq: 0, events: [] } satisfies MinigameFramesMsg });
    const e: InputEvent = [12, InputCode.PickCell, 47];
    expect(ref.input(2, { sessionId: 'mg-1-d1', seq: 1, events: [e] }, 11_000).ok).toBe(true);
    expect(s.frames.map((f) => f.seq)).toEqual([0, 1]);
    expect(s.log).toEqual([e]);
    expect(ref.started('d1')).toBe(true);
    const r = ref.settle('d1');
    expect(r).toMatchObject({ kind: 'result', ...replay(PENGUIN_SIM, 99, P, [e]), logHash: hashLog([e]) });
    expect(ref.spectatorTicket(s)).toEqual({ ...ticket(), role: 'spectator' });
    // 截止之后
    expect(ref.input(2, { sessionId: 'mg-1-d1', seq: 2, events: [] }, 32_001)).toMatchObject({
      ok: false,
      error: { code: 'MINIGAME_TOO_LATE' },
    });
    ref.close('d1', { score: 5 });
    expect(ref.active()).toEqual([]);
    expect(ref.recentSettled()).toEqual([{ ticket: ticket(), log: [e], score: 5 }]);
  });

  it('提交超过截止 + 宽限返回 MINIGAME_TOO_LATE；未开局就关闭的会话不记入已结算', () => {
    const ref = new MinigameReferee({ log: silentLogger, graceMs: GRACE });
    ref.open(ticket());
    const msg = { sessionId: 'mg-1-d1', inputs: [], claimedScore: 0, finalHash: 0, clientElapsedMs: 0 };
    expect(ref.submit(2, msg, 32_000 + GRACE + 1)).toMatchObject({ ok: false, error: { code: 'MINIGAME_TOO_LATE' } });
    ref.close('d1', { score: 60 });
    expect(ref.recentSettled()).toEqual([]);
  });
});
