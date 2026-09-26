/**
 * 喜从天降 sim（design/minigames-ai.md §5.2）。50ms/tick；intro 10 tick，游玩 360 tick（18 秒）；
 * 时间到或接到炸弹进入 ending：财神停下，屏上掉落物落完后结束。state 只放 JSON 值。
 */
import { hashBase, hashBool, hashFinish, hashInt, hashInts } from '../hash';
import { idiv, rand15 } from '../rng';
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
  CATCH_BOTTOM_Y,
  CATCH_HALF_W,
  CATCH_REQUIRES_MOVING,
  CATCH_TOP_Y,
  CATCHER_DEADZONE,
  CATCHER_FRAMES,
  CATCHER_INIT_X,
  CATCHER_SPEED,
  FALL,
  GOD_IDLE_FRAME,
  GOD_IDLE_STATE,
  GOD_INIT_FRAME,
  GOD_INIT_SPAWN_FRAME,
  GOD_INIT_STATE,
  GOD_INIT_X,
  GOD_MAX_X,
  GOD_MIN_X,
  GOD_SEGMENT_FRAMES,
  GOD_SPAWN_ROLL,
  GOD_STEP,
  GOD_TURN_LEFT_END,
  GOD_TURN_RIGHT_END,
  GOD_TURN_ROLL,
  GOD_WALK_LEFT,
  GOD_WALK_RIGHT,
  ITEM_BOMB,
  ITEM_GRAVITY,
  ITEM_MAX_VY,
  ITEM_MISS_Y,
  ITEM_ROLL,
  ITEM_SCORE,
  ITEM_SLOTS,
  ITEM_START_VY,
  ITEM_START_Y,
  ITEM_TOSS_UNTIL_Y,
  MID_X,
  SWAY_DIV,
  SWAY_FRAMES,
  WARN_DROP_AT,
  WARN_FRAMES,
  WARN_PASS_BELOW,
  WARN_ROLL,
  WARN_X_LEFT,
  WARN_X_RIGHT,
  WARN_X_ROLL,
  XICONG_TIMING,
} from './constants';

export interface XicongState extends SimBase {
  introLeft: number;
  /** 游玩剩余 tick（HUD 显示 timeLeft/2，单位 0.1 秒） */
  timeLeft: number;
  godX: number;
  /** 0 向右走；2 右端转身；3 左端转身；4 向左走 */
  godState: number;
  godFrame: number;
  godSpawnFrame: number;
  /** 最近一次上报的光标横坐标（0..639） */
  cursorX: number;
  catcherX: number;
  /** 0 静止；1 向左；2 向右 */
  catcherDir: number;
  catcherFrame: number;
  /** 预警帧：−1 未激活；0..11 */
  warn: number;
  warnX: number;
  hitBomb: boolean;
  /** 16 槽：x（0 = 空槽）、y、类型 0..4、摆动帧 0..7、竖直速度 */
  ix: number[];
  iy: number[];
  ikind: number[];
  iframe: number[];
  ivy: number[];
  /** 下标 0..3：各类宝物接到的件数 */
  counts: number[];
}

export const XICONG_SPEC: Readonly<MinigameSpec> = Object.freeze({
  id: 'xicong',
  tickMs: XICONG_TIMING.tickMs,
  introTicks: XICONG_TIMING.introTicks,
  playTicks: XICONG_TIMING.playTicks,
  maxTicks: XICONG_TIMING.maxTicks,
  stage: Object.freeze({ w: 640, h: 480 }),
  acceptedCodes: Object.freeze([InputCode.CursorX]),
  maxInputsPerTick: 1,
  maxInputsPerSecond: 20,
  scoreSanityMax: XICONG_TIMING.scoreSanityMax,
  rollbackAttribution: false,
} as const);

const TAG = 0x5849434f; // 'XICO'

function fill(n: number, v: number): number[] {
  return new Array<number>(n).fill(v);
}

function init(seed: number, _p: MinigameParams): XicongState {
  return {
    tick: 0,
    phase: 'intro',
    rng: seed >>> 0,
    fx: [],
    introLeft: XICONG_SPEC.introTicks,
    timeLeft: XICONG_SPEC.playTicks,
    godX: GOD_INIT_X,
    godState: GOD_INIT_STATE,
    godFrame: GOD_INIT_FRAME,
    godSpawnFrame: GOD_INIT_SPAWN_FRAME,
    cursorX: CATCHER_INIT_X,
    catcherX: CATCHER_INIT_X,
    catcherDir: 0,
    catcherFrame: 0,
    warn: -1,
    warnX: 0,
    hitBomb: false,
    ix: fill(ITEM_SLOTS, 0),
    iy: fill(ITEM_SLOTS, 0),
    ikind: fill(ITEM_SLOTS, 0),
    iframe: fill(ITEM_SLOTS, 0),
    ivy: fill(ITEM_SLOTS, 0),
    counts: fill(4, 0),
  };
}

function accepting(s: XicongState): boolean {
  return s.phase === 'intro' || s.phase === 'play';
}

