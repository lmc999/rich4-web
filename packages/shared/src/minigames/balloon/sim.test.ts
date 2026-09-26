import { describe, expect, it } from 'vitest';
import { createWatcomState, watcomRand } from '../../util/rng/watcom';
import { rand15 } from '../rng';
import { DEFAULT_MINIGAME_PARAMS, InputCode, type InputEvent, MINIGAME_TIMING, type SimFx } from '../types';
import {
  KIND_DOUBLE,
  KIND_HALF,
  KIND_MYSTERY,
  LANES,
  SPECIAL_TABLE,
  SPEED,
  SPEED_FAST,
  SPEED_NORMAL,
  SPEED_SLOW,
} from './constants';
import { BALLOON_SPEC, type BalloonState, balloonHit, rollBalloonKind, BALLOON_SIM as sim } from './sim';

const P = DEFAULT_MINIGAME_PARAMS;
const click = (tick: number, x: number, y: number): InputEvent => [tick, InputCode.Click, x, y];

/** 进入游玩（tick 5），清空所有槽，并把 rng 换成一个「下一个 rand%1000 ≥ 30」连续很长的种子，避免意外生成 */
function playEmpty(seed = 1): BalloonState {
  const s = sim.init(seed, P);
  while (s.phase === 'intro') sim.step(s, []);
  s.x.fill(0);
  s.y.fill(0);
  s.kind.fill(0);
  s.pop.fill(0);
  return s;
}

function place(s: BalloonState, slot: number, lane: number, y: number, kind: number): void {
  s.x[slot] = lane;
  s.y[slot] = y;
  s.kind[slot] = kind;
  s.pop[slot] = 0;
}

/** 找一个 rng 状态，使得接下来的 rand15 % n === want */
function rngFor(n: number, want: number): number {
  for (let seed = 1; ; seed++) {
    const t = { rng: seed };
    if (rand15(t) % n === want) return seed;
  }
}

/** 参照映射（按文档表格逐段写出） */
function referenceKind(rng: { next: number }): number {
  const r = watcomRand(rng) % 1000;
  if (r < 4) return 0;
  if (r < 8) return 1;
  if (r < 12) return 2;
  if (r < 16) return 3;
  if (r < 20) return 4;
  if (r < 22) return 8;
  if (r < 24) return 7;
  if (r < 26) return 6;
  if (r < 28) return 5;
  if (r < 30) return [9, 9, 10, 10, 10, 10, 10, 11, 11, 11][watcomRand(rng) % 10]!;
  return -1;
}

/** 让 click 之后的 step 不生成新气球：暂时把 timeLeft 设成 0 并切到 ending */
function noSpawn(s: BalloonState): void {
  s.phase = 'ending';
  s.timeLeft = 0;
}

