import { describe, expect, it } from 'vitest';
import type { HolidayDef } from '../../data/maps/types';
import {
  addDays,
  addTenure,
  dayNumber,
  daysBetween,
  fromDayNumber,
  holidayOn,
  isLeapYear,
  isMarketClosedDay,
  isValidDate,
  loanDueDate,
  nextDate,
  nthWeekdayDay,
  weekdayOf,
} from './calendar';

describe('calendar（design/engine.md §3「日期」）', () => {
  it('1998-01-01 是星期四；已知日期的星期', () => {
    expect(weekdayOf(19980101)).toBe(4);
    expect(weekdayOf(19980104)).toBe(0);
    expect(weekdayOf(20000101)).toBe(6);
    expect(weekdayOf(20100101)).toBe(5);
    expect(weekdayOf(20260927)).toBe(0);
  });

  it('闰年只看 %4：2000、2100 都是闰年', () => {
    expect(isLeapYear(2000)).toBe(true);
    expect(isLeapYear(2100)).toBe(true);
    expect(isLeapYear(1999)).toBe(false);
    expect(isValidDate(20000229)).toBe(true);
    expect(isValidDate(21000229)).toBe(true);
    expect(isValidDate(19990229)).toBe(false);
    expect(nextDate(20040228)).toBe(20040229);
    expect(nextDate(20040229)).toBe(20040301);
    expect(nextDate(20031231)).toBe(20040101);
  });

  it('逐日推进与 dayNumber / 星期相互一致（1998..2012）', () => {
    let d = 19980101;
    let wd = weekdayOf(d);
    for (let n = 0; n < 5500; n++) {
      expect(dayNumber(d)).toBe(n);
      expect(fromDayNumber(n)).toBe(d);
      expect(weekdayOf(d)).toBe(wd);
      d = nextDate(d);
      wd = (wd + 1) % 7;
    }
    expect(daysBetween(19980101, 19990101)).toBe(365);
    expect(daysBetween(20000101, 20010101)).toBe(366);
    expect(addDays(20050131, 30)).toBe(20050302);
  });

  it('地契按月加、不夹日：1/31 + 1 个月 = 2/31，这一天永远不会到来', () => {
    expect(addTenure(20050131, '1m')).toBe(20050231);
    expect(isValidDate(20050231)).toBe(false);
    expect(addTenure(20051130, '3m')).toBe(20060230);
    expect(addTenure(20050115, '2y')).toBe(20070115);
    expect(addTenure(20050115, 'unlimited')).toBe(0);
    let d = 20050101;
    for (let i = 0; i < 400; i++) {
      expect(d).not.toBe(20050231);
      d = nextDate(d);
    }
  });

  it('休市：星期日与 closed 节日（农历节日暂不判定）；贷款到期日顺延到开市日', () => {
    const holidays: HolidayDef[] = [
      { slot: 0, month: 1, day: 1, kind: 0, flagsRaw: 1, closed: true },
      { slot: 1, month: 12, day: 25, kind: 0, flagsRaw: 2, giveCard: true },
      { slot: 2, month: 1, day: 3, kind: 0, flagsRaw: 1, closed: true, lunar: true },
    ];
    expect(isMarketClosedDay(19980104, 0, holidays)).toBe(true);
    expect(isMarketClosedDay(19990101, weekdayOf(19990101), holidays)).toBe(true);
    expect(isMarketClosedDay(19981225, weekdayOf(19981225), holidays)).toBe(false);
    expect(isMarketClosedDay(19990105, weekdayOf(19990105), holidays)).toBe(false);
    expect(holidayOn(19981225, holidays)?.slot).toBe(1);
    expect(holidayOn(19990103, holidays)).toBeNull();
    // 1998-10-04 + 89 天 = 1999-01-01（节日、星期五）→ 顺延到 1999-01-02（星期六）
    expect(addDays(19981004, 89)).toBe(19990101);
    expect(loanDueDate(19981004, 89, holidays)).toBe(19990102);
    // 落在星期日顺延到星期一
    expect(weekdayOf(addDays(19980101, 3))).toBe(0);
    expect(loanDueDate(19980101, 3, holidays)).toBe(19980105);
  });

  it('kind 2（第 n 个星期 w）：day = n，星期在 flagsRaw 16..23 位；不再当作固定日期', () => {
    // 台湾 slot 7：5 月第 2 个星期日（母亲节），flagsRaw 星期位 = 0
    const mother: HolidayDef = { slot: 7, month: 5, day: 2, kind: 2, flagsRaw: 0, closed: false };
    // 虚构：11 月第 4 个星期四，休市（感恩节式）
    const thanks: HolidayDef = { slot: 3, month: 11, day: 4, kind: 2, flagsRaw: (4 << 16) | 1, closed: true };
    const holidays = [mother, thanks];
    expect(weekdayOf(19980502)).toBe(6);
    expect(holidayOn(19980502, holidays)).toBeNull();
    expect(weekdayOf(19990502)).toBe(0);
    expect(holidayOn(19990502, holidays)).toBeNull(); // 1999 年 5 月第 1 个星期日
    expect(holidayOn(19980510, holidays)?.slot).toBe(7);
    expect(holidayOn(19990509, holidays)?.slot).toBe(7);
    expect(holidayOn(19980503, holidays)).toBeNull(); // 第 1 个星期日
    expect(holidayOn(19980517, holidays)).toBeNull(); // 第 3 个星期日
    // 1998-11-26 是 11 月第 4 个星期四；11-04 只是日期巧合
    expect(weekdayOf(19981126)).toBe(4);
    expect(holidayOn(19981104, holidays)).toBeNull();
    expect(holidayOn(19981126, holidays)?.slot).toBe(3);
    expect(isMarketClosedDay(19981126, 4, holidays)).toBe(true);
    expect(isMarketClosedDay(19981104, weekdayOf(19981104), holidays)).toBe(false);
    // 贷款到期日落在 1998-11-26 → 顺延到 11-27（星期五）
    expect(loanDueDate(19981125, 1, holidays)).toBe(19981127);
    expect(loanDueDate(19981103, 1, holidays)).toBe(19981104);
  });

  it('kind 2 照搬 exe 0x4521f0：w < 当月 1 日的星期时丢掉 w，目标日落在星期日', () => {
    // mapId 3 slot 6 式：2 月第 3 个星期一，休市。2000-02-01 是星期二（wd1 = 2 > w = 1）
    const third: HolidayDef = { slot: 6, month: 2, day: 3, kind: 2, flagsRaw: 1, weekday: 1, closed: true };
    expect(weekdayOf(20000201)).toBe(2);
    expect(nthWeekdayDay(2, 1, 3)).toBe(20);
    expect(weekdayOf(20000220)).toBe(0);
    expect(holidayOn(20000220, [third])).toBe(third);
    expect(holidayOn(20000221, [third])).toBeNull(); // 数学上的第 3 个星期一，原版照常开市
    expect(isMarketClosedDay(20000221, 1, [third])).toBe(false);
    // w ≥ wd1 时与数学定义一致：2005-02-01 是星期二，第 3 个星期四 = 2/17
    const thu: HolidayDef = { ...third, weekday: 4 };
    expect(weekdayOf(20050201)).toBe(2);
    expect(holidayOn(20050217, [thu])).toBe(thu);
    // 超出当月天数不命中（2000-02 第 5 个星期二 = 2/29 命中；第 5 个星期三 = 3/1 不算）
    expect(nthWeekdayDay(2, 3, 5)).toBe(30);
    expect(holidayOn(20000229, [{ ...third, day: 5, weekday: 2 }])?.slot).toBe(6);
  });
});

