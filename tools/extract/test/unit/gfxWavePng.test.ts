import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GfxError } from '../../src/gfx/errors';
import {
  encodePngGray8,
  encodePngIndexed,
  encodePngRgba,
  filterScanlines,
  isDerivedPng,
  PNG_DERIVED_KEYWORD,
  PNG_DERIVED_VALUE,
  PNG_FILTER,
  readPngText,
} from '../../src/gfx/png';
import { parseWave, sliceWave } from '../../src/gfx/wave';
import { buildWave } from '../helpers/buildGfx';
import { decodePng } from '../helpers/pngDecode';

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GfxError);
    return (e as GfxError).code;
  }
  throw new Error('应抛 GfxError');
};

describe('WAVE', () => {
  const samples = Uint8Array.from({ length: 2205 }, (_, i) => 128 + ((i * 5) % 50));

  it('解析 fmt/data/LIST/smpl，奇数块带填充', () => {
    const bytes = buildWave({
      rate: 22050,
      samples,
      extra: [
        { id: 'LIST', data: new Uint8Array(7) },
        { id: 'smpl', data: new Uint8Array(60) },
      ],
    });
    const w = parseWave(bytes, 'w');
    expect([w.format, w.channels, w.sampleRate, w.bitsPerSample, w.blockAlign, w.byteRate]).toEqual([
      1, 1, 22050, 8, 1, 22050,
    ]);
    expect(w.chunks.map((c) => [c.id, c.size])).toEqual([
      ['fmt ', 16],
      ['data', 2205],
      ['LIST', 7],
      ['smpl', 60],
    ]);
    expect(w.dataBytes).toBe(2205);
    expect(bytes.subarray(w.dataOffset, w.dataOffset + w.dataBytes)).toEqual(samples);
    expect(w.sampleFrames).toBe(2205);
    expect(w.durationSec).toBeCloseTo(0.1, 10);
    expect(w.riffSize + 8).toBe(bytes.length);
  });

  it('立体声 16 位', () => {
    const w = parseWave(buildWave({ rate: 44100, channels: 2, bits: 16, samples: new Uint8Array(400) }));
    expect([w.blockAlign, w.sampleFrames, w.byteRate]).toEqual([4, 100, 176400]);
  });

  it('sliceWave 截出完整 RIFF（容忍尾部多余字节）', () => {
    const bytes = buildWave({ rate: 22050, samples });
    const padded = new Uint8Array(bytes.length + 3);
    padded.set(bytes);
    expect(code(() => parseWave(padded))).toBe('E_WAVE_SIZE');
    const s = sliceWave(padded);
    expect(s.bytes.length).toBe(bytes.length);
    expect(s.info.dataBytes).toBe(samples.length);
  });

  it('结构校验', () => {
    expect(code(() => parseWave(new Uint8Array(12)))).toBe('E_WAVE_MAGIC');
    expect(code(() => parseWave(buildWave({ rate: 22050, samples, riffSizeDelta: 4 })))).toBe('E_WAVE_SIZE');
    expect(code(() => parseWave(buildWave({ rate: 22050, samples, omitFmt: true })))).toBe('E_WAVE_ORDER');
    const noData = buildWave({ rate: 22050, samples: new Uint8Array(0) });
    // 把 data 块 id 改掉
    noData[12 + 8 + 16] = 0x78;
    expect(code(() => parseWave(noData))).toBe('E_WAVE_DATA');
    expect(code(() => parseWave(buildWave({ rate: 0, samples })))).toBe('E_WAVE_FMT');
    const chunkOver = buildWave({ rate: 22050, samples });
    chunkOver[40] = 0xff; // data 块大小改大
    chunkOver[41] = 0xff;
    expect(code(() => parseWave(chunkOver))).toBe('E_WAVE_CHUNK');
  });
});

