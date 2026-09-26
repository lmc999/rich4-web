/**
 * 引擎随机数的语义层（architecture §4 RNG；design/engine.md §3）。
 * 底层是 state.secret.rng 上的 xoshiro128**；每次取数都带 purpose 标签。
 * SYS_DEBUG forceNext 往 secret.debugQueue 放的值按 purpose 逐个出队，直接替换「语义结果」（不消耗底层 RNG）：
 *   - dice          → 骰子点数 1..6
 *   - pick 类        → 候选下标 0..n-1（fork、parachute、reverse、place、beggar、steal 等）
 *   - rand15 类      → 原始值 0..32767（quota、market、bless、minigameSkip 等）
 *   - deck           → 卡号（该卡在牌堆中须有剩余）
 *   - u32 类         → 原始 uint32（minigameSeed、aiSeed）
 * 强制值不合法时抛 EngineRuleError('BAD_FORCED_VALUE')（只可能来自测试 / 调试输入）。
 */
import { xoshiroNext32, xoshiroRand15 } from '../../util/rng/xoshiro';
import { EngineRuleError } from '../errors';
import type { CardId, DiceFace, RandPurpose } from '../types/ids';
import type { GameState } from '../types/state';

/** 取出 purpose 的下一个强制值；没有则返回 null */
export function takeForced(s: GameState, purpose: RandPurpose): number | null {
  const q = s.secret.debugQueue;
  for (let i = 0; i < q.length; i++) {
    const e = q[i]!;
    if (e.purpose !== purpose) continue;
    const v = e.values.shift();
    if (e.values.length === 0) q.splice(i, 1);
    return v ?? null;
  }
  return null;
}

function badForced(purpose: RandPurpose, v: number, why: string): never {
  throw new EngineRuleError('BAD_FORCED_VALUE', `${purpose}=${v}: ${why}`, { purpose, value: v });
}

/** 0..32767 */
export function rand15(s: GameState, purpose: RandPurpose): number {
  const f = takeForced(s, purpose);
  if (f !== null) {
    if (!Number.isInteger(f) || f < 0 || f > 0x7fff) badForced(purpose, f, 'expect 0..32767');
    return f;
  }
  return xoshiroRand15(s.secret.rng);
}

/** rand15() % n（只有 1 个候选也消耗一次，与原版一致） */
export function pick(s: GameState, purpose: RandPurpose, n: number): number {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError(`pick(${purpose}): n must be a positive integer, got ${n}`);
  const f = takeForced(s, purpose);
  if (f !== null) {
    if (!Number.isInteger(f) || f < 0 || f >= n) badForced(purpose, f, `expect 0..${n - 1}`);
    return f;
  }
  return xoshiroRand15(s.secret.rng) % n;
}

/** 一颗骰子：rand15() % 6 + 1 */
export function rollDie(s: GameState): DiceFace {
  const f = takeForced(s, 'dice');
  if (f !== null) {
    if (!Number.isInteger(f) || f < 1 || f > 6) badForced('dice', f, 'expect 1..6');
    return f as DiceFace;
  }
  return ((xoshiroRand15(s.secret.rng) % 6) + 1) as DiceFace;
}

/** 原始 uint32（小游戏种子、aiSeed 派生） */
export function next32(s: GameState, purpose: RandPurpose): number {
  const f = takeForced(s, purpose);
  if (f !== null) {
    if (!Number.isInteger(f) || f < 0 || f > 0xffffffff) badForced(purpose, f, 'expect uint32');
    return f >>> 0;
  }
  return xoshiroNext32(s.secret.rng);
}

/** 按权重抽下标（权重为非负整数，合计 > 0）：r = rand15() % Σw，再沿累计和查找 */
export function weightedIndex(s: GameState, purpose: RandPurpose, weights: readonly number[]): number {
  let total = 0;
  for (const w of weights) total += w;
  if (total <= 0) throw new RangeError(`weightedIndex(${purpose}): empty weights`);
  let r = pick(s, purpose, total);
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]!;
    if (r < 0) return i;
  }
  return weights.length - 1;
}

/**
 * 从牌堆按剩余张数加权抽 1 张（不修改牌堆，由调用方扣减）；牌堆为空返回 null。
 * 强制值为卡号。
 */
export function drawCardId(s: GameState, purpose: RandPurpose = 'deck'): CardId | null {
  const forced = takeForced(s, purpose);
  const deck = s.pools.cards;
  if (forced !== null) {
    if (!Number.isInteger(forced) || forced < 1 || forced > 30 || (deck[forced] ?? 0) <= 0) {
      badForced(purpose, forced, 'expect a card id still in the deck');
    }
    return forced as CardId;
  }
  let total = 0;
  for (let c = 1; c < deck.length; c++) total += deck[c]!;
  if (total <= 0) return null;
  let r = xoshiroRand15(s.secret.rng) % total;
  for (let c = 1; c < deck.length; c++) {
    r -= deck[c]!;
    if (r < 0) return c as CardId;
  }
  return null;
}

/** Fisher–Yates（从后往前，j = pick(i+1)） */
export function shuffle<T>(s: GameState, purpose: RandPurpose, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = pick(s, purpose, i + 1);
    const t = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = t;
  }
  return arr;
}
