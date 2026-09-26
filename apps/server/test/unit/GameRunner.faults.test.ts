/**
 * GameRunner 回归：提交原子性与定时器兜底、暂停不消耗计时链、解除托管失败补发 pending、AI 接手时等剩余动画。
 */
import type { EngineApi } from '@rich4/shared/engine';
import { describe, expect, it } from 'vitest';
import { RealScheduler } from '../../src/infra/clock';
import { makeRunner } from '../helpers/runnerHarness';

const GRACE = 800;

/** 包一层引擎：failPending 置位时下一次 getPendingDecisions 抛 TypeError（非规则异常） */
function flakyEngine() {
  const ctl = { failPending: 0, failResult: 0 };
  const wrap = (e: EngineApi): EngineApi => ({
    ENGINE_VERSION: e.ENGINE_VERSION,
    STATE_SCHEMA_VERSION: e.STATE_SCHEMA_VERSION,
    createGame: (...a) => e.createGame(...a),
    applyAction: (s, a) => e.applyAction(s, a),
    getPendingDecisions: (s) => {
      if (ctl.failPending > 0) {
        ctl.failPending--;
        throw new TypeError('injected getPendingDecisions failure');
      }
      return e.getPendingDecisions(s);
    },
    getResult: (s) => {
      if (ctl.failResult > 0) {
        ctl.failResult--;
        throw new TypeError('injected getResult failure');
      }
      return e.getResult(s);
    },
    validateState: (s): s is never => e.validateState(s),
    migrateState: (s, v) => e.migrateState(s, v),
  });
  return { ctl, wrap };
}

describe('GameRunner：提交原子性', () => {
  it('getPendingDecisions / getResult 抛异常：返回 INTERNAL，state、seq、journal、ring 全部不变，决策照常可用', () => {
    const f = flakyEngine();
    const h = makeRunner({ wrapEngine: f.wrap });
    const d = h.pendingOf(0)!;
    const st = h.runner.state;
    for (const k of ['failPending', 'failResult'] as const) {
      f.ctl[k] = 1;
      expect(h.act(0, { type: 'ROLL' })).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
      expect(h.runner.state).toBe(st);
      expect(h.runner.seq).toBe(0);
      expect(h.runner.journal()).toHaveLength(0);
      expect(h.runner.rawBatches()).toHaveLength(0);
      expect(h.rec.batches).toHaveLength(0);
      expect(h.pendingOf(0)?.id).toBe(d.id);
    }
    // 原决策仍然有效，重新提交成功
    expect(h.act(0, { type: 'ROLL' }).ok).toBe(true);
    expect(h.runner.seq).toBe(1);
  });

  it('超时路径中引擎抛异常：不外抛，执行 defaultIntent 失败后通知暂停（aiStuck），状态不变', () => {
    const f = flakyEngine();
    const h = makeRunner({ wrapEngine: f.wrap });
    f.ctl.failPending = 1;
    expect(() => h.sched.advance(30_000 + GRACE)).not.toThrow();
    expect(h.rec.stuck).toEqual([0]);
    expect(h.runner.seq).toBe(0);
    expect(h.rec.timedOut).toEqual([{ seat: 0, by: 'default' }]);
  });

  it('AI 路径：第一次提交遇到引擎异常退回 defaultIntent 重试成功，不外抛', () => {
    const f = flakyEngine();
    const h = makeRunner({
      wrapEngine: f.wrap,
      players: [
        { seat: 0, character: 0, controller: 'ai' },
        { seat: 1, character: 1, controller: 'human' },
      ],
    });
    f.ctl.failPending = 1;
    expect(() => h.sched.advance(10)).not.toThrow();
    expect(h.rec.batches).toHaveLength(1);
    expect(h.rec.batches[0]!.cause).toMatchObject({ seat: 0, by: 'ai' });
    expect(h.rec.stuck).toEqual([]);
  });

  it('提交后的广播 hooks 抛异常（定时器路径）：不外抛，action 已生效，报告 fault 并暂停', () => {
    const h = makeRunner({ batchThrows: () => true });
    expect(() => h.sched.advance(30_000 + GRACE)).not.toThrow();
    expect(h.runner.seq).toBe(1);
    expect(h.rec.batches).toHaveLength(1);
    expect(h.rec.faults).toEqual([0]);
    expect(h.runner.paused).toBe(true);
  });

  it('RealScheduler：回调抛出的异常交给 onError，不变成 uncaughtException', async () => {
    const errors: unknown[] = [];
    const rs = new RealScheduler((e) => errors.push(e));
    await new Promise<void>((resolve) => {
      rs.after(0, () => {
        throw new Error('boom');
      });
      rs.after(20, resolve);
    });
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toMatch(/boom/);
  });
});

