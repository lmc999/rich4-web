/**
 * DAY 帧：日推进（design/engine.md §7.9；docs/research/r_rules_map.md §7；g_arbitration.md §3.1）。
 * date → victory → pi → market → holiday → d15 → month → lots → end，每个阶段先推进游标再执行，
 * 所以可以被分红破产、拍卖等打断后从下一阶段继续。
 *
 * M1 实现 date、victory、pi、lots、end；market / holiday / d15 / month 留空待 M4（见 TODO）。
 */

import type { HolidayDef } from '../../data/maps/types';
import type { FrameHandler } from '../core/frameHandler';
import { holidayKey, holidayOn, isMarketClosedDay, nextDate, weekdayOf } from '../rules/calendar';
import { checkDayEnd } from '../rules/victory';
import { nextPriceIndex } from '../rules/wealth';
import type { FrameOf } from '../types/frames';
import type { LotId } from '../types/ids';
import type { GameState } from '../types/state';

type DayFrame = FrameOf<'DAY'>;

/** 按日期重算 weekday / marketOpen / holiday（开局、日推进、调试改日期共用） */
export function applyCalendar(s: GameState, holidays: readonly HolidayDef[]): void {
  const c = s.clock;
  c.weekday = weekdayOf(c.date);
  const h = holidayOn(c.date, holidays);
  c.holiday = h ? holidayKey(h) : null;
  c.marketOpen = !isMarketClosedDay(c.date, c.weekday, holidays) && s.econ.marketClosedDays === 0;
}

export const DAY: FrameHandler<DayFrame> = {
  step(ctx, f) {
    const s = ctx.s;
    switch (f.stage) {
      case 'date': {
        f.stage = 'victory';
        s.clock.date = nextDate(s.clock.date);
        s.clock.elapsedDays += 1;
        applyCalendar(s, ctx.map.def.holidays);
        ctx.emit('DAY_ADVANCED', { date: s.clock.date, weekday: s.clock.weekday, elapsed: s.clock.elapsedDays });
        return;
      }
      case 'victory': {
        f.stage = 'pi';
        const end = checkDayEnd(s, ctx.map);
        if (end) ctx.endGame(end);
        return;
      }
      case 'pi': {
        f.stage = 'market';
        const from = s.econ.priceIndex;
        const to = nextPriceIndex(s, ctx.map);
        if (to !== from) {
          s.econ.priceIndex = to;
          ctx.emit('PRICE_INDEX', { from, to });
        }
        return;
      }
      case 'market':
        // TODO(M4)：全面停市 / 挤兑天数 −1；各股停牌、利多、利空 −1；开市日跑行情（tickMarket → MARKET_TICK）
        f.stage = 'holiday';
        return;
      case 'holiday':
        // TODO(M4)：节日（圣诞节每位在场玩家从牌堆抽 1 张 → HOLIDAY + CARD_GAINED{source:'holiday'}）
        f.stage = 'd15';
        return;
      case 'd15':
        // TODO(M4)：15 日逐公司分红（负分红先存款后现金，扣不出来破产）→ 乐透开奖
        f.stage = 'month';
        return;
      case 'month':
        // TODO(M4)：每月 1 日月结（利息、冠军、悲情人物、清零月度累计）→ 礼物、宝箱重新摆放
        f.stage = 'lots';
        return;
      case 'lots': {
        f.stage = 'end';
        const expired: Record<'raise' | 'seal', LotId[]> = { raise: [], seal: [] };
        for (const l of [...s.lands, ...s.facilities]) {
          if (!l.mark) continue;
          l.mark.days -= 1;
          if (l.mark.days <= 0) {
            expired[l.mark.kind].push(l.id);
            l.mark = null;
          }
        }
        for (const kind of ['raise', 'seal'] as const) {
          if (expired[kind].length > 0) ctx.emit('MARK_EXPIRED', { lots: expired[kind], kind });
        }
        // 地契到期（日期相等才算；1/31 + 1 个月 = 2/31 永不到期）：地主清空、等级保留
        const tenure: LotId[] = [];
        for (const l of [...s.lands, ...s.facilities]) {
          if (l.owner !== null && l.tenure !== 0 && l.tenure === s.clock.date) {
            l.owner = null;
            l.tenure = 0;
            tenure.push(l.id);
          }
        }
        if (tenure.length > 0) ctx.emit('TENURE_EXPIRED', { lots: tenure });
        return;
      }
      case 'end':
        ctx.emit('DAY_END', { date: s.clock.date, elapsed: s.clock.elapsedDays });
        ctx.pop(f);
        return;
    }
  },
};
