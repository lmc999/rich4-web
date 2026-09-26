import { describe, expect, it } from 'vitest';
import {
  add32,
  addU16,
  clampInt32,
  divTrunc,
  INT32_MAX,
  INT32_MIN,
  isInt32,
  mul32,
  sub32,
  subU16,
  toInt32,
  toU16,
} from './int32';

describe('int32 saturate（默认）', () => {
  it('加减在边界夹紧', () => {
    expect(add32(INT32_MAX, 1)).toBe(INT32_MAX);
    expect(add32(INT32_MIN, -1)).toBe(INT32_MIN);
    expect(sub32(INT32_MIN, 1)).toBe(INT32_MIN);
    expect(sub32(INT32_MAX, -5)).toBe(INT32_MAX);
    expect(add32(1_500_000_000, 1_000_000_000)).toBe(INT32_MAX);
    expect(add32(1_500_000_000, 1_000_000_000, 'wrap')).toBe(2_500_000_000 - 0x100000000);
    expect(add32(123, -456)).toBe(-333);
  });
  it('乘法夹紧且不产生 -0', () => {
    expect(mul32(65536, 65536)).toBe(INT32_MAX);
    expect(mul32(-65536, 65536)).toBe(INT32_MIN);
    expect(mul32(INT32_MAX, INT32_MAX)).toBe(INT32_MAX);
    expect(mul32(1234, -5678)).toBe(-7006652);
    expect(Object.is(mul32(-5, 0), 0)).toBe(true);
  });
  it('截断除法', () => {
    expect(divTrunc(7, 2)).toBe(3);
    expect(divTrunc(-7, 2)).toBe(-3);
    expect(divTrunc(7, -2)).toBe(-3);
    expect(Object.is(divTrunc(-1, 5), 0)).toBe(true);
    expect(divTrunc(INT32_MIN, -1)).toBe(INT32_MAX);
    expect(divTrunc(INT32_MAX, 1)).toBe(INT32_MAX);
    expect(() => divTrunc(1, 0)).toThrow(RangeError);
  });
  it('点券 u16 夹在 0..65535', () => {
    expect(toU16(70000)).toBe(65535);
    expect(toU16(-3)).toBe(0);
    expect(addU16(65000, 1000)).toBe(65535);
    expect(subU16(10, 30)).toBe(0);
    expect(toU16(1234)).toBe(1234);
  });
});

describe('int32 wrap（原版行为）', () => {
  it('加减乘按 2^32 回绕', () => {
    expect(add32(INT32_MAX, 1, 'wrap')).toBe(INT32_MIN);
    expect(sub32(INT32_MIN, 1, 'wrap')).toBe(INT32_MAX);
    expect(mul32(65536, 65536, 'wrap')).toBe(0);
    expect(mul32(0x7fffffff, 3, 'wrap')).toBe(0x7ffffffd);
    expect(mul32(123456789, 987654321, 'wrap')).toBe(Math.imul(123456789, 987654321));
  });
  it('除法溢出回绕，u16 取低 16 位', () => {
    expect(divTrunc(INT32_MIN, -1, 'wrap')).toBe(INT32_MIN);
    expect(toU16(65536 + 5, 'wrap')).toBe(5);
    expect(toU16(-1, 'wrap')).toBe(65535);
    expect(addU16(65535, 2, 'wrap')).toBe(1);
  });
  it('toInt32 与 clampInt32', () => {
    expect(toInt32(0x100000000 + 7, 'wrap')).toBe(7);
    expect(toInt32(0x10000000000)).toBe(INT32_MAX);
    expect(toInt32(-12.9)).toBe(-12);
    expect(clampInt32(-0x200000000)).toBe(INT32_MIN);
    expect(isInt32(INT32_MAX)).toBe(true);
    expect(isInt32(INT32_MAX + 1)).toBe(false);
    expect(isInt32(1.5)).toBe(false);
  });
  it('两种模式在不溢出时结果相同', () => {
    const samples = [0, 1, -1, 99, -12345, 2_000_000, -2_000_000, 46340];
    for (const a of samples) {
      for (const b of samples) {
        expect(add32(a, b, 'wrap')).toBe(add32(a, b));
        expect(sub32(a, b, 'wrap')).toBe(sub32(a, b));
        if (Math.abs(a * b) <= INT32_MAX) expect(mul32(a, b, 'wrap')).toBe(mul32(a, b));
        if (b !== 0) expect(divTrunc(a, b, 'wrap')).toBe(divTrunc(a, b));
      }
    }
  });
});