/** 掉落物判定点横坐标（含摆动） */
export function itemPx(x: number, y: number, frame: number): number {
  const dy = y - ITEM_TOSS_UNTIL_Y;
  return x + (dy > 0 ? idiv(frame * dy, SWAY_DIV) : 0);
}

/** 掉落物一步：摆动帧 +1、上抛或匀速下落（原地修改槽 i） */
function fallStep(s: XicongState, i: number): void {
  s.iframe[i] = (s.iframe[i]! + 1) % SWAY_FRAMES;
  if (s.iy[i]! < ITEM_TOSS_UNTIL_Y) {
    const vy = s.ivy[i]! + ITEM_GRAVITY;
    s.ivy[i] = vy > ITEM_MAX_VY ? ITEM_MAX_VY : vy;
    s.iy[i]! += s.ivy[i]!;
  } else {
    s.iy[i]! += FALL[s.ikind[i]!]!;
  }
}

function enterEnding(s: XicongState): void {
  s.phase = 'ending';
  s.catcherDir = 0;
}

/** 写入空槽；bomb 时不掷类型，宝物先掷 rand%20 再找空槽。@source 0x4123d7..0x412463（A） */
function spawnItem(s: XicongState, x: number, bomb: boolean): void {
  let kind = ITEM_BOMB;
  if (!bomb) {
    const r = rand15(s) % ITEM_ROLL;
    kind = r < 9 ? 3 : r < 15 ? 2 : r < 18 ? 1 : 0;
  }
  const slot = s.ix.indexOf(0);
  if (slot < 0) return;
  s.ix[slot] = x;
  s.iy[slot] = ITEM_START_Y;
  s.ikind[slot] = kind;
  s.iframe[slot] = 0;
  s.ivy[slot] = ITEM_START_VY;
  s.fx.push(bomb ? { t: 'bombDrop', slot } : { t: 'drop', slot, item: kind });
}

function moveCatcher(s: XicongState): void {
  const dx = s.catcherX - s.cursorX;
  if (dx <= CATCHER_DEADZONE && dx >= -CATCHER_DEADZONE) {
    s.catcherDir = 0;
    return;
  }
  s.catcherDir = dx > 0 ? 1 : 2;
  s.catcherX += dx > 0 ? -CATCHER_SPEED : CATCHER_SPEED;
  s.catcherFrame = (s.catcherFrame + 1) % CATCHER_FRAMES;
}

/** 掉落物；返回是否还有在场的 */
function updateItems(s: XicongState): boolean {
  let active = false;
  for (let i = 0; i < ITEM_SLOTS; i++) {
    if (s.ix[i] === 0) continue;
    fallStep(s, i);
    const y = s.iy[i]!;
    const px = itemPx(s.ix[i]!, y, s.iframe[i]!);
    const canCatch = s.phase === 'play' && (!CATCH_REQUIRES_MOVING || s.catcherDir !== 0);
    if (
      canCatch &&
      px > s.catcherX - CATCH_HALF_W &&
      px < s.catcherX + CATCH_HALF_W &&
      y > CATCH_TOP_Y &&
      y < CATCH_BOTTOM_Y
    ) {
      const kind = s.ikind[i]!;
      s.ix[i] = 0;
      if (kind === ITEM_BOMB) {
        s.hitBomb = true;
        s.warn = -1;
        enterEnding(s);
        s.fx.push({ t: 'boom' });
      } else {
        s.counts[kind]!++;
        s.fx.push({ t: 'catch', item: kind });
      }
      continue;
    }
    if (y > ITEM_MISS_Y) {
      s.ix[i] = 0;
      continue;
    }
    active = true;
  }
  return active;
}

/** 炸弹预警。@source mytbk asm 0x41375b..0x4137e8（A）：先掷 rand%10，再判断阶段 */
function warnStep(s: XicongState): void {
  if (s.warn >= 0) {
    s.warn++;
    if (s.warn === WARN_DROP_AT && !s.hitBomb) spawnItem(s, s.warnX, true);
    if (s.warn >= WARN_FRAMES) s.warn = -1;
    return;
  }
  const farSide =
    (s.godState < GOD_TURN_RIGHT_END && s.godX > MID_X) || (s.godState > GOD_TURN_LEFT_END && s.godX < MID_X);
  if (!farSide) return;
  if (rand15(s) % WARN_ROLL < WARN_PASS_BELOW) return;
  if (s.phase !== 'play') return;
  const r = rand15(s) % WARN_X_ROLL;
  s.warn = 0;
  s.warnX = s.godX > MID_X ? WARN_X_LEFT + r : WARN_X_RIGHT + r;
  s.fx.push({ t: 'warn', x: s.warnX });
}

/**
 * 财神状态机（见 constants 的 ⚑ 说明）。转身段：frame 走满 5 帧当拍切到行走、frame 清零，x 不动。
 * 行走段：frame 0..4 每拍先判撒宝再 frame++、x±12；frame == 5 的那一拍是决策拍（转身，或重掷撒宝帧并 x±12 续走），
 * 所以行走时每拍都恰好移动 12px。
 */
