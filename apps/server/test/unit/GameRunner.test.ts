import type { AiPolicy } from '@rich4/shared/ai';
import type { GameEvent, GameState } from '@rich4/shared/engine';
import { canonicalJson } from '@rich4/shared/util';
import { describe, expect, it } from 'vitest';
import { makeRunner, TEST_SEED } from '../helpers/runnerHarness';

const MENU_MS = 30_000;
const CONFIRM_MS = 15_000;
const GRACE = 800;

describe('GameRunner：截止时间', () => {
  it('截止时间 = now + animMs + 超时（动画不占思考时间）', () => {
    const h = makeRunner();
    const t0 = h.sched.now();
    const d1 = h.pendingOf(0)!;
    expect(d1.kind).toBe('TURN_MENU');
    expect(h.runner.deadlineOf(d1.id)).toBe(t0 + MENU_MS);
    h.forceDice(1);
    h.sched.advance(2000);
    expect(h.act(0, { type: 'ROLL' }).ok).toBe(true);
    const raw = h.rec.batches.at(-1)!;
    expect(raw.animMs).toBeGreaterThan(0);
    const buy = h.pendingOf(0)!;
    expect(buy.kind).toBe('BUY_LAND');
    expect(h.runner.deadlineOf(buy.id)).toBe(h.sched.now() + raw.animMs + CONFIRM_MS);
    const pv = h.runner.pendingViews();
    expect(pv).toHaveLength(1);
    expect(pv[0]).toMatchObject({ seat: 0, kind: 'BUY_LAND', control: 'human', timing: 'confirm' });
  });

  it('到期（加网络宽限）后执行 defaultIntent，cause.by=timeout', () => {
    const h = makeRunner();
    h.sched.advance(MENU_MS + GRACE - 1);
    expect(h.rec.batches).toHaveLength(0);
    h.sched.advance(1);
    expect(h.rec.batches).toHaveLength(1);
    expect(h.rec.batches[0]!.cause).toEqual({ seat: 0, intentType: 'ROLL', by: 'timeout' });
    expect(h.rec.timedOut).toEqual([{ seat: 0, by: 'default' }]);
  });

  it('真人提交与超时竞态：只有先到的生效，后到的返回 STALE_DECISION', () => {
    const h = makeRunner();
    const d1 = h.pendingOf(0)!;
    h.sched.advance(MENU_MS + GRACE);
    expect(h.rec.batches).toHaveLength(1);
    const r = h.runner.submitPlayer(0, d1.id, { type: 'ROLL' }, null);
    expect(r).toMatchObject({ ok: false, error: { code: 'STALE_DECISION' } });

    const h2 = makeRunner();
    const e1 = h2.pendingOf(0)!;
    expect(h2.runner.submitPlayer(0, e1.id, { type: 'ROLL' }, null).ok).toBe(true);
    const n = h2.rec.batches.length;
    h2.sched.advance(MENU_MS + GRACE);
    expect(h2.rec.batches.filter((b) => b.cause.by === 'timeout' && b.seq <= n)).toHaveLength(0);
  });

  it('TURN_MENU 计时链：继承剩余时间，至少 8 秒，整回合不超过 90 秒', () => {
    const h = makeRunner();
    const t0 = h.sched.now();
    const d1 = h.pendingOf(0)!;
    expect(d1.budgetKey).not.toBeNull();
    h.sched.advance(10_000);
    expect(h.act(0, { type: 'STOCK_BUY', stock: 0, shares: 1 }).ok).toBe(true);
    const d2 = h.pendingOf(0)!;
    expect(d2.id).not.toBe(d1.id);
    expect(d2.budgetKey).toBe(d1.budgetKey);
    expect(h.runner.deadlineOf(d2.id)).toBe(t0 + MENU_MS);

    h.sched.advance(18_000);
    h.act(0, { type: 'STOCK_BUY', stock: 0, shares: 1 });
    const anim = h.rec.batches.at(-1)!.animMs;
    const d3 = h.pendingOf(0)!;
    expect(h.runner.deadlineOf(d3.id)).toBe(h.sched.now() + anim + 8000);

    for (let i = 0; i < 20; i++) {
      const cur = h.pendingOf(0)!;
      const dl = h.runner.deadlineOf(cur.id)!;
      h.sched.advance(Math.max(0, dl - h.sched.now() - 100));
      expect(h.act(0, { type: 'STOCK_BUY', stock: 0, shares: 1 }).ok).toBe(true);
    }
    const last = h.pendingOf(0)!;
    expect(h.runner.deadlineOf(last.id)).toBe(t0 + 90_000);
  });

  it('拍卖：多人并发决策各自计时，出价后其余人以新 id 重新计时', () => {
    const h = makeRunner();
    h.forceDice(3);
    h.act(0, { type: 'ROLL' });
    const raw = h.rec.batches.at(-1)!;
    expect(raw.events.some((e) => e.type === 'AUCTION_STARTED')).toBe(true);
    const bids = h.runner.pendingDecisions();
    expect(bids.map((d) => [d.seat, d.kind])).toEqual([
      [0, 'AUCTION_BID'],
      [1, 'AUCTION_BID'],
      [2, 'AUCTION_BID'],
      [3, 'AUCTION_BID'],
    ]);
    for (const d of bids) expect(h.runner.deadlineOf(d.id)).toBe(h.sched.now() + raw.animMs + 15_000);
    const old2 = h.pendingOf(2)!;

    h.sched.advance(5000);
    expect(h.act(1, { type: 'BID', inc: 0 }).ok).toBe(true);
    const anim = h.rec.batches.at(-1)!.animMs;
    const again = h.runner.pendingDecisions();
    expect(again.map((d) => d.seat)).toEqual([0, 2, 3]);
    for (const d of again) expect(h.runner.deadlineOf(d.id)).toBe(h.sched.now() + anim + 15_000);
    expect(h.runner.submitPlayer(2, old2.id, { type: 'PASS' }, null)).toMatchObject({
      ok: false,
      error: { code: 'STALE_DECISION' },
    });

    // seat 0 超时（PASS），另外两人主动 PASS → 成交
    h.act(2, { type: 'PASS' });
    h.act(3, { type: 'PASS' });
    h.sched.advance(15_000 + anim + GRACE);
    const ended = h.rec.batches.flatMap((b) => b.events).find((e) => e.type === 'AUCTION_ENDED');
    expect(ended).toMatchObject({ winner: 1 });
    expect(h.pendingOf(1)?.kind).toBe('TURN_MENU');
  });
});

