/**
 * AiView：对公平视图（projectState 的 GameView）的只读封装（design/minigames-ai.md §9.2、§9.9）。
 * 只读公开信息与本座位的决策 options；不引用 GameState、不访问 secret。数值规则经 engine/selectors 复用引擎实现。
 */
import type { MapIndex } from '../data/maps/mapIndex';
import type { CompanyDef, TileId } from '../data/maps/types';
import { daysUntil, netWorth } from '../engine/selectors/index';
import type { DateNum, LotId, SeatIndex } from '../engine/types/index';
import type { GameView, PlayerView } from '../view/types';
import type { AiRng } from './types';

export class AiView {
  constructor(
    readonly view: GameView,
    readonly seat: SeatIndex,
    readonly map: MapIndex,
  ) {}

  get me(): PlayerView {
    return this.player(this.seat);
  }

  player(seat: SeatIndex): PlayerView {
    const p = this.view.players.find((x) => x.seat === seat);
    if (!p) throw new RangeError(`no player at seat ${seat}`);
    return p;
  }

  get pi(): number {
    return this.view.econ.priceIndex;
  }

  get initialFund(): number {
    return this.view.econ.initialFund;
  }

  get date(): DateNum {
    return this.view.clock.date;
  }

  get dayOfMonth(): number {
    return this.view.clock.date % 100;
  }

  /** 已经过的月数（按 30 天一个月，至少 1；月均盈余的分母 ⚑） */
  get totalMonths(): number {
    return Math.trunc(this.view.clock.elapsedDays / 30) + 1;
  }

  /** 在场的其他玩家 */
  rivals(): SeatIndex[] {
    return this.view.players.filter((p) => p.alive && p.seat !== this.seat).map((p) => p.seat);
  }

  /** 最恨的人：严格大于当前最大值才替换（first-wins）；全为 0 返回 -1（@0x40d2d3） */
  mostHated(): SeatIndex | -1 {
    let best: SeatIndex | -1 = -1;
    let max = 0;
    for (const s of this.rivals()) {
      const h = this.me.hostility[s] ?? 0;
      if (h > max) {
        max = h;
        best = s;
      }
    }
    return best;
  }

  netWorth(seat: SeatIndex = this.seat): number {
    return netWorth(this.view, this.map, seat);
  }

  /** 持仓市值 Σ trunc(持股 × 股价分 / 100) */
  holdingsValue(seat: SeatIndex = this.seat): number {
    const p = this.player(seat);
    let v = 0;
    this.view.stocks.forEach((st, i) => {
      const n = p.holdings[i]?.shares ?? 0;
      if (n > 0) v += Math.trunc((n * st.priceCents) / 100);
    });
    return v;
  }

  /** 到 date 还有几天；date 为 0 时返回 null */
  daysUntil(date: DateNum): number | null {
    return daysUntil(this.view, date);
  }

  /** 股票对应的实体公司（没有返回 null） */
  companyOfStock(idx: number): CompanyDef | null {
    if (!this.map.def.stocks[idx]?.hasCompany) return null;
    return this.map.def.companies.find((c) => c.stockIndex === idx) ?? null;
  }

  /** 地块的地主（住宅、设施）；企业与非地产返回 undefined */
  ownerOfLot(lot: LotId): SeatIndex | null | undefined {
    if (lot.startsWith('L')) return this.view.lands.find((l) => l.id === lot)?.owner;
    if (lot.startsWith('F')) return this.view.facilities.find((f) => f.id === lot)?.owner;
    return undefined;
  }

  /**
   * 沿前进方向看 n 格（不回头；岔路用 AI 的 rng 挑一条并记下遇到过岔路；无路可走原路返回）（@0x40b221）
   */
  lookahead(n: number, rng: AiRng): { nodes: TileId[]; forked: boolean } {
    const me = this.me;
    let at = me.node;
    let prev = me.prevNode;
    const nodes: TileId[] = [];
    let forked = false;
    if (!me.placed || at === 0) return { nodes, forked };
    for (let i = 0; i < n; i++) {
      const cands = this.map.forwardCandidates(at, prev);
      let next: TileId;
      if (cands.length === 0) next = prev;
      else if (cands.length === 1) next = cands[0]!;
      else {
        forked = true;
        next = cands[rng.mod(cands.length)]!;
      }
      prev = at;
      at = next;
      nodes.push(at);
    }
    return { nodes, forked };
  }
}
