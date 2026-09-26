// 数值与日期的显示格式（纯函数，可单测）。金额按原版：整数元、千分位；股价以「分」存整数，显示两位小数。
import type { DateNum } from '@rich4/shared/engine';

const INT_FMT = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });

/** 48800 → "48,800" */
export function formatInt(n: number): string {
  return INT_FMT.format(n);
}

/** 带符号：+1,200 / −300（用真正的减号） */
export function formatSigned(n: number): string {
  if (n > 0) return `+${formatInt(n)}`;
  if (n < 0) return `−${formatInt(-n)}`;
  return '0';
}

/** 简写（手机与飘字）：12345 → "1.2万"，123456789 → "1.2亿"；一位小数向零截断 */
export function formatShort(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (abs >= 1e8) return `${sign}${trim1(abs / 1e8)}亿`;
  if (abs >= 1e4) return `${sign}${trim1(abs / 1e4)}万`;
  return `${sign}${formatInt(abs)}`;
}

function trim1(x: number): string {
  const v = Math.trunc(x * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** 股价（分）→ "12.35" */
export function formatCents(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const s = `${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return neg ? `−${s}` : s;
}

/** 涨跌幅（千分比，×10 的百分比）→ "+9.5%" / "−3.0%" / "0.0%" */
export function formatPct10(p10: number): string {
  const abs = Math.abs(Math.trunc(p10));
  const s = `${Math.trunc(abs / 10)}.${abs % 10}%`;
  if (p10 > 0) return `+${s}`;
  if (p10 < 0) return `−${s}`;
  return s;
}

/** 股票金额（元）= trunc(价(分) × 股数 / 100)，与引擎买卖、总资产的算法相同 */
export function stockAmount(priceCents: number, shares: number): number {
  return Math.trunc((priceCents * shares) / 100);
}

export interface DateParts {
  y: number;
  m: number;
  d: number;
}

export function dateParts(date: DateNum): DateParts {
  return { y: Math.trunc(date / 10000), m: Math.trunc(date / 100) % 100, d: date % 100 };
}

/** DateNum → "1998/3/12"（紧凑格式，表格用）；0 返回 "—" */
export function formatDateShort(date: DateNum): string {
  if (!date) return '—';
  const p = dateParts(date);
  return `${p.y}/${p.m}/${p.d}`;
}

/** 下个月 1 日（月结与计息日） */
export function nextMonthFirst(date: DateNum): DateNum {
  const p = dateParts(date);
  return p.m === 12 ? (p.y + 1) * 10000 + 101 : p.y * 10000 + (p.m + 1) * 100 + 1;
}

/** 限制在 [min, max] 的整数 */
export function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  const x = Math.trunc(v);
  if (max < min) return min;
  return x < min ? min : x > max ? max : x;
}

/**
 * 两段式计数器（坐牢、住院、住旅馆、出国、冬眠、梦游、停留、乌龟、保险、拒绝往来）的剩余天数：
 * 低 7 位为天数，0x80 为「待释放」；0 表示没有。与引擎 rules/counters.displayRemaining 相同，显示 (c & 0x7f) + 1（含本回合）。
 */
export function counterDays(raw: number): number {
  return raw === 0 ? 0 : (raw & 0x7f) + 1;
}