describe('GameRunner：托管状态机', () => {
  it('连续 2 次超时进入 autopilot:afk，之后由 AI 代打；真人一次操作即解除', () => {
    const h = makeRunner({ thinkMs: [5000, 5000] });
    h.forceDice(1);
    h.sched.advance(MENU_MS + GRACE); // 超时 1：ROLL → BUY_LAND
    expect(h.pendingOf(0)?.kind).toBe('BUY_LAND');
    const buy = h.pendingOf(0)!;
    h.sched.advance(h.runner.deadlineOf(buy.id)! - h.sched.now() + GRACE); // 超时 2：DECLINE
    expect(h.rec.controls).toContainEqual({ seat: 0, control: 'autopilot:afk', prev: 'human' });
    expect(h.runner.controlOf(0)).toBe('autopilot:afk');

    // 其他三人主动掷骰，轮回 seat 0 后由 AI 代打（思考 5 秒）
    for (const s of [1, 2, 3] as const) {
      h.forceDice(2);
      h.act(s, { type: 'ROLL' });
      while (h.pendingOf(s)) h.act(s, { type: 'DECLINE' });
    }
    const menu = h.pendingOf(0)!;
    expect(menu.kind).toBe('TURN_MENU');
    // 真人在 AI 出手前操作：解除托管
    h.sched.advance(1000);
    expect(h.runner.submitPlayer(0, menu.id, { type: 'ROLL' }, 'x').ok).toBe(true);
    expect(h.runner.controlOf(0)).toBe('human');
    expect(h.rec.batches.at(-1)!.cause.by).toBe('player');
  });

  it('断线超过宽限转 autopilot:disconnect 由 AI 代打，重连后控制权回到真人', () => {
    const h = makeRunner({ thinkMs: [5000, 5000] });
    const t0 = h.sched.now();
    h.runner.setConnected(0, false);
    expect(h.runner.pendingViews()[0]!.deadlineAt).toBe(t0 + 15_000);
    h.sched.advance(15_000);
    expect(h.runner.controlOf(0)).toBe('autopilot:disconnect');
    h.sched.advance(2000);
    h.runner.setConnected(0, true);
    expect(h.runner.controlOf(0)).toBe('human');
    const d = h.pendingOf(0)!;
    expect(h.runner.deadlineOf(d.id)).toBeGreaterThanOrEqual(h.sched.now() + 10_000);
    h.sched.advance(4000);
    expect(h.rec.batches).toHaveLength(0);

    // 再次断线：截止时间（t0+30s）早于宽限结束，按普通超时执行 defaultIntent
    h.runner.setConnected(0, false);
    expect(h.runner.pendingViews()[0]!.deadlineAt).toBe(t0 + MENU_MS);
    h.sched.advance(15_000 + 5000);
    expect(h.rec.batches[0]!.cause).toEqual({ seat: 0, intentType: 'ROLL', by: 'timeout' });
  });

  it('断线宽限到期后由 AI 代打（cause.by=autopilot）', () => {
    const h = makeRunner({ thinkMs: [1000, 1000] });
    h.runner.setConnected(0, false);
    h.sched.advance(15_000 + 1000);
    expect(h.rec.batches[0]!.cause).toEqual({ seat: 0, intentType: 'ROLL', by: 'autopilot' });
  });

  it('手动托管 on/off', () => {
    const h = makeRunner({ thinkMs: [3000, 3000] });
    expect(h.runner.setAutopilot(0, true).ok).toBe(true);
    expect(h.runner.controlOf(0)).toBe('autopilot:manual');
    h.sched.advance(3000);
    expect(h.rec.batches.at(-1)!.cause.by).toBe('autopilot');
    expect(h.runner.setAutopilot(0, false).ok).toBe(true);
    expect(h.runner.controlOf(0)).toBe('human');
  });

  it('踢人：SYS_SET_CONTROLLER 转为纯电脑', () => {
    const h = makeRunner();
    h.runner.kick(0);
    expect(h.runner.controlOf(0)).toBe('ai');
    expect(h.runner.state.players[0]!.controller).toBe('ai');
    expect(h.rec.batches.at(-1)!.events.map((e) => e.type)).toContain('CONTROLLER_CHANGED');
    h.sched.advance(0);
    expect(h.rec.batches.at(-1)!.cause.by).toBe('ai');
  });

  it('AI 抛异常时退回 defaultIntent，连续 3 次失败通知暂停', () => {
    const throwing: AiPolicy = {
      id: 'basic',
      decide: () => {
        throw new Error('boom');
      },
    };
    const h = makeRunner({
      policy: throwing,
      players: [
        { seat: 0, character: 0, controller: 'ai' },
        { seat: 1, character: 1, controller: 'ai' },
      ],
    });
    for (let i = 0; i < 20 && h.rec.stuck.length === 0; i++) h.sched.runAll(1);
    expect(h.rec.batches[0]!.cause).toEqual({ seat: 0, intentType: 'ROLL', by: 'ai' });
    expect(h.rec.stuck).toHaveLength(1);
    // 每个座位各失败 3 次以内，最先累计到 3 次的座位被报告
    const seat = h.rec.stuck[0]!;
    expect(h.rec.batches.filter((b) => b.cause.seat === seat)).toHaveLength(3);
  });
});

