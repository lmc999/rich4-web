// 显示格式与 Sparkline 路径（client-unit，纯函数）
import { describe, expect, it } from 'vitest';
import {
  clampInt,
  dateParts,
  formatCents,
  formatDateShort,
  formatInt,
  formatPct10,
  formatShort,
  formatSigned,
  nextMonthFirst,
  stockAmount,
} from './format';
import { sparkPath } from './Sparkline';

describe('format', () => {
  it('整数千分位与正负号', () => {
    expect(formatInt(48800)).toBe('48,800');
    expect(formatInt(-1200)).toBe('-1,200');
    expect(formatSigned(1200)).toBe('+1,200');
    expect(formatSigned(-300)).toBe('−300');
    expect(formatSigned(0)).toBe('0');
  });

  it('简写：万、亿，一位小数向零截断', () => {
    expect(formatShort(9999)).toBe('9,999');
    expect(formatShort(48800)).toBe('4.8万');
    expect(formatShort(10000)).toBe('1万');
    expect(formatShort(-123456789)).toBe('−1.2亿');
  });

  it('股价（分）与涨跌幅（千分比）', () => {
    expect(formatCents(1235)).toBe('12.35');
    expect(formatCents(5)).toBe('0.05');
    expect(formatCents(-100)).toBe('−1.00');
    expect(formatPct10(95)).toBe('+9.5%');
    expect(formatPct10(-30)).toBe('−3.0%');
    expect(formatPct10(0)).toBe('0.0%');
  });

  it('股票金额与引擎同算法：trunc(价 × 股数 / 100)', () => {
    expect(stockAmount(1235, 100)).toBe(1235);
    expect(stockAmount(1999, 3)).toBe(59);
    expect(stockAmount(0, 1000)).toBe(0);
  });

  it('日期', () => {
    expect(dateParts(19980312)).toEqual({ y: 1998, m: 3, d: 12 });
    expect(formatDateShort(19980312)).toBe('1998/3/12');
    expect(formatDateShort(0)).toBe('—');
    expect(nextMonthFirst(19981231)).toBe(19990101);
    expect(nextMonthFirst(19980312)).toBe(19980401);
  });

  it('clampInt', () => {
    expect(clampInt(5.9, 0, 10)).toBe(5);
    expect(clampInt(-3, 0, 10)).toBe(0);
    expect(clampInt(99, 0, 10)).toBe(10);
    expect(clampInt(Number.NaN, 1, 10)).toBe(1);
    expect(clampInt(3, 5, 2)).toBe(5);
  });
});

describe('sparkPath', () => {
  it('首点在左、末点在右，最高点在顶部', () => {
    const d = sparkPath([1, 3, 2], 100, 20, 2);
    expect(d.startsWith('M2.0,18.0')).toBe(true);
    expect(d).toContain('L50.0,2.0');
    expect(d.endsWith('L98.0,10.0')).toBe(true);
  });

  it('空序列为空路径；全平画中线', () => {
    expect(sparkPath([], 10, 10)).toBe('');
    expect(sparkPath([5, 5], 10, 10)).toBe('M2.0,5.0L8.0,5.0');
  });
});
