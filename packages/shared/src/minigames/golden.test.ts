/**
 * 小游戏 golden（design/minigames-ai.md §10.1 第 2 条）：每个游戏 10 组固定 seed + 脚本化输入 → {score, endTick, hash}。
 * JSON 在 __golden__/ 下，client-browser 的三端一致性测试直接读取同一批文件在浏览器里重放比对。
 * 规则有意变更时用 `RICH4_UPDATE_GOLDEN=1 npx vitest run --project shared src/minigames/golden` 重新生成，并在变更说明里写明原因。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MINIGAME_BOTS, MINIGAME_SIMS } from './index';
import { VALID_CELLS } from './penguin/geometry';
import { playBot, replay } from './replay';
import {
  DEFAULT_MINIGAME_PARAMS,
  InputCode,
  type InputEvent,
  MINIGAME_IDS,
  type MinigameId,
  type MinigameSim,
  type SimBase,
} from './types';
import { validateLog } from './validate';

/** 文件格式：GoldenCase[]，一行一组 */
interface GoldenCase {
  name: string;
  seed: number;
  score: number;
  endTick: number;
  hash: number;
  log: InputEvent[];
}

const P = DEFAULT_MINIGAME_PARAMS;
const UPDATE = process.env.RICH4_UPDATE_GOLDEN === '1';
const fileOf = (id: MinigameId) => new URL(`./__golden__/${id}.json`, import.meta.url);

/** 注意：Watcom rand 只输出状态的 16..30 位，只差 bit31 的两个种子局面完全相同（哈希因 rng 不同而不同），这里避开 */
const BOT_SEEDS = [1, 2, 3, 0xdeadbeef, 0x7fffffff, 20260927, 987654321];

/** 脚本化日志（不依赖 bot）：确定性的整数公式 */
function scripted(id: MinigameId, variant: number): InputEvent[] {
  const log: InputEvent[] = [];
  if (id === 'penguin') {
    if (variant === 0) {
      // 每 9 tick 点一个格（其中不少会落在走路/挖掘中被忽略）
      for (let t = 10, k = 0; t < 160; t += 9, k++) log.push([t, InputCode.PickCell, VALID_CELLS[(k * 17 + 5) % 64]!]);
    } else {
      // intro 中乱点、点冰屋/无效格/当前格，之后每 4 tick 点一次附近的格
      for (let t = 0; t < 12; t++) log.push([t, InputCode.PickCell, [40, 0, 56, 81 - 1][t % 4]!]);
      for (let t = 12, k = 0; t < 160; t += 4, k++) log.push([t, InputCode.PickCell, VALID_CELLS[(k * 5 + 40) % 64]!]);
    }
  } else if (id === 'balloon') {
    if (variant === 0) {
      // 每 tick 点一枪，扫过 8 条跑道与不同高度
      for (let t = 5; t < 220; t++) log.push([t, InputCode.Click, 40 + 80 * (t % 8), 420 - ((t * 37) % 400)]);
    } else {
      // 每 2 tick 连点 4 枪（刚好压在每 tick 4 条、每秒 20 条的上限上）
      for (let t = 5; t < 200; t += 2) {
        for (let k = 0; k < 4; k++)
          log.push([t, InputCode.Click, 40 + 80 * ((t + k * 3) % 8), 60 + ((t * 13 + k * 97) % 360)]);
      }
    }
  } else if (variant === 0) {
    // 三角波扫动光标，每 tick 一条
    for (let t = 10; t < 370; t++) {
      const ph = (t * 23) % 1260;
      log.push([t, InputCode.CursorX, ph < 630 ? ph : 1259 - ph]);
    }
  } else {
    // intro 中先把光标放到左侧，之后每 3 tick 在两点间来回
    log.push([2, InputCode.CursorX, 150]);
    for (let t = 10, k = 0; t < 370; t += 3, k++) log.push([t, InputCode.CursorX, k % 2 === 0 ? 180 : 460]);
  }
  return log;
}

function generate(id: MinigameId): GoldenCase[] {
  const sim = MINIGAME_SIMS[id] as MinigameSim<SimBase>;
  const out: GoldenCase[] = [];
  const add = (name: string, seed: number, log: InputEvent[]) => {
    const r = replay(sim, seed, P, log);
    out.push({ name, seed, score: r.score, endTick: r.endTick, hash: r.hash, log });
  };
  add('empty', 1, []);
  for (const seed of BOT_SEEDS)
    add(`bot-${seed}`, seed, playBot(sim, MINIGAME_BOTS[id], seed, P, seed ^ 0x5bd1e995).log);
  add('scripted-a', 424242, scripted(id, 0));
  add('scripted-b', 0x13579bdf, scripted(id, 1));
  return out;
}

describe('小游戏 golden', () => {
  for (const id of MINIGAME_IDS) {
    it(`${id}：10 组 seed + 输入重放得到固定的 score/endTick/hash`, () => {
      const sim = MINIGAME_SIMS[id] as MinigameSim<SimBase>;
      if (UPDATE)
        writeFileSync(
          fileOf(id),
          `[\n${generate(id)
            .map((c) => JSON.stringify(c))
            .join(',\n')}\n]\n`,
        );
      const cases = JSON.parse(readFileSync(fileOf(id), 'utf8')) as GoldenCase[];
      expect(cases).toHaveLength(10);
      for (const c of cases) {
        expect(validateLog(sim.spec, c.log), c.name).toBeNull();
        expect(replay(sim, c.seed, P, c.log), c.name).toEqual({ score: c.score, endTick: c.endTick, hash: c.hash });
      }
      // 生成器与文件一致（规则或 bot 改动而未刷新 golden 时在这里暴露）
      expect(generate(id)).toEqual(cases);
      // 覆盖面：至少有一局提前结束（企鹅挖到炸弹 / 气球 ? 时间归一 / 财神 bot 躲不掉也行），分数不全相同
      expect(new Set(cases.map((c) => c.score)).size).toBeGreaterThan(3);
    });
  }
});
