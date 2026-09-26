// EventPlayer（design/client.md §12.1）：串行播放、提交时机、倍速与自动追帧、skipAll、断档 resync、
// 决策框在动画播完后才出现、instant、catchup、game:pending 覆盖、TIME_REWOUND 直达、开发对账告警。
import type { GameEvent } from '@rich4/shared/engine';
import type { GameBatchMsg, YourDecision } from '@rich4/shared/net';
import type { GameView, PendingView } from '@rich4/shared/view';
import { beforeEach, describe, expect, it } from 'vitest';
import { AnimClock } from '../game/anim/AnimClock';
import { selfPlay } from '../test/selfPlay';
import { AUTO_FAST_BACKLOG_MS, EventPlayer, type EventPlayerSink, firstDiff } from './EventPlayer';
import type { HandlerMap, PresentationContext } from './types';

interface Rec {
  log: string[];
  views: GameView[];
  batches: { seq: number; decision: YourDecision | null; pending: PendingView[] }[];
  resets: number;
  resyncs: number;
  warns: string[];
}

/** 所有事件 handler 都记录开始 / 结束，并按 ms 等待时钟 */
function harness(ms = 100) {
  const clock = new AnimClock();
  const rec: Rec = { log: [], views: [], batches: [], resets: 0, resyncs: 0, warns: [] };
  const handler = async (e: GameEvent, ctx: PresentationContext): Promise<void> => {
    rec.log.push(`start:${e.type}`);
    await ctx.wait(ms);
    rec.log.push(`end:${e.type}`);
  };
  const handlers = new Proxy({}, { get: () => handler }) as HandlerMap;
  const sink: EventPlayerSink = {
    reset: () => {
      rec.resets++;
    },
    commitView: (v, e) => {
      rec.views.push(v);
      rec.log.push(`commit:${e.type}`);
    },
    commitBatch: (b) => {
      rec.batches.push({ seq: b.seq, decision: b.decision, pending: b.pending });
      rec.log.push(`batch:${b.seq}`);
    },
    commitPending: (pending, decision) => rec.batches.push({ seq: -1, decision, pending }),
    setAnim: () => {},
  };
  const player = new EventPlayer({
    handlers,
    clock,
    sink,
    dev: true,
    warn: (m) => rec.warns.push(m),
    requestResync: () => {
      rec.resyncs++;
    },
    context: (signal) => ({ signal, wait: (x: number) => clock.wait(x, signal) }) as unknown as PresentationContext,
  });
  /** 推进时钟直到空闲（每步 16ms） */
  const drain = async (maxMs = 60_000): Promise<void> => {
    for (let t = 0; t < maxMs && !player.idle; t += 16) {
      clock.advance(16);
      await Promise.resolve();
      await Promise.resolve();
    }
  };
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { clock, rec, player, drain, flush };
}

const sp = selfPlay({ seed: 3, steps: 40 });
const firstWithDecision = sp.batches.findIndex((b) => b.yourDecision && b.events.length > 1);

function batch(i: number): GameBatchMsg {
  return sp.batches[i]!;
}

