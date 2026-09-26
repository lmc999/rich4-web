import { describe, expect, it } from 'vitest';
import {
  seedFromHex,
  seedFromU32,
  XOSHIRO_ZERO_FALLBACK,
  XoshiroRng,
  type XoshiroState,
  xoshiroFromWords,
  xoshiroInt,
  xoshiroNext32,
  xoshiroRand15,
} from './xoshiro';

/** BigInt 参照实现（逐行照抄 xoshiro128** 参考 C 代码） */
function refNext(s: bigint[]): bigint {
  const M = 0xffffffffn;
  const rotl = (x: bigint, k: bigint) => ((x << k) | (x >> (32n - k))) & M;
  const result = (rotl((s[1]! * 5n) & M, 7n) * 9n) & M;
  const t = (s[1]! << 9n) & M;
  s[2]! ^= s[0]!;
  s[3]! ^= s[1]!;
  s[1]! ^= s[2]!;
  s[0]! ^= s[3]!;
  s[2]! ^= t;
  s[3] = rotl(s[3]!, 11n);
  return result;
}

describe('xoshiro128**', () => {
  it('种子 [1,2,3,4] 的 golden 序列（参考实现公认输出）', () => {
    const s = xoshiroFromWords([1, 2, 3, 4]);
    const got = Array.from({ length: 10 }, () => xoshiroNext32(s));
    expect(got).toEqual([
      11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849, 3729100597, 4258142804,
    ]);
  });

  it('与 BigInt 参照实现逐位一致', () => {
    const s = seedFromHex('0123456789abcdef0123456789abcdef');
    const r = s.map((x) => BigInt(x));
    for (let i = 0; i < 2000; i++) expect(xoshiroNext32(s)).toBe(Number(refNext(r)));
  });

  it('seedFromHex 的 golden', () => {
    const s = seedFromHex('00112233445566778899aabbccddeeff');
    expect(s).toEqual([0xbca62359, 0x6a7e0dd1, 0x77bd2c87, 0xa6d1beca]);
    expect(Array.from({ length: 4 }, () => xoshiroNext32(s))).toEqual([339140314, 1622037035, 2207673792, 2676715906]);
    const t = seedFromHex('0123456789abcdef0123456789abcdef');
    expect(Array.from({ length: 8 }, () => xoshiroRand15(t))).toEqual([
      16553, 29221, 29297, 8887, 29733, 3849, 166, 23096,
    ]);
  });

  it('seedFromHex：大小写不敏感、左补零、非法输入抛错、不同种子不同状态', () => {
    expect(seedFromHex('ABCDEF')).toEqual(seedFromHex('abcdef'));
    expect(seedFromHex('abc')).toEqual(seedFromHex('00000abc'));
    expect(seedFromHex('0')).toEqual(seedFromHex('0'.repeat(32)));
    expect(seedFromHex('1')).not.toEqual(seedFromHex('2'));
    expect(seedFromHex('1'.padStart(32, '0'))).not.toEqual(seedFromHex('1'.padEnd(32, '0')));
    expect(() => seedFromHex('')).toThrow(RangeError);
    expect(() => seedFromHex('xyz')).toThrow(RangeError);
    expect(() => seedFromHex('0'.repeat(65))).toThrow(RangeError);
  });

  it('全零状态被替换成常量', () => {
    expect(xoshiroFromWords([0, 0, 0, 0])).toEqual([...XOSHIRO_ZERO_FALLBACK]);
    expect(seedFromU32(0).some((x) => x !== 0)).toBe(true);
  });

  it('rand15 在 0..32767，int(n) = rand15 % n', () => {
    const a = seedFromU32(7);
    const b: XoshiroState = [...a];
    for (let i = 0; i < 5000; i++) {
      const r = xoshiroRand15(a);
      expect(r >= 0 && r <= 32767 && Number.isInteger(r)).toBe(true);
      expect(xoshiroInt(b, 6)).toBe(r % 6);
    }
    expect(() => xoshiroInt(a, 0)).toThrow(RangeError);
    expect(() => xoshiroInt(a, 2.5)).toThrow(RangeError);
  });

  it('状态经 JSON 往返后序列不变', () => {
    const rng = XoshiroRng.fromHex('feedface');
    for (let i = 0; i < 37; i++) rng.next32();
    const saved = JSON.parse(JSON.stringify(rng.state)) as XoshiroState;
    const copy = new XoshiroRng(saved);
    for (let i = 0; i < 100; i++) expect(copy.next32()).toBe(rng.next32());
    expect(copy.snapshot()).toEqual(rng.state);
    expect(rng.state.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffffffff)).toBe(true);
  });

  it('XoshiroRng 原地推进传入的状态数组', () => {
    const st = seedFromU32(1);
    const before = [...st];
    const rng = new XoshiroRng(st);
    rng.int(10);
    expect(st).not.toEqual(before);
    expect(rng.state).toBe(st);
  });
});
