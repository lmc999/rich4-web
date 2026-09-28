/**
 * 小游戏的联机流程（architecture §5.8、§5.10；design/minigames-ai.md §6）：真实 Socket.IO，stubEngine 与真实引擎各跑一遍。
 * - live：会话开启时其他座位与观战者收到观战票据（含种子、role=spectator），玩家本人收不到；输入实时转发为帧；
 *   迟到的观战者补收票据与积压帧；玩家重连补收自己的帧。
 * - 提交：服务器重放，MINIGAME_ENDED 的分数与重放一致（伪造的 claimedScore 不生效）。
 * - replay：不直播；结算后其他人收到带完整日志的观战票据。
 * 为了不等 17 秒，用种子推算出最快挖到炸弹的点格序列，挖到即结束。
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

/**
 * 最快挖到炸弹的点格序列：点格 → 走过去 → 挖到炸弹立即结束。
 * 企鹅按 DDA 直走，被无效格挡住或步数用完会提前停下来挖：约千分之一的种子里三颗炸弹都不能一步直达（种子随房间随机，
 * 曾因此偶发失败），所以按「从 x 点 c → 在 digAt 挖」建图，Dijkstra 找耗时最少的点格序列（多半一步，最多约 4 秒）。
 * 途中挖开的都不是炸弹、挖开只清宝物，图只由几何决定；相邻格一步可达、有效格连通，必有解。
 */
function bombRun(t: MinigameTicket): { log: InputEvent[]; score: number; endTick: number; hash: number } {
  const s = PENGUIN_SIM.init(t.seed, t.params);
  // dist：到达该格并挖完的 tick 数；via：上一格与这一步点的格
  const dist = new Map<number, number>([[s.cell, 0]]);
  const via = new Map<number, { from: number; pick: number }>();
  const done = new Set<number>();
  let goal = -1;
  for (;;) {
    let x = -1;
    for (const [c, d] of dist) if (!done.has(c) && (x < 0 || d < dist.get(x)!)) x = c;
    if (x < 0 || (x !== s.cell && s.board[x] === penguin.ITEM_BOMB)) {
      goal = x;
      break;
    }
    done.add(x);
    for (const c of penguin.VALID_CELLS) {
      if (c === x) continue;
      const p = penguin.tracePath(x, c);
      if (p.digAt === x) continue;
      const d = dist.get(x)! + p.path.length * penguin.TICKS_PER_CELL + penguin.DIG_TICKS;
      if (d < (dist.get(p.digAt) ?? Number.POSITIVE_INFINITY)) {
        dist.set(p.digAt, d);
        via.set(p.digAt, { from: x, pick: c });
      }
    }
  }
  expect(goal).toBeGreaterThanOrEqual(0);
  const picks: number[] = [];
  for (let c = goal; c !== s.cell; c = via.get(c)!.from) picks.unshift(via.get(c)!.pick);
  // 用 sim 本身排 tick：企鹅一可以接受点格就点下一格
  const log: InputEvent[] = [];
  while (!PENGUIN_SIM.isOver(s)) {
    const e: InputEvent[] =
      PENGUIN_SIM.accepting(s) && picks.length > 0 ? [[s.tick, InputCode.PickCell, picks.shift()!]] : [];
    log.push(...e);
    PENGUIN_SIM.step(s, e);
  }
  expect(s.endReason).toBe('bomb');
  return { log, ...replay(PENGUIN_SIM, t.seed, t.params, log) };
}

/** 让座位 0 停在小游戏格（stub：6 → 7；真实引擎：15 → 16 企鹅挖宝） */
async function landOnMinigame(host: BotClient): Promise<MinigameTicket> {
  const node = srv!.engineKind === 'stub' ? { node: 6 } : { node: 15, prev: 14 };
  // 真实引擎开局会在路上随机摆神明、恶犬等：先清场，免得落点附近的恶犬把人咬进医院、等不到 MINIGAME 决策
  if (srv!.engineKind !== 'stub') {
    expect((await host.req('debug:act', { op: { op: 'clearBoard' } })).ok).toBe(true);
    await host.until(() => host.yourDecision?.kind === 'TURN_MENU', 3000, 'menu after clearBoard');
  }
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
    // 整段日志一帧上传：等最后一条输入的 tick 过去（服务器拒收未来 tick）
    await waitUntil(t.startsAt + (run.log.at(-1)![0] + 1) * t.tickMs);
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
    await waitUntil(t.startsAt + (run.log.at(-1)![0] + 1) * t.tickMs);
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
