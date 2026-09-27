/**
 * 红卡、黑卡（design/engine.md §10.2 #24/25；docs/research/g_arbitration.md §2.a；r_stocks_time.md §4.5）。
 *
 * PROGRAM（exe）：走势字节写红 0x20 / 黑 0x02（up / down = 2，另一个清 0），并立即按开盘价 ±10% 重定当日价
 *   （覆盖当日走势点）；日推进时先减计数再算行情，计数仍非 0 再 ±10%——共当天 + 下一个自然日两次（休市日照扣不跳价）。
 *   重复使用覆写：同色重置计数并再按开盘价 ±10%，异色直接改成反向。
 * MANUAL：说明书「涨停板三天、重复使用可相抵消」：计数 3；已有异色计数时两者抵消为 0、价格不动 ⚑。
 * 休市日不可用（marketClosed，卡不消耗）；停牌中的股票不可选。不产生敌意。
 */
import { CMB } from '../../../data/tables/combat';
import { ECON } from '../../../data/tables/economy';
import type { Ctx } from '../../core/ctx';
import { movePrice } from '../../rules/stock';
import type { CardEffect } from '../types';
import { unusable, usableIf } from '../types';

function stockCard(dir: 'up' | 'down'): CardEffect {
  return {
    menu(s) {
      const open = s.clock.marketOpen && s.econ.marketClosedDays === 0;
      if (!open) return unusable('marketClosed', { t: 'stock', stocks: [] });
      const stocks = s.stocks.filter((st) => st.suspend === 0).map((st) => st.idx);
      return usableIf({ t: 'stock', stocks }, stocks.length === 0);
    },
    apply(ctx: Ctx, _seat, t) {
      if (t.t !== 'stock') return;
      const st = ctx.s.stocks.find((x) => x.idx === t.stock);
      if (!st) return;
      const other = dir === 'up' ? 'down' : 'up';
      if (ctx.s.config.rules.redBlack === 'manual' && st[other] > 0) {
        st.up = 0;
        st.down = 0;
        ctx.emit('STOCK_FLAG', { stock: st.idx, up: 0, down: 0, byCard: true });
        return;
      }
      const days = ctx.s.config.rules.redBlack === 'manual' ? CMB.RED_BLACK_MANUAL_DAYS : CMB.RED_BLACK_DAYS;
      st[dir] = days;
      st[other] = 0;
      st.priceCents = movePrice(st.openCents, dir === 'up' ? ECON.STOCK_LIMIT_PCT : -ECON.STOCK_LIMIT_PCT);
      if (st.history.length > 0) st.history[st.history.length - 1] = st.priceCents;
      ctx.emit('STOCK_FLAG', { stock: st.idx, up: st.up, down: st.down, byCard: true });
    },
  };
}

export const redCard: CardEffect = stockCard('up');
export const blackCard: CardEffect = stockCard('down');
