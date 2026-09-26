/**
 * 企鹅挖宝 sim（design/minigames-ai.md §3.2–§3.3）。100ms/tick；intro 10 tick（只画土堆，看不出种类）后游玩 150 tick。
 * 点有效格 → 企鹅沿 DDA 逐格走（每格 4 tick），到达后挖 4 tick 再揭晓；途经不挖；走路、挖掘中点击无效；
 * 挖到炸弹立即结束（分数保留）。state 只放 JSON 值。
 */
import { hashBase, hashBool, hashFinish, hashInt, hashInts } from '../hash';
import { randScale } from '../rng';
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
  BURY_COUNTS,
  CELL_COUNT,
  DIG_TICKS,
  DIR_INITIAL,
  ITEM_BOMB,
  ITEM_SCORE,
  PENGUIN_TIMING,
  POSE_HIGH_ABOVE,
  POSE_LOW_BELOW,
  START_CELL,
  TICKS_PER_CELL,
  VALID_CELL_COUNT,
} from './constants';
import { dirBetween, initWalk, nextCell, type PenguinWalk, VALID, VALID_CELLS } from './geometry';

export type PenguinEndReason = 'none' | 'time' | 'bomb';

export interface PenguinState extends SimBase {
  introLeft: number;
  /** 游玩剩余 tick（HUD 显示 ceil(timeLeft/10) 秒） */
  timeLeft: number;
  /** 81 格：0 空，1 炸弹，2..5 宝物；挖开后清 0 */
  board: number[];
  /** 81 格：1 = 已挖 */
  dug: number[];
  /** 81 格：挖开时揭晓的类型（0 表示空洞），供渲染已挖格 */
  found: number[];
  /** 81 格：1 = 开局有埋藏（只在 intro 渲染土堆） */
  mound: number[];
  /** 下标 0..5：各类型已挖到的件数（1 = 炸弹） */
  counts: number[];
  /** 企鹅当前所在格 */
  cell: number;
  walk: PenguinWalk | null;
  /** 挖掘剩余 tick（0..4） */
  digLeft: number;
  /** 朝向 0..7（表现用） */
  dir: number;
  endReason: PenguinEndReason;
}

export const PENGUIN_SPEC: Readonly<MinigameSpec> = Object.freeze({
  id: 'penguin',
  tickMs: PENGUIN_TIMING.tickMs,
  introTicks: PENGUIN_TIMING.introTicks,
  playTicks: PENGUIN_TIMING.playTicks,
  maxTicks: PENGUIN_TIMING.maxTicks,
  stage: Object.freeze({ w: 640, h: 480 }),
  acceptedCodes: Object.freeze([InputCode.PickCell]),
  maxInputsPerTick: 2,
  maxInputsPerSecond: 10,
  scoreSanityMax: PENGUIN_TIMING.scoreSanityMax,
  rollbackAttribution: false,
} as const);

const TAG = 0x50454e47; // 'PENG'
const END_CODE: Readonly<Record<PenguinEndReason, number>> = Object.freeze({ none: 0, time: 1, bomb: 2 });

function fill(n: number, v: number): number[] {
  return new Array<number>(n).fill(v);
}

/** 埋宝：5 轮按 BURY_COUNTS，每件 pick = rand()*free>>15，取第 pick 个「有效且为空」的格。@source v311:0x411fc8 / 0x412014（A） */
function bury(s: PenguinState): void {
  let free = VALID_CELL_COUNT;
  for (let kind = 1; kind < BURY_COUNTS.length; kind++) {
    for (let n = BURY_COUNTS[kind]!; n > 0; n--) {
      let pick = randScale(s, free);
      for (const cell of VALID_CELLS) {
        if (s.board[cell] !== 0) continue;
        if (pick === 0) {
          s.board[cell] = kind;
          break;
        }
        pick--;
      }
      free--;
    }
  }
}

function init(seed: number, _p: MinigameParams): PenguinState {
  const s: PenguinState = {
    tick: 0,
    phase: 'intro',
    rng: seed >>> 0,
    fx: [],
    introLeft: PENGUIN_SPEC.introTicks,
    timeLeft: PENGUIN_SPEC.playTicks,
    board: fill(CELL_COUNT, 0),
    dug: fill(CELL_COUNT, 0),
    found: fill(CELL_COUNT, 0),
    mound: fill(CELL_COUNT, 0),
    counts: fill(BURY_COUNTS.length, 0),
    cell: START_CELL,
    walk: null,
    digLeft: 0,
    dir: DIR_INITIAL,
    endReason: 'none',
  };
  bury(s);
  for (let i = 0; i < CELL_COUNT; i++) s.mound[i] = s.board[i] !== 0 ? 1 : 0;
  return s;
}

function accepting(s: PenguinState): boolean {
  return s.phase === 'play' && s.walk === null && s.digLeft === 0;
}

function startDig(s: PenguinState): void {
  s.walk = null;
  s.digLeft = DIG_TICKS;
  s.fx.push({ t: 'dig', cell: s.cell });
}

