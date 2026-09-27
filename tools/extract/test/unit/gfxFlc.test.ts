import { describe, expect, it } from 'vitest';
import { GfxError } from '../../src/gfx/errors';
import {
  decodeFlcFrames,
  FLC_CHUNK,
  FlcDecoder,
  flcFrameDelay,
  flcFrameToRgba,
  parseFlc,
  verifyFlcRing,
} from '../../src/gfx/flc';
import { buildFlc, flcByteRun, flcColor256, flcCopy, flcDeltaFlc } from '../helpers/buildGfx';

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GfxError);
    return (e as GfxError).code;
  }
  throw new Error('应抛 GfxError');
};

const W = 7; // 奇数宽，覆盖 DELTA_FLC 的「行末像素」操作字
const H = 5;
const frame = (f: (x: number, y: number) => number): Uint8Array => {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = f(x, y);
  return out;
};
const f0 = frame((x, y) => (x + y) % 3);
const f1 = frame((x, y) => (y === 2 ? 9 : (x + y) % 3)); // 只改第 2 行
const f2 = frame((x, y) => (y === 4 && x === W - 1 ? 7 : y === 2 ? 9 : (x + y) % 3)); // 只改最后一个像素
const pal = Uint8Array.from({ length: 30 }, (_, i) => i * 8);

function sample(): Uint8Array {
  return buildFlc({
    w: W,
    h: H,
    speed: 71,
    prefix: true,
    frames: [
      { subs: [flcColor256(0, pal), flcByteRun(f0, W, H), { type: FLC_CHUNK.PSTAMP, data: new Uint8Array(10) }] },
      { subs: [flcDeltaFlc(f0, f1, W, H)], delay: 100 },
      { subs: [flcDeltaFlc(f1, f2, W, H)] },
      // 循环帧：回到 f0
      { subs: [flcDeltaFlc(f2, f0, W, H)] },
    ],
  });
}