describe('GameRunner：暂停、幂等、校验', () => {
  it('暂停保留剩余时间，恢复后至少 5 秒', () => {
    const h = makeRunner();
    h.sched.advance(10_000);
    h.runner.pause();
    expect(h.runner.pendingViews()[0]!.deadlineAt).toBeNull();
    expect(h.act(0, { type: 'ROLL' })).toMatchObject({ ok: false, error: { code: 'GAME_PAUSED' } });
    h.sched.advance(60_000);
    expect(h.rec.batches).toHaveLength(0);
    h.runner.resume();
    const d = h.pendingOf(0)!;
    expect(h.runner.deadlineOf(d.id)).toBe(h.sched.now() + 20_000);

    h.sched.advance(18_000);
    h.runner.pause();
    h.runner.resume();
    expect(h.runner.deadlineOf(d.id)).toBe(h.sched.now() + 5000);
    h.sched.advance(5000 + GRACE);
    expect(h.rec.batches).toHaveLength(1);
  });

  it('clientActionId 幂等：重复提交直接返回上次结果', () => {
    const h = makeRunner();
    const r1 = h.act(0, { type: 'ROLL' }, 'c-1');
    const d1 = h.rec.batches.length;
    const r2 = h.runner.submitPlayer(0, 'd1', { type: 'ROLL' }, 'c-1');
    expect(r2).toBe(r1);
    expect(h.rec.batches.length).toBe(d1);
  });

  it('NOT_YOUR_DECISION / STALE_DECISION / INVALID_ACTION，引擎拒绝时状态不变', () => {
    const h = makeRunner();
    const d = h.pendingOf(0)!;
    expect(h.runner.submitPlayer(1, d.id, { type: 'ROLL' }, null)).toMatchObject({
      ok: false,
      error: { code: 'NOT_YOUR_DECISION' },
    });
    expect(h.runner.submitPlayer(0, 'd999', { type: 'ROLL' }, null)).toMatchObject({
      ok: false,
      error: { code: 'STALE_DECISION' },
    });
    expect(h.runner.submitPlayer(0, d.id, { type: 'CONFIRM' }, null)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ACTION', details: { rule: 'INTENT_NOT_ALLOWED' } },
    });
    const before: GameState = h.runner.state;
    expect(h.act(0, { type: 'STOCK_BUY', stock: 0, shares: 99_999 })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ACTION', details: { rule: 'OUT_OF_RANGE' } },
    });
    expect(h.runner.state).toBe(before);
    expect(h.runner.seq).toBe(0);
  });
});

