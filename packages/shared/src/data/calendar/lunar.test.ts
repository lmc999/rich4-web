import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LUNAR_FIRST_SOLAR, lunarLeapMonth, lunarOf, lunarYearInfo, packLunar } from './lunar';

/** 公历日期的逐日推进（格里历），测试用 */
function nextSolar(date: number): number {
  const y = Math.trunc(date / 10000);
  const m = Math.trunc(date / 100) % 100;
  const d = date % 100;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
  if (d < dim) return date + 1;
  if (m < 12) return y * 10000 + (m + 1) * 100 + 1;
  return (y + 1) * 10000 + 101;
}

/** 春节（农历正月初一）的公历日期 */
const SPRING_FESTIVAL: readonly number[] = [
  19980128, 19990216, 20000205, 20010124, 20020212, 20030201, 20040122, 20050209, 20060129, 20070218, 20080207,
  20090126, 20100214, 20110203, 20120123, 20130210, 20140131, 20150219, 20160208, 20170128, 20180216, 20190205,
  20200125, 20210212, 20220201, 20230122, 20240210, 20250129, 20260217, 20270206, 20280126, 20290213, 20300203,
];

describe('农历换算（data/calendar/lunar）', () => {
  it('1998..2030 的春节', () => {
    for (const date of SPRING_FESTIVAL) {
      expect(lunarOf(date), String(date)).toMatchObject({ month: 1, day: 1, leap: false });
      const y = Math.trunc(date / 10000);
      expect(lunarOf(date)!.year).toBe(y);
    }
  });

  it('与 exe 农历表的摘要一致：首尾日期、闰月个数、十二月最大日', () => {
    expect(lunarOf(LUNAR_FIRST_SOLAR)).toEqual({ year: 1997, month: 12, day: 3, leap: false });
    expect(lunarOf(20201231)).toEqual({ year: 2020, month: 11, day: 17, leap: false });
    let leaps = 0;
    let maxDay12 = 0;
    for (let d = LUNAR_FIRST_SOLAR; d <= 20201231; d = nextSolar(d)) {
      const l = lunarOf(d)!;
      if (l.leap && l.day === 1) leaps++;
      if (l.month === 12) maxDay12 = Math.max(maxDay12, l.day);
    }
    expect(leaps).toBe(9);
    expect(maxDay12).toBe(30);
  });

  it('1998..2020 的闰月：1998 闰五月、2001 闰四月 … 2020 闰四月', () => {
    const want: Record<number, number> = {
      1998: 5,
      2001: 4,
      2004: 2,
      2006: 7,
      2009: 5,
      2012: 4,
      2014: 9,
      2017: 6,
      2020: 4,
    };
    for (let y = 1998; y <= 2020; y++) expect(lunarLeapMonth(lunarYearInfo(y)!), String(y)).toBe(want[y] ?? 0);
  });

  it('逐日连续（到 2100-12-31）：日 +1，或换月 / 换年时从初一开始', () => {
    let prev = lunarOf(LUNAR_FIRST_SOLAR)!;
    for (let d = nextSolar(LUNAR_FIRST_SOLAR); d <= 21001231; d = nextSolar(d)) {
      const cur = lunarOf(d);
      expect(cur, String(d)).not.toBeNull();
      const c = cur!;
      const sameMonth = c.year === prev.year && c.month === prev.month && c.leap === prev.leap;
      if (sameMonth) expect(c.day, String(d)).toBe(prev.day + 1);
      else {
        expect(c.day, String(d)).toBe(1);
        expect(prev.day === 29 || prev.day === 30, String(d)).toBe(true);
      }
      prev = c;
    }
    expect(lunarOf(19971231)).toBeNull();
    expect(lunarOf(21010101)).toBeNull();
  });

  // 数据代理把 exe 逐日农历表导出到 .cache/extract/tables.v206.json 后，逐日对照（没有逐日数据时只对照摘要）
  const cache = resolve(__dirname, '../../../../../.cache/extract/tables.v206.json');
  it.skipIf(!existsSync(cache))('与 .cache/extract 的 exe 农历表逐日一致（有逐日数据时）', () => {
    const t = JSON.parse(readFileSync(cache, 'utf8')) as { lunar?: Record<string, unknown> };
    const lunar = t.lunar ?? {};
    expect(lunar.firstLunar).toBe('1997-12-03');
    expect(lunar.lastLunar).toBe('2020-11-17');
    // 逐月摘要（{solarStart:'YYYY-MM-DD', year, month, leap, days}）：月首、闰月标记与月长一致
    if (Array.isArray(lunar.months)) {
      for (const m of lunar.months as { solarStart: string; year: number; month: number; leap: boolean }[]) {
        const date = Number(m.solarStart.replace(/-/g, ''));
        const l = lunarOf(date)!;
        expect([l.year, l.month, l.leap], m.solarStart).toEqual([m.year, m.month, m.leap]);
      }
    }
    const rows = (
      Array.isArray(lunar.packed) ? lunar.packed : Object.values(lunar).find((v) => Array.isArray(v) && v.length >= 366)
    ) as unknown[] | undefined;
    if (!rows) return;
    let d = LUNAR_FIRST_SOLAR;
    let compared = 0;
    for (let i = 0; i < rows.length; i++, d = nextSolar(d)) {
      const packed = unpackRow(rows[i]);
      if (packed === null) continue;
      expect(packLunar(lunarOf(d)!), String(d)).toBe(packed);
      compared++;
    }
    expect(compared).toBe(rows.length);
  });
});

/** 逐日数据的几种可能写法：u32、'0x…'、'YYYY-MM-DD'、{y,m,d} / {year,month,day} */
function unpackRow(v: unknown): number | null {
  const pack = (y: number, m: number, d: number) => ((y << 16) | (m << 8) | d) >>> 0;
  if (typeof v === 'number') return v >>> 0;
  if (typeof v === 'string') {
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (iso) return pack(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    const n = Number.parseInt(v.replace(/^0x/, ''), 16);
    return Number.isNaN(n) ? null : n >>> 0;
  }
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const y = o.y ?? o.year;
    const m = o.m ?? o.month;
    const d = o.d ?? o.day;
    if (typeof y === 'number' && typeof m === 'number' && typeof d === 'number') return pack(y, m, d);
  }
  return null;
}

describe('农历换算：辅助', () => {
  it('packLunar 与 exe 的打包一致', () => {
    expect(packLunar({ year: 1997, month: 12, day: 3, leap: false })).toBe(0x07cd0c03);
  });
});