describe('七彩气球 sim', () => {
  it('spec 与计时契约一致', () => {
    expect(BALLOON_SPEC).toMatchObject({
      id: 'balloon',
      tickMs: 100,
      introTicks: 5,
      playTicks: 150,
      maxTicks: MINIGAME_TIMING.balloon.maxTicks,
      acceptedCodes: [InputCode.Click],
      rollbackAttribution: true,
    });
    expect(LANES).toEqual([40, 120, 200, 280, 360, 440, 520, 600]);
  });

  it('生成掷骰：与文档表格逐次一致；分布 数字 1–5 各 0.4%、6–9 各 0.2%、特殊 ×2/÷2/? = 20/50/30', () => {
    const s = { rng: 2024 };
    const ref = createWatcomState(2024);
    const N = 1_000_000;
    const hist = new Array<number>(12).fill(0);
    let none = 0;
    let mismatch = 0;
    for (let i = 0; i < N; i++) {
      const k = rollBalloonKind(s);
      if (k !== referenceKind(ref)) mismatch++;
      if (k < 0) none++;
      else hist[k]!++;
    }
    expect(mismatch).toBe(0);
    expect(s.rng).toBe(ref.next);
    for (let k = 0; k < 5; k++) expect(Math.abs(hist[k]! / N - 0.004)).toBeLessThan(0.0004);
    for (let k = 5; k < 9; k++) expect(Math.abs(hist[k]! / N - 0.002)).toBeLessThan(0.0003);
    const special = hist[9]! + hist[10]! + hist[11]!;
    expect(Math.abs(special / N - 0.002)).toBeLessThan(0.0003);
    expect(Math.abs(hist[9]! / special - 0.2)).toBeLessThan(0.04);
    expect(Math.abs(hist[10]! / special - 0.5)).toBeLessThan(0.04);
    expect(Math.abs(hist[11]! / special - 0.3)).toBeLessThan(0.04);
    expect(none / N).toBeGreaterThan(0.96);
    expect(SPECIAL_TABLE.filter((k) => k === KIND_DOUBLE)).toHaveLength(2);
    expect(SPEED).toEqual([15, 15, 15, 15, 18, 18, 18, 24, 24, 24, 24, 18]);
  });

  it('只在 8 条跑道上从 y=420 生成；每条跑道上 y>300 的气球最多一只；intro 不生成', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const s = sim.init(seed * 97, P);
      while (!sim.isOver(s)) {
        const wasIntro = s.phase === 'intro';
        sim.step(s, []);
        const spawns = s.fx.filter((f): f is Extract<SimFx, { t: 'spawn' }> => f.t === 'spawn');
        if (wasIntro) expect(spawns).toHaveLength(0);
        for (const f of spawns) {
          expect(LANES).toContain(s.x[f.slot]);
          expect(s.y[f.slot]).toBe(420);
        }
        for (const lane of LANES) {
          let n = 0;
          for (let i = 0; i < 16; i++) if (s.x[i] === lane && s.y[i]! > 300) n++;
          expect(n).toBeLessThanOrEqual(1);
        }
      }
      expect(s.tick).toBeLessThanOrEqual(BALLOON_SPEC.maxTicks);
    }
  });

  it('上升速度按类型；速度模式 ×2 / ÷2；冻结时不动', () => {
    const s = playEmpty();
    noSpawn(s);
    place(s, 0, 40, 400, 0);
    place(s, 1, 120, 400, 7);
    place(s, 2, 200, 400, KIND_MYSTERY);
    sim.step(s, []);
    expect([s.y[0], s.y[1], s.y[2]]).toEqual([385, 376, 382]);
    s.speedMode = SPEED_FAST;
    sim.step(s, []);
    expect([s.y[0], s.y[1], s.y[2]]).toEqual([355, 328, 346]);
    s.speedMode = SPEED_SLOW;
    sim.step(s, []);
    expect([s.y[0], s.y[1], s.y[2]]).toEqual([348, 316, 337]);
    s.freeze = 2;
    sim.step(s, []);
    expect([s.y[0], s.y[1], s.y[2]]).toEqual([348, 316, 337]);
    sim.step(s, []);
    expect(s.y[0]).toBe(341);
  });

  it('出屏：y + off ≤ 0 时移除（大球 off 111，小球 off 90）', () => {
    const s = playEmpty();
    noSpawn(s);
    place(s, 0, 40, -96, 0); // −96−15 = −111 → 移除
    place(s, 1, 120, -95, 0); // −110 → 保留
    place(s, 2, 200, -66, 7); // 小球（数字 8，速度 24）：−66−24 = −90 → 移除
    place(s, 3, 280, -65, 7); // −89 → 保留
    sim.step(s, []);
    expect([s.x[0], s.x[1], s.x[2], s.x[3]]).toEqual([0, 120, 0, 280]);
  });

  it('命中框含端点：kind<6 为 ±22×±30，否则 ±18×±26', () => {
    expect(balloonHit(0, 100, 100, 122, 130)).toBe(true);
    expect(balloonHit(0, 100, 100, 123, 100)).toBe(false);
    expect(balloonHit(5, 100, 100, 78, 70)).toBe(true);
    expect(balloonHit(5, 100, 100, 100, 131)).toBe(false);
    expect(balloonHit(6, 100, 100, 118, 126)).toBe(true);
    expect(balloonHit(6, 100, 100, 119, 100)).toBe(false);
    expect(balloonHit(KIND_MYSTERY, 100, 100, 100, 74)).toBe(true);
    expect(balloonHit(KIND_MYSTERY, 100, 100, 100, 73)).toBe(false);
  });

  it('数字气球加分；999 夹子只在加数字这一支（≥1000 一律夹回 999，包括已超过 1000 的分数）', () => {
    const cases: [before: number, kind: number, after: number][] = [
      [0, 0, 1],
      [10, 8, 19],
      [990, 8, 999],
      [995, 8, 999],
      [999, 0, 999],
      [1500, 3, 999],
    ];
    for (const [before, kind, after] of cases) {
      const s = playEmpty();
      s.score = before;
      place(s, 0, 40, 200, kind);
      sim.step(s, [click(s.tick, 40, 200)]);
      expect(s.score).toBe(after);
      expect(s.fx).toContainEqual({ t: 'pop', slot: 0, kind, scoreAfter: after });
    }
  });

  it('×2 不夹 999；÷2 向下取整', () => {
    const s = playEmpty();
    s.score = 999;
    place(s, 0, 40, 200, KIND_DOUBLE);
    sim.step(s, [click(s.tick, 40, 200)]);
    expect(s.score).toBe(1998);
    place(s, 1, 120, 200, KIND_HALF);
    s.score = 1999;
    sim.step(s, [click(s.tick, 120, 200)]);
    expect(s.score).toBe(999);
  });

  it('一次点击打爆所有命中的气球，按槽号升序计分', () => {
    const a = playEmpty();
    a.score = 10;
    place(a, 0, 40, 200, 4); // +5
    place(a, 1, 40, 210, KIND_DOUBLE);
    sim.step(a, [click(a.tick, 40, 205)]);
    expect(a.score).toBe(30);
    const b = playEmpty();
    b.score = 10;
    place(b, 0, 40, 210, KIND_DOUBLE);
    place(b, 1, 40, 200, 4);
    sim.step(b, [click(b.tick, 40, 205)]);
    expect(b.score).toBe(25);
  });

  it('爆开图停 3 tick 后清槽，期间不能再打；点空只放一次 miss', () => {
    const s = playEmpty();
    noSpawn(s);
    place(s, 0, 40, 200, 0);
    place(s, 1, 600, 200, 0);
    sim.step(s, [click(s.tick, 40, 200)]);
    expect(s.pop[0]).toBe(2);
    expect(s.y[0]).toBe(200);
    sim.step(s, [click(s.tick, 40, 200)]);
    expect(s.fx).toEqual([{ t: 'miss' }]);
    expect(s.score).toBe(1);
    expect(s.pop[0]).toBe(1);
    sim.step(s, []);
    expect(s.x[0]).toBe(0);
  });

  it('? 先清冻结与变速，再按 rand%6 取 6 种效果', () => {
    const results: Record<number, (s: BalloonState) => void> = {
      0: (s) => {
        expect(s.timeLeft).toBe(0);
        expect(s.phase).toBe('ending');
      },
      1: (s) => {
        expect(s.freeze).toBe(19);
        expect(s.y[1]).toBe(300);
      },
      2: (s) => {
        expect(s.speedMode).toBe(SPEED_FAST);
        expect(s.y[1]).toBe(270);
      },
      3: (s) => {
        expect(s.speedMode).toBe(SPEED_SLOW);
        expect(s.y[1]).toBe(293);
      },
      4: (s) => expect(s.score).toBe(0),
      5: (s) => expect(s.score).toBe(80),
    };
    for (let e = 0; e < 6; e++) {
      const s = playEmpty();
      s.score = 40;
      s.freeze = 5;
      s.speedMode = SPEED_FAST;
      s.timeLeft = 100;
      place(s, 0, 40, 200, KIND_MYSTERY);
      place(s, 1, 600, 300, 0);
      s.rng = rngFor(6, e);
      sim.step(s, [click(s.tick, 40, 200)]);
      expect(s.fx[0]).toEqual({ t: 'effect', effect: e });
      if (e !== 1) expect(s.freeze).toBe(0);
      if (e >= 4) expect(s.speedMode).toBe(SPEED_NORMAL);
      results[e]!(s);
    }
  });

  it('时间到后不再生成，剩余气球仍可打，全部离场才结束', () => {
    const s = sim.init(3, P);
    while (s.phase !== 'ending') sim.step(s, []);
    expect(s.tick).toBe(5 + 150);
    expect(s.fx).toContainEqual({ t: 'timeup' });
    // 放一只慢气球保证 ending 持续
    place(s, 15, 360, 300, 0);
    let clicked = false;
    while (!sim.isOver(s)) {
      expect(sim.accepting(s)).toBe(true);
      const inputs = !clicked && s.x[15] !== 0 ? [click(s.tick, 360, s.y[15]!)] : [];
      sim.step(s, inputs);
      if (inputs.length > 0) {
        clicked = true;
        expect(s.fx).toContainEqual({ t: 'pop', slot: 15, kind: 0, scoreAfter: s.score });
      }
      expect(s.fx.some((f) => f.t === 'spawn')).toBe(false);
    }
    expect(clicked).toBe(true);
    expect(s.x.every((x) => x === 0)).toBe(true);
    expect(sim.accepting(s)).toBe(false);
  });

  it('intro 期间点击无效', () => {
    const a = sim.init(5, P);
    const b = sim.init(5, P);
    for (let t = 0; t < 5; t++) {
      expect(sim.accepting(a)).toBe(false);
      sim.step(a, [click(t, 320, 240)]);
      sim.step(b, []);
    }
    expect(sim.hash(a)).toBe(sim.hash(b));
  });

  it('validateInput：只收 Click、x 0..639、y 0..479', () => {
    expect(sim.validateInput([0, InputCode.Click, 0, 0])).toBe(true);
    expect(sim.validateInput([0, InputCode.Click, 639, 479])).toBe(true);
    expect(sim.validateInput([0, InputCode.Click, 640, 0])).toBe(false);
    expect(sim.validateInput([0, InputCode.Click, 0, 480])).toBe(false);
    expect(sim.validateInput([0, InputCode.Click, 5])).toBe(false);
    expect(sim.validateInput([0, InputCode.PickCell, 5])).toBe(false);
  });

  it('clone 独立、hash 相同', () => {
    const s = sim.init(11, P);
    for (let i = 0; i < 40; i++) sim.step(s, []);
    const c = sim.clone(s);
    expect(c).toEqual(s);
    expect(sim.hash(c)).toBe(sim.hash(s));
    sim.step(c, []);
    expect(sim.hash(c)).not.toBe(sim.hash(s));
    expect(s.tick).toBe(40);
  });
});