describe('GameRunner：小游戏票据', () => {
  it('startsAt = now + animMs + 3s，deadlineAt = startsAt + maxTicks×tickMs + 5s', () => {
    const h = makeRunner();
    h.forceDice(6);
    h.act(0, { type: 'ROLL' });
    const raw = h.rec.batches.at(-1)!;
    const you = h.runner.decisionFor(0)!;
    expect(you.kind).toBe('MINIGAME');
    const t = you.minigame!;
    expect(t.startsAt).toBe(h.sched.now() + raw.animMs + 3000);
    expect(t.deadlineAt).toBe(t.startsAt + 170 * 100 + 5000);
    expect(t).toMatchObject({ seat: 0, minigameId: 'penguin', role: 'player', tickMs: 100, maxTicks: 170 });
    expect(typeof t.seed).toBe('number');
    // 其他座位与观战者拿不到票据
    expect(h.runner.decisionFor(1)).toBeUndefined();
    expect(JSON.stringify(h.runner.pendingViews())).not.toContain(String(t.seed));
  });

  it('allowMinigameDecline=false 时拒绝 MINIGAME_DECLINE；到期按 decline 结算', () => {
    const h = makeRunner({ settings: { allowMinigameDecline: false } });
    h.forceDice(6);
    h.act(0, { type: 'ROLL' });
    expect(h.act(0, { type: 'MINIGAME_DECLINE' })).toMatchObject({
      ok: false,
      error: { details: { rule: 'MINIGAME_DECLINE_DISABLED' } },
    });
    const t = h.runner.decisionFor(0)!.minigame!;
    h.sched.advance(t.deadlineAt + GRACE - h.sched.now());
    const ended = h.rec.batches.at(-1)!.events.find((e) => e.type === 'MINIGAME_ENDED');
    expect(ended).toMatchObject({ seat: 0, mode: 'skipped' });
    expect(h.rec.batches.at(-1)!.cause.by).toBe('timeout');
  });
});

