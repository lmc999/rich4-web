/**
 * 有效计时档位（design/net.md §5.4）：只有一名真人、其余座位都是电脑时不限时（同单机）；对局中真人离开 / 被踢
 * 使真人座位只剩一名时取消当前决策的截止时间，离开的真人回来后从现在起按档位重新计时。托管中的真人仍算真人；
 * 已淘汰（破产、投降）的真人不算。
 */
import type { EngineApi, GameState, PlayerSetup, SeatIndex } from '@rich4/shared/engine';
import { describe, expect, it } from 'vitest';
import { makeRunner } from '../helpers/runnerHarness';

const MENU_MS = 30_000;
const CONFIRM_MS = 15_000;
const GRACE = 800;
const LONG = 10 * 60_000;

/** humans 个真人（座位 0..humans-1），其余座位电脑 */
function seats(humans: number): PlayerSetup[] {
  return ([0, 1, 2, 3] as const).map((seat) => ({
    seat,
    character: seat,
    controller: seat < humans ? ('human' as const) : ('ai' as const),
  }));
}

/**
 * 包装引擎：系统 action「SYS_DEBUG setPoints seat=1 points=0」之后把座位 1 标为投降出局（模拟别人的决策进行中
 * 有真人被淘汰；stub 引擎只会在自己回合付不起过路费时破产，那时别的座位没有待决策）
 */
function withSurrender(e: EngineApi): EngineApi {
  return {
    ENGINE_VERSION: e.ENGINE_VERSION,
    STATE_SCHEMA_VERSION: e.STATE_SCHEMA_VERSION,
    createGame: (...a) => e.createGame(...a),
    applyAction: (s, a) => {
      const r = e.applyAction(s, a);
      if (a.type !== 'SYS_DEBUG' || a.op.op !== 'setPoints' || a.op.seat !== 1 || a.op.points !== 0) return r;
      const state: GameState = structuredClone(r.state);
      const p = state.players.find((x) => x.seat === 1)!;
      p.alive = false;
      p.out = 'surrender';
      state.pending = state.pending.filter((d) => d.seat !== 1);
      return { ...r, state };
    },
    getPendingDecisions: (s) => e.getPendingDecisions(s),
    getResult: (s) => e.getResult(s),
    validateState: (s): s is never => e.validateState(s),
    migrateState: (s, v) => e.migrateState(s, v),
  };
}

