/**
 * 总资产与物价指数（design/engine.md §7.9 'pi'、§11.1；docs/research/r_rules_map.md §2、r_property.md §2、§10）。
 *
 * netWorth = cash + deposit − loan
 *          + Σ trunc(持股 × 股价分 / 100)
 *          + Σ 自有住宅 (landPrice + (连锁店 ? 房价 : 等级 × 房价))
 *          + Σ 自有设施 (landPrice + 等级 × rate0)          // rate0 = rateWindow[0] = 房价
 * 全程按 int32 语义（intOverflow），不乘物价指数；特别融资已计入存款，不扣除（原版如此）。
 *
 * PI = max(PI, trunc(trunc(Σ在场 netWorth / 在场人数) / 开局资金))，只升不降。
 * @source exe v3.11 rich4_calculate_player_wealth、rich4_update_price_index（oama rich4-spec）
 */
import { add32, divTrunc, mul32, sub32, toInt32 } from '../../util/int32';
import type { EngineMap } from '../core/mapCache';
import type { SeatIndex } from '../types/ids';
import { modeOf, playerOf, type RuleWorld } from './world';

export function netWorth(w: RuleWorld, em: EngineMap, seat: SeatIndex): number {
  const mode = modeOf(w);
  const p = playerOf(w.players, seat);
  let v = sub32(add32(p.cash, p.deposit, mode), p.loan, mode);
  for (let i = 0; i < w.stocks.length; i++) {
    const shares = p.holdings[i]?.shares ?? 0;
    if (shares === 0) continue;
    // 持股 × 股价分可能超出 int32：先在双精度下精确计算再截断（2^53 以内）
    v = add32(v, toInt32(Math.trunc((shares * w.stocks[i]!.priceCents) / 100), mode), mode);
  }
  for (let i = 0; i < w.lands.length; i++) {
    const l = w.lands[i]!;
    if (l.owner !== seat) continue;
    const def = em.lands[i]!;
    const house = l.chain ? def.housePrice : mul32(l.level, def.housePrice, mode);
    v = add32(v, add32(l.landPrice, house, mode), mode);
  }
  for (let i = 0; i < w.facilities.length; i++) {
    const f = w.facilities[i]!;
    if (f.owner !== seat) continue;
    const def = em.facilities[i]!;
    v = add32(v, add32(f.landPrice, mul32(f.level, def.rateWindow[0], mode), mode), mode);
  }
  return v;
}

/** 日推进 'pi' 阶段的新物价指数（只升不降）；没有在场玩家时保持不变 */
export function nextPriceIndex(w: RuleWorld, em: EngineMap): number {
  const mode = modeOf(w);
  const alive = w.players.filter((p) => p.alive);
  if (alive.length === 0 || w.econ.initialFund <= 0) return w.econ.priceIndex;
  let sum = 0;
  for (const p of alive) sum = add32(sum, netWorth(w, em, p.seat), mode);
  const avg = divTrunc(sum, alive.length, mode);
  const pi = divTrunc(avg, w.econ.initialFund, mode);
  return pi > w.econ.priceIndex ? pi : w.econ.priceIndex;
}
