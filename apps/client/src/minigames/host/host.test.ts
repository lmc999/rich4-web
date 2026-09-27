// 宿主的纯逻辑（client-unit）：定步循环按服务器时间对齐、最近 tick 归属的回滚与从头重放一致、
// 输入记录一定能通过服务器的 validateLog、上传分批规则、观战流的重组与定格。
import {
  BALLOON_SIM,
  type BalloonState,
  InputCode,
  type InputEvent,
  PENGUIN_SIM,
  replay,
  validateLog,
  XICONG_SIM,
} from '@rich4/shared/minigames';
import { MINIGAME_INPUT_FLUSH_MS } from '@rich4/shared/net';
import { describe, expect, it } from 'vitest';
import { FixedStepLoop, MAX_CATCH_UP } from './FixedStepLoop';
import { InputRecorder, MINIGAME_HEARTBEAT_MS } from './InputRecorder';
import { SPECTATOR_STALL_MS, SpectatorFeed } from './SpectatorFeed';

const P = { ruleset: 'exe311' } as const;
const none = () => [] as InputEvent[];

describe('FixedStepLoop', () => {
  it('按服务器时间换算 tick：开局前 0；每帧最多补 10 个；到硬上限为止', () => {
    const loop = new FixedStepLoop(PENGUIN_SIM, 7, P, { tickMs: 100, startsAt: 1000 });
    expect(loop.targetTick(500)).toBe(0);
    expect(loop.advance(999, none)).toBe(0);
    expect(loop.advance(1099, none)).toBe(0);
    expect(loop.advance(1100, none)).toBe(1);
    expect(loop.curr.tick).toBe(1);
    expect(loop.advance(1000 + 100 * 50, none)).toBe(MAX_CATCH_UP);
    expect(loop.curr.tick).toBe(11);
    expect(loop.alpha(1000 + 1150)).toBeCloseTo(0.5);
    for (let i = 0; i < 30; i++) loop.advance(1000 + 100 * 1000, none);
    expect(loop.canStep).toBe(false);
    expect(loop.curr.tick).toBe(160);
    expect(loop.alpha(0)).toBe(1);
  });

  it('redoLast 与从头重放同一日志的结果完全相同（最近 tick 归属的回滚）', () => {
    const loop = new FixedStepLoop(BALLOON_SIM, 20260927, P, { tickMs: 100, startsAt: 0 });
    const rec = new InputRecorder(BALLOON_SIM.spec);
    // 跑到有气球升起，然后在每个 tick 用「上一 tick」回滚点击一个气球
    let t = 0;
    let hits = 0;
    while (loop.canStep && t < 220) {
      t++;
      loop.advance(t * 100, (k) => rec.inputsAt(k));
      const s = loop.prev as BalloonState;
      const slot = s.x.findIndex((x, i) => x !== 0 && s.pop[i] === 0 && s.y[i]! < 400);
      if (slot >= 0 && loop.curr.tick >= 1 && rec.canRecord(loop.curr.tick - 1) && t % 3 === 0) {
        const e: InputEvent = [loop.curr.tick - 1, InputCode.Click, s.x[slot]!, s.y[slot]!];
        if (rec.record(e)) {
          loop.redoLast(rec.inputsAt(loop.curr.tick - 1));
          hits++;
        }
      }
    }
    expect(hits).toBeGreaterThan(3);
    expect(validateLog(BALLOON_SIM.spec, rec.log)).toBeNull();
    const fresh = BALLOON_SIM.init(20260927, P);
    const cursor = { i: 0 };
    while (fresh.tick < loop.curr.tick) {
      const inputs: InputEvent[] = [];
      while (cursor.i < rec.log.length && rec.log[cursor.i]![0] === fresh.tick) inputs.push(rec.log[cursor.i++]!);
      BALLOON_SIM.step(fresh, inputs);
    }
    expect(BALLOON_SIM.hash(fresh)).toBe(BALLOON_SIM.hash(loop.curr));
    // 表现提示里有补发的 pop
    const fx = loop.drainFx();
    expect(fx.some((f) => f.t === 'pop')).toBe(true);
  });

  it('rebuild 从头重放到指定 tick', () => {
    const log: InputEvent[] = [
      [12, InputCode.CursorX, 100],
      [40, InputCode.CursorX, 500],
    ];
    const a = new FixedStepLoop(XICONG_SIM, 3, P, { tickMs: 50, startsAt: 0 });
    const feed = (k: number) => log.filter((e) => e[0] === k);
    for (let i = 0; i < 10; i++) a.advance(50 * 60, feed);
    const h = XICONG_SIM.hash(a.curr);
    a.rebuild(60, feed);
    expect(a.curr.tick).toBe(60);
    expect(XICONG_SIM.hash(a.curr)).toBe(h);
    expect(a.drainFx()).toEqual([]);
  });
});