function godWalk(s: XicongState): void {
  const st = s.godState;
  if (st === GOD_TURN_RIGHT_END || st === GOD_TURN_LEFT_END) {
    if (++s.godFrame >= GOD_SEGMENT_FRAMES) {
      s.godState = st === GOD_TURN_RIGHT_END ? GOD_WALK_LEFT : GOD_WALK_RIGHT;
      s.godFrame = 0;
    }
    return;
  }
  const right = st === GOD_WALK_RIGHT;
  const dx = right ? GOD_STEP : -GOD_STEP;
  if (s.godFrame < GOD_SEGMENT_FRAMES) {
    if (s.godFrame === s.godSpawnFrame) spawnItem(s, s.godX, false);
    s.godFrame++;
    s.godX += dx;
    return;
  }
  const farHalf = right ? s.godX > MID_X : s.godX < MID_X;
  const atEnd = right ? s.godX === GOD_MAX_X : s.godX === GOD_MIN_X;
  // 远半场先掷 rand%4（在端点也掷），0 或到端点就转身
  if (farHalf && (rand15(s) % GOD_TURN_ROLL === 0 || atEnd)) {
    s.godState = right ? GOD_TURN_RIGHT_END : GOD_TURN_LEFT_END;
    s.godFrame = 0;
    return;
  }
  s.godSpawnFrame = rand15(s) % GOD_SPAWN_ROLL;
  s.godX += dx;
  s.godFrame = 0;
}

function step(s: XicongState, inputs: readonly InputEvent[]): void {
  s.fx = [];
  for (const e of inputs) {
    if (e[1] === InputCode.CursorX && validateInput(e)) s.cursorX = e[2];
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
  if (s.phase === 'play' && --s.timeLeft <= 0) {
    enterEnding(s);
    s.fx.push({ t: 'timeup' });
  }
  if (s.phase === 'play') moveCatcher(s);
  const active = updateItems(s);
  warnStep(s);
  if (s.phase === 'play') {
    godWalk(s);
  } else {
    s.godState = GOD_IDLE_STATE;
    s.godFrame = GOD_IDLE_FRAME;
  }
  // 按 §5.2：本拍掉落物更新后已无在场物件即结束（ending 中预警才投下的炸弹不影响分数）
  if (s.phase === 'ending' && !active) s.phase = 'over';
  s.tick++;
}

function score(s: XicongState): number {
  let v = 0;
  for (let k = 0; k < s.counts.length; k++) v += ITEM_SCORE[k]! * s.counts[k]!;
  return v;
}

function clone(s: XicongState): XicongState {
  return {
    tick: s.tick,
    phase: s.phase,
    rng: s.rng,
    fx: s.fx.slice(),
    introLeft: s.introLeft,
    timeLeft: s.timeLeft,
    godX: s.godX,
    godState: s.godState,
    godFrame: s.godFrame,
    godSpawnFrame: s.godSpawnFrame,
    cursorX: s.cursorX,
    catcherX: s.catcherX,
    catcherDir: s.catcherDir,
    catcherFrame: s.catcherFrame,
    warn: s.warn,
    warnX: s.warnX,
    hitBomb: s.hitBomb,
    ix: s.ix.slice(),
    iy: s.iy.slice(),
    ikind: s.ikind.slice(),
    iframe: s.iframe.slice(),
    ivy: s.ivy.slice(),
    counts: s.counts.slice(),
  };
}

function hash(s: XicongState): number {
  let h = hashBase(TAG, s);
  h = hashInt(h, s.introLeft);
  h = hashInt(h, s.timeLeft);
  h = hashInt(h, s.godX);
  h = hashInt(h, s.godState);
  h = hashInt(h, s.godFrame);
  h = hashInt(h, s.godSpawnFrame);
  h = hashInt(h, s.cursorX);
  h = hashInt(h, s.catcherX);
  h = hashInt(h, s.catcherDir);
  h = hashInt(h, s.catcherFrame);
  h = hashInt(h, s.warn);
  h = hashInt(h, s.warnX);
  h = hashBool(h, s.hitBomb);
  h = hashInts(h, s.ix);
  h = hashInts(h, s.iy);
  h = hashInts(h, s.ikind);
  h = hashInts(h, s.iframe);
  h = hashInts(h, s.ivy);
  h = hashInts(h, s.counts);
  return hashFinish(h);
}

function validateInput(e: InputEvent): boolean {
  return validateInputForSpec(XICONG_SPEC, e);
}

export const XICONG_SIM: MinigameSim<XicongState> = Object.freeze({
  spec: XICONG_SPEC,
  init,
  step,
  isOver: (s: XicongState) => s.phase === 'over',
  score,
  clone,
  hash,
  validateInput,
  accepting,
});

/** 结算姿势分档（表现层）：0 (<40)、1 (40–49)、2 (50–59)、3 (≥60)；被炸时没有姿势 */
export function xicongPose(scoreValue: number): 0 | 1 | 2 | 3 {
  if (scoreValue < 40) return 0;
  if (scoreValue < 50) return 1;
  return scoreValue < 60 ? 2 : 3;
}
