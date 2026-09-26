/**
 * 七彩气球 sim（design/minigames-ai.md §4.2）。100ms/tick；intro 5 tick，游玩 150 tick；
 * 时间到后不再生成，剩余气球仍可打，全部出屏或打掉后结束（ending → over）。state 只放 JSON 值。
 */
import { hashBase, hashFinish, hashInt, hashInts } from '../hash';
import { rand15 } from '../rng';
import {
  InputCode,
  type InputEvent,
  type MinigameParams,
  type MinigameSim,
  type MinigameSpec,
  type SimBase,
} from '../types';
import { validateInputForSpec } from '../validate';
import {
  BALLOON_TIMING,
  BIG_KIND_BELOW,
  DIGIT_CAP_AT,
  DIGIT_CAP_TO,
  EFFECT_DOUBLE,
  EFFECT_FAST,
  EFFECT_FREEZE,
  EFFECT_SLOW,
  EFFECT_TIME_ONE,
  EFFECT_ZERO,
  FREEZE_TICKS,
  HIT_BIG,
  HIT_SMALL,
  KIND_DOUBLE,
  KIND_HALF,
  KIND_MYSTERY,
  LANE_BLOCK_Y,
  LANES,
  MYSTERY_EFFECTS,
  OFF_BIG,
  OFF_SMALL,
  POP_TICKS,
  ROLL_LANE_WHEN_NONE,
  SCORE_SAT,
  SLOT_COUNT,
  SPAWN_HIGH_BELOW,
  SPAWN_LOW_BELOW,
  SPAWN_ROLL,
  SPAWN_SPECIAL_BELOW,
  SPAWN_Y,
  SPECIAL_TABLE,
  SPEED,
  SPEED_FAST,
  SPEED_NORMAL,
  SPEED_SLOW,
} from './constants';

export interface BalloonState extends SimBase {
  introLeft: number;
  /** 游玩剩余 tick；ending 阶段为 0 */
  timeLeft: number;
  /** 冻结剩余 tick（>0 时气球不动） */
  freeze: number;
  /** 0 正常；1 ×2；2 ÷2 */
  speedMode: number;
  score: number;
  /** 16 槽：跑道 x（0 = 空槽）、y、类型 0..11、爆开剩余 tick（>0 = 正在爆开，不再移动、不可再打） */
  x: number[];
  y: number[];
  kind: number[];
  pop: number[];
}

export const BALLOON_SPEC: Readonly<MinigameSpec> = Object.freeze({
  id: 'balloon',
  tickMs: BALLOON_TIMING.tickMs,
  introTicks: BALLOON_TIMING.introTicks,
  playTicks: BALLOON_TIMING.playTicks,
  maxTicks: BALLOON_TIMING.maxTicks,
  stage: Object.freeze({ w: 640, h: 480 }),
  acceptedCodes: Object.freeze([InputCode.Click]),
  maxInputsPerTick: 4,
  maxInputsPerSecond: 20,
  scoreSanityMax: BALLOON_TIMING.scoreSanityMax,
  rollbackAttribution: true,
} as const);

const TAG = 0x42414c4c; // 'BALL'

function fill(n: number, v: number): number[] {
  return new Array<number>(n).fill(v);
}

function init(seed: number, _p: MinigameParams): BalloonState {
  return {
    tick: 0,
    phase: 'intro',
    rng: seed >>> 0,
    fx: [],
    introLeft: BALLOON_SPEC.introTicks,
    timeLeft: BALLOON_SPEC.playTicks,
    freeze: 0,
    speedMode: SPEED_NORMAL,
    score: 0,
    x: fill(SLOT_COUNT, 0),
    y: fill(SLOT_COUNT, 0),
    kind: fill(SLOT_COUNT, 0),
    pop: fill(SLOT_COUNT, 0),
  };
}

function accepting(s: BalloonState): boolean {
  return s.phase === 'play' || s.phase === 'ending';
}

/** 命中框（含端点）：kind < 6 为 ±22×±30，否则 ±18×±26 */
export function balloonHit(kind: number, bx: number, by: number, px: number, py: number): boolean {
  const box = kind < BIG_KIND_BELOW ? HIT_BIG : HIT_SMALL;
  return Math.abs(px - bx) <= box.hw && Math.abs(py - by) <= box.hh;
}

/** 出屏偏移：大球 111、小球 90 */
export function balloonOff(kind: number): number {
  return kind < BIG_KIND_BELOW ? OFF_BIG : OFF_SMALL;
}

/** 当前速度模式下的每 tick 上升量 */
export function balloonRise(kind: number, speedMode: number): number {
  const v = SPEED[kind]!;
  if (speedMode === SPEED_FAST) return v * 2;
  if (speedMode === SPEED_SLOW) return v >> 1;
  return v;
}

function sat(v: number): number {
  return v > SCORE_SAT ? SCORE_SAT : v;
}

