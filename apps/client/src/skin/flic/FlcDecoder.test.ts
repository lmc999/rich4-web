// FLC 解码器与合成 FLC 逐像素对拍（全部子块类型、0xF100 前缀、循环帧、Panel#20 COPY 怪癖、索引 0 透明与 opaque 例外）；
// 本机装有 ffmpeg 时再用 ffmpeg 的 flic 解码器独立解一遍，逐帧比对 RGB。
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLC_CHUNK, FlcDecoder, FlcError, flcFrameDelay, parseFlc } from './FlcDecoder';
import { buildFlc, lcg, palette64, randomPalette, type SynthFlc, type SynthFrame } from './testing/flcBuilder';

const W = 37; // 奇数宽：覆盖 DELTA_FLC 的行尾像素操作字
const H = 23;

/** 生成一组有结构的帧：大块纯色（BYTE_RUN 重复包）、随机噪点（字面包）、局部变化（DELTA 跳行 / 跳列） */
function scenario(): { spec: SynthFlc; expected: { pixels: Uint8Array; palette: Uint8Array }[] } {
  const rnd = lcg(42);
  const pal0 = randomPalette(1);
  pal0.set([0, 0, 0], 0);
  const f0 = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f0[y * W + x] = y < 5 ? 0 : x < 12 ? 7 : rnd() % 256;
  }
  const f1 = f0.slice();
  for (let x = 3; x < 30; x++) f1[9 * W + x] = 200; // 一整段相同：重复字包
  f1[14 * W + W - 1] = 99; // 只改行尾奇像素
  f1[20 * W + 2] = 1;
  const f2 = f1.slice();
  for (let i = 0; i < 40; i++) f2[(rnd() % H) * W + (rnd() % W)] = rnd() % 256;
  const f3 = f2.slice(); // DELTA_FLI
  for (let x = 0; x < W; x++) f3[6 * W + x] = 55;
  f3[18 * W + 30] = 3;
  const f4 = new Uint8Array(W * H); // COPY（带 size 怪癖）
  for (let i = 0; i < f4.length; i++) f4[i] = (i * 7) % 256;
  const pal1 = pal0.slice();
  pal1.set([10, 20, 30], 5 * 3); // 只改两段调色板：多包 COLOR_256
  pal1.set([40, 50, 60, 70, 80, 90], 250 * 3);
  const pal2 = palette64(9); // COLOR_64
  const frames: SynthFrame[] = [
    { pixels: f0, palette: pal0, encoding: 'byterun' },
    { pixels: f1, encoding: 'delta', pstamp: true, delay: 50 },
    { pixels: f2, palette: pal1, encoding: 'delta' },
    { pixels: f3, encoding: 'deltafli' },
    { pixels: f4, encoding: 'copy', copyQuirk: true },
    { pixels: new Uint8Array(W * H), encoding: 'black' },
    { pixels: f2, palette: pal2, color64: true, encoding: 'delta' },
    { pixels: f2, encoding: 'delta' }, // 与上一帧相同：0 行的 DELTA_FLC
  ];
  const pals = [pal0, pal0, pal1, pal1, pal1, pal1, pal2, pal2];
  const expected = frames.map((f, i) => ({ pixels: f.pixels, palette: pals[i]! }));
  return { spec: { width: W, height: H, speed: 70, frames, ring: true, prefix: true }, expected };
}

describe('FLC 解析', () => {
  it('文件头、前缀块、帧块数与循环帧、COPY 怪癖告警', () => {
    const { spec } = scenario();
    const flc = parseFlc(buildFlc(spec));
    expect(flc.width).toBe(W);
    expect(flc.height).toBe(H);
    expect(flc.frames).toBe(8);
    expect(flc.chunks).toHaveLength(9);
    expect(flc.hasRingFrame).toBe(true);
    expect(flc.speed).toBe(70);
    expect(flcFrameDelay(flc, 0)).toBe(70);
    expect(flcFrameDelay(flc, 1)).toBe(50);
    expect(flc.warnings.some((w) => w.startsWith('W_FLC_COPY_SIZE'))).toBe(true);
    // 合成用例覆盖全部 8 种子块
    const types = new Set(flc.chunks.flatMap((c) => c.subs.map((s) => s.type)));
    expect([...types].sort((a, b) => a - b)).toEqual(Object.values(FLC_CHUNK).sort((a, b) => a - b));
  });

  it('结构错误抛 FlcError', () => {
    const good = buildFlc(scenario().spec);
    const badMagic = good.slice();
    badMagic[4] = 0x11;
    expect(() => parseFlc(badMagic)).toThrow(FlcError);
    expect(() => parseFlc(good.slice(0, 100))).toThrow(/E_FLC|只有/);
    const badSize = good.slice();
    badSize[0] = (badSize[0]! + 1) & 0xff;
    expect(() => parseFlc(badSize)).toThrow(FlcError);
    const badDepth = good.slice();
    badDepth[12] = 16;
    expect(() => parseFlc(badDepth)).toThrow(/depth/);
  });
});

