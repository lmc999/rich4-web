/**
 * 调试：统计企鹅挖宝「一步直达炸弹」失败的种子比例，以及多步点格规划（apps/server/test/integration/minigame.test.ts
 * 的 bombRun）的结束 tick 分布。用法：npx tsx test/minigame-bomb-plan.ts [种子数]
 */
import {
  InputCode,
  type InputEvent,
  MINIGAME_TIMING,
  PENGUIN_SIM,
  penguin,
  replay,
} from '../packages/shared/src/minigames';

const P = MINIGAME_TIMING.penguin;

function singlePick(seed: number): number {
  const s = PENGUIN_SIM.init(seed, {});
  let best = -1;
  let bestLen = Number.POSITIVE_INFINITY;
  for (const c of penguin.VALID_CELLS) {
    if (s.board[c] !== penguin.ITEM_BOMB || c === s.cell) continue;
    const p = penguin.tracePath(s.cell, c);
    if (p.digAt === c && p.path.length < bestLen) {
      best = c;
      bestLen = p.path.length;
    }
  }
  return best;
}

function plan(seed: number): { log: InputEvent[]; endTick: number; reason: string } {
  const s = PENGUIN_SIM.init(seed, {});
  const dist = new Map<number, number>([[s.cell, 0]]);
  const via = new Map<number, { from: number; pick: number }>();
  const done = new Set<number>();
  let goal = -1;
  for (;;) {
    let x = -1;
    for (const [c, d] of dist) if (!done.has(c) && (x < 0 || d < dist.get(x)!)) x = c;
    if (x < 0) break;
    done.add(x);
    if (x !== s.cell && s.board[x] === penguin.ITEM_BOMB) {
      goal = x;
      break;
    }
    for (const c of penguin.VALID_CELLS) {
      if (c === x) continue;
      const p = penguin.tracePath(x, c);
      if (p.digAt === x) continue;
      const d = dist.get(x)! + (p.path.length + 1) * penguin.TICKS_PER_CELL;
      if (d < (dist.get(p.digAt) ?? Number.POSITIVE_INFINITY)) {
        dist.set(p.digAt, d);
        via.set(p.digAt, { from: x, pick: c });
      }
    }
  }
  const picks: number[] = [];
  for (let c = goal; c !== s.cell; c = via.get(c)!.from) picks.unshift(via.get(c)!.pick);
  const log: InputEvent[] = [];
  while (!PENGUIN_SIM.isOver(s) && s.tick < P.maxTicks) {
    const inputs: InputEvent[] =
      PENGUIN_SIM.accepting(s) && picks.length > 0 ? [[s.tick, InputCode.PickCell, picks.shift()!]] : [];
    log.push(...inputs);
    PENGUIN_SIM.step(s, inputs);
  }
  const r = replay(PENGUIN_SIM, seed, {}, log);
  if (r.endTick !== s.tick) throw new Error(`replay mismatch ${seed}`);
  return { log, endTick: s.tick, reason: s.endReason };
}

const N = Number(process.argv[2] ?? 20000);
let fail = 0;
let notBomb = 0;
let worst = 0;
let worstFail = 0;
const hist = new Map<number, number>();
for (let i = 0; i < N; i++) {
  const seed = (Math.imul(i + 1, 2654435761) >>> 1) & 0x7fffffff;
  const single = singlePick(seed);
  const r = plan(seed);
  if (r.reason !== 'bomb') notBomb++;
  worst = Math.max(worst, r.endTick);
  hist.set(r.log.length, (hist.get(r.log.length) ?? 0) + 1);
  if (single < 0) {
    fail++;
    worstFail = Math.max(worstFail, r.endTick);
    if (fail <= 3) console.log('无直达炸弹的种子', seed, '规划', JSON.stringify(r.log), 'endTick', r.endTick);
  }
}
console.log({ N, fail, failRate: fail / N, notBomb, worstEndTick: worst, worstFailEndTick: worstFail, picks: [...hist] });