/** 一次点击：按槽升序遍历，所有命中的气球都爆并依次计分；一个都没中只放「点空」音效。@source 0x414dec..0x414f2b（B，⚑ M11） */
function click(s: BalloonState, px: number, py: number): void {
  let any = false;
  for (let i = 0; i < SLOT_COUNT; i++) {
    if (s.x[i] === 0 || s.pop[i]! > 0) continue;
    const k = s.kind[i]!;
    if (!balloonHit(k, s.x[i]!, s.y[i]!, px, py)) continue;
    any = true;
    if (k === KIND_DOUBLE) {
      s.score = sat(s.score * 2);
    } else if (k === KIND_HALF) {
      s.score >>= 1;
    } else if (k === KIND_MYSTERY) {
      s.freeze = 0;
      s.speedMode = SPEED_NORMAL;
      const e = rand15(s) % MYSTERY_EFFECTS;
      s.fx.push({ t: 'effect', effect: e as 0 | 1 | 2 | 3 | 4 | 5 });
      if (e === EFFECT_TIME_ONE) s.timeLeft = 1;
      else if (e === EFFECT_FREEZE) s.freeze = FREEZE_TICKS;
      else if (e === EFFECT_FAST) s.speedMode = SPEED_FAST;
      else if (e === EFFECT_SLOW) s.speedMode = SPEED_SLOW;
      else if (e === EFFECT_ZERO) s.score = 0;
      else if (e === EFFECT_DOUBLE) s.score = sat(s.score * 2);
    } else {
      // 「999 bug」：只有加数字这一支检查上限
      s.score += k + 1;
      if (s.score >= DIGIT_CAP_AT) s.score = DIGIT_CAP_TO;
    }
    s.pop[i] = POP_TICKS;
    s.fx.push({ t: 'pop', slot: i, kind: k, scoreAfter: s.score });
  }
  if (!any) s.fx.push({ t: 'miss' });
}

/** 生成掷骰：返回类型 0..11 或 −1（不生成）。r = rand%1000，特殊气球再掷 rand%10 查表 */
export function rollBalloonKind(s: { rng: number }): number {
  const r = rand15(s) % SPAWN_ROLL;
  if (r < SPAWN_LOW_BELOW) return r >> 2;
  if (r < SPAWN_HIGH_BELOW) return ((SPAWN_HIGH_BELOW - 1 - r) >> 1) + 5;
  if (r < SPAWN_SPECIAL_BELOW) return SPECIAL_TABLE[rand15(s) % SPECIAL_TABLE.length]!;
  return -1;
}

/** 空槽生成：只放在没有气球 y > 300 的跑道。@source 0x413001 / 0x413083（A） */
function trySpawn(s: BalloonState, i: number): boolean {
  const k = rollBalloonKind(s);
  if (k < 0) return false;
  const lanes: number[] = [];
  for (const lane of LANES) {
    let blocked = false;
    for (let j = 0; j < SLOT_COUNT; j++) {
      if (s.x[j] === lane && s.y[j]! > LANE_BLOCK_Y) {
        blocked = true;
        break;
      }
    }
    if (!blocked) lanes.push(lane);
  }
  if (lanes.length === 0) {
    if (ROLL_LANE_WHEN_NONE) rand15(s);
    return false;
  }
  s.x[i] = lanes[rand15(s) % lanes.length]!;
  s.y[i] = SPAWN_Y;
  s.kind[i] = k;
  s.pop[i] = 0;
  s.fx.push({ t: 'spawn', slot: i });
  return true;
}

function step(s: BalloonState, inputs: readonly InputEvent[]): void {
  s.fx = [];
  if (accepting(s)) {
    for (const e of inputs) {
      if (e[1] === InputCode.Click && validateInput(e)) click(s, e[2], e[3]!);
    }
  }
  if (s.phase === 'intro') {
    if (--s.introLeft <= 0) s.phase = 'play';
    s.tick++;
    return;
  }
  if (s.phase === 'over') {
    s.tick++;
    return;
  }
  if (s.freeze > 0) s.freeze--;
  if (s.timeLeft > 0) s.timeLeft--;
  const spawning = s.phase === 'play' && s.timeLeft > 0;
  let active = false;
  for (let i = 0; i < SLOT_COUNT; i++) {
    if (s.x[i] === 0) {
      if (spawning && trySpawn(s, i)) active = true;
      continue;
    }
    if (s.pop[i]! > 0) {
      if (--s.pop[i]! === 0) s.x[i] = 0;
      else active = true;
      continue;
    }
    const k = s.kind[i]!;
    if (s.freeze === 0) s.y[i]! -= balloonRise(k, s.speedMode);
    if (s.y[i]! + balloonOff(k) <= 0) {
      s.x[i] = 0;
      continue;
    }
    active = true;
  }
  if (s.phase === 'play' && s.timeLeft === 0) {
    s.phase = 'ending';
    s.fx.push({ t: 'timeup' });
  }
  if (s.phase === 'ending' && !active) s.phase = 'over';
  s.tick++;
}

function clone(s: BalloonState): BalloonState {
  return {
    tick: s.tick,
    phase: s.phase,
    rng: s.rng,
    fx: s.fx.slice(),
    introLeft: s.introLeft,
    timeLeft: s.timeLeft,
    freeze: s.freeze,
    speedMode: s.speedMode,
    score: s.score,
    x: s.x.slice(),
    y: s.y.slice(),
    kind: s.kind.slice(),
    pop: s.pop.slice(),
  };
}

function hash(s: BalloonState): number {
  let h = hashBase(TAG, s);
  h = hashInt(h, s.introLeft);
  h = hashInt(h, s.timeLeft);
  h = hashInt(h, s.freeze);
  h = hashInt(h, s.speedMode);
  h = hashInt(h, s.score);
  h = hashInts(h, s.x);
  h = hashInts(h, s.y);
  h = hashInts(h, s.kind);
  h = hashInts(h, s.pop);
  return hashFinish(h);
}

function validateInput(e: InputEvent): boolean {
  return validateInputForSpec(BALLOON_SPEC, e);
}

export const BALLOON_SIM: MinigameSim<BalloonState> = Object.freeze({
  spec: BALLOON_SPEC,
  init,
  step,
  isOver: (s: BalloonState) => s.phase === 'over',
  score: (s: BalloonState) => s.score,
  clone,
  hash,
  validateInput,
  accepting,
});
