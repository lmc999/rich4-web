import { hexVa, type PeFile } from '../../pe/scan';
import type { Check, LunarSummary } from '../types';
import { chk, hintOf, type TableSpec, u32SeqSignature } from './common';

/**
 * 农历表（v3.11 VA 0x47639c）：从公历 1998-01-01 起每天一个 u32 = 农历 (年 << 16 | 月 << 8 | 日)，闰月沿用月号。
 * 节日表 kind 1 的项在查找时用它把「当日」换成农历再比较（0x4521f0 → 0x451f8c 算 1998 起的天数）。
 * 签名：1998-01-01 = 农历 1997 年十二月初三（公历事实），即 u32 序列 0x07cd0c03, 0x07cd0c04, 0x07cd0c05。
 */

const FIRST = [0x07cd0c03, 0x07cd0c04, 0x07cd0c05] as const;
const MAX_DAYS = 40000;

function unpack(v: number): { y: number; m: number; d: number } {
  return { y: v >>> 16, m: (v >>> 8) & 0xff, d: v & 0xff };
}

/** 从 va 起连续「逐日推进」的项数 */
export function countLunarDays(file: PeFile, va: number): number {
  let n = 0;
  let prev: { y: number; m: number; d: number } | null = null;
  while (n < MAX_DAYS) {
    const off = file.tryVaToOff(va + n * 4);
    if (off === null || off + 4 > file.bytes.length) break;
    const cur = unpack(file.reader.u32(off));
    if (cur.m < 1 || cur.m > 12 || cur.d < 1 || cur.d > 30 || cur.y < 1900 || cur.y > 2200) break;
    if (prev) {
      const nextDay = cur.y === prev.y && cur.m === prev.m && cur.d === prev.d + 1;
      const newMonth = cur.d === 1 && prev.d >= 29 && (cur.m === prev.m || cur.m === prev.m + 1) && cur.y === prev.y;
      const newYear = cur.d === 1 && cur.m === 1 && prev.m === 12 && prev.d >= 29 && cur.y === prev.y + 1;
      if (!nextDay && !newMonth && !newYear) break;
    }
    prev = cur;
    n++;
  }
  return n;
}

/** 1998-01-01 起第 n 天的公历日期（只做整数日历推算；公历闰年按格里历） */
export function solarOf(n: number): string {
  let y = 1998;
  let rest = n;
  const leap = (yy: number) => (yy % 4 === 0 && yy % 100 !== 0) || yy % 400 === 0;
  while (rest >= (leap(y) ? 366 : 365)) {
    rest -= leap(y) ? 366 : 365;
    y++;
  }
  const mdays = [31, leap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let mo = 0;
  while (rest >= mdays[mo]!) {
    rest -= mdays[mo]!;
    mo++;
  }
  return `${y}-${String(mo + 1).padStart(2, '0')}-${String(rest + 1).padStart(2, '0')}`;
}

export function summarizeLunar(file: PeFile, va: number): LunarSummary {
  const days = countLunarDays(file, va);
  const fmt = (v: number) => {
    const { y, m, d } = unpack(v);
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  const packed = Array.from({ length: days }, (_, i) => file.u32(va + i * 4));
  let maxDay12 = 0;
  let leapMonths = 0;
  let prevM = 0;
  const months: LunarSummary['months'] = [];
  for (let i = 0; i < days; i++) {
    const { y, m, d } = unpack(packed[i]!);
    if (m === 12) maxDay12 = Math.max(maxDay12, d);
    const leap = d === 1 && m === prevM;
    if (leap) leapMonths++;
    if (d === 1 || i === 0) months.push({ solarStart: solarOf(i), year: y, month: m, leap, days: 0 });
    months[months.length - 1]!.days++;
    prevM = m;
  }
  return {
    days,
    firstSolar: '1998-01-01',
    lastSolar: solarOf(days - 1),
    firstLunar: fmt(packed[0]!),
    lastLunar: fmt(packed[days - 1]!),
    maxDayMonth12: maxDay12,
    leapMonths,
    packed,
    months,
  };
}

export function validateLunar(file: PeFile, va: number): Check[] {
  const days = countLunarDays(file, va);
  const first = file.tryVaToOff(va) === null ? null : file.u32(va);
  return [
    chk(
      'lunar.first',
      'error',
      first === FIRST[0],
      `首项 ${first === null ? '未映射' : hexVa(first)}（期望 1997-12-03）`,
    ),
    chk('lunar.days', 'error', days >= 366, `连续逐日推进 ${days} 天`),
  ];
}

export const lunarSpec: TableSpec<LunarSummary> = {
  id: 'lunar',
  xrefSpan: 4,
  hint: (ctx) => hintOf(ctx, ctx.anchors.tables.lunar.hint),
  signature: (ctx) => u32SeqSignature(ctx.file, FIRST),
  validate: (file, va) => validateLunar(file, va),
  parse: (file, va) => summarizeLunar(file, va),
  byteLength: (ctx) => countLunarDays(ctx.file, ctx.located.lunar ?? 0) * 4,
};
