/**
 * 胜负判定（design/engine.md §7.9 'victory'、§7.10；docs/research/r_rules_map.md §2）。
 * - 时间与资产条件只在日推进时判定：
 *   时间到：已过天数 ≥ 游戏时间，且在场首富资产 > 0；
 *   资产达标：在场首富资产 ≥ 倍数 × 开局资金（阈值用 ≥）。
 *   赢家为在场首富，并列取座位靠前者。
 * - 破产之后：本局有真人座位、而在场真人为 0（且 endWhenNoHumans）→ noHumansLeft（code 1，无赢家）；
 *   在场只剩 1 人 → lastStanding。
 *   ⚑ 全员 controller='ai' 的对局（模拟、测试）不触发 noHumansLeft，否则第一次破产就会结束。
 * - 终局码：1 真人全出局；2 单真人局胜；3 多真人局胜（按本局 human 座位数）。
 */
import type { EngineMap } from '../core/mapCache';
import type { SeatIndex } from '../types/ids';
import type { GameEndReason, GameResult } from '../types/state';
import { netWorth } from './wealth';
import type { RuleWorld } from './world';

export interface EndCheck {
  reason: GameEndReason;
  winner: SeatIndex | null;
}

/** 在场首富（并列取座位靠前）；没有在场玩家返回 null */
export function richestAlive(w: RuleWorld, em: EngineMap): { seat: SeatIndex; worth: number } | null {
  let best: { seat: SeatIndex; worth: number } | null = null;
  for (const p of w.players) {
    if (!p.alive) continue;
    const worth = netWorth(w, em, p.seat);
    if (best === null || worth > best.worth || (worth === best.worth && p.seat < best.seat))
      best = { seat: p.seat, worth };
  }
  return best;
}

export function checkDayEnd(w: RuleWorld, em: EngineMap): EndCheck | null {
  const top = richestAlive(w, em);
  if (top === null) return null;
  const limit = w.config.timeLimitDays;
  if (limit > 0 && w.clock.elapsedDays >= limit && top.worth > 0) return { reason: 'timeLimit', winner: top.seat };
  const multiple = w.config.winMultiple;
  if (multiple > 0 && top.worth >= multiple * w.econ.initialFund) return { reason: 'wealthTarget', winner: top.seat };
  return null;
}

export function checkAfterBankruptcy(w: RuleWorld): EndCheck | null {
  const alive = w.players.filter((p) => p.alive);
  const hadHumans = w.players.some((p) => p.controller === 'human');
  const humansAlive = alive.filter((p) => p.controller === 'human').length;
  if (w.config.rules.endWhenNoHumans && hadHumans && humansAlive === 0) return { reason: 'noHumansLeft', winner: null };
  if (alive.length === 1) return { reason: 'lastStanding', winner: alive[0]!.seat };
  if (alive.length === 0) return { reason: 'lastStanding', winner: null };
  return null;
}

/** 排名：在场者在前，资产降序，平手按座位升序 */
export function ranking(w: RuleWorld, em: EngineMap): GameResult['ranking'] {
  const rows = w.players.map((p) => ({ seat: p.seat, netWorth: netWorth(w, em, p.seat), alive: p.alive }));
  rows.sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    if (a.netWorth !== b.netWorth) return b.netWorth - a.netWorth;
    return a.seat - b.seat;
  });
  return rows;
}

export function resultCode(w: RuleWorld, reason: GameEndReason): 1 | 2 | 3 {
  if (reason === 'noHumansLeft') return 1;
  const humans = w.players.filter((p) => p.controller === 'human').length;
  return humans > 1 ? 3 : 2;
}

export function buildResult(w: RuleWorld, em: EngineMap, end: EndCheck): GameResult {
  return {
    reason: end.reason,
    code: resultCode(w, end.reason),
    winner: end.winner,
    date: w.clock.date,
    elapsedDays: w.clock.elapsedDays,
    ranking: ranking(w, em),
  };
}
