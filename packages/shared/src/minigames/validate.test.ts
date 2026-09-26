import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BALLOON_SIM } from './balloon/sim';
import { MINIGAME_SIMS } from './index';
import { PENGUIN_SIM } from './penguin/sim';
import { replay } from './replay';
import {
  DEFAULT_MINIGAME_PARAMS,
  InputCode,
  type InputEvent,
  type LogValidationCode,
  MINIGAME_IDS,
  MINIGAME_MAX_LOG,
  type MinigameId,
  type MinigameSpec,
} from './types';
import { ticksPerSecond, validateInputForSpec, validateLog } from './validate';
import { XICONG_SIM } from './xicong/sim';

const P = DEFAULT_MINIGAME_PARAMS;

/** 一条合法事件（按游戏的输入码与范围） */
function eventArb(id: MinigameId): fc.Arbitrary<(tick: number) => InputEvent> {
  if (id === 'penguin') {
    return fc.integer({ min: 0, max: 80 }).map(
      (c) =>
        (t: number): InputEvent => [t, InputCode.PickCell, c],
    );
  }
  if (id === 'balloon') {
    return fc
      .tuple(fc.integer({ min: 0, max: 7 }), fc.integer({ min: -30, max: 30 }), fc.integer({ min: 0, max: 479 }))
      .map(
        ([lane, dx, y]) =>
          (t: number): InputEvent => [t, InputCode.Click, 40 + 80 * lane + dx, y],
      );
  }
  return fc.integer({ min: 0, max: 639 }).map(
    (x) =>
      (t: number): InputEvent => [t, InputCode.CursorX, x],
  );
}

/** 构造合法日志：tick 单调递增、每 tick ≤ maxInputsPerTick、任意 1 秒窗口 ≤ maxInputsPerSecond */
function legalLogArb(id: MinigameId): fc.Arbitrary<InputEvent[]> {
  const spec = MINIGAME_SIMS[id].spec;
  const w = ticksPerSecond(spec);
  return fc
    .array(
      fc.record({
        gap: fc.integer({ min: 0, max: 15 }),
        n: fc.integer({ min: 1, max: spec.maxInputsPerTick }),
        make: fc.array(eventArb(id), { minLength: spec.maxInputsPerTick, maxLength: spec.maxInputsPerTick }),
      }),
      { maxLength: 120 },
    )
    .map((chunks) => {
      const log: InputEvent[] = [];
      let tick = -1;
      for (const c of chunks) {
        tick += Math.max(1, c.gap);
        if (tick >= spec.maxTicks) break;
        for (let j = 0; j < c.n; j++) {
          const inWindow = log.filter((e) => e[0] > tick - w).length;
          if (inWindow >= spec.maxInputsPerSecond) break;
          log.push(c.make[j]!(tick));
        }
      }
      return log;
    });
}

const idArb = fc.constantFrom(...MINIGAME_IDS);

describe('validateInputForSpec', () => {
  it('形状、code、范围、整数', () => {
    const spec = BALLOON_SIM.spec;
    expect(validateInputForSpec(spec, [0, InputCode.Click, 10, 10])).toBe(true);
    expect(validateInputForSpec(spec, [0, InputCode.Click, 10, 10.5])).toBe(false);
    expect(validateInputForSpec(spec, [0.5, InputCode.Click, 10, 10])).toBe(false);
    expect(validateInputForSpec(spec, [0, InputCode.Click, 10, 10, 1] as unknown as InputEvent)).toBe(false);
    expect(validateInputForSpec(spec, [0, 9, 10, 10] as unknown as InputEvent)).toBe(false);
    expect(validateInputForSpec(spec, [0, InputCode.Click, '10', 10] as unknown as InputEvent)).toBe(false);
    expect(validateInputForSpec(spec, null as unknown as InputEvent)).toBe(false);
    expect(validateInputForSpec(XICONG_SIM.spec, [0, InputCode.CursorX, 3, undefined])).toBe(true);
  });
});