describe('EventPlayer', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
    h.player.reset(sp.initial);
  });

  it('串行播放：handler 依次执行，每个事件播完才提交显示态，批尾提交 view / pending', async () => {
    h.player.enqueue(batch(0));
    h.player.enqueue(batch(1));
    await h.drain();
    const types = [...batch(0).events, ...batch(1).events].map((e) => e.type);
    const expected = [
      ...batch(0).events.flatMap((e) => [`start:${e.type}`, `end:${e.type}`, `commit:${e.type}`]),
      'batch:1',
      ...batch(1).events.flatMap((e) => [`start:${e.type}`, `end:${e.type}`, `commit:${e.type}`]),
      'batch:2',
    ];
    expect(types.length).toBeGreaterThan(2);
    expect(h.rec.log).toEqual(expected);
    expect(h.player.displayView).toEqual(batch(1).view);
    expect(h.rec.warns).toEqual([]);
  });

  it('决策框在动画播完后才出现：批尾之前 sink 收不到 yourDecision', async () => {
    expect(firstWithDecision).toBeGreaterThanOrEqual(0);
    for (let i = 0; i <= firstWithDecision; i++) h.player.enqueue(batch(i));
    // 刚入队：还没有任何批尾
    expect(h.rec.batches).toHaveLength(0);
    h.clock.advance(50);
    await h.flush();
    expect(h.rec.batches).toHaveLength(0);
    await h.drain();
    const last = h.rec.batches.at(-1)!;
    expect(last.seq).toBe(batch(firstWithDecision).seq);
    expect(last.decision?.decisionId).toBe(batch(firstWithDecision).yourDecision?.decisionId);
    // 决策提交在该批所有事件提交之后
    const idx = h.rec.log.lastIndexOf(`batch:${last.seq}`);
    const lastEv = batch(firstWithDecision).events.at(-1)!;
    expect(h.rec.log.lastIndexOf(`commit:${lastEv.type}`)).toBeLessThan(idx);
  });

  it('倍速：setSpeed 改变时钟速度；积压超过 6 秒自动 3 倍速', async () => {
    h.player.setSpeed(2);
    expect(h.clock.speed).toBe(2);
    h.player.setSpeed(1);
    const heavy: GameBatchMsg = { ...batch(0), animMs: AUTO_FAST_BACKLOG_MS + 500 };
    h.player.enqueue(heavy);
    await h.flush();
    expect(h.clock.speed).toBe(3);
    await h.drain();
    expect(h.clock.speed).toBe(1);
  });

  it('skipAll：中止当前 handler、清空积压，直达最新 view，不再调 handler', async () => {
    for (let i = 0; i < 4; i++) h.player.enqueue(batch(i));
    h.clock.advance(20);
    await h.flush();
    const started = h.rec.log.filter((x) => x.startsWith('start:')).length;
    expect(started).toBe(1);
    h.player.skipAll();
    await h.flush();
    await h.drain(200);
    expect(h.player.idle).toBe(true);
    expect(h.rec.log.filter((x) => x.startsWith('start:')).length).toBe(1);
    expect(h.player.displayView).toEqual(batch(3).view);
    expect(h.rec.batches.map((b) => b.seq)).toEqual([1, 2, 3, 4]);
  });

  it('单独一批很长不算落后（不跳过）；落后超过 15 秒才跳过', async () => {
    h.player.enqueue({ ...batch(0), animMs: 20_000 });
    await h.flush();
    expect(h.rec.log.filter((x) => x.startsWith('start:')).length).toBe(1);
    h.player.enqueue({ ...batch(1), animMs: 1000 });
    await h.flush();
    await h.drain(1000);
    expect(h.player.displayView).toEqual(batch(1).view);
    expect(h.rec.log.filter((x) => x.startsWith('start:')).length).toBe(1);
  });

  it('积压超过 5 批直接 skipAll', async () => {
    for (let i = 0; i < 7; i++) h.player.enqueue(batch(i));
    await h.drain(500);
    expect(h.player.displayView).toEqual(batch(6).view);
    // 只有第一个 handler 真正开始过
    expect(h.rec.log.filter((x) => x.startsWith('start:')).length).toBeLessThanOrEqual(1);
  });

  it('断档：seq 跳号或 epoch 不同 → 丢弃并只发一次 game:resync；重复 seq 忽略；reset 后恢复', async () => {
    h.player.enqueue(batch(0));
    h.player.enqueue(batch(0)); // 重复
    expect(h.rec.resyncs).toBe(0);
    h.player.enqueue(batch(2)); // 跳过 seq 2
    expect(h.rec.resyncs).toBe(1);
    h.player.enqueue(batch(3));
    h.player.enqueue({ ...batch(1), epoch: 99 });
    expect(h.rec.resyncs).toBe(1);
    await h.drain();
    expect(h.rec.batches.map((b) => b.seq)).toEqual([1]);
    // 服务器回快照
    h.player.reset({ epoch: 1, seq: 3, view: batch(2).view, pending: batch(2).pending });
    h.player.enqueue(batch(3));
    await h.drain();
    expect(h.rec.batches.at(-1)?.seq).toBe(4);
    expect(h.player.displayView).toEqual(batch(3).view);
  });

  it('instant：不调 handler，只提交', async () => {
    h.player.setInstant(true);
    for (let i = 0; i < 3; i++) h.player.enqueue(batch(i));
    await h.flush();
    await h.player.whenIdle();
    expect(h.rec.log.some((x) => x.startsWith('start:'))).toBe(false);
    expect(h.player.displayView).toEqual(batch(2).view);
    expect(h.clock.instant).toBe(true);
    h.player.setInstant(false);
    expect(h.clock.instant).toBe(false);
  });

  it('后台标签页（setHidden）：中止正在播放的 handler 并以 instant 追完', async () => {
    h.player.enqueue(batch(0));
    h.player.enqueue(batch(1));
    h.clock.advance(10);
    await h.flush();
    h.player.setHidden(true);
    await h.flush();
    await h.player.whenIdle();
    expect(h.player.displayView).toEqual(batch(1).view);
    expect(h.rec.log.filter((x) => x.startsWith('start:')).length).toBe(1);
  });

  it('catchup：≤8 批以 2–4 倍速补播；超过 8 批直接 reset', async () => {
    const small = {
      epoch: 1,
      batches: [batch(0), batch(1), batch(2)].map((b) => ({
        seq: b.seq,
        cause: b.cause,
        events: b.events,
        animMs: b.animMs,
      })),
      seq: 3,
      view: batch(2).view,
      pending: batch(2).pending,
      serverNow: 0,
    };
    h.player.catchup(small);
    await h.flush();
    expect(h.clock.speed).toBeGreaterThanOrEqual(2);
    expect(h.clock.speed).toBeLessThanOrEqual(4);
    await h.drain();
    expect(h.player.displayView).toEqual(batch(2).view);
    expect(h.rec.batches.map((b) => b.seq)).toEqual([3]); // 中间批次没有 view，不提交批尾
    const resets = h.rec.resets;
    const big = {
      epoch: 1,
      batches: sp.batches.slice(3, 13).map((b) => ({ seq: b.seq, cause: b.cause, events: b.events, animMs: b.animMs })),
      seq: 13,
      view: batch(12).view,
      pending: batch(12).pending,
      serverNow: 0,
    };
    h.player.catchup(big);
    expect(h.rec.resets).toBe(resets + 1);
    expect(h.player.displayView).toEqual(batch(12).view);
    expect(h.player.receivedSeq).toBe(13);
  });

  it('game:pending：空闲时立即提交；播放中推迟到对应批尾', async () => {
    h.player.applyPending({ epoch: 1, seq: 0, pending: [] });
    expect(h.rec.batches).toEqual([{ seq: -1, decision: null, pending: [] }]);
    h.player.enqueue(batch(0));
    const pv: PendingView[] = [{ ...(batch(0).pending[0] as PendingView), deadlineAt: 12345 }];
    h.player.applyPending({ epoch: 1, seq: 1, pending: pv });
    await h.drain();
    expect(h.rec.batches.at(-1)).toMatchObject({ seq: 1, pending: pv });
  });

  it('开发模式：批尾对账不一致时告警，并以 batch.view 为准', async () => {
    const bad: GameBatchMsg = {
      ...batch(0),
      view: { ...batch(0).view, clock: { ...batch(0).view.clock, turnNo: 999 } },
    };
    h.player.enqueue(bad);
    await h.drain();
    expect(h.rec.warns.some((w) => w.includes('批尾对账不一致') && w.includes('turnNo'))).toBe(true);
    expect(h.player.displayView?.clock.turnNo).toBe(999);
  });

  it('TIME_REWOUND（resetsView）：跳过其后事件，直接用批尾 view', async () => {
    const e = { type: 'TIME_REWOUND', bySeat: 0, toTurnNo: 1 } as GameEvent;
    const tail = { type: 'SYNC', reason: 'timeRewind' } as GameEvent;
    h.player.enqueue({ ...batch(0), events: [e, tail] });
    await h.drain();
    expect(h.rec.log).toContain('start:TIME_REWOUND');
    expect(h.rec.log).not.toContain('start:SYNC');
    expect(h.player.displayView).toEqual(batch(0).view);
    expect(h.rec.warns).toEqual([]);
  });

  it('handler 抛错不会卡住队列', async () => {
    const clock = new AnimClock();
    const warns: string[] = [];
    let commits = 0;
    const p = new EventPlayer({
      handlers: new Proxy({}, { get: () => async () => Promise.reject(new Error('boom')) }) as HandlerMap,
      clock,
      warn: (m) => warns.push(m),
      requestResync: () => {},
      context: (signal) => ({ signal }) as unknown as PresentationContext,
      sink: {
        reset: () => {},
        commitView: () => commits++,
        commitBatch: () => {},
        commitPending: () => {},
        setAnim: () => {},
      },
    });
    p.reset(sp.initial);
    p.enqueue(batch(0));
    await p.whenIdle();
    expect(commits).toBe(batch(0).events.length);
    expect(warns.some((w) => w.includes('handler 出错'))).toBe(true);
  });
});

describe('firstDiff', () => {
  it('相同返回 null；不同给出路径；undefined 与缺失视为相同', () => {
    expect(firstDiff({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBeNull();
    expect(firstDiff({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toContain('$.a[1].b');
    expect(firstDiff({ a: 1, u: undefined }, { a: 1 })).toBeNull();
    expect(firstDiff([1, 2], [1])).toContain('length');
  });
});
