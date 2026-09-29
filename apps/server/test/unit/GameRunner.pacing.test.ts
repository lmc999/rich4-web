/**
 * 演出节奏（original-skin.md U3、§3 修正 1）：GameRunner 按房间 pacing 估算每批 animMs，截止时间与 AI 行动前的等待都随之变化。
 * 桩引擎：从 4 号格强制 6 点走到 10 号卡片格（CARD_GAINED source 'square'，original 下按原版 FLIC 495 放宽），随后 1 号座位的回合菜单出现。
 */
import type { EngineApi, GameEvent } from '@rich4/shared/engine';
import type { PacingProfile } from '@rich4/shared/net';
import { estimateAnimMs, eventBudgetMs } from '@rich4/shared/view';
import { describe, expect, it } from 'vitest';
import { makeRunner } from '../helpers/runnerHarness';
import { CARD_TILE } from '../helpers/stubEngine';

const MENU_MS = 30_000;
const GRACE = 800;
const PROFILES: readonly PacingProfile[] = ['original', 'compact'];

/** 0 号座位传送到卡片格前 6 格，强制 6 点走到卡片格 */
function rollToCardSquare(h: ReturnType<typeof makeRunner>) {
  const tp = h.runner.submitSystem({
    type: 'SYS_DEBUG',
    op: { op: 'teleport', seat: 0, node: CARD_TILE - 6, prev: CARD_TILE - 7 },
  });
  expect(tp.ok).toBe(true);
  h.forceDice(6);
  expect(h.act(0, { type: 'ROLL' }).ok).toBe(true);
  const raw = h.rec.batches.at(-1)!;
  expect(raw.events.some((e) => e.type === 'CARD_GAINED' && e.source === 'square')).toBe(true);
  return raw;
}

/** 包一层引擎：每次 applyAction 在事件末尾追加一个送医院事件（救护车 FLIC 6.2 s） */
function withHospital(e: EngineApi): EngineApi {
  const hospital: GameEvent = {
    type: 'CONFINED',
    actor: { t: 'seat', seat: 0 },
    where: 'hospital',
    days: 3,
    total: 3,
    cause: { k: 'object', ref: null, by: null },
  };
  return {
    ENGINE_VERSION: e.ENGINE_VERSION,
    STATE_SCHEMA_VERSION: e.STATE_SCHEMA_VERSION,
    createGame: (...a) => e.createGame(...a),
    applyAction: (s, a) => {
      const r = e.applyAction(s, a);
      return { ...r, events: [...r.events, hospital] };
    },
    getPendingDecisions: (s) => e.getPendingDecisions(s),
    getResult: (s) => e.getResult(s),
    validateState: (s): s is never => e.validateState(s),
    migrateState: (s, v) => e.migrateState(s, v),
  };
}

describe('GameRunner：按房间演出节奏计时', () => {
  it.each(PROFILES)('%s：animMs = estimateAnimMs(events, pacing)，截止时间 = now + animMs + 超时', (pacing) => {
    const h = makeRunner({ settings: { pacing } });
    h.sched.advance(1000);
    const raw = rollToCardSquare(h);
    expect(raw.animMs).toBe(estimateAnimMs(raw.events, pacing));
    const next = h.pendingOf(1)!;
    expect(next.kind).toBe('TURN_MENU');
    expect(h.runner.deadlineOf(next.id)).toBe(h.sched.now() + raw.animMs + MENU_MS);
    // 补发给重连者的也是同一个 animMs
    expect(h.runner.rawBatches().at(-1)!.animMs).toBe(raw.animMs);
  });

  it('同一批事件：original 比 compact 多出卡片 FLIC 与掷骰演出（速度 1 对速度 2）的差额，截止时间随之后移', () => {
    const run = (pacing: PacingProfile) => {
      const h = makeRunner({ settings: { pacing } });
      const raw = rollToCardSquare(h);
      return { raw, deadline: h.runner.deadlineOf(h.pendingOf(1)!.id)!, now: h.sched.now() };
    };
    const o = run('original');
    const c = run('compact');
    expect(o.raw.events).toEqual(c.raw.events);
    let diff = 0;
    for (const t of ['CARD_GAINED', 'DICE_ROLLED'] as const) {
      const e = o.raw.events.find((x) => x.type === t)!;
      const d = eventBudgetMs(e, 'original') - eventBudgetMs(e, 'compact');
      expect(d, t).toBeGreaterThan(0);
      diff += d;
    }
    expect(o.raw.animMs - c.raw.animMs).toBe(diff);
    expect(o.deadline - o.now - (c.deadline - c.now)).toBe(diff);
  });

  it('长 FLIC（救护车 6.2 s）：original 的截止时间按原长扣除，compact 按紧凑预算', () => {
    for (const pacing of PROFILES) {
      const h = makeRunner({ settings: { pacing }, wrapEngine: withHospital });
      h.forceDice(1);
      expect(h.act(0, { type: 'ROLL' }).ok).toBe(true);
      const raw = h.rec.batches.at(-1)!;
      expect(raw.animMs).toBe(estimateAnimMs(raw.events, pacing));
      const hospital = raw.events.at(-1)!;
      expect(eventBudgetMs(hospital, pacing)).toBe(pacing === 'original' ? 6650 : 1500);
      const d = h.runner.pendingViews()[0]!;
      expect(d.deadlineAt).toBe(h.sched.now() + raw.animMs + (d.kind === 'TURN_MENU' ? MENU_MS : 15_000));
    }
  });

  it.each(PROFILES)('%s：AI 行动前等完这一批（按节奏估算的）动画', (pacing) => {
    const h = makeRunner({
      settings: { pacing },
      players: [
        { seat: 0, character: 0, controller: 'human' },
        { seat: 1, character: 1, controller: 'ai' },
      ],
    });
    const raw = rollToCardSquare(h);
    expect(raw.animMs).toBe(estimateAnimMs(raw.events, pacing));
    const n = h.rec.batches.length;
    // 思考时间为 0（夹具）：动画播完之前 AI 不行动，到点立即行动
    h.sched.advance(raw.animMs - 1);
    expect(h.rec.batches).toHaveLength(n);
    h.sched.advance(1);
    expect(h.rec.batches).toHaveLength(n + 1);
    expect(h.rec.batches.at(-1)!.cause).toMatchObject({ seat: 1, by: 'ai' });
  });

  it('真人超时：到 now + animMs + 超时 + 网络宽限才执行默认操作（两种节奏）', () => {
    for (const pacing of PROFILES) {
      const h = makeRunner({ settings: { pacing } });
      const raw = rollToCardSquare(h);
      const n = h.rec.batches.length;
      h.sched.advance(raw.animMs + MENU_MS + GRACE - 1);
      expect(h.rec.batches).toHaveLength(n);
      h.sched.advance(1);
      expect(h.rec.batches.at(-1)!.cause).toEqual({ seat: 1, intentType: 'ROLL', by: 'timeout' });
    }
  });
});
