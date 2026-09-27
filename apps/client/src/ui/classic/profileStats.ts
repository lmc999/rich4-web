// 个人资料栏四页（Panel#0：資金 / 地產 / 股票 / 其他）的数值：纯函数，只由 view + 地图算出（四个页面上一致）。
// 行图标烘焙在原版页图里（每页 3 行），这里给每行一个数值；各行语义按图标目视选取（visual）：
//   資金：现金 · 存款 · 总资产（shared netWorth，与引擎同算法）
//   地產：土地块数 · 房屋栋数 · 地产价值（总资产扣掉现金、存款、股票，加回贷款）
//   股票：股票市值 · 持股总数 · 持股损益（市值 − 累计成本）
//   其他：点券 · 贷款 · 卡片 / 道具数
import type { MapIndex } from '@rich4/shared/data';
import { netWorth, type SeatIndex } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';

export const PROFILE_PAGES = ['funds', 'estate', 'stocks', 'other'] as const;
export type ProfilePage = (typeof PROFILE_PAGES)[number];

export type ProfileFormat = 'money' | 'count' | 'lots' | 'houses' | 'shares' | 'pair';

export interface ProfileRow {
  /** 文案键 classic:profile.<page>.<field> */
  field: string;
  /** data-value（E2E 比对四个页面一致） */
  value: number | string;
  format: ProfileFormat;
}

export interface ProfileNumbers {
  cash: number;
  deposit: number;
  loan: number;
  points: number;
  netWorth: number;
  lots: number;
  houses: number;
  estateValue: number;
  stockValue: number;
  shares: number;
  stockProfit: number;
  cards: number;
  items: number;
}

/** 股票市值（与引擎 netWorth 同口径：持股 × 股价分 / 100 取整） */
function stockValueOf(view: GameView, seat: SeatIndex): { value: number; shares: number; cost: number } {
  const p = view.players.find((x) => x.seat === seat);
  let value = 0;
  let shares = 0;
  let cost = 0;
  if (!p) return { value, shares, cost };
  view.stocks.forEach((st, i) => {
    const h = p.holdings[i];
    if (!h || h.shares === 0) return;
    value += Math.trunc((h.shares * st.priceCents) / 100);
    shares += h.shares;
    cost += Math.trunc(h.costCents / 100);
  });
  return { value, shares, cost };
}

export function profileNumbers(view: GameView, map: MapIndex | null, seat: SeatIndex): ProfileNumbers | null {
  const p = view.players.find((x) => x.seat === seat);
  if (!p) return null;
  const st = stockValueOf(view, seat);
  const worth = map ? netWorth(view, map, seat) : p.cash + p.deposit - p.loan + st.value;
  const lands = view.lands.filter((l) => l.owner === seat);
  const facilities = view.facilities.filter((f) => f.owner === seat);
  return {
    cash: p.cash,
    deposit: p.deposit,
    loan: p.loan,
    points: p.points,
    netWorth: worth,
    lots: lands.length + facilities.length,
    houses: lands.reduce((a, l) => a + l.level, 0),
    estateValue: worth - p.cash - p.deposit + p.loan - st.value,
    stockValue: st.value,
    shares: st.shares,
    stockProfit: st.value - st.cost,
    cards: p.cardCount,
    items: p.items.reduce((a, b) => a + b, 0),
  };
}

/** 某页的三行 */
export function profileRows(page: ProfilePage, n: ProfileNumbers): [ProfileRow, ProfileRow, ProfileRow] {
  switch (page) {
    case 'funds':
      return [
        { field: 'cash', value: n.cash, format: 'money' },
        { field: 'deposit', value: n.deposit, format: 'money' },
        { field: 'netWorth', value: n.netWorth, format: 'money' },
      ];
    case 'estate':
      return [
        { field: 'lots', value: n.lots, format: 'lots' },
        { field: 'houses', value: n.houses, format: 'houses' },
        { field: 'value', value: n.estateValue, format: 'money' },
      ];
    case 'stocks':
      return [
        { field: 'value', value: n.stockValue, format: 'money' },
        { field: 'shares', value: n.shares, format: 'shares' },
        { field: 'profit', value: n.stockProfit, format: 'money' },
      ];
    case 'other':
      return [
        { field: 'points', value: n.points, format: 'count' },
        { field: 'loan', value: n.loan, format: 'money' },
        { field: 'inventory', value: `${n.cards}/${n.items}`, format: 'pair' },
      ];
  }
}
