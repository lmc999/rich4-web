import { describe, expect, it } from 'vitest';
import { big5Roundtrip, decodeBig5Strict, encodeBig5, rawNameFromBytes, readNameField } from '../../src/bin/big5';
import { BinReader, fromHex, toHex } from '../../src/bin/reader';
import { ExtractError } from '../../src/context';

const hex = (s: string) => fromHex(s);

describe('BinReader', () => {
  const bytes = Uint8Array.from([0x01, 0x02, 0xff, 0xff, 0x78, 0x56, 0x34, 0x12, 0xfe, 0xff, 0xff, 0xff]);
  const r = new BinReader(bytes, 't');

  it('小端读取', () => {
    expect(r.u8(0)).toBe(1);
    expect(r.u16(0)).toBe(0x0201);
    expect(r.i16(2)).toBe(-1);
    expect(r.u16(2)).toBe(0xffff);
    expect(r.u32(4)).toBe(0x12345678);
    expect(r.i32(8)).toBe(-2);
    expect(r.u32(8)).toBe(0xfffffffe);
    expect(r.u16Array(0, 2)).toEqual([0x0201, 0xffff]);
    expect(r.hex(4, 4)).toBe('78563412');
  });

  it('越界抛 E_OUT_OF_BOUNDS', () => {
    expect(() => r.u32(9)).toThrow(ExtractError);
    expect(() => r.u8(-1)).toThrow(/E_OUT_OF_BOUNDS/);
    expect(() => r.slice(10, 3)).toThrow(/E_OUT_OF_BOUNDS/);
    expect(r.inRange(8, 4)).toBe(true);
    expect(r.inRange(8, 5)).toBe(false);
  });

  it('子视图偏移正确（非 0 byteOffset）', () => {
    const sub = new BinReader(bytes.subarray(4), 'sub');
    expect(sub.u32(0)).toBe(0x12345678);
  });

  it('hex 往返', () => {
    expect(toHex(fromHex('00a5ff'))).toBe('00a5ff');
    expect(() => fromHex('abc')).toThrow(/E_HEX/);
  });
});

describe('Big5', () => {
  it('解码公开文档里的字节序列', () => {
    expect(decodeBig5Strict(hex('a564a4f9'))).toBe('卡片');
    expect(decodeBig5Strict(hex('c55daa6babce'))).toBe('魔法屋');
    expect(decodeBig5Strict(hex('bbc8a6e6'))).toBe('銀行');
  });

  it('常用字回编码一致', () => {
    for (const h of ['a564a4f9', 'c55daa6babce', 'bbc8a6e6', 'a578a55fa5ab', 'bb4fc657a448b9d8', '41424320']) {
      expect(big5Roundtrip(hex(h))).toBe(true);
    }
    expect(toHex(encodeBig5('卡片魔法屋 AB')!)).toBe('a564a4f9c55daa6babce204142');
  });

  it('回编码能发现 HKSCS 段与重码字', () => {
    // 0x8840 属 HKSCS 段（WHATWG 编码器排除）
    expect(decodeBig5Strict(hex('8840'))).not.toBeNull();
    expect(big5Roundtrip(hex('8840'))).toBe(false);
    // U+2550 有两个码位，WHATWG 取最后一个（0xF9F9）
    expect(decodeBig5Strict(hex('a2a4'))).toBe(decodeBig5Strict(hex('f9f9')));
    expect(big5Roundtrip(hex('a2a4'))).toBe(false);
    expect(big5Roundtrip(hex('f9f9'))).toBe(true);
    // U+5341「十」：0xA2CC 与 0xA451，取后者
    expect(big5Roundtrip(hex('a2cc'))).toBe(false);
    expect(big5Roundtrip(hex('a451'))).toBe(true);
  });

  it('非法序列：text 为 null，roundtrip 为 false', () => {
    const n = rawNameFromBytes(hex('a5'));
    expect(n).toEqual({ hex: 'a5', text: null, roundtrip: false });
    expect(decodeBig5Strict(hex('a5ff'))).toBeNull();
    // WHATWG 解码器把 0x80 映射为 U+0080，但编码器不接受 → 回编码失败
    expect(decodeBig5Strict(hex('80'))).toBe('\u0080');
    expect(big5Roundtrip(hex('80'))).toBe(false);
    expect(encodeBig5('😀')).toBeNull();
  });

  it('定长名称字段：NUL 截断与残留检测', () => {
    const a = readNameField(hex('a564a4f900000000'));
    expect(a.name).toEqual({ hex: 'a564a4f9', text: '卡片', roundtrip: true });
    expect(a.terminated).toBe(true);
    expect(a.trailingGarbage).toBe(false);
    const b = readNameField(hex('a564a4f900410000'));
    expect(b.trailingGarbage).toBe(true);
    const c = readNameField(hex('41424344'));
    expect(c.terminated).toBe(false);
    expect(c.name.text).toBe('ABCD');
    const empty = readNameField(new Uint8Array(4));
    expect(empty.name).toEqual({ hex: '', text: '', roundtrip: true });
  });
});
