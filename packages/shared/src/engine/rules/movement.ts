/**
 * 行进（architecture §7.2；design/engine.md §7.4–§7.5；docs/research/g_arbitration.md §2.m）。
 * - 岔路：候选 = MapIndex.forwardCandidates(at, prev)（按槽序去掉来路与静态封路）；
 *   候选为空 → 掉头回 prev（不消耗随机数）；否则取 候选[rand15() % n]，只有 1 个候选也消耗一次。
 * - 骰子颗数：步行 1、机车 1..2、汽车 1..3、工程车 1。
 */
import type { MapIndex } from '../../data/maps/mapIndex';
import { VEHICLE_MAX_DICE } from '../../data/tables/setup';
import type { DiceCount, TileId, Vehicle } from '../types/ids';

export function maxDice(v: Vehicle): DiceCount {
  return VEHICLE_MAX_DICE[v];
}

/** 交通工具允许的骰子颗数（ROLL{dice} 的合法取值） */
export function diceAllowed(v: Vehicle): DiceCount[] {
  const out: DiceCount[] = [];
  for (let n = 1; n <= maxDice(v); n++) out.push(n as DiceCount);
  return out;
}

/**
 * 下一格。pickFork(n) 返回 0..n-1（由调用方接到 ctx 的 'fork' 随机数，强制值同样按下标解释）。
 */
export function nextTile(map: MapIndex, at: TileId, prev: TileId, pickFork: (n: number) => number): TileId {
  const cands = map.forwardCandidates(at, prev);
  if (cands.length === 0) return prev;
  return cands[pickFork(cands.length)]!;
}