describe('GameRunner：只有一名真人时不限时', () => {
  it('一名真人 + 三个电脑：开局即不限时，截止时间为 null，久等也不超时；之后的决策同样不计时', () => {
    const h = makeRunner({ players: seats(1) });
    expect(h.runner.effectiveTimerPreset()).toBe('off');
    const d = h.pendingOf(0)!;
    expect(d.kind).toBe('TURN_MENU');
    expect(h.runner.deadlineOf(d.id)).toBeNull();
    expect(h.runner.pendingViews()[0]!.deadlineAt).toBeNull();
    expect(h.runner.decisionFor(0)!.deadlineAt).toBeNull();
    h.sched.advance(LONG);
    expect(h.rec.batches).toHaveLength(0);
    expect(h.rec.timedOut).toEqual([]);

    h.forceDice(1);
    expect(h.act(0, { type: 'ROLL' }).ok).toBe(true);
    const buy = h.pendingOf(0)!;
    expect(buy.kind).toBe('BUY_LAND');
    expect(h.runner.deadlineOf(buy.id)).toBeNull();
    const n = h.rec.batches.length;
    h.sched.advance(LONG);
    expect(h.rec.batches).toHaveLength(n);
    expect(h.runner.controlOf(0)).toBe('human');
  });

  it('两名真人 + 两个电脑：按房间档位计时', () => {
    const h = makeRunner({ players: seats(2), settings: { timerPreset: 'fast' } });
    const t0 = h.sched.now();
    expect(h.runner.effectiveTimerPreset()).toBe('fast');
    const d = h.pendingOf(0)!;
    expect(h.runner.deadlineOf(d.id)).toBe(t0 + MENU_MS / 2);
    h.sched.advance(MENU_MS / 2 + GRACE);
    expect(h.rec.timedOut).toEqual([{ seat: 0, by: 'default' }]);
  });

  it('单机（房间档位 off）：真人再多也不计时', () => {
    const h = makeRunner({ settings: { timerPreset: 'off' } });
    expect(h.runner.effectiveTimerPreset()).toBe('off');
    expect(h.runner.deadlineOf(h.pendingOf(0)!.id)).toBeNull();
  });

  it('两名真人中一人离开：当前决策的截止时间取消、之后不再给；离开的人回来后从现在起按档位重新计时', () => {
    const h = makeRunner({ players: seats(2) });
    const t0 = h.sched.now();
    const menu = h.pendingOf(0)!;
    expect(h.runner.deadlineOf(menu.id)).toBe(t0 + MENU_MS);
    h.sched.advance(5000);
    const pc = h.rec.pendingChanged;
    h.runner.leave(1);
    expect(h.runner.controlOf(1)).toBe('autopilot:left');
    expect(h.runner.effectiveTimerPreset()).toBe('off');
    expect(h.runner.deadlineOf(menu.id)).toBeNull();
    expect(h.runner.pendingViews()[0]!.deadlineAt).toBeNull();
    expect(h.runner.decisionFor(0)!.deadlineAt).toBeNull();
    // 走现有的「截止时间变化」通道：game:pending
    expect(h.rec.pendingChanged).toBe(pc + 1);
    h.sched.advance(LONG);
    expect(h.rec.batches).toHaveLength(0);
    expect(h.rec.timedOut).toEqual([]);

    h.forceDice(1);
    expect(h.act(0, { type: 'ROLL' }).ok).toBe(true);
    const raw = h.rec.batches.at(-1)!;
    const buy = h.pendingOf(0)!;
    expect(buy.kind).toBe('BUY_LAND');
    expect(h.runner.deadlineOf(buy.id)).toBeNull();

    // 同一 token room:resume 回来：两名真人，从现在（动画已播完）起按档位给完整时限
    h.sched.advance(raw.animMs + 3000);
    h.runner.setConnected(1, true);
    expect(h.runner.controlOf(1)).toBe('human');
    expect(h.runner.effectiveTimerPreset()).toBe('normal');
    const back = h.sched.now();
    expect(h.runner.deadlineOf(buy.id)).toBe(back + CONFIRM_MS);
    expect(h.runner.pendingViews()[0]!.deadlineAt).toBe(back + CONFIRM_MS);
    h.sched.advance(CONFIRM_MS + GRACE - 1);
    expect(h.rec.timedOut).toEqual([]);
    h.sched.advance(1);
    expect(h.rec.timedOut).toEqual([{ seat: 0, by: 'default' }]);
  });

  it('变回有时限时这批动画还没播完：从动画播完时起算', () => {
    const h = makeRunner({ players: seats(2) });
    h.runner.leave(1);
    h.forceDice(1);
    expect(h.act(0, { type: 'ROLL' }).ok).toBe(true);
    const raw = h.rec.batches.at(-1)!;
    expect(raw.animMs).toBeGreaterThan(1000);
    const shown = h.sched.now();
    h.sched.advance(500);
    h.runner.setConnected(1, true);
    expect(h.runner.deadlineOf(h.pendingOf(0)!.id)).toBe(shown + raw.animMs + CONFIRM_MS);
  });

  it('被踢（转为电脑）后只剩一名真人：踢人那一批之后就不限时', () => {
    const h = makeRunner({ players: seats(2) });
    const menu = h.pendingOf(0)!;
    expect(h.runner.deadlineOf(menu.id)).not.toBeNull();
    h.runner.kick(1);
    expect(h.runner.controlOf(1)).toBe('ai');
    expect(h.runner.effectiveTimerPreset()).toBe('off');
    expect(h.runner.deadlineOf(menu.id)).toBeNull();
    const n = h.rec.batches.length;
    h.sched.advance(LONG);
    expect(h.rec.batches).toHaveLength(n);
  });

  it('托管中的真人仍算真人：手动托管、断线托管期间另一名真人照常计时', () => {
    const h = makeRunner({ players: seats(2) });
    const t0 = h.sched.now();
    const menu = h.pendingOf(0)!;
    expect(h.runner.setAutopilot(1, true).ok).toBe(true);
    expect(h.runner.controlOf(1)).toBe('autopilot:manual');
    expect(h.runner.effectiveTimerPreset()).toBe('normal');
    expect(h.runner.deadlineOf(menu.id)).toBe(t0 + MENU_MS);
    expect(h.runner.setAutopilot(1, false).ok).toBe(true);

    h.runner.setConnected(1, false);
    h.sched.advance(15_000);
    expect(h.runner.controlOf(1)).toBe('autopilot:disconnect');
    expect(h.runner.effectiveTimerPreset()).toBe('normal');
    expect(h.runner.deadlineOf(menu.id)).toBe(t0 + MENU_MS);
    h.sched.advance(MENU_MS - 15_000 + GRACE);
    expect(h.rec.timedOut).toEqual([{ seat: 0, by: 'default' }]);
  });

  it('连续超时进 AFK 托管的真人仍算真人', () => {
    const h = makeRunner({ players: seats(2), thinkMs: [5000, 5000] });
    // 座位 0 连续两次超时（掷骰、买地）进 autopilot:afk
    h.forceDice(1);
    h.sched.advance(MENU_MS + GRACE);
    const buy = h.pendingOf(0)!;
    h.sched.advance(h.runner.deadlineOf(buy.id)! - h.sched.now() + GRACE);
    expect(h.runner.controlOf(0)).toBe('autopilot:afk');
    expect(h.runner.effectiveTimerPreset()).toBe('normal');
  });

  it('只剩的一名真人断线：照断线宽限转托管（同单机）', () => {
    const h = makeRunner({ players: seats(1), thinkMs: [1000, 1000] });
    const t0 = h.sched.now();
    h.runner.setConnected(0, false);
    // 不限时，但断线宽限照常：给别人看的截止时间是宽限结束
    expect(h.runner.pendingViews()[0]!.deadlineAt).toBe(t0 + 15_000);
    h.sched.advance(15_000);
    expect(h.runner.controlOf(0)).toBe('autopilot:disconnect');
    expect(h.runner.effectiveTimerPreset()).toBe('off');
    h.sched.advance(1000);
    expect(h.rec.batches[0]!.cause).toEqual({ seat: 0, intentType: 'ROLL', by: 'autopilot' });
  });

  it('暂停中有人离开：恢复后仍不限时；暂停中离开的人回来，恢复后按档位给完整时限', () => {
    const h = makeRunner({ players: seats(2) });
    const menu = h.pendingOf(0)!;
    h.sched.advance(20_000);
    h.runner.pause();
    h.runner.leave(1);
    h.sched.advance(LONG);
    h.runner.resume();
    expect(h.runner.deadlineOf(menu.id)).toBeNull();
    h.runner.pause();
    h.runner.setConnected(1, true);
    expect(h.runner.controlOf(1)).toBe('human');
    h.sched.advance(60_000);
    h.runner.resume();
    expect(h.runner.deadlineOf(menu.id)).toBe(h.sched.now() + MENU_MS);
  });

  it('开局时已离开的座位（重启恢复的快照控制方式）不算真人', () => {
    const players = seats(2);
    const h = makeRunner({
      players,
      seats: players.map((p) => ({
        seat: p.seat as SeatIndex,
        control: p.controller === 'ai' ? 'ai' : p.seat === 1 ? 'autopilot:left' : 'human',
        connected: p.seat !== 1,
      })),
    });
    expect(h.runner.effectiveTimerPreset()).toBe('off');
    expect(h.runner.deadlineOf(h.pendingOf(0)!.id)).toBeNull();
  });

  it('TURN_MENU 计时链在重新计时后从头开始：之后的菜单操作按新链继承', () => {
    const h = makeRunner({ players: seats(2) });
    h.runner.leave(1);
    h.sched.advance(40_000);
    h.runner.setConnected(1, true);
    const t1 = h.sched.now();
    const d = h.pendingOf(0)!;
    expect(h.runner.deadlineOf(d.id)).toBe(t1 + MENU_MS);
    h.sched.advance(5000);
    expect(h.act(0, { type: 'STOCK_BUY', stock: 0, shares: 1 }).ok).toBe(true);
    const anim = h.rec.batches.at(-1)!.animMs;
    const d2 = h.pendingOf(0)!;
    expect(d2.budgetKey).toBe(d.budgetKey);
    expect(h.runner.deadlineOf(d2.id)).toBe(Math.max(t1 + MENU_MS, h.sched.now() + anim + 8000));
  });
  it('两名真人中一人破产出局（仍算真人控制方式）：之后另一名真人不限时；出局者关页面转断线托管也不再计时，不会被 AFK 托管', () => {
    const h = makeRunner({ players: seats(2) });
    expect(h.runner.effectiveTimerPreset()).toBe('normal');
    // 座位 0 买下 L1（格 2）
    h.forceDice(1);
    expect(h.act(0, { type: 'ROLL' }).ok).toBe(true);
    expect(h.pendingOf(0)!.kind).toBe('BUY_LAND');
    expect(h.act(0, { type: 'CONFIRM' }).ok).toBe(true);
    // 座位 1 身无分文，也落到 L1：付不起过路费而破产
    const menu1 = h.pendingOf(1)!;
    expect(menu1.kind).toBe('TURN_MENU');
    expect(h.runner.deadlineOf(menu1.id)).not.toBeNull();
    expect(
      h.runner.submitSystem({ type: 'SYS_DEBUG', op: { op: 'setCash', seat: 1, cash: 0, deposit: null } }).ok,
    ).toBe(true);
    h.forceDice(1);
    const before = h.rec.batches.length;
    expect(h.act(1, { type: 'ROLL' }).ok).toBe(true);
    const raw = h.rec.batches.at(-1)!;
    expect(raw.events.some((e) => e.type === 'BANKRUPT' && e.seat === 1)).toBe(true);
    const p1 = h.runner.state.players.find((p) => p.seat === 1)!;
    expect(p1.alive).toBe(false);
    expect(p1.out).toBe('bankrupt');
    // 控制方式仍是 human（没离开、没被踢），但已不在局中：只剩一名真人
    expect(h.runner.controlOf(1)).toBe('human');
    expect(h.runner.effectiveTimerPreset()).toBe('off');
    // 先通知房间（room:state 带新的有效档位），再发这一批
    expect(h.rec.presetChanges).toEqual([{ preset: 'off', batches: before }]);

    // 出局者关掉页面：断线宽限后转托管（仍是真人控制方式），不影响判定
    h.runner.setConnected(1, false);
    h.sched.advance(15_000);
    expect(h.runner.controlOf(1)).toBe('autopilot:disconnect');
    expect(h.runner.effectiveTimerPreset()).toBe('off');

    // 电脑走完各自的回合，轮到座位 0（或电脑发起的拍卖里座位 0 要出价）：不限时，久等也不超时、不进 AFK 托管
    h.sched.advance(LONG);
    const mine = h.pendingOf(0)!;
    expect(mine).toBeDefined();
    expect(h.runner.deadlineOf(mine.id)).toBeNull();
    expect(h.runner.pendingViews().find((v) => v.seat === 0)!.deadlineAt).toBeNull();
    expect(h.runner.decisionFor(0)!.deadlineAt).toBeNull();
    h.sched.advance(LONG);
    expect(h.rec.timedOut).toEqual([]);
    expect(h.runner.controlOf(0)).toBe('human');
    expect(h.rec.presetChanges).toHaveLength(1);
  });

  it('别人的决策进行中有真人被淘汰（投降）：当前决策的截止时间立即取消，不再超时', () => {
    const h = makeRunner({ players: seats(2), wrapEngine: withSurrender });
    const t0 = h.sched.now();
    const menu = h.pendingOf(0)!;
    expect(h.runner.deadlineOf(menu.id)).toBe(t0 + MENU_MS);
    h.sched.advance(5000);
    const before = h.rec.batches.length;
    expect(h.runner.submitSystem({ type: 'SYS_DEBUG', op: { op: 'setPoints', seat: 1, points: 0 } }).ok).toBe(true);
    expect(h.runner.state.players.find((p) => p.seat === 1)!.out).toBe('surrender');
    // 同一个决策（没有换 id），截止时间取消
    expect(h.pendingOf(0)!.id).toBe(menu.id);
    expect(h.runner.effectiveTimerPreset()).toBe('off');
    expect(h.runner.deadlineOf(menu.id)).toBeNull();
    expect(h.runner.pendingViews()[0]!.deadlineAt).toBeNull();
    expect(h.rec.presetChanges).toEqual([{ preset: 'off', batches: before }]);
    h.sched.advance(LONG);
    expect(h.rec.timedOut).toEqual([]);
    expect(h.rec.batches).toHaveLength(before + 1);
  });

  it('三名真人中一人出局：还剩两名真人，照常计时，不通知房间', () => {
    const h = makeRunner({ players: seats(3), wrapEngine: withSurrender });
    const t0 = h.sched.now();
    const menu = h.pendingOf(0)!;
    expect(h.runner.submitSystem({ type: 'SYS_DEBUG', op: { op: 'setPoints', seat: 1, points: 0 } }).ok).toBe(true);
    expect(h.runner.effectiveTimerPreset()).toBe('normal');
    expect(h.runner.deadlineOf(menu.id)).toBe(t0 + MENU_MS);
    expect(h.rec.presetChanges).toEqual([]);
  });
});
