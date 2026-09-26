/**
 * 企鹅挖宝 bot（design/minigames-ai.md §3.4）：只用玩家看得到的信息——intro 期间记下土堆格，游玩时看已挖格与企鹅位置。
 * 每次可以点击时先等 2 + rand%3 tick（反应延迟），再挑路径步数最少、能直达的未挖土堆格（平手取格号小者）；
 * 土堆挖完后改挑最近的未挖有效格。
 */
import { randMod } from '../rng';
import { InputCode, type InputEvent, type MinigameBot } from '../types';
import { tracePath, VALID_CELLS } from './geometry';
import { PENGUIN_SIM, type PenguinState } from './sim';

interface PenguinBotMem {
  rng: number;
  /** intro 期间看到的土堆格；null 表示还没看到 */
  mounds: number[] | null;
  /** 反应延迟剩余 tick；−1 表示尚未开始计时 */
  delay: number;
}

/** 在候选中挑能直达（最终挖掘格就是目标）且步数最少的格；没有返回 −1 */
function nearestReachable(from: number, candidates: readonly number[]): number {
  let best = -1;
  let bestLen = Number.MAX_SAFE_INTEGER;
  for (const c of candidates) {
    if (c === from) continue;
    const { path, digAt } = tracePath(from, c);
    if (digAt !== c) continue;
    if (path.length < bestLen) {
      bestLen = path.length;
      best = c;
    }
  }
  return best;
}

export function choosePenguinTarget(s: Readonly<PenguinState>, mounds: readonly number[]): number {
  const undug = (c: number) => s.dug[c] === 0;
  let t = nearestReachable(s.cell, mounds.filter(undug));
  if (t < 0) t = nearestReachable(s.cell, VALID_CELLS.filter(undug));
  if (t < 0) t = VALID_CELLS.find((c) => c !== s.cell) ?? -1;
  return t;
}

export const PENGUIN_BOT: MinigameBot<PenguinState> = Object.freeze({
  create(seed: number): PenguinBotMem {
    return { rng: seed >>> 0, mounds: null, delay: -1 };
  },
  act(memRaw: unknown, s: Readonly<PenguinState>): InputEvent[] {
    const mem = memRaw as PenguinBotMem;
    if (s.phase === 'intro') {
      if (mem.mounds === null) mem.mounds = VALID_CELLS.filter((c) => s.mound[c] === 1);
      return [];
    }
    if (!PENGUIN_SIM.accepting(s as PenguinState)) {
      mem.delay = -1;
      return [];
    }
    if (mem.delay < 0) mem.delay = 2 + randMod(mem, 3);
    if (mem.delay > 0) {
      mem.delay--;
      return [];
    }
    mem.delay = -1;
    const target = choosePenguinTarget(s, mem.mounds ?? []);
    return target < 0 ? [] : [[s.tick, InputCode.PickCell, target]];
  },
});