describe('FLC 解析', () => {
  it('文件头、前缀块、帧块、子块统计', () => {
    const flc = parseFlc(sample(), 't.flc');
    expect([flc.frames, flc.width, flc.height, flc.depth, flc.speed]).toEqual([3, W, H, 8, 71]);
    expect(flc.prefixChunks).toHaveLength(1);
    expect(flc.frameChunks).toHaveLength(4);
    expect(flc.hasRingFrame).toBe(true);
    expect(flc.oframe1).toBe(flc.frameChunks[0]!.offset);
    expect(flc.oframe2).toBe(flc.frameChunks[1]!.offset);
    expect(flc.subchunkCounts).toEqual({ '4': 1, '15': 1, '18': 1, '7': 3 });
    expect(flc.warnings).toEqual([]);
    expect([flcFrameDelay(flc, 0), flcFrameDelay(flc, 1)]).toEqual([71, 100]);
  });

  it('逐帧解码 BYTE_RUN / DELTA_FLC（跳行、行末像素）/ COLOR_256，循环帧回到首帧', () => {
    const flc = parseFlc(sample());
    const frames = decodeFlcFrames(flc);
    expect(frames.map((f) => f.index)).toEqual([0, 1, 2]);
    expect([...frames[0]!.pixels]).toEqual([...f0]);
    expect([...frames[1]!.pixels]).toEqual([...f1]);
    expect([...frames[2]!.pixels]).toEqual([...f2]);
    expect([...frames[0]!.palette.subarray(0, 30)]).toEqual([...pal]);
    expect(decodeFlcFrames(flc, { includeRing: true })).toHaveLength(4);
    expect(decodeFlcFrames(flc, { maxFrames: 2 })).toHaveLength(2);
    expect(verifyFlcRing(flc)).toBe(true);
    const dec = new FlcDecoder(flc);
    while (!dec.done) dec.next();
    expect(dec.position).toBe(4);
    expect(() => dec.next()).toThrow(/E_FLC_EOF/);
  });

  it('RGBA：索引 0 透明（默认），null 表示不透明', () => {
    const flc = parseFlc(sample());
    const [fr] = decodeFlcFrames(flc, { maxFrames: 1 });
    const a = flcFrameToRgba(fr!, W, H);
    expect([...a.rgba.subarray(0, 8)]).toEqual([0, 0, 0, 0, 24, 32, 40, 255]);
    const b = flcFrameToRgba(fr!, W, H, { transparentIndex: null });
    expect([...b.rgba.subarray(0, 4)]).toEqual([0, 8, 16, 255]);
  });

  it('COLOR_64、BLACK、DELTA_FLI、FLI_COPY', () => {
    // DELTA_FLI：u16 y0=1、u16 行数=1；行：1 个包，跳 3，count=+2 → 写 [0xfe, 5]
    const fliData = Uint8Array.from([1, 0, 1, 0, 1, 3, 2, 0xfe, 5]);
    const copy = frame(() => 4);
    const bytes = buildFlc({
      w: W,
      h: H,
      headerFrames: 3,
      frames: [
        { subs: [flcColor256(2, [63, 32, 0], FLC_CHUNK.COLOR_64), { type: FLC_CHUNK.BLACK, data: new Uint8Array(0) }] },
        { subs: [{ type: FLC_CHUNK.DELTA_FLI, data: fliData }] },
        { subs: [flcCopy(copy)] },
      ],
    });
    const flc = parseFlc(bytes);
    expect(flc.hasRingFrame).toBe(false);
    expect(verifyFlcRing(flc)).toBeNull();
    const frames = decodeFlcFrames(flc);
    expect([...frames[0]!.palette.subarray(6, 9)]).toEqual([255, 130, 0]);
    expect(frames[0]!.pixels.every((v) => v === 0)).toBe(true);
    expect([...frames[1]!.pixels.subarray(W, 2 * W)]).toEqual([0, 0, 0, 0xfe, 5, 0, 0]);
    expect([...frames[2]!.pixels]).toEqual([...copy]);
  });

  it('怪癖：COPY 子块 size 少 2（Panel#20）→ 告警，按 W·H 读取、按帧块前进', () => {
    const copy = frame((x) => x);
    const bytes = buildFlc({
      w: W,
      h: H,
      frames: [
        { subs: [flcColor256(0, pal), flcCopy(copy, 6 + W * H - 2)] },
        { subs: [flcDeltaFlc(copy, copy, W, H)] },
      ],
    });
    const flc = parseFlc(bytes);
    expect(flc.warnings.map((w) => [w.code, w.frame])).toEqual([['W_FLC_COPY_SIZE', 0]]);
    expect([...decodeFlcFrames(flc)[0]!.pixels]).toEqual([...copy]);
    expect(verifyFlcRing(flc)).toBe(true);
  });

  it('结构校验', () => {
    const good = sample();
    expect(code(() => parseFlc(good.subarray(0, 100)))).toBe('E_FLC_TRUNCATED');
    expect(code(() => parseFlc(buildFlc({ w: 1, h: 1, magic: 0xaf11, frames: [] })))).toBe('E_FLC_MAGIC');
    expect(code(() => parseFlc(buildFlc({ w: 1, h: 1, depth: 16, frames: [] })))).toBe('E_FLC_DEPTH');
    expect(code(() => parseFlc(buildFlc({ w: 1, h: 1, sizeOverride: 1, frames: [] })))).toBe('E_FLC_SIZE');
    expect(code(() => parseFlc(buildFlc({ w: 0, h: 1, frames: [] })))).toBe('E_FLC_HEADER');
    // 帧数不符
    expect(code(() => parseFlc(buildFlc({ w: W, h: H, headerFrames: 7, frames: [{ subs: [] }] })))).toBe(
      'E_FLC_FRAME_COUNT',
    );
    // 未知顶层块
    const bad = good.slice();
    const off = parseFlc(good).frameChunks[1]!.offset;
    bad[off + 4] = 0x34;
    expect(code(() => parseFlc(bad))).toBe('E_FLC_CHUNK');
    // 块链越过文件尾
    const chain = good.slice();
    chain[off] = 0xff;
    chain[off + 1] = 0xff;
    expect(code(() => parseFlc(chain))).toBe('E_FLC_CHAIN');
    // 未知子块类型
    const sub = buildFlc({ w: W, h: H, frames: [{ subs: [{ type: 99, data: new Uint8Array(2) }] }], headerFrames: 1 });
    expect(code(() => parseFlc(sub))).toBe('E_FLC_SUBCHUNK');
  });

  it('解码越界报错', () => {
    // BYTE_RUN 游程越过行宽
    const run = buildFlc({
      w: 2,
      h: 1,
      headerFrames: 1,
      frames: [{ subs: [{ type: FLC_CHUNK.BYTE_RUN, data: Uint8Array.of(1, 3, 9) }] }],
    });
    expect(code(() => decodeFlcFrames(parseFlc(run)))).toBe('E_FLC_DECODE');
    // DELTA_FLC 行号越界
    const delta = buildFlc({
      w: 2,
      h: 1,
      headerFrames: 1,
      frames: [{ subs: [{ type: FLC_CHUNK.DELTA_FLC, data: Uint8Array.of(1, 0, 0xfe, 0xff, 1, 0, 0, 1, 1, 1) }] }],
    });
    expect(code(() => decodeFlcFrames(parseFlc(delta)))).toBe('E_FLC_DECODE');
    // 调色板索引越界
    const color = buildFlc({
      w: 1,
      h: 1,
      headerFrames: 1,
      frames: [{ subs: [flcColor256(255, [1, 2, 3, 4, 5, 6])] }],
    });
    expect(code(() => decodeFlcFrames(parseFlc(color)))).toBe('E_FLC_DECODE');
    // 数据不足
    const short = buildFlc({
      w: 4,
      h: 1,
      headerFrames: 1,
      frames: [{ subs: [{ type: FLC_CHUNK.BYTE_RUN, data: Uint8Array.of(1, 0xfc, 1) }] }],
    });
    expect(code(() => decodeFlcFrames(parseFlc(short)))).toBe('E_FLC_DECODE');
  });
});
