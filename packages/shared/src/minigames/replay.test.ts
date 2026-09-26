import { describe, expect, it } from 'vitest';
import { BALLOON_SIM } from './balloon/sim';
import { MINIGAME_BOTS, MINIGAME_SIMS, MINIGAME_SPECS } from './index';
import { PENGUIN_SIM } from './penguin/sim';
import { advanceTo, canStep, type LogCursor, playBot, replay, takeInputs } from './replay';
import {
  DEFAULT_MINIGAME_PARAMS,
  InputCode,
  type InputEvent,
  MINIGAME_IDS,
  MINIGAME_TIMING,
  type MinigameSim,
  type SimBase,
} from './types';
import { validateLog, validateSimLog } from './validate';

const P = DEFAULT_MINIGAME_PARAMS;

describe('注册表', () => {
  it('三个 sim 的 spec 与 MINIGAME_TIMING 一致', () => {
    for (const id of MINIGAME_IDS) {
      const sim = MINIGAME_SIMS[id];
      const t = MINIGAME_TIMING[id];
      expect(sim.spec.id).toBe(id);
      expect(MINIGAME_SPECS[id]).toBe(sim.spec);
      expect(sim.spec).toMatchObject({
        tickMs: t.tickMs,
        introTicks: t.introTicks,
        playTicks: t.playTicks,
        maxTicks: t.maxTicks,
        scoreSanityMax: t.scoreSanityMax,
        stage: { w: 640, h: 480 },
      });
      expect(sim.spec.maxInputsPerSecond).toBeGreaterThanOrEqual(sim.spec.maxInputsPerTick);
      expect(MINIGAME_BOTS[id]).toBeDefined();
      // init 只由种子决定；种子按 uint32 取
      expect(sim.hash(sim.init(5, P))).toBe(sim.hash(sim.init(5 + 2 ** 32, P)));
      expect(sim.hash(sim.init(5, P))).not.toBe(sim.hash(sim.init(6, P)));
      // state 只放 JSON 值：开局与对局中途都能 JSON 往返且哈希不变
      const s = sim.init(5, P);
      expect(JSON.parse(JSON.stringify(s))).toEqual(s);
      const run = playBot(sim as MinigameSim<SimBase>, MINIGAME_BOTS[id], 5, P, 5);
      const mid = sim.init(5, P);
      advanceTo(sim as MinigameSim<SimBase>, mid, run.log, { i: 0 }, run.endTick >> 1);
      const round = JSON.parse(JSON.stringify(mid)) as SimBase;
      expect(round).toEqual(mid);
      expect(sim.hash(round)).toBe(sim.hash(mid));
      expect(validateSimLog(sim as MinigameSim<SimBase>, run.log)).toBeNull();
    }
  });
});

describe('replay', () => {
  it('takeInputs：按 tick 取片段，跳过过期条目', () => {
    const log: InputEvent[] = [
      [1, InputCode.Click, 1, 1],
      [3, InputCode.Click, 2, 2],
      [3, InputCode.Click, 3, 3],
      [5, InputCode.Click, 4, 4],
    ];
    const c: LogCursor = { i: 0 };
    expect(takeInputs(log, c, 0)).toEqual([]);
    expect(takeInputs(log, c, 2)).toEqual([]);
    expect(c.i).toBe(1);
    expect(takeInputs(log, c, 3)).toEqual([log[1], log[2]]);
    expect(takeInputs(log, c, 6)).toEqual([]);
    expect(c.i).toBe(4);
  });

  it('等价于逐 tick 手动 step；endTick 为结束时已完成的 step 数；advanceTo 分段推进结果相同', () => {
    for (const id of MINIGAME_IDS) {
      const sim = MINIGAME_SIMS[id] as MinigameSim<SimBase>;
      const run = playBot(sim, MINIGAME_BOTS[id], 777, P, 1);
      const r = replay(sim, 777, P, run.log);
      expect(r).toEqual({ score: run.score, endTick: run.endTick, hash: run.hash });
      const s = sim.init(777, P);
      const cur: LogCursor = { i: 0 };
      for (const target of [3, 50, 51, 120, 10_000]) advanceTo(sim, s, run.log, cur, target);
      expect(canStep(sim, s)).toBe(false);
      expect(sim.hash(s)).toBe(r.hash);
      expect(s.tick).toBe(r.endTick);
    }
  });

  it('分数夹到 [0, scoreSanityMax]', () => {
    const fake: MinigameSim<SimBase> = {
      ...(BALLOON_SIM as unknown as MinigameSim<SimBase>),
      score: () => 1e9,
    };
    expect(replay(fake, 1, P, []).score).toBe(BALLOON_SIM.spec.scoreSanityMax);
    const neg: MinigameSim<SimBase> = { ...(BALLOON_SIM as unknown as MinigameSim<SimBase>), score: () => -5 };
    expect(replay(neg, 1, P, []).score).toBe(0);
  });

  it('重放不看日志里超过 maxTicks 的部分，也不因乱序条目卡住', () => {
    const log: InputEvent[] = [
      [12, InputCode.PickCell, 47],
      [11, InputCode.PickCell, 38],
      [500, InputCode.PickCell, 38],
    ];
    const r = replay(PENGUIN_SIM, 3, P, log);
    expect(r.endTick).toBeLessThanOrEqual(PENGUIN_SIM.spec.maxTicks);
    expect(validateLog(PENGUIN_SIM.spec, log)).not.toBeNull();
  });
});

describe('bot', () => {
  it('1000 个种子下都在 maxTicks 内结束，日志合法，重放一致', { timeout: 60_000 }, () => {
    for (const id of MINIGAME_IDS) {
      const sim = MINIGAME_SIMS[id] as MinigameSim<SimBase>;
      const bot = MINIGAME_BOTS[id];
      let total = 0;
      for (let k = 0; k < 1000; k++) {
        const seed = (Math.imul(k + 1, 0x9e3779b1) >>> 0) ^ 0x5bd1e995;
        const run = playBot(sim, bot, seed, P, k);
        expect(run.endTick).toBeLessThanOrEqual(sim.spec.maxTicks);
        const s = sim.init(seed, P);
        const cur: LogCursor = { i: 0 };
        advanceTo(sim, s, run.log, cur, sim.spec.maxTicks);
        expect(sim.isOver(s)).toBe(true);
        expect(sim.hash(s)).toBe(run.hash);
        expect(validateLog(sim.spec, run.log)).toBeNull();
        total += run.score;
      }
      // 平均分只作回归基线（design §10.1：偏离 ±30% 告警，不设硬阈值）
      const avg = total / 1000;
      const base = BOT_BASELINE[id];
      if (Math.abs(avg - base) > base * 0.3)
        console.warn(`[minigames] ${id} bot 平均分 ${avg} 偏离基线 ${base} 超过 30%`);
      expect(avg).toBeGreaterThan(0);
    }
  });
});

/** bot 平均分基线（1000 种子，见上面的种子公式） */
const BOT_BASELINE: Readonly<Record<(typeof MINIGAME_IDS)[number], number>> = {
  penguin: 45,
  balloon: 350,
  xicong: 108,
};
