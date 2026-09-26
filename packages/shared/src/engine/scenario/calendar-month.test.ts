import { describe, expect, it } from 'vitest';
import { lunarOf } from '../../data/calendar/lunar';
import { buildFixtureMaps } from '../../data/maps/fixtures/testMap';
import { createRegistry } from '../../data/maps/registry';
import type { HolidayDef } from '../../data/maps/types';
import { TABLES } from '../../data/tables/index';
import { holidayOn, isMarketClosedDay, loanDueDate, nextDate, weekdayOf } from '../rules/calendar';
import { scenario } from '../testing/scenario';

/** 'test' 地图换一张节日表（kind 0 公历 / 1 农历 / 2 第 n 个星期 w） */
function registryWithHolidays(holidays: HolidayDef[]) {
  const maps = buildFixtureMaps();
  maps.find((m) => m.id === 'test')!.holidays = holidays;
  return createRegistry(maps, { tables: TABLES, verifyHash: false });
}

const SECOND_MONDAY_OF_MAY: HolidayDef = { slot: 0, month: 5, day: 2, kind: 2, flagsRaw: 1 << 16, closed: true };
const SPRING_FESTIVAL: HolidayDef = { slot: 1, month: 1, day: 1, kind: 1, flagsRaw: 1, closed: true, lunar: true };
const GHOST: HolidayDef = { slot: 2, month: 7, day: 15, kind: 1, flagsRaw: 0, closed: false, lunar: true };
const LUNAR_NEW_YEARS_EVE_31: HolidayDef = {
  slot: 3,
  month: 12,
  day: 31,
  kind: 1,
  flagsRaw: 1,
  closed: true,
  lunar: true,
};

describe('holiday：节日与休市（kind 0 / 1 / 2）', () => {
  it('kind 2：第 n 个星期 w（flagsRaw 16..23 位，或 HolidayDef.weekday）', () => {
    const hs = [SECOND_MONDAY_OF_MAY];
    expect(weekdayOf(20050509)).toBe(1);
    expect(holidayOn(20050509, hs)).toBe(SECOND_MONDAY_OF_MAY);
    expect(holidayOn(20050502, hs)).toBeNull();
    expect(holidayOn(20050510, hs)).toBeNull();
    const withField = { ...SECOND_MONDAY_OF_MAY, flagsRaw: 0, weekday: 1 } as HolidayDef;
    expect(holidayOn(20050509, [withField])).toBe(withField);
    // 台湾母亲节：五月第 2 个星期日（weekday 0）
    const mothers = { slot: 7, month: 5, day: 2, kind: 2, flagsRaw: 0, closed: false } as HolidayDef;
    expect(holidayOn(20050508, [mothers])).toBe(mothers);
  });

  it('kind 1：农历按 data/calendar/lunar 换算；闰月沿用月号（与 exe 表一致）；十二月三十一永不命中', () => {
    expect(holidayOn(20050209, [SPRING_FESTIVAL])).toBe(SPRING_FESTIVAL);
    expect(holidayOn(20060129, [SPRING_FESTIVAL])).toBe(SPRING_FESTIVAL);
    // 2006 年闰七月：七月十五与闰七月十五都命中
    const hits: number[] = [];
    for (let d = 20060101; d <= 20061231; d = nextDate(d)) if (holidayOn(d, [GHOST])) hits.push(d);
    expect(hits).toHaveLength(2);
    expect(hits.map((d) => lunarOf(d)!.leap)).toEqual([false, true]);
    for (let d = 19980101; d <= 20301231; d = nextDate(d)) expect(holidayOn(d, [LUNAR_NEW_YEARS_EVE_31])).toBeNull();
  });

  it('休市节日也影响贷款到期日顺延', () => {
    expect(isMarketClosedDay(20050209, weekdayOf(20050209), [SPRING_FESTIVAL])).toBe(true);
    // 2004-11-11 + 90 = 2005-02-09（春节，星期三）→ 顺延到 2005-02-10
    expect(loanDueDate(20041111, 90, [SPRING_FESTIVAL])).toBe(20050210);
  });

  it('holiday market closed：kind 2 与农历节日当天 MARKET_CLOSED{reason:"holiday"}，并发 HOLIDAY', () => {
    const reg = registryWithHolidays([SECOND_MONDAY_OF_MAY, SPRING_FESTIVAL]);
    const sc = scenario({ registry: reg, players: ['human', 'human'] }).untilMenu(1);
    sc.apply({ type: 'SYS_DEBUG', op: { op: 'setDate', date: 20050508 } });
    sc.until((s) => s.clock.date === 20050509);
    expect(sc.log.filter((e) => e.type === 'MARKET_CLOSED').at(-1)).toMatchObject({ reason: 'holiday' });
    expect(sc.log.filter((e) => e.type === 'HOLIDAY').at(-1)).toMatchObject({ key: 'h0', giveCard: false });
    expect(sc.state.clock).toMatchObject({ marketOpen: false, holiday: 'h0' });

    const cny = scenario({ registry: reg, players: ['human', 'human'] }).untilMenu(1);
    cny.apply({ type: 'SYS_DEBUG', op: { op: 'setDate', date: 20050208 } });
    cny.until((s) => s.clock.date === 20050209);
    expect(cny.log.filter((e) => e.type === 'MARKET_CLOSED').at(-1)).toMatchObject({ reason: 'holiday' });
    expect(cny.state.clock).toMatchObject({ marketOpen: false, holiday: 'h1' });
    // 次日照常开市
    cny.until((s) => s.clock.date === 20050210);
    expect(cny.state.clock.marketOpen).toBe(true);
  });

  it('送卡的节日（圣诞）：每位在场玩家从牌堆抽 1 张', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(1);
    sc.apply({ type: 'SYS_DEBUG', op: { op: 'setDate', date: 20051224 } });
    sc.until((s) => s.clock.date === 20051225);
    expect(sc.log.find((e) => e.type === 'HOLIDAY')).toMatchObject({ key: 'h1', giveCard: true });
    const gained = sc.log.filter((e) => e.type === 'CARD_GAINED' && e.source === 'holiday');
    expect(gained.map((e) => (e as { seat: number }).seat)).toEqual([0, 1]);
  });
});

