/**
 * 小游戏的联机流程（architecture §5.8、§5.10；design/minigames-ai.md §6）：真实 Socket.IO，stubEngine 与真实引擎各跑一遍。
 * - live：会话开启时其他座位与观战者收到观战票据（含种子、role=spectator），玩家本人收不到；输入实时转发为帧；
 *   迟到的观战者补收票据与积压帧；玩家重连补收自己的帧。
 * - 提交：服务器重放，MINIGAME_ENDED 的分数与重放一致（伪造的 claimedScore 不生效）。
 * - replay：不直播；结算后其他人收到带完整日志的观战票据。
 * 为了不等 17 秒，用种子推算出离起点最近的炸弹格，挖到即结束。
 */
import type { GameEvent } from '@rich4/shared/engine';
import { InputCode, type InputEvent, type MinigameTicket, PENGUIN_SIM, penguin, replay } from '@rich4/shared/minigames';
import type { MinigameFramesMsg, MinigameWatchMsg } from '@rich4/shared/net';
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

function watches(b: BotClient): MinigameWatchMsg[] {
  return b.received.filter((m) => m.event === 'game:minigameWatch').map((m) => m.payload as MinigameWatchMsg);
}

function frames(b: BotClient): MinigameFramesMsg[] {
  return b.received.filter((m) => m.event === 'game:minigameFrames').map((m) => m.payload as MinigameFramesMsg);
}

function endedOf(b: BotClient): Extract<GameEvent, { type: 'MINIGAME_ENDED' }> | undefined {
  for (const batch of b.batches) {
    const e = batch.events.find((x) => x.type === 'MINIGAME_ENDED');
    if (e) return e as Extract<GameEvent, { type: 'MINIGAME_ENDED' }>;
  }
  return undefined;
}

/** 离起点最近的炸弹格：点它 → 走过去 → 挖到炸弹立即结束 */
function bombRun(t: MinigameTicket): { log: InputEvent[]; score: number; endTick: number; hash: number } {
  const s = PENGUIN_SIM.init(t.seed, t.params);
  let best = -1;
  let bestLen = Number.POSITIVE_INFINITY;
  for (const c of penguin.VALID_CELLS) {
    if (s.board[c] !== penguin.ITEM_BOMB || c === s.cell) continue;
    const p = penguin.tracePath(s.cell, c);
    if (p.digAt === c && p.path.length < bestLen) {
      best = c;
      bestLen = p.path.length;
    }
  }
  expect(best).toBeGreaterThanOrEqual(0);
  const log: InputEvent[] = [[t.introTicks, InputCode.PickCell, best]];
  return { log, ...replay(PENGUIN_SIM, t.seed, t.params, log) };
}

/** 让座位 0 停在小游戏格（stub：6 → 7；真实引擎：15 → 16 企鹅挖宝） */
async function landOnMinigame(host: BotClient): Promise<MinigameTicket> {
  const node = srv!.engineKind === 'stub' ? { node: 6 } : { node: 15, prev: 14 };
  expect((await host.req('debug:act', { op: { op: 'teleport', seat: 0, ...node } })).ok).toBe(true);
  expect((await host.req('debug:act', { op: { op: 'forceNext', purpose: 'dice', values: [1] } })).ok).toBe(true);
  await host.until(() => host.yourDecision?.kind === 'TURN_MENU', 3000, 'menu');
  expect((await host.act(host.yourDecision!.decisionId, { type: 'ROLL' })).ok).toBe(true);
  await host.until(() => host.yourDecision?.kind === 'MINIGAME', 3000, 'MINIGAME decision');
  const t = host.yourDecision!.minigame!;
  expect(t).toMatchObject({ seat: 0, minigameId: 'penguin', role: 'player' });
  return t;
}

async function waitUntil(ms: number): Promise<void> {
  const d = ms - Date.now();
  if (d > 0) await sleep(d);
}

async function game(spectate: 'live' | 'replay') {
  srv = await startTestServer({ rateLimitScale: 0 });
  const s = await setupRoom(srv.url, { humans: 2, settings: { timerPreset: 'off', minigameSpectate: spectate } });
  bots.push(...s.bots);
  const spec = await connectBot(srv.url, { nickname: 'W' });
  bots.push(spec);
  expect((await spec.req('room:join', { code: s.code, role: 'spectator' })).ok).toBe(true);
  await startGame(s, [spec]);
  return { s, host: s.host, p1: s.bots[1]!, spec };
}

