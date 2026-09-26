/**
 * 日历（design/engine.md §3「日期」；docs/research/r_rules_map.md §6）。
 * - DateNum = y*10000 + m*100 + d。闰年只判能否被 4 整除（原版如此，2100 年也按闰年）。
 * - 星期以 1998-01-01 为星期四推算（0 = 星期日）。
 * - 地契到期日按月加、不夹日：1/31 + 1 个月 = 2/31，这一天永远不会等于真实日期，所以永不到期。
 * - 休市：星期日，或 MapDef.holidays 中标记 closed 的公历节日（农历节日 ⚑ 待 calendar/lunar，暂不判定）。
 * - 节日 kind（VERIFY V-E5）：0 公历 month/day；1 农历（暂不判定）；2 第 n 个星期 w：day = n，
 *   w 暂存在 flagsRaw 16..23 位（architecture §17.4，待 HolidayDef 增加 weekday 字段）。
 */
import type { HolidayDef } from '../../data/maps/types';
import { TENURE_MONTHS } from '../../data/tables/setup';
import type { DateNum, Tenure } from '../types/ids';

export const EPOCH_DATE: DateNum = 19980101;
/** 1998-01-01 是星期四 */
export const EPOCH_WEEKDAY = 4;

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export function packDate(y: number, m: number, d: number): DateNum {
  return y * 10000 + m * 100 + d;
}

export function unpackDate(date: DateNum): { y: number; m: number; d: number } {
  const y = Math.trunc(date / 10000);
  const m = Math.trunc(date / 100) % 100;
  return { y, m, d: date % 100 };
}

export function isLeapYear(y: number): boolean {
  return y % 4 === 0;
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function daysInMonth(y: number, m: number): number {
  return m === 2 && isLeapYear(y) ? 29 : MONTH_DAYS[m - 1]!;
}

export function isValidDate(date: DateNum): boolean {
  if (!Number.isInteger(date) || date <= 0) return false;
  const { y, m, d } = unpackDate(date);
  return y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/** 当年 1 月 1 日之前的天数（相对 1998-01-01） */
function daysBeforeYear(y: number): number {
  // [1998, y) 之间的闰年个数 = floor((y-1)/4) - floor(1997/4)
  return (y - 1998) * 365 + (Math.floor((y - 1) / 4) - 499);
}

/** 相对 1998-01-01 的天数（1998-01-01 为 0；只对合法日期有意义） */
export function dayNumber(date: DateNum): number {
  const { y, m, d } = unpackDate(date);
  let n = daysBeforeYear(y);
  for (let k = 1; k < m; k++) n += daysInMonth(y, k);
  return n + d - 1;
}

export function fromDayNumber(n: number): DateNum {
  let y = 1998 + Math.floor(n / 366);
  while (daysBeforeYear(y + 1) <= n) y++;
  while (daysBeforeYear(y) > n) y--;
  let rest = n - daysBeforeYear(y);
  let m = 1;
  while (rest >= daysInMonth(y, m)) {
    rest -= daysInMonth(y, m);
    m++;
  }
  return packDate(y, m, rest + 1);
}

export function weekdayOf(date: DateNum): Weekday {
  return ((((EPOCH_WEEKDAY + dayNumber(date)) % 7) + 7) % 7) as Weekday;
}

export function nextDate(date: DateNum): DateNum {
  const { y, m, d } = unpackDate(date);
  if (d < daysInMonth(y, m)) return packDate(y, m, d + 1);
  if (m < 12) return packDate(y, m + 1, 1);
  return packDate(y + 1, 1, 1);
}

export function addDays(date: DateNum, n: number): DateNum {
  return fromDayNumber(dayNumber(date) + n);
}

/** b − a（天） */
export function daysBetween(a: DateNum, b: DateNum): number {
  return dayNumber(b) - dayNumber(a);
}

/** 地契到期日：按日历月加，不夹日；unlimited 返回 0（无限期） */
export function addTenure(date: DateNum, tenure: Tenure): DateNum {
  const months = TENURE_MONTHS[tenure];
  if (months === 0) return 0;
  const { y, m, d } = unpackDate(date);
  const total = y * 12 + (m - 1) + months;
  return packDate(Math.trunc(total / 12), (total % 12) + 1, d);
}

/** kind 2 节日的星期（0 = 星期日） */
export function holidayWeekday(h: HolidayDef): number {
  return (h.flagsRaw >> 16) & 0xff;
}

/** 当天的公历节日（农历节日 lunar=true / kind 1 暂不判定 ⚑）；按表序取第一个命中项 */
export function holidayOn(date: DateNum, holidays: readonly HolidayDef[]): HolidayDef | null {
  const { m, d } = unpackDate(date);
  let wd = -1;
  for (const h of holidays) {
    if (h.lunar === true || h.kind === 1 || h.month !== m) continue;
    if (h.kind === 2) {
      // 第 n 个星期 w：当月第 trunc((d-1)/7)+1 个同星期日
      if (Math.trunc((d - 1) / 7) + 1 !== h.day) continue;
      if (wd < 0) wd = weekdayOf(date);
      if (wd === holidayWeekday(h)) return h;
      continue;
    }
    if (h.day === d) return h;
  }
  return null;
}

/** clock.holiday 的 key（i18n 由客户端按地图拼接） */
export function holidayKey(h: HolidayDef): string {
  return `h${h.slot}`;
}

/** 休市：星期日或休市节日（全面停市 marketClosedDays 由调用方另判） */
export function isMarketClosedDay(date: DateNum, weekday: number, holidays: readonly HolidayDef[]): boolean {
  if (weekday === 0) return true;
  const h = holidayOn(date, holidays);
  return h !== null && h.closed === true;
}

/** 首次借款的到期日：date + days，落在休市日就顺延到下一个开市日 */
export function loanDueDate(date: DateNum, days: number, holidays: readonly HolidayDef[]): DateNum {
  let due = addDays(date, days);
  for (let guard = 0; guard < 366 && isMarketClosedDay(due, weekdayOf(due), holidays); guard++) due = nextDate(due);
  return due;
}
