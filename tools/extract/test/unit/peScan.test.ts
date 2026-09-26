import { describe, expect, it } from 'vitest';
import { encodeBig5 } from '../../src/bin/big5';
import { f32Bits, f32BitsHex, f32FromBits, f32Shortest } from '../../src/bin/f32';
import { ExtractError } from '../../src/context';
import {
  Big5StringIndex,
  findPattern,
  normalizeText,
  PeFile,
  parsePattern,
  patternFromBytes,
  patternToString,
} from '../../src/pe/scan';
import { buildPe } from '../helpers/buildPe';

function peWithData(): { pe: Uint8Array; file: PeFile } {
  const pe = buildPe(
    [
      {
        name: 'AUTO',
        virtualAddress: 0x1000,
        virtualSize: 0x200,
        rawSize: 0x200,
        rawPointer: 0x400,
        characteristics: 0x60000020,
      },
      // Watcom 风格：VirtualSize = 0 时按 rawSize
      {
        name: 'DGROUP',
        virtualAddress: 0x2000,
        virtualSize: 0,
        rawSize: 0x200,
        rawPointer: 0x600,
        characteristics: 0xc0000040,
      },
      {
        name: '.bss',
        virtualAddress: 0x3000,
        virtualSize: 0x1000,
        rawSize: 0,
        rawPointer: 0,
        characteristics: 0xc0000080,
      },
    ],
    { imageBase: 0x400000 },
  );
  return { pe, file: new PeFile(pe, 'synth') };
}

describe('PeFile：VA ↔ 文件偏移', () => {
  const { pe, file } = peWithData();

  it('代码节与数据节互转；.bss 与越界返回 null', () => {
    expect(file.vaToOff(0x401000)).toBe(0x400);
    expect(file.vaToOff(0x4011ff)).toBe(0x5ff);
    expect(file.vaToOff(0x402010)).toBe(0x610);
    expect(file.offToVa(0x610)).toBe(0x402010);
    expect(file.tryVaToOff(0x403000)).toBeNull();
    expect(file.tryVaToOff(0x400000)).toBeNull();
    expect(file.tryOffToVa(0x10)).toBeNull();
    expect(() => file.vaToOff(0x4011fe, 4)).toThrow(ExtractError);
    for (const off of [0x400, 0x4ff, 0x600, 0x7ff]) expect(file.vaToOff(file.offToVa(off))).toBe(off);
    expect(pe.length).toBe(0x800);
  });

  it('节分类与映像范围', () => {
    expect(file.spans('code').map((s) => s.section.name)).toEqual(['AUTO']);
    expect(file.spans('data').map((s) => s.section.name)).toEqual(['DGROUP']);
    expect(file.kindOfVa(0x401004)).toBe('code');
    expect(file.kindOfVa(0x402004)).toBe('data');
    expect(file.kindOfVa(0x403004)).toBeNull();
    expect(file.isImageAddress(0x400000)).toBe(true);
    expect(file.isImageAddress(0x403fff)).toBe(true);
    expect(file.isImageAddress(0x404000)).toBe(false);
  });
});

describe('字节模式', () => {
  it('解析、打印与通配搜索', () => {
    const p = parsePattern('8b 0d ?? ?? 46 00');
    expect(patternToString(p)).toBe('8b 0d ?? ?? 46 00');
    const hay = Uint8Array.from([0, 0x8b, 0x0d, 1, 2, 0x46, 0, 0x8b, 0x0d, 9, 9, 0x46, 0, 0x8b, 0x0d, 9, 9, 0x47, 0]);
    expect(findPattern(hay, p)).toEqual([1, 7]);
    expect(findPattern(hay, p, 2)).toEqual([7]);
    expect(findPattern(hay, p, 0, 12)).toEqual([1]);
    expect(findPattern(hay, parsePattern('?? 0d'))).toEqual([1, 7, 13]);
    expect(() => parsePattern('8g')).toThrow(/E_PATTERN/);
    expect(() => parsePattern('  ')).toThrow(/E_PATTERN/);
    expect(patternToString(patternFromBytes(Uint8Array.from([1, 2]), [false, true]))).toBe('01 ??');
  });

  it('PeFile.findU32 / findU32InRange 只在指定节内找', () => {
    const { pe, file } = peWithData();
    const dv = new DataView(pe.buffer);
    dv.setUint32(0x610, 0x402100, true);
    dv.setUint32(0x421, 0x402100, true);
    dv.setUint32(0x430, 0x402104, true);
    expect(file.findU32(0x402100, 'data')).toEqual([0x402010]);
    expect(file.findU32(0x402100, 'code')).toEqual([0x401021]);
    expect(file.findU32InRange(0x402100, 0x402108, 'code').map((r) => [r.at, r.value])).toEqual([
      [0x401021, 0x402100],
      [0x401030, 0x402104],
    ]);
  });
});

describe('Big5 字符串索引', () => {
  it('以 NUL 切分、严格解码、按去空格文本反查', () => {
    const { pe, file } = peWithData();
    let off = 0x620;
    const put = (s: string) => {
      const va = file.offToVa(off);
      const b = encodeBig5(s)!;
      pe.set(b, off);
      off += b.length + 1;
      return va;
    };
    const a = put('約 翰 喬');
    const b = put('均富卡');
    put('ABC');
    pe.set([0xa5, 0xff], off); // 非法 Big5
    off += 3;
    const idx = Big5StringIndex.build(file);
    expect(idx.find('約翰喬').map((e) => e.va)).toEqual([a]);
    expect(idx.find('約 翰 喬')[0]!.text).toBe('約 翰 喬');
    expect(idx.at(b)?.text).toBe('均富卡');
    expect(idx.find('ABC')).toEqual([]); // 纯 ASCII 不入索引
    expect(idx.size).toBe(2);
    expect(file.big5At(b)).toBe('均富卡');
    expect(normalizeText('台 積　電')).toBe('台積電');
  });
});

describe('f32', () => {
  it('位型往返与最短十进制', () => {
    expect(f32BitsHex(f32Bits(1))).toBe('3f800000');
    expect(f32BitsHex(f32Bits(0.6))).toBe('3f19999a');
    expect(f32FromBits(0x42c80000)).toBe(100);
    expect(f32Shortest(0x3f19999a)).toBe(0.6);
    expect(f32Shortest(0x3fcccccd)).toBe(1.6);
    expect(f32Shortest(0x3f800000)).toBe(1);
    expect(f32Shortest(0)).toBe(0);
    for (const x of [0.7, 0.9, 1.4, 1.2, 0.8, 171, 1030]) {
      const bits = f32Bits(x);
      expect(f32Bits(f32Shortest(bits))).toBe(bits);
    }
  });
});