describe('FLC 逐帧解码（与合成源逐像素一致）', () => {
  it('每一帧的索引与调色板都等于编码前的数据；循环帧回到首帧', () => {
    const { spec, expected } = scenario();
    const dec = new FlcDecoder(parseFlc(buildFlc(spec)));
    expected.forEach((e, i) => {
      expect(dec.next()).toBe(i);
      expect(Buffer.from(dec.pixels).equals(Buffer.from(e.pixels)), `frame ${i} pixels`).toBe(true);
      expect(Buffer.from(dec.palette).equals(Buffer.from(e.palette)), `frame ${i} palette`).toBe(true);
    });
    dec.next(); // 循环帧
    expect(dec.done).toBe(true);
    expect(Buffer.from(dec.pixels).equals(Buffer.from(expected[0]!.pixels))).toBe(true);
    expect(Buffer.from(dec.palette).equals(Buffer.from(expected[0]!.palette))).toBe(true);
    expect(() => dec.next()).toThrow(FlcError);
  });

  it('seek：向后跳会从头重解，结果与顺序解码一致', () => {
    const { spec, expected } = scenario();
    const dec = new FlcDecoder(parseFlc(buildFlc(spec)));
    dec.seek(6);
    expect(Buffer.from(dec.pixels).equals(Buffer.from(expected[6]!.pixels))).toBe(true);
    dec.seek(2);
    expect(Buffer.from(dec.pixels).equals(Buffer.from(expected[2]!.pixels))).toBe(true);
    expect(dec.position).toBe(3);
    dec.seek(3);
    expect(Buffer.from(dec.pixels).equals(Buffer.from(expected[3]!.pixels))).toBe(true);
  });

  it('RGBA：索引 0 透明（alpha 0），opaque 时索引 0 按调色板不透明', () => {
    const { spec, expected } = scenario();
    const dec = new FlcDecoder(parseFlc(buildFlc(spec)));
    dec.next();
    const out = new Uint8ClampedArray(W * H * 4);
    dec.toRgba(out);
    const e = expected[0]!;
    for (let i = 0; i < W * H; i++) {
      const v = e.pixels[i]!;
      const got = [out[i * 4], out[i * 4 + 1], out[i * 4 + 2], out[i * 4 + 3]];
      const want = v === 0 ? [0, 0, 0, 0] : [e.palette[v * 3], e.palette[v * 3 + 1], e.palette[v * 3 + 2], 255];
      if (got.join() !== want.join()) throw new Error(`pixel ${i}: ${got} ≠ ${want}`);
    }
    dec.toRgba(out, true);
    const i0 = e.pixels.indexOf(0);
    expect(i0).toBeGreaterThanOrEqual(0);
    expect(out[i0 * 4 + 3]).toBe(255);
    // 非 4 字节对齐的缓冲走逐字节路径，结果相同
    const backing = new Uint8Array(W * H * 4 + 1);
    const odd = backing.subarray(1);
    dec.toRgba(odd);
    const aligned = new Uint8ClampedArray(W * H * 4);
    dec.toRgba(aligned);
    expect(Buffer.from(odd).equals(Buffer.from(aligned))).toBe(true);
    expect(() => dec.toRgba(new Uint8ClampedArray(4))).toThrow(RangeError);
  });
});

function hasFfmpeg(): boolean {
  try {
    return spawnSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

describe.skipIf(!hasFfmpeg())('与 ffmpeg 的 flic 解码器对拍（本机有 ffmpeg 时）', () => {
  it('逐帧 RGB 一致（不含 COPY 怪癖帧）', () => {
    const w = 40;
    const h = 24;
    const rnd = lcg(7);
    const pal = randomPalette(3);
    const frames: SynthFrame[] = [];
    let px = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) px[i] = i % 5 === 0 ? rnd() % 256 : (i >> 3) % 256;
    frames.push({ pixels: px, palette: pal, encoding: 'byterun' });
    for (let k = 1; k < 6; k++) {
      px = px.slice();
      for (let n = 0; n < 30; n++) px[(rnd() % h) * w + (rnd() % w)] = rnd() % 256;
      frames.push({ pixels: px, encoding: k === 3 ? 'copy' : k === 4 ? 'deltafli' : 'delta' });
    }
    const bytes = buildFlc({ width: w, height: h, speed: 60, frames });
    const dir = mkdtempSync(join(tmpdir(), 'rich4-flc-'));
    try {
      const file = join(dir, 'a.flc');
      writeFileSync(file, bytes);
      const raw = execFileSync(
        'ffmpeg',
        ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      const dec = new FlcDecoder(parseFlc(bytes));
      const frameBytes = w * h * 3;
      expect(raw.length).toBeGreaterThanOrEqual(frameBytes * frames.length);
      for (let f = 0; f < frames.length; f++) {
        dec.next();
        const mine = new Uint8Array(frameBytes);
        for (let i = 0; i < w * h; i++) {
          const v = dec.pixels[i]!;
          mine[i * 3] = dec.palette[v * 3]!;
          mine[i * 3 + 1] = dec.palette[v * 3 + 1]!;
          mine[i * 3 + 2] = dec.palette[v * 3 + 2]!;
        }
        const theirs = raw.subarray(f * frameBytes, (f + 1) * frameBytes);
        expect(Buffer.from(mine).equals(Buffer.from(theirs)), `frame ${f}`).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