describe('GameRunner：补发、私密投影、结束、重放', () => {
  it('catchup 覆盖 (lastSeq, seq]；超出环形缓冲或 epoch 不同返回 null', () => {
    const h = makeRunner();
    for (let i = 0; i < 5; i++) {
      h.runner.submitSystem({ type: 'SYS_DEBUG', op: { op: 'setPoints', seat: 0, points: i } });
    }
    const c = h.runner.catchupMsg({ kind: 'spectator' }, 2, 1)!;
    expect(c.batches.map((b) => b.seq)).toEqual([3, 4, 5]);
    expect(c.seq).toBe(5);
    expect(h.runner.catchupMsg({ kind: 'spectator' }, 5, 1)!.batches).toEqual([]);
    expect(h.runner.catchupMsg({ kind: 'spectator' }, 2, 2)).toBeNull();
    expect(h.runner.catchupMsg({ kind: 'spectator' }, 6, 1)).toBeNull();
    for (let i = 0; i < 300; i++) {
      h.runner.submitSystem({ type: 'SYS_DEBUG', op: { op: 'setPoints', seat: 0, points: i } });
    }
    expect(h.runner.catchupMsg({ kind: 'spectator' }, 2, 1)).toBeNull();
    expect(h.runner.catchupMsg({ kind: 'spectator' }, h.runner.seq - 256, 1)!.batches).toHaveLength(256);
  });

  it('private 模式：卡片事件与 view 对他人脱敏，本人可见', () => {
    const h = makeRunner({ settings: { handVisibility: 'private' } });
    h.runner.submitSystem({ type: 'SYS_DEBUG', op: { op: 'teleport', seat: 0, node: 4 } });
    h.forceDice(6);
    h.act(0, { type: 'ROLL' });
    const raw = h.rec.batches.at(-1)!;
    const compose = h.runner.composeBatch(raw);
    const other = compose({ kind: 'seat', seat: 1 });
    const mine = compose({ kind: 'seat', seat: 0 });
    const spec = compose({ kind: 'spectator' });
    const card = (m: typeof other) =>
      (m.events.find((e) => e.type === 'CARD_GAINED') as Extract<GameEvent, { type: 'CARD_GAINED' }>).card;
    expect(card(mine)).not.toBeNull();
    expect(card(other)).toBeNull();
    expect(card(spec)).toBeNull();
    expect(mine.view.players[0]!.cards).toHaveLength(1);
    expect(other.view.players[0]!.cards).toBeNull();
    expect(other.view.players[0]!.cardCount).toBe(1);
    expect(mine.yourDecision).toBeUndefined();
    expect(compose({ kind: 'seat', seat: 1 }).yourDecision?.kind).toBe('TURN_MENU');
  });

  it('对局结束：发 game:over，清空计时器与待决策；journal 重放得到相同状态', () => {
    const h = makeRunner({ config: { timeLimitDays: 30 }, thinkMs: [0, 0] });
    for (const s of [0, 1, 2, 3] as const) h.runner.setAutopilot(s, true);
    h.sched.runAll(50_000);
    expect(h.rec.over).toHaveLength(1);
    expect(h.runner.over).toBe(true);
    expect(h.runner.pendingViews()).toEqual([]);
    expect(h.sched.pendingCount()).toBe(0);
    expect(h.rec.dayEnds).toBeGreaterThan(0);
    expect(h.rec.over[0]!.result.reason).toMatch(/timeLimit|lastStanding/);
    // seq 连续
    expect(h.rec.batches.map((b) => b.seq)).toEqual(h.rec.batches.map((_, i) => i + 1));

    let s = h.engine.createGame(h.config, h.players, TEST_SEED);
    for (const j of h.runner.journal()) s = h.engine.applyAction(s, j.action).state;
    expect(canonicalJson(s)).toBe(canonicalJson(h.runner.state));
  });
});