describe('integration/minigame', () => {
  it('live：票据只给其他人与观战者；输入实时转发；迟到者补收；提交以服务器重放为准', async () => {
    const { s, host, p1, spec } = await game('live');
    const t = await landOnMinigame(host);
    await spec.until(() => watches(spec).length > 0, 3000, 'watch');
    await p1.until(() => watches(p1).length > 0, 3000, 'watch');
    const w = watches(spec)[0]!;
    expect(w).toEqual({ ticket: { ...t, role: 'spectator' }, mode: 'live', log: null });
    expect(watches(p1)[0]!.ticket.seed).toBe(t.seed);
    expect(watches(host)).toEqual([]);
    expect(watches(spec)).toHaveLength(1);

    const run = bombRun(t);
    await waitUntil(t.startsAt);
    expect(await host.req('game:minigameInput', { sessionId: t.sessionId, seq: 0, events: [] })).toEqual({
      ok: true,
      data: undefined,
    });
    await waitUntil(t.startsAt + (run.log[0]![0] + 1) * t.tickMs);
    expect((await host.req('game:minigameInput', { sessionId: t.sessionId, seq: 1, events: run.log })).ok).toBe(true);
    await spec.until(() => frames(spec).length >= 2, 3000, 'frames');
    expect(frames(spec)).toEqual([
      { sessionId: t.sessionId, seq: 0, events: [] },
      { sessionId: t.sessionId, seq: 1, events: run.log },
    ]);
    await p1.until(() => frames(p1).length >= 2, 3000, 'frames');
    expect(frames(host)).toEqual([]);
    // 开局后不能再跳过
    expect(await host.act(t.decisionId, { type: 'MINIGAME_DECLINE' })).toMatchObject({
      ok: false,
      error: { code: 'MINIGAME_INVALID' },
    });

    // 迟到的观战者：补收票据与积压帧
    const late = await connectBot(srv!.url, { nickname: 'L' });
    bots.push(late);
    expect((await late.req('room:join', { code: s.code, role: 'spectator' })).ok).toBe(true);
    await late.until(() => frames(late).length >= 2, 3000, 'late frames');
    expect(watches(late)).toHaveLength(1);
    expect(late.received.findIndex((m) => m.event === 'game:snapshot')).toBeLessThan(
      late.received.findIndex((m) => m.event === 'game:minigameWatch'),
    );

    // 玩家重连：补收自己的帧（续玩）
    const r = await host.reconnect(s.code);
    expect(r.ok).toBe(true);
    await host.until(() => frames(host).length >= 2, 3000, 'own frames');
    expect(host.yourDecision?.minigame?.sessionId).toBe(t.sessionId);

    // 提交：伪造的分数不生效
    await waitUntil(t.startsAt + run.endTick * t.tickMs);
    const sub = await host.req('game:minigameSubmit', {
      sessionId: t.sessionId,
      inputs: run.log,
      claimedScore: 188,
      finalHash: 0,
      clientElapsedMs: run.endTick * t.tickMs,
    });
    expect(sub).toEqual({ ok: true, data: { score: run.score } });
    for (const b of [host, p1, spec, late]) {
      await b.until(() => endedOf(b) !== undefined, 3000, 'MINIGAME_ENDED');
      expect(endedOf(b)).toMatchObject({ seat: 0, mode: 'played', score: run.score });
    }
    // 结算后的输入：会话已关闭
    expect(await host.req('game:minigameInput', { sessionId: t.sessionId, seq: 2, events: [] })).toMatchObject({
      ok: false,
      error: { code: 'MINIGAME_INVALID' },
    });
    // 观战者不能提交输入
    expect(await spec.req('game:minigameInput', { sessionId: t.sessionId, seq: 0, events: [] })).toMatchObject({
      ok: false,
      error: { code: 'NOT_A_PLAYER' },
    });
  });

  it('replay：不直播；结算后其他人收到带完整日志的观战票据', async () => {
    const { host, p1, spec } = await game('replay');
    const t = await landOnMinigame(host);
    const run = bombRun(t);
    await waitUntil(t.startsAt);
    expect((await host.req('game:minigameInput', { sessionId: t.sessionId, seq: 0, events: [] })).ok).toBe(true);
    await waitUntil(t.startsAt + (run.log[0]![0] + 1) * t.tickMs);
    expect((await host.req('game:minigameInput', { sessionId: t.sessionId, seq: 1, events: run.log })).ok).toBe(true);
    await sleep(50);
    expect(watches(spec)).toEqual([]);
    expect(frames(spec)).toEqual([]);
    await waitUntil(t.startsAt + run.endTick * t.tickMs);
    const sub = await host.req('game:minigameSubmit', {
      sessionId: t.sessionId,
      inputs: run.log,
      claimedScore: run.score,
      finalHash: run.hash,
      clientElapsedMs: 0,
    });
    expect(sub).toEqual({ ok: true, data: { score: run.score } });
    for (const b of [p1, spec]) {
      await b.until(() => watches(b).length > 0, 3000, 'replay watch');
      expect(watches(b)).toEqual([{ ticket: { ...t, role: 'spectator' }, mode: 'replay', log: run.log }]);
    }
    expect(watches(host)).toEqual([]);
  });
});
