// M8 小游戏 sim 冒烟：bot 在多个种子下的分数、结束 tick 与耗时
import {
  DEFAULT_MINIGAME_PARAMS,
  MINIGAME_BOTS,
  MINIGAME_IDS,
  MINIGAME_SIMS,
  playBot,
  validateLog,
} from '../packages/shared/src/minigames/index';

for (const id of MINIGAME_IDS) {
  const sim = MINIGAME_SIMS[id];
  const bot = MINIGAME_BOTS[id];
  const t0 = process.hrtime.bigint();
  const scores: number[] = [];
  let maxEnd = 0;
  let minEnd = 1e9;
  let bad = 0;
  let logLen = 0;
  for (let seed = 1; seed <= 1000; seed++) {
    const r = playBot(sim, bot, seed * 2654435761, DEFAULT_MINIGAME_PARAMS, seed);
    scores.push(r.score);
    maxEnd = Math.max(maxEnd, r.endTick);
    minEnd = Math.min(minEnd, r.endTick);
    logLen = Math.max(logLen, r.log.length);
    if (validateLog(sim.spec, r.log) !== null) bad++;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  scores.sort((a, b) => a - b);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  console.log(id, {
    avg: avg.toFixed(1),
    min: scores[0],
    med: scores[500],
    max: scores[999],
    minEnd,
    maxEnd,
    maxLog: logLen,
    badLogs: bad,
    ms: ms.toFixed(0),
  });
}
