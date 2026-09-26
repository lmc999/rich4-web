/**
 * 喜从天降 bot（design/minigames-ai.md §5.2 末）：只读屏幕上看得到的掉落物与接物者位置。
 * 1) 若某颗炸弹 8 tick 内会落进接物者 ±40px，先向远离的方向躲；
 * 2) 否则在赶得上的宝物中挑「分值 / 到达 tick」最大者，把光标对准它的预测判定点；
 *    瞄准时光标在目标两侧 ±12 交替，让接物者一直处于移动状态（CATCH_REQUIRES_MOVING）；
 * 3) 没有目标时跟着财神走。光标只在变化时上报（每 tick 至多一条）。
 */
import { InputCode, type InputEvent, type MinigameBot } from '../types';
import {
  CATCH_BOTTOM_Y,
  CATCH_HALF_W,
  CATCH_TOP_Y,
  CATCHER_SPEED,
  FALL,
  ITEM_BOMB,
  ITEM_GRAVITY,
  ITEM_MAX_VY,
  ITEM_MISS_Y,
  ITEM_SCORE,
  ITEM_SLOTS,
  ITEM_TOSS_UNTIL_Y,
  SWAY_FRAMES,
} from './constants';
import { itemPx, type XicongState } from './sim';

interface XicongBotMem {
  /** 上次上报的光标 x；−1 表示尚未上报 */
  last: number;
}

const LOOKAHEAD = 60;
const BOMB_HORIZON = 8;
const BOMB_MARGIN = 40;
const DODGE = 100;
const WOBBLE = 12;

/** 预测槽 i 第一次进入接住高度带的步数 k 与判定点 px；落出屏幕前进不去返回 null */
export function predictCatch(s: Readonly<XicongState>, i: number, maxK = LOOKAHEAD): { k: number; px: number } | null {
  let y = s.iy[i]!;
  let vy = s.ivy[i]!;
  let f = s.iframe[i]!;
  const kind = s.ikind[i]!;
  for (let k = 1; k <= maxK; k++) {
    f = (f + 1) % SWAY_FRAMES;
    if (y < ITEM_TOSS_UNTIL_Y) {
      vy = vy + ITEM_GRAVITY > ITEM_MAX_VY ? ITEM_MAX_VY : vy + ITEM_GRAVITY;
      y += vy;
    } else {
      y += FALL[kind]!;
    }
    if (y > CATCH_TOP_Y && y < CATCH_BOTTOM_Y) return { k, px: itemPx(s.ix[i]!, y, f) };
    if (y > ITEM_MISS_Y) return null;
  }
  return null;
}

function clampX(x: number): number {
  return x < 0 ? 0 : x > 639 ? 639 : x;
}

export function chooseXicongCursor(s: Readonly<XicongState>): number {
  const cx = s.catcherX;
  // 1) 躲炸弹
  for (let i = 0; i < ITEM_SLOTS; i++) {
    if (s.ix[i] === 0 || s.ikind[i] !== ITEM_BOMB) continue;
    const p = predictCatch(s, i, BOMB_HORIZON);
    if (p === null || Math.abs(p.px - cx) >= BOMB_MARGIN + CATCH_HALF_W) continue;
    let to = p.px <= cx ? cx + DODGE : cx - DODGE;
    if (to > 639 || to < 0) to = p.px <= cx ? cx - DODGE : cx + DODGE;
    return clampX(to);
  }
  // 2) 赶得上的宝物中「分值 / 到达 tick」最大者（整数交叉相乘比较，平手取槽号小者）
  let best = -1;
  let bestV = 0;
  let bestK = 1;
  let bestPx = 0;
  for (let i = 0; i < ITEM_SLOTS; i++) {
    if (s.ix[i] === 0 || s.ikind[i] === ITEM_BOMB) continue;
    const p = predictCatch(s, i);
    if (p === null) continue;
    if (Math.abs(p.px - cx) - (CATCH_HALF_W - 3) > CATCHER_SPEED * p.k) continue;
    const v = ITEM_SCORE[s.ikind[i]!]!;
    if (best < 0 || v * bestK > bestV * p.k) {
      best = i;
      bestV = v;
      bestK = p.k;
      bestPx = p.px;
    }
  }
  if (best >= 0) return clampX(bestPx + ((s.tick & 1) === 1 ? WOBBLE : -WOBBLE));
  // 3) 跟着财神
  return clampX(s.godX);
}

export const XICONG_BOT: MinigameBot<XicongState> = Object.freeze({
  create(_seed: number): XicongBotMem {
    return { last: -1 };
  },
  act(memRaw: unknown, s: Readonly<XicongState>): InputEvent[] {
    const mem = memRaw as XicongBotMem;
    if (s.phase !== 'play') return [];
    const x = chooseXicongCursor(s);
    if (x === mem.last) return [];
    mem.last = x;
    return [[s.tick, InputCode.CursorX, x]];
  },
});