/**
 * 美国图（gm 3）的 kind 2 节日：字面量照抄 exe v2.06 节日表 0x47d6aa + 3·288 的对应项（MapDef 口径：
 * flagsRaw 16..23 位 = 星期，weekday 同值）。CI 没有原版数据，所以不读 rich4-data。
 * 行为照搬 exe（fcn.00450a17 0x450b12–0x450b6c）：w < 当月 1 日的星期时落在星期日，超出当月天数不命中。
 * 美国图的实机表现（1998-01-18、1998-09-06 是否显示节日）登记在 VERIFY 待核实。
 */
describe('calendar：美国图 kind 2 节日（原版算法，锁定现状）', () => {
  // slot 2：1 月第 3 个星期一（马丁路德金纪念日）
  const mlk: HolidayDef = { slot: 2, month: 1, day: 3, kind: 2, flagsRaw: 1 << 16, weekday: 1, closed: false };
  // slot 8：5 月第 2 个星期日（母亲节），w = 0
  const mother: HolidayDef = { slot: 8, month: 5, day: 2, kind: 2, flagsRaw: 0, weekday: 0, closed: false };
  // slot 9：5 月第 5 个星期一（阵亡将士纪念日的原版写法）
  const memorial: HolidayDef = { slot: 9, month: 5, day: 5, kind: 2, flagsRaw: 1 << 16, weekday: 1, closed: false };
  // slot 13：9 月第 1 个星期一（劳动节）
  const labor: HolidayDef = { slot: 13, month: 9, day: 1, kind: 2, flagsRaw: 1 << 16, weekday: 1, closed: false };
  // slot 17：11 月第 4 个星期四（感恩节），休市
  const thanks: HolidayDef = {
    slot: 17,
    month: 11,
    day: 4,
    kind: 2,
    flagsRaw: (4 << 16) | 1,
    weekday: 4,
    closed: true,
  };
  const usa = [mlk, mother, memorial, labor, thanks];

  it('1998 年 1 月第 3 个星期一 → 1/18（星期日；1998-01-01 是星期四 > 星期一）', () => {
    expect(weekdayOf(19980101)).toBe(4);
    expect(holidayOn(19980118, usa)).toBe(mlk);
    expect(weekdayOf(19980118)).toBe(0);
    expect(holidayOn(19980119, usa)).toBeNull(); // 数学上的第 3 个星期一
    // 当月 1 日是星期一或更早时与数学定义一致：2001-01-01 是星期一 → 1/15
    expect(holidayOn(20010115, usa)).toBe(mlk);
    expect(weekdayOf(20010115)).toBe(1);
  });

  it('1998 年 9 月第 1 个星期一 → 9/6（星期日）', () => {
    expect(weekdayOf(19980901)).toBe(2);
    expect(holidayOn(19980906, usa)).toBe(labor);
    expect(weekdayOf(19980906)).toBe(0);
    expect(holidayOn(19980907, usa)).toBeNull();
    expect(holidayOn(20030901, usa)).toBe(labor); // 2003-09-01 是星期一
  });

  it('11 月第 4 个星期四：1998 → 11/26（星期四）；2002 → 11/24（星期日，休市）', () => {
    expect(weekdayOf(19981101)).toBe(0);
    expect(holidayOn(19981126, usa)).toBe(thanks);
    expect(weekdayOf(19981126)).toBe(4);
    expect(weekdayOf(20021101)).toBe(5);
    expect(holidayOn(20021124, usa)).toBe(thanks);
    expect(weekdayOf(20021124)).toBe(0);
    expect(holidayOn(20021128, usa)).toBeNull(); // 数学上的第 4 个星期四照常开市
    expect(isMarketClosedDay(20021128, 4, usa)).toBe(false);
  });

  it('5 月第 5 个星期一：2001 年不命中（算出 5/34）；1998 年落在 5/31 星期日', () => {
    expect(weekdayOf(20010501)).toBe(2);
    expect(nthWeekdayDay(2, 1, 5)).toBe(34);
    for (let d = 20010501; d <= 20010531; d++) expect(holidayOn(d, [memorial]), String(d)).toBeNull();
    expect(holidayOn(19980531, [memorial])).toBe(memorial);
    expect(weekdayOf(19980531)).toBe(0);
  });

  it('5 月第 2 个星期日（w = 0）总是正确：1998-05-10、1999-05-09、2001-05-13', () => {
    for (const d of [19980510, 19990509, 20010513]) {
      expect(holidayOn(d, usa), String(d)).toBe(mother);
      expect(weekdayOf(d)).toBe(0);
    }
    expect(holidayOn(19980503, usa)).toBeNull();
  });
});