describe('validateLog', () => {
  const pen = PENGUIN_SIM.spec;
  const bal = BALLOON_SIM.spec;
  const pc = (t: number, c = 47): InputEvent => [t, InputCode.PickCell, c];
  const expectCode = (spec: MinigameSpec, log: InputEvent[], code: LogValidationCode | null, index?: number) => {
    const r = validateLog(spec, log);
    if (code === null) expect(r).toBeNull();
    else expect(r).toEqual({ code, index: index ?? expect.any(Number) });
  };

  it('空日志合法；各种错误码与首个出错下标', () => {
    expectCode(pen, [], null);
    expectCode(pen, [pc(0), pc(0), pc(169)], null);
    expectCode(pen, [pc(3), pc(170)], 'BAD_TICK', 1);
    expectCode(pen, [pc(-1)], 'BAD_TICK', 0);
    expectCode(pen, [pc(1.5)], 'BAD_TICK', 0);
    expectCode(pen, [pc(5), pc(4)], 'NOT_MONOTONIC', 1);
    expectCode(pen, [pc(5), pc(6, 81)], 'BAD_INPUT', 1);
    expectCode(pen, [pc(5), [6, InputCode.Click, 1, 1]], 'BAD_INPUT', 1);
    expectCode(pen, [pc(5), pc(5), pc(5)], 'TOO_MANY_PER_TICK', 2);
    // 企鹅：窗口 10 tick 内最多 10 条；tick 0..4 各 2 条 = 10 条，tick 9 的第 11 条超密度，tick 10 时窗口已滑过 tick 0
    const dense = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4].map((t) => pc(t));
    expectCode(pen, [...dense, pc(9)], 'TOO_DENSE', 10);
    expectCode(pen, [...dense, pc(10), pc(10)], null);
    expectCode(pen, new Array(MINIGAME_MAX_LOG + 1).fill(pc(0)), 'TOO_LONG', MINIGAME_MAX_LOG);
    // 气球：每 tick 4 条、窗口 20 条
    const clicks: InputEvent[] = [];
    for (let t = 5; t < 10; t++) for (let k = 0; k < 4; k++) clicks.push([t, InputCode.Click, 40, 200]);
    expectCode(bal, clicks, null);
    expectCode(bal, [...clicks, [14, InputCode.Click, 1, 1]], 'TOO_DENSE', 20);
    expectCode(bal, [...clicks, [15, InputCode.Click, 1, 1]], null);
  });

  it('fast-check：构造的合法日志全部通过；重放确定、分数与 endTick 在范围内；中途 clone 续跑结果相同', () => {
    fc.assert(
      fc.property(
        idArb.chain((id) => fc.tuple(fc.constant(id), legalLogArb(id), fc.integer({ min: 0, max: 0xffffffff }))),
        ([id, log, seed]) => {
          const sim = MINIGAME_SIMS[id];
          expect(validateLog(sim.spec, log)).toBeNull();
          const a = replay(sim, seed, P, log);
          const b = replay(sim, seed, P, log);
          expect(b).toEqual(a);
          expect(a.score).toBeGreaterThanOrEqual(0);
          expect(a.score).toBeLessThanOrEqual(sim.spec.scoreSanityMax);
          expect(a.endTick).toBeLessThanOrEqual(sim.spec.maxTicks);
          // 在一半处 clone，clone 续跑与原状态续跑的哈希一致
          const s = sim.init(seed, P);
          const half = a.endTick >> 1;
          let i = 0;
          const inputsAt = (t: number) => {
            const out: InputEvent[] = [];
            while (i < log.length && log[i]![0] < t) i++;
            while (i < log.length && log[i]![0] === t) out.push(log[i++]!);
            return out;
          };
          while (s.tick < half) sim.step(s, inputsAt(s.tick));
          const c = sim.clone(s);
          const j = i;
          while (!sim.isOver(s) && s.tick < sim.spec.maxTicks) sim.step(s, inputsAt(s.tick));
          i = j;
          while (!sim.isOver(c) && c.tick < sim.spec.maxTicks) sim.step(c, inputsAt(c.tick));
          expect(sim.hash(c)).toBe(sim.hash(s));
          expect(sim.hash(s)).toBe(a.hash);
        },
      ),
      { numRuns: 300, seed: 20260927 },
    );
  });

  it('fast-check：非法日志（越界 tick、坏输入、乱序、单 tick 超量、超长）一律被拒', () => {
    type Mut = 'badTick' | 'badInput' | 'swap' | 'perTick' | 'tooLong';
    fc.assert(
      fc.property(
        idArb.chain((id) =>
          fc.tuple(
            fc.constant(id),
            legalLogArb(id).filter((l) => l.length >= 2 && l[0]![0] < l[l.length - 1]![0]),
            fc.constantFrom<Mut>('badTick', 'badInput', 'swap', 'perTick', 'tooLong'),
            fc.nat(),
            fc.integer({ min: 0, max: 3 }),
          ),
        ),
        ([id, log, mut, rnd, variant]) => {
          const spec = MINIGAME_SIMS[id].spec;
          const i = rnd % log.length;
          const bad = log.map((e) => [...e] as unknown as InputEvent);
          let want: LogValidationCode | null = null;
          if (mut === 'badTick') {
            const t = [spec.maxTicks, -1, 2.5, Number.NaN][variant]!;
            (bad[i] as unknown as number[])[0] = variant === 2 ? log[i]![0] + 0.5 : t;
            want = 'BAD_TICK';
          } else if (mut === 'badInput') {
            const e = bad[i] as unknown as unknown[];
            if (variant === 0) e[1] = spec.acceptedCodes[0] === InputCode.Click ? InputCode.CursorX : InputCode.Click;
            else if (variant === 1) e[2] = 100_000;
            else if (variant === 2) e[2] = (e[2] as number) + 0.25;
            else e.push(1, 2);
            want = 'BAD_INPUT';
          } else if (mut === 'swap') {
            const first = bad[0]!;
            bad[0] = bad[bad.length - 1]!;
            bad[bad.length - 1] = first;
          } else if (mut === 'perTick') {
            // 截到最后一个 tick 之前留出 1 秒空档，再在同一 tick 塞 maxInputsPerTick+1 条
            const t = spec.maxTicks - 1;
            const w = ticksPerSecond(spec);
            const kept = bad.filter((e) => e[0] < t - w);
            bad.length = 0;
            bad.push(...kept);
            for (let k = 0; k <= spec.maxInputsPerTick; k++)
              bad.push([t, ...log[0]!.slice(1)] as unknown as InputEvent);
            want = 'TOO_MANY_PER_TICK';
          } else {
            while (bad.length <= MINIGAME_MAX_LOG) bad.push(bad[bad.length - 1]!);
            want = 'TOO_LONG';
          }
          const r = validateLog(spec, bad);
          expect(r).not.toBeNull();
          if (want !== null) expect(r!.code).toBe(want);
          if (mut === 'badTick' || mut === 'badInput') expect(r!.index).toBe(i);
        },
      ),
      { numRuns: 400, seed: 20260928 },
    );
  });
});