describe('InputRecorder', () => {
  it('本地限流：每 tick 与每秒条数、单调；记录下来的日志一定通过 validateLog', () => {
    const rec = new InputRecorder(BALLOON_SIM.spec);
    let ok = 0;
    for (let t = 5; t < 60; t++) for (let k = 0; k < 6; k++) if (rec.record([t, InputCode.Click, 40 + k, 100])) ok++;
    expect(ok).toBeLessThan(55 * 6);
    expect(validateLog(BALLOON_SIM.spec, rec.log)).toBeNull();
    expect(rec.record([10, InputCode.Click, 1, 1])).toBe(false);
    expect(rec.record([70, InputCode.Click, 700, 1])).toBe(false);
    expect(rec.countAt(59)).toBeLessThanOrEqual(BALLOON_SIM.spec.maxInputsPerTick);
  });

  it('上传：seq 0 立即发；有输入时 200ms 或 8 条一批；空闲 1 秒心跳；同一时刻一批在路上', () => {
    const rec = new InputRecorder(PENGUIN_SIM.spec);
    const b0 = rec.takeBatch(0);
    expect(b0).toEqual({ seq: 0, events: [] });
    expect(rec.takeBatch(1000)).toBeNull();
    rec.settle(0, { ok: true });
    expect(rec.takeBatch(100)).toBeNull();
    rec.record([12, InputCode.PickCell, 47]);
    expect(rec.takeBatch(100)).toBeNull();
    const b1 = rec.takeBatch(MINIGAME_INPUT_FLUSH_MS);
    expect(b1).toEqual({ seq: 1, events: [[12, InputCode.PickCell, 47]] });
    // 传输失败：原样重发
    rec.settle(1, { ok: false, code: 'INTERNAL', transient: true });
    expect(rec.takeBatch(MINIGAME_INPUT_FLUSH_MS * 2)).toEqual(b1);
    // ack 丢了、服务器已经在等 seq 2
    rec.settle(1, { ok: false, code: 'seq', expected: 2 });
    expect(rec.uploaded).toBe(1);
    expect(rec.takeBatch(MINIGAME_INPUT_FLUSH_MS * 2 + 10)).toBeNull();
    const hb = rec.takeBatch(MINIGAME_INPUT_FLUSH_MS * 2 + MINIGAME_HEARTBEAT_MS);
    expect(hb).toEqual({ seq: 2, events: [] });
    // 其他拒绝：停止上传
    rec.settle(2, { ok: false, code: 'MINIGAME_INVALID' });
    expect(rec.uploadStopped).toBe(true);
    expect(rec.takeBatch(1e9, true)).toBeNull();
  });

  it('传输失败后又记了新输入：重发的仍是原来那一批；ack 丢了时按服务器的 logLength 对齐', () => {
    const rec = new InputRecorder(PENGUIN_SIM.spec);
    rec.takeBatch(0);
    rec.settle(0, { ok: true });
    rec.record([6, InputCode.PickCell, 10]);
    rec.record([7, InputCode.PickCell, 11]);
    rec.record([8, InputCode.PickCell, 12]);
    const b1 = rec.takeBatch(MINIGAME_INPUT_FLUSH_MS)!;
    expect(b1.events).toHaveLength(3);
    // 服务器其实收下了 b1，但 ack 在断线时以错误回调
    rec.settle(1, { ok: false, code: 'INTERNAL', transient: true });
    rec.record([9, InputCode.PickCell, 13]);
    rec.record([10, InputCode.PickCell, 14]);
    expect(rec.takeBatch(MINIGAME_INPUT_FLUSH_MS + 10)).toBeNull();
    const again = rec.takeBatch(MINIGAME_INPUT_FLUSH_MS * 2)!;
    expect(again).toEqual({ seq: 1, events: b1.events });
    rec.settle(1, { ok: false, code: 'seq', expected: 2, logLength: 3 });
    expect(rec.uploaded).toBe(3);
    const b2 = rec.takeBatch(MINIGAME_INPUT_FLUSH_MS * 3)!;
    expect(b2).toEqual({
      seq: 2,
      events: [
        [9, InputCode.PickCell, 13],
        [10, InputCode.PickCell, 14],
      ],
    });
    // 服务器与客户端的日志前缀一致
    rec.settle(2, { ok: true });
    expect(rec.uploaded).toBe(rec.log.length);
  });

  it('续玩：恢复服务器已接受的帧，seq 接着走', () => {
    const rec = new InputRecorder(PENGUIN_SIM.spec);
    rec.restore([
      { seq: 0, events: [] },
      { seq: 1, events: [[12, InputCode.PickCell, 47]] },
    ]);
    expect(rec.log).toEqual([[12, InputCode.PickCell, 47]]);
    expect(rec.seq).toBe(2);
    expect(rec.uploaded).toBe(1);
    rec.record([30, InputCode.PickCell, 30]);
    expect(rec.takeBatch(0)).toEqual({ seq: 2, events: [[30, InputCode.PickCell, 30]] });
    expect(replay(PENGUIN_SIM, 5, P, rec.log).endTick).toBeGreaterThan(0);
  });
});

describe('SpectatorFeed', () => {
  it('按 seq 重组乱序帧；迟到的输入要求从头重放；超过 2 秒没有新帧定格', () => {
    const f = new SpectatorFeed(0);
    f.push({ seq: 1, events: [[20, InputCode.PickCell, 30]] }, 10, 0);
    expect(f.log).toEqual([]);
    f.push({ seq: 0, events: [[12, InputCode.PickCell, 47]] }, 20, 0);
    expect(f.log.map((e) => e[0])).toEqual([12, 20]);
    expect(f.receivedSeq).toBe(2);
    expect(f.takeRewind()).toBe(false);
    f.push({ seq: 2, events: [[25, InputCode.PickCell, 31]] }, 30, 40);
    expect(f.takeRewind()).toBe(true);
    expect(f.takeRewind()).toBe(false);
    expect(f.inputsAt(20)).toEqual([[20, InputCode.PickCell, 30]]);
    expect(f.stalled(30 + SPECTATOR_STALL_MS)).toBe(false);
    expect(f.stalled(31 + SPECTATOR_STALL_MS)).toBe(true);
    f.setComplete(f.log.slice());
    expect(f.stalled(1e9)).toBe(false);
    expect(f.bufferedNow(1000)).toBe(700);
  });
});
