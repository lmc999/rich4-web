/**
 * 七彩气球 bot（design/minigames-ai.md §4.2 末）：一只气球出现满 2 tick 才会被瞄准（反应延迟），每 2 tick 最多点一次（≤ 5 次/秒）。
 * 估值：数字 = 实际加分（考虑 999 夹子）；×2 在分数 ≥ 30 时 = 当前分数；÷2 为负；? 在分数 ≥ 50 时为负、否则为 3。
 * 瞄准价值最大者的中心（小幅随机抖动），并避开同时会打中负值气球的点。只读屏幕上看得到的信息。
 */
import { randMod } from '../rng';
import { InputCode, type InputEvent, type MinigameBot } from '../types';
import { DIGIT_CAP_AT, DIGIT_CAP_TO, KIND_DOUBLE, KIND_HALF, KIND_MYSTERY, SLOT_COUNT } from './constants';
import { BALLOON_SIM, type BalloonState, balloonHit } from './sim';

interface BalloonBotMem {
  rng: number;
  /** 每槽：首次看到当前气球的 tick（−1 = 空） */
  firstSeen: number[];
  /** 每槽：识别同一只气球用的键（x·16 + kind）与上次看到的 y */
  key: number[];
  lastY: number[];
  /** 下一次允许点击的 tick */
  nextClick: number;
}

const REACTION_TICKS = 2;
const CLICK_INTERVAL = 2;

/** 打中该气球后分数的变化（估值） */
export function balloonValue(kind: number, score: number): number {
  if (kind === KIND_DOUBLE) return score >= 30 ? score : 0;
  if (kind === KIND_HALF) return -(score - (score >> 1));
  if (kind === KIND_MYSTERY) return score >= 50 ? -1 : 3;
  const next = score + kind + 1;
  return (next >= DIGIT_CAP_AT ? DIGIT_CAP_TO : next) - score;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export const BALLOON_BOT: MinigameBot<BalloonState> = Object.freeze({
  create(seed: number): BalloonBotMem {
    return {
      rng: seed >>> 0,
      firstSeen: new Array<number>(SLOT_COUNT).fill(-1),
      key: new Array<number>(SLOT_COUNT).fill(-1),
      lastY: new Array<number>(SLOT_COUNT).fill(0),
      nextClick: 0,
    };
  },
  act(memRaw: unknown, s: Readonly<BalloonState>): InputEvent[] {
    const mem = memRaw as BalloonBotMem;
    for (let i = 0; i < SLOT_COUNT; i++) {
      if (s.x[i] === 0) {
        mem.firstSeen[i] = -1;
        mem.key[i] = -1;
        continue;
      }
      const key = s.x[i]! * 16 + s.kind[i]!;
      if (mem.key[i] !== key || s.y[i]! > mem.lastY[i]!) {
        mem.firstSeen[i] = s.tick;
        mem.key[i] = key;
      }
      mem.lastY[i] = s.y[i]!;
    }
    if (!BALLOON_SIM.accepting(s as BalloonState) || s.tick < mem.nextClick) return [];

    let best = -1;
    let bestValue = 0;
    let bestX = 0;
    let bestY = 0;
    for (let i = 0; i < SLOT_COUNT; i++) {
      if (s.x[i] === 0 || s.pop[i]! > 0 || s.tick - mem.firstSeen[i]! < REACTION_TICKS) continue;
      const v = balloonValue(s.kind[i]!, s.score);
      if (v <= bestValue) continue;
      const ax = clamp(s.x[i]! + randMod(mem, 5) - 2, 0, 639);
      const ay = clamp(s.y[i]! + randMod(mem, 5) - 2, 0, 479);
      if (!balloonHit(s.kind[i]!, s.x[i]!, s.y[i]!, ax, ay)) continue;
      let hurts = false;
      for (let j = 0; j < SLOT_COUNT && !hurts; j++) {
        if (j === i || s.x[j] === 0 || s.pop[j]! > 0) continue;
        if (balloonValue(s.kind[j]!, s.score) < 0 && balloonHit(s.kind[j]!, s.x[j]!, s.y[j]!, ax, ay)) hurts = true;
      }
      if (hurts) continue;
      best = i;
      bestValue = v;
      bestX = ax;
      bestY = ay;
    }
    if (best < 0) return [];
    mem.nextClick = s.tick + CLICK_INTERVAL;
    return [[s.tick, InputCode.Click, bestX, bestY]];
  },
});
