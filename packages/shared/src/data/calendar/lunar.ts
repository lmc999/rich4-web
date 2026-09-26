/**
 * 公历 → 农历换算（1998-01-01 .. 2100-12-31），供节日表 kind 1（农历节日）判定用。
 *
 * 原版 exe 自带一张逐日农历表（v3.11 VA 0x47639c，每天一个 u32 = 年<<16 | 月<<8 | 日，闰月沿用月号），
 * 只覆盖 1998-01-01 .. 2020-12-31（8401 天），之后查表越界。这里改用通行的农历年信息表
 * （每年一个 17 位编码，覆盖到 2100 年），与 exe 表在重叠区间逐日一致（lunar.test.ts 对照 .cache/extract）。
 *
 * 年信息编码（每个农历年一项）：
 *   bit 0..3    闰月月号（0 = 无闰月）
 *   bit 4..15   1..12 月的大小：月 m 对应 0x10000 >> m，置位为大月 30 天，否则小月 29 天
 *   bit 16      闰月大小：置位 30 天，否则 29 天
 * 基准：农历 1997 年正月初一 = 公历 1997-02-07。
 *
 * 公历天数按真实的格里历计算（与引擎「闰年只判被 4 整除」的日历只在 2100-02-29 之后差一天，
 * 游戏里的 2100-02-29 按 2100-03-01 换算）。
 *
 * @source 通行农历年信息表（寿星万年历 / 香港天文台农历与公历对照表整理的公开数据）
 * @source docs/research/r_stocks_time.md §1.3（节日休市）；docs/architecture.md §17.4（exe 农历表只到 2020）
 * @verify extract:lunar（1998-01-01 = 农历 1997-12-03，2020-12-31 = 农历 2020-11-17，闰月 9 个）
 */

/** 第一项是农历 1997 年 */
const FIRST_LUNAR_YEAR = 1997;

/** 农历 1997..2100 年的年信息 */
// biome-ignore format: 年信息表按十年一行排列
const LUNAR_INFO: readonly number[] = Object.freeze([
  0x0ab60, 0x096d5, 0x092e0, // 1997-1999
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, // 2000-2009
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930, // 2010-2019
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530, // 2020-2029
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45, // 2030-2039
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0, // 2040-2049
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0, // 2050-2059
  0x092e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4, // 2060-2069
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0, // 2070-2079
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160, // 2080-2089
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252, // 2090-2099
  0x0d520, // 2100
]);

/** 可换算的公历范围（DateNum） */
export const LUNAR_FIRST_SOLAR = 19980101;
export const LUNAR_LAST_SOLAR = 21001231;

export interface LunarDate {
  year: number;
  month: number;
  day: number;
  /** 闰月（原版 exe 表不区分，闰月沿用月号） */
  leap: boolean;
}

function isGregorianLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

const CUM_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

/** 相对 1997-01-01 的格里历天数 */
function civilDays(y: number, m: number, d: number): number {
  let n = 0;
  for (let yy = 1997; yy < y; yy++) n += isGregorianLeap(yy) ? 366 : 365;
  n += CUM_DAYS[m - 1]! + (m > 2 && isGregorianLeap(y) ? 1 : 0);
  return n + d - 1;
}

/** 农历 1997 年正月初一（公历 1997-02-07）相对 1997-01-01 的天数 */
const BASE_OFFSET = 37;

export function lunarLeapMonth(info: number): number {
  return info & 0xf;
}

export function lunarLeapDays(info: number): number {
  if (lunarLeapMonth(info) === 0) return 0;
  return (info & 0x10000) !== 0 ? 30 : 29;
}

export function lunarMonthDays(info: number, month: number): number {
  return (info & (0x10000 >> month)) !== 0 ? 30 : 29;
}

export function lunarYearDays(info: number): number {
  let n = 0;
  for (let m = 1; m <= 12; m++) n += lunarMonthDays(info, m);
  return n + lunarLeapDays(info);
}

/** 农历年 y 的年信息；超出表的范围返回 null */
export function lunarYearInfo(year: number): number | null {
  const i = year - FIRST_LUNAR_YEAR;
  return i >= 0 && i < LUNAR_INFO.length ? LUNAR_INFO[i]! : null;
}

/** 各农历年正月初一相对基准的天数（首次调用时计算） */
let yearStarts: number[] | null = null;

function starts(): number[] {
  if (yearStarts === null) {
    const out: number[] = [];
    let acc = 0;
    for (const info of LUNAR_INFO) {
      out.push(acc);
      acc += lunarYearDays(info);
    }
    out.push(acc);
    yearStarts = out;
  }
  return yearStarts;
}

/** 公历 DateNum（y*10000+m*100+d）→ 农历；超出 1998..2100 或日期非法返回 null */
export function lunarOf(date: number): LunarDate | null {
  if (!Number.isInteger(date) || date < LUNAR_FIRST_SOLAR || date > LUNAR_LAST_SOLAR) return null;
  const y = Math.trunc(date / 10000);
  const m = Math.trunc(date / 100) % 100;
  const d = date % 100;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  let off = civilDays(y, m, d) - BASE_OFFSET;
  const st = starts();
  let yi = 0;
  while (yi + 1 < st.length - 1 && st[yi + 1]! <= off) yi++;
  off -= st[yi]!;
  const info = LUNAR_INFO[yi]!;
  const leapMonth = lunarLeapMonth(info);
  for (let month = 1; month <= 12; month++) {
    const len = lunarMonthDays(info, month);
    if (off < len) return { year: FIRST_LUNAR_YEAR + yi, month, day: off + 1, leap: false };
    off -= len;
    if (month === leapMonth) {
      const ll = lunarLeapDays(info);
      if (off < ll) return { year: FIRST_LUNAR_YEAR + yi, month, day: off + 1, leap: true };
      off -= ll;
    }
  }
  return null;
}

/** 与原版 exe 农历表相同的打包：年 << 16 | 月 << 8 | 日（闰月沿用月号） */
export function packLunar(l: LunarDate): number {
  return ((l.year << 16) | (l.month << 8) | l.day) >>> 0;
}
