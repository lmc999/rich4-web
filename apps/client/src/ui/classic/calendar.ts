// 右下日历 / 月历（Panel#2：图0–3 春夏秋冬风景、图4–7 月历版、图8/9 太阳钮、图10/11 月亮钮）：纯函数。
import type { DateNum } from '@rich4/shared/engine';

export type CalendarMode = 'day' | 'month' | 'map';

export interface YMD {
  y: number;
  m: number;
  d: number;
}

export function ymd(date: DateNum): YMD {
  return { y: Math.trunc(date / 10000), m: Math.trunc(date / 100) % 100, d: date % 100 };
}

/** 季节：0 春（3–5 月）、1 夏（6–8）、2 秋（9–11）、3 冬（12–2） */
export function seasonOf(month: number): 0 | 1 | 2 | 3 {
  if (month >= 3 && month <= 5) return 0;
  if (month >= 6 && month <= 8) return 1;
  if (month >= 9 && month <= 11) return 2;
  return 3;
}

/** 日历模式的底图帧（春夏秋冬风景） */
export function dayFrame(month: number): number {
  return seasonOf(month);
}

/** 月历模式的底图帧（带 S M T W T F S 的淡化风景） */
export function monthFrame(month: number): number {
  return 4 + seasonOf(month);
}

/** 公历某月天数 */
export function daysInMonth(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

export interface MonthGrid {
  y: number;
  m: number;
  today: number;
  /** 本月 1 日是星期几（0 = 星期日） */
  firstWeekday: number;
  days: number;
  /** 行 × 7 列；空格为 0 */
  weeks: number[][];
}

/** 由今天的日期与星期推出整月网格（与引擎的星期口径一致：0 = 星期日） */
export function monthGrid(date: DateNum, weekday: number): MonthGrid {
  const { y, m, d } = ymd(date);
  const days = daysInMonth(y, m);
  const firstWeekday = (((weekday - (d - 1)) % 7) + 7) % 7;
  const weeks: number[][] = [];
  let row: number[] = new Array<number>(firstWeekday).fill(0);
  for (let day = 1; day <= days; day++) {
    row.push(day);
    if (row.length === 7) {
      weeks.push(row);
      row = [];
    }
  }
  if (row.length > 0) weeks.push([...row, ...new Array<number>(7 - row.length).fill(0)]);
  return { y, m, today: d, firstWeekday, days, weeks };
}