describe('GameRunner：暂停与 TURN_MENU 计时链', () => {
  it('暂停不计入整回合 90 秒上限：恢复后的菜单操作继承剩余时间，不会立刻超时', () => {
    const h = makeRunner();
    const t0 = h.sched.now();
    const d = h.pendingOf(0)!;
    expect(h.runner.deadlineOf(d.id)! - t0).toBe(30_000);
    h.sched.advance(5000);
    h.runner.pause();
    h.sched.advance(120_000);
    h.runner.resume();
    expect(h.runner.deadlineOf(d.id)! - h.sched.now()).toBe(25_000);
    expect(h.act(0, { type: 'STOCK_BUY', stock: 0, shares: 1 }).ok).toBe(true);
    const anim = h.rec.batches.at(-1)!.animMs;
    const d2 = h.pendingOf(0)!;
    expect(d2.budgetKey).toBe(d.budgetKey);
    expect(h.runner.deadlineOf(d2.id)! - h.sched.now()).toBe(Math.max(25_000, anim + 8000));
    h.sched.advance(GRACE + 100);
    expect(h.rec.timedOut).toEqual([]);

    // 整回合上限顺延了暂停时长：首次可见 t0 + 暂停 120s + 90s
    for (let i = 0; i < 20; i++) {
      const cur = h.pendingOf(0)!;
      const dl = h.runner.deadlineOf(cur.id)!;
      h.sched.advance(Math.max(0, dl - h.sched.now() - 100));
      expect(h.act(0, { type: 'STOCK_BUY', stock: 0, shares: 1 }).ok).toBe(true);
    }
    expect(h.runner.deadlineOf(h.pendingOf(0)!.id)).toBe(t0 + 120_000 + 90_000);
    expect(h.rec.timedOut).toEqual([]);
  });
});

describe('GameRunner：解除托管与动画', () => {
  it('托管中的真人提交被引擎拒绝：托管已解除，补发 pendingChanged', () => {
    const h = makeRunner({ thinkMs: [3000, 3000] });
    expect(h.runner.setAutopilot(0, true).ok).toBe(true);
    expect(h.runner.pendingViews()[0]!.control).toBe('autopilot:manual');
    const before = h.rec.pendingChanged;
    const r = h.act(0, { type: 'STOCK_BUY', stock: 0, shares: 999_999 });
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID_ACTION' } });
    expect(h.runner.controlOf(0)).toBe('human');
    expect(h.rec.pendingChanged).toBe(before + 1);
    expect(h.runner.pendingViews()[0]!.control).toBe('human');
    expect(h.rec.batches).toHaveLength(0);
  });

  it('动画播放中切到托管：AI 先等剩余动画再思考，不抢跑', () => {
    const h = makeRunner({ thinkMs: [400, 400] });
    h.forceDice(3);
    expect(h.act(0, { type: 'ROLL' }).ok).toBe(true);
    const raw = h.rec.batches.at(-1)!;
    expect(raw.animMs).toBeGreaterThan(1000);
    expect(h.pendingOf(0)!.kind).toBe('AUCTION_BID');
    h.sched.advance(1000);
    h.runner.setAutopilot(0, true);
    const n = h.rec.batches.length;
    h.sched.advance(raw.animMs - 1000 + 399);
    expect(h.rec.batches).toHaveLength(n);
    h.sched.advance(1);
    expect(h.rec.batches).toHaveLength(n + 1);
    expect(h.rec.batches.at(-1)!.cause).toMatchObject({ seat: 0, by: 'autopilot' });
  });

  it('动画已播完再切托管：只等思考时间', () => {
    const h = makeRunner({ thinkMs: [400, 400] });
    h.forceDice(3);
    h.act(0, { type: 'ROLL' });
    const raw = h.rec.batches.at(-1)!;
    h.sched.advance(raw.animMs + 2000);
    h.runner.setAutopilot(0, true);
    const n = h.rec.batches.length;
    h.sched.advance(400);
    expect(h.rec.batches).toHaveLength(n + 1);
  });
});