describe('monthly（1 日月结）', () => {
  it('monthly interest with/without loan：无贷款者存款 ×1.1；有贷款者不发；评冠军与悲情人物，清零月度累计', () => {
    const sc = scenario({ players: ['human', 'human', 'human'] }).untilMenu(2);
    sc.apply({ type: 'SYS_DEBUG', op: { op: 'setDate', date: 20050531 } }).edit((s) => {
      s.players[0]!.loan = 10000;
      s.players[0]!.loanDue = 20050801;
      s.players[0]!.monthly = { loss: 14001, gain: 0, badDays: 0, interest: 0 };
      s.players[1]!.monthly = { loss: 10000, gain: 0, badDays: 0, interest: 0 };
      s.players[2]!.deposit = 100005;
      s.econ.ledger.minted += 5;
    });
    const d0 = sc.player(0).deposit;
    const d1 = sc.player(1).deposit;
    sc.until((s) => s.clock.date === 20050601);
    const rep = sc.log.find((e) => e.type === 'MONTHLY_REPORT');
    expect(rep).toMatchObject({
      rows: [
        { seat: 0, loss: 14001, interest: 0 },
        { seat: 1, loss: 10000, interest: Math.trunc(d1 / 10) },
        { seat: 2, interest: 10000 },
      ],
      champion: 2,
      tragic: 0,
    });
    expect(sc.player(0).deposit).toBe(d0);
    expect(sc.player(1).deposit).toBe(d1 + Math.trunc(d1 / 10));
    expect(sc.player(2).deposit).toBe(110005);
    for (const p of sc.state.players) expect(p.monthly).toEqual({ loss: 0, gain: 0, badDays: 0, interest: 0 });
  });

  it('悲情人物须领先次高分 40%（倒楣天数 × PI × 2500 计入分数）', () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(1);
    sc.apply({ type: 'SYS_DEBUG', op: { op: 'setDate', date: 20050531 } }).edit((s) => {
      s.players[0]!.monthly = { loss: 14000, gain: 0, badDays: 0, interest: 0 };
      s.players[1]!.monthly = { loss: 0, gain: 0, badDays: 4, interest: 0 };
    });
    sc.until((s) => s.clock.date === 20050601);
    // 0 号 14000，1 号 4 × 1 × 2500 = 10000：14000 × 10 > 10000 × 14 不成立
    expect(sc.log.find((e) => e.type === 'MONTHLY_REPORT')).toMatchObject({ tragic: null });
  });
});