/** 点格闸门：只在游玩中、不在走路/挖掘、目标为有效格且不是当前格时生效。@source 0x414abe（A） */
function onPick(s: PenguinState, target: number): void {
  if (!accepting(s) || target === s.cell || VALID[target] !== true) return;
  const w = initWalk(s.cell, target);
  if (w === null) return;
  const n = nextCell(w);
  if (n < 0) {
    // 第一步就无路可走：原地挖
    startDig(s);
    return;
  }
  w.next = n;
  s.walk = w;
  const d = dirBetween(s.cell, n);
  if (d >= 0) s.dir = d;
}

function advance(s: PenguinState, w: PenguinWalk): void {
  s.cell = w.next;
  w.left--;
  w.sub = 0;
  if (s.cell === w.target || w.left === 0) {
    s.fx.push({ t: 'arrive', cell: s.cell });
    startDig(s);
    return;
  }
  const n = nextCell(w);
  if (n < 0) {
    s.fx.push({ t: 'arrive', cell: s.cell });
    startDig(s);
    return;
  }
  w.next = n;
  const d = dirBetween(s.cell, n);
  if (d >= 0) s.dir = d;
}

function reveal(s: PenguinState, cell: number): void {
  const kind = s.board[cell]!;
  s.board[cell] = 0;
  // 重挖已挖过的格只会揭晓 0；found 保留第一次揭晓的结果供渲染
  if (s.dug[cell] === 0) s.found[cell] = kind;
  s.dug[cell] = 1;
  s.fx.push({ t: 'reveal', cell, item: kind });
  if (kind === ITEM_BOMB) {
    s.counts[kind]!++;
    s.phase = 'over';
    s.endReason = 'bomb';
    s.fx.push({ t: 'bomb' });
  } else if (kind > ITEM_BOMB) {
    s.counts[kind]!++;
  }
}

function step(s: PenguinState, inputs: readonly InputEvent[]): void {
  s.fx = [];
  for (const e of inputs) {
    if (e[1] === InputCode.PickCell && validateInput(e)) onPick(s, e[2]);
  }
  if (s.phase === 'intro') {
    if (--s.introLeft <= 0) s.phase = 'play';
  } else if (s.phase === 'play') {
    s.timeLeft--;
    if (s.timeLeft <= 0) {
      s.phase = 'over';
      s.endReason = 'time';
      s.fx.push({ t: 'timeup' });
    } else if (s.digLeft > 0) {
      if (--s.digLeft === 0) reveal(s, s.cell);
    } else if (s.walk !== null) {
      if (++s.walk.sub >= TICKS_PER_CELL) advance(s, s.walk);
    }
  }
  s.tick++;
}

function score(s: PenguinState): number {
  let v = 0;
  for (let k = 0; k < ITEM_SCORE.length; k++) v += ITEM_SCORE[k]! * s.counts[k]!;
  return v;
}

function clone(s: PenguinState): PenguinState {
  return {
    tick: s.tick,
    phase: s.phase,
    rng: s.rng,
    fx: s.fx.slice(),
    introLeft: s.introLeft,
    timeLeft: s.timeLeft,
    board: s.board.slice(),
    dug: s.dug.slice(),
    found: s.found.slice(),
    mound: s.mound.slice(),
    counts: s.counts.slice(),
    cell: s.cell,
    walk: s.walk === null ? null : { ...s.walk },
    digLeft: s.digLeft,
    dir: s.dir,
    endReason: s.endReason,
  };
}

function hash(s: PenguinState): number {
  let h = hashBase(TAG, s);
  h = hashInt(h, s.introLeft);
  h = hashInt(h, s.timeLeft);
  h = hashInts(h, s.board);
  h = hashInts(h, s.dug);
  h = hashInts(h, s.found);
  h = hashInts(h, s.mound);
  h = hashInts(h, s.counts);
  h = hashInt(h, s.cell);
  const w = s.walk;
  h = hashBool(h, w !== null);
  if (w !== null) {
    h = hashInt(h, w.target);
    h = hashBool(h, w.majorIsCol);
    h = hashInt(h, w.maj);
    h = hashInt(h, w.minFx);
    h = hashInt(h, w.sMaj);
    h = hashInt(h, w.stepMin);
    h = hashInt(h, w.left);
    h = hashInt(h, w.next);
    h = hashInt(h, w.sub);
  }
  h = hashInt(h, s.digLeft);
  h = hashInt(h, s.dir);
  h = hashInt(h, END_CODE[s.endReason]);
  return hashFinish(h);
}

function validateInput(e: InputEvent): boolean {
  return validateInputForSpec(PENGUIN_SPEC, e);
}

export const PENGUIN_SIM: MinigameSim<PenguinState> = Object.freeze({
  spec: PENGUIN_SPEC,
  init,
  step,
  isOver: (s: PenguinState) => s.phase === 'over',
  score,
  clone,
  hash,
  validateInput,
  accepting,
});

/** 结算姿势分档（表现层）：0 低（<40）、1 中（40–55）、2 高（>55） */
export function penguinPose(scoreValue: number): 0 | 1 | 2 {
  if (scoreValue < POSE_LOW_BELOW) return 0;
  return scoreValue > POSE_HIGH_ABOVE ? 2 : 1;
}