describe('PNG 编码（node:zlib 往返自检）', () => {
  it('RGBA：往返一致、带派生标记、固定 filter、同输入同字节', () => {
    const w = 5;
    const h = 3;
    const rgba = Uint8Array.from({ length: w * h * 4 }, (_, i) => (i * 37) & 0xff);
    const png = encodePngRgba(w, h, rgba);
    const d = decodePng(png);
    expect([d.w, d.h, d.colorType, d.bitDepth]).toEqual([5, 3, 6, 8]);
    expect(d.rgba).toEqual(rgba);
    expect(d.text).toEqual({ [PNG_DERIVED_KEYWORD]: PNG_DERIVED_VALUE });
    expect(d.filters.every((f) => f === PNG_FILTER.NONE)).toBe(true);
    expect(d.chunks).toEqual(['IHDR', 'tEXt', 'IDAT', 'IEND']);
    expect(Buffer.from(encodePngRgba(w, h, rgba)).equals(Buffer.from(png))).toBe(true);
    expect(isDerivedPng(png)).toBe(true);
    expect(isDerivedPng(encodePngRgba(w, h, rgba, { derivedMarker: false }))).toBe(false);
  });

  it('索引色：PLTE + 截尾 tRNS', () => {
    const pal = Uint8Array.of(0, 0, 0, 255, 0, 0, 0, 255, 0);
    const px = Uint8Array.of(0, 1, 2, 1, 0, 2);
    const d = decodePng(encodePngIndexed(3, 2, px, pal, Uint8Array.of(0, 255, 255)));
    expect(d.colorType).toBe(3);
    expect(d.trns).toEqual(Uint8Array.of(0));
    expect(d.chunks).toEqual(['IHDR', 'PLTE', 'tRNS', 'tEXt', 'IDAT', 'IEND']);
    expect([...d.rgba]).toEqual([
      0, 0, 0, 0, 255, 0, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0, 0, 255, 0, 255,
    ]);
    const opaque = decodePng(encodePngIndexed(3, 2, px, pal, Uint8Array.of(255, 255, 255)));
    expect(opaque.trns).toBeNull();
    expect(code(() => encodePngIndexed(3, 2, Uint8Array.of(0, 1, 3, 1, 0, 2), pal))).toBe('E_PNG_PALETTE');
    expect(code(() => encodePngIndexed(3, 2, px, new Uint8Array(4)))).toBe('E_PNG_PALETTE');
  });

  it('灰度：值原样保存（区域掩膜）', () => {
    const v = Uint8Array.from({ length: 64 }, (_, i) => i % 14);
    const d = decodePng(encodePngGray8(8, 8, v));
    expect(d.colorType).toBe(0);
    expect(d.raw).toEqual(v);
  });

  it('额外 tEXt 按关键字排序；非法关键字/尺寸报错', () => {
    const png = encodePngGray8(1, 1, Uint8Array.of(0), { text: { zeta: '1', Alpha: '2' } });
    const d = decodePng(png);
    expect(Object.keys(d.text)).toEqual(['Alpha', PNG_DERIVED_KEYWORD, 'zeta']);
    expect(readPngText(png)).toEqual(d.text);
    expect(readPngText(Uint8Array.of(1, 2, 3))).toBeNull();
    expect(code(() => encodePngGray8(1, 1, Uint8Array.of(0), { text: { '': 'x' } }))).toBe('E_PNG_TEXT');
    expect(code(() => encodePngGray8(1, 1, Uint8Array.of(0), { text: { k: '中' } }))).toBe('E_PNG_TEXT');
    expect(code(() => encodePngGray8(0, 1, new Uint8Array(0)))).toBe('E_PNG_SIZE');
    expect(code(() => encodePngRgba(2, 2, new Uint8Array(15)))).toBe('E_PNG_SIZE');
  });

  it('filterScanlines：五种 filter 都能被标准解码器还原', () => {
    const w = 4;
    const h = 3;
    const px = Uint8Array.from({ length: w * h * 4 }, (_, i) => (i * 91 + 7) & 0xff);
    const base = encodePngRgba(w, h, px, { derivedMarker: false });
    // 签名 8 + IHDR 25 之后就是 IDAT；换成指定 filter 的 IDAT
    const head = base.subarray(0, 8 + 25);
    for (const f of [0, 1, 2, 3, 4] as const) {
      const lines = filterScanlines(px, w, h, 4, f);
      expect(lines.length).toBe((w * 4 + 1) * h);
      const z = deflateSync(lines);
      const idat = new Uint8Array(12 + z.length);
      const dv = new DataView(idat.buffer);
      dv.setUint32(0, z.length);
      idat.set([0x49, 0x44, 0x41, 0x54], 4);
      idat.set(z, 8);
      dv.setUint32(8 + z.length, crc32(idat.subarray(4, 8 + z.length)));
      const iend = Uint8Array.of(0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82);
      const d = decodePng(Buffer.concat([head, idat, iend]));
      expect(d.filters.every((x) => x === f)).toBe(true);
      expect(d.rgba).toEqual(px);
    }
  });
});
