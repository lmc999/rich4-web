/**
 * int32 / u16 整数语义（architecture §4 数值、DEV-01）。
 * - saturate（默认）：金额夹在 [INT32_MIN, INT32_MAX]，点券夹在 [0, 65535]。
 * - wrap：按原版 C 语义回绕（int32 取模 2^32，u16 取低 16 位）。
 * 入参约定为整数；非整数输入的行为未定义（toInt32 例外，会先截断）。
 */
export type OverflowMode = 'saturate' | 'wrap';

export const INT32_MAX = 2147483647;
export const INT32_MIN = -2147483648;
export const U16_MAX = 65535;

export function isInt32(x: number): boolean {
  return Number.isInteger(x) && x >= INT32_MIN && x <= INT32_MAX;
}

/** 夹到 int32 范围；`| 0` 同时把 -0 规范成 0 */
export function clampInt32(x: number): number {
  if (x > INT32_MAX) return INT32_MAX;
  if (x < INT32_MIN) return INT32_MIN;
  return x | 0;
}

export function toInt32(x: number, mode: OverflowMode = 'saturate'): number {
  const t = Math.trunc(x);
  return mode === 'wrap' ? t | 0 : clampInt32(t);
}

export function add32(a: number, b: number, mode: OverflowMode = 'saturate'): number {
  return mode === 'wrap' ? (a + b) | 0 : clampInt32(a + b);
}

export function sub32(a: number, b: number, mode: OverflowMode = 'saturate'): number {
  return mode === 'wrap' ? (a - b) | 0 : clampInt32(a - b);
}

/** wrap 用 Math.imul；saturate 时双精度乘积超出 2^53 也必然越界，夹紧结果仍正确 */
export function mul32(a: number, b: number, mode: OverflowMode = 'saturate'): number {
  return mode === 'wrap' ? Math.imul(a, b) : clampInt32(a * b);
}

/** C 语言截断除法。int32 操作数下 Math.trunc(a / b) 结果精确；除数为 0 抛 RangeError */
export function divTrunc(a: number, b: number, mode: OverflowMode = 'saturate'): number {
  if (b === 0) throw new RangeError('divTrunc: division by zero');
  const q = Math.trunc(a / b);
  return mode === 'wrap' ? q | 0 : clampInt32(q);
}

export function toU16(x: number, mode: OverflowMode = 'saturate'): number {
  if (mode === 'wrap') return x & 0xffff;
  if (x < 0) return 0;
  if (x > U16_MAX) return U16_MAX;
  return x | 0;
}

export function addU16(a: number, b: number, mode: OverflowMode = 'saturate'): number {
  return toU16(a + b, mode);
}

export function subU16(a: number, b: number, mode: OverflowMode = 'saturate'): number {
  return toU16(a - b, mode);
}
