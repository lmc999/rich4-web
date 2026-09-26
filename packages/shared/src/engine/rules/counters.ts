/**
 * 阻碍类计数器的原版两段式编码（design/engine.md §7.2；docs/research/g_arbitration.md §3.2–§3.3）。
 * 低 7 位 = 天数；0x80 = 待释放。回合开始时：
 *   c == 0     → 不变
 *   c == 0x80  → 置 0 并「释放」（主阻碍：走回棋盘，本回合不掷骰）
 *   其他       → c − 1；减到 0 时写 0x80
 * 判定「受影响」的条件是 c ≠ 0（含 0x80）；状态框显示剩余天数 = (c & 0x7f) + 1。
 * 由此直接得到原版回合数：坐牢 N 天 = N 个被阻碍的回合 + 1 个走回棋盘（不掷骰）的回合。
 */
import { ECON } from '../../data/tables/economy';
import type { ConfineWhere } from '../types/frames';
import type { Counters2 } from '../types/state';

export const COUNTER_PENDING = ECON.COUNTER_PENDING;
export const COUNTER_MASK = ECON.COUNTER_MASK;

export interface Tick2Result {
  next: number;
  released: boolean;
}

export function tick2(c: number): Tick2Result {
  if (c === 0) return { next: 0, released: false };
  if (c === COUNTER_PENDING) return { next: 0, released: true };
  const n = (c & COUNTER_MASK) - 1;
  return { next: n <= 0 ? COUNTER_PENDING : n, released: false };
}

export function isCounterActive(c: number): boolean {
  return c !== 0;
}

/** 状态框显示的剩余天数（含本回合） */
export function displayRemaining(c: number): number {
  return (c & COUNTER_MASK) + 1;
}

/** 重复施加（加刑）：(旧值 + 新天数) & 0x7f，可能回绕成 0（原版如此） */
export function addCounterDays(old: number, days: number): number {
  return (old + days) & COUNTER_MASK;
}

/** 主阻碍，判定顺序即 TURN_BLOCKED.reason 的优先级 */
export const MAIN_BLOCKS: readonly ConfineWhere[] = Object.freeze(['hotel', 'away', 'jail', 'hospital'] as const);

/** 第一个非 0 的主阻碍；都为 0 返回 null */
export function mainBlockOf(st: Counters2): ConfineWhere | null {
  for (const k of MAIN_BLOCKS) if (st[k] !== 0) return k;
  return null;
}

/**
 * 回合开始时推进本人的计数器（原地修改），返回本次释放的主阻碍（按 MAIN_BLOCKS 顺序）。
 * - 主阻碍总是倒数；
 * - 主阻碍都为 0（释放当回合也算 0）时，冬眠、梦游、乌龟才倒数（关押期间暂停）；
 * - 停留总是倒数。
 */
export function tickActorCounters(st: Counters2): ConfineWhere[] {
  const released: ConfineWhere[] = [];
  for (const k of MAIN_BLOCKS) {
    const r = tick2(st[k]);
    st[k] = r.next;
    if (r.released) released.push(k);
  }
  if (mainBlockOf(st) === null) {
    st.hibernate = tick2(st.hibernate).next;
    st.sleepwalk = tick2(st.sleepwalk).next;
    st.tortoise = tick2(st.tortoise).next;
  }
  st.stay = tick2(st.stay).next;
  return released;
}

export function emptyCounters(): Counters2 {
  return { hotel: 0, away: 0, jail: 0, hospital: 0, hibernate: 0, sleepwalk: 0, stay: 0, tortoise: 0 };
}
