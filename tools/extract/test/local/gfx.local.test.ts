/**
 * 需要用户正版文件（original/）；文件不存在时整组 skip。只读原版文件与 .cache/assets-research 调研样图，不写任何文件。
 * 调研样图由 test/sprite-proto.ts（本项目调研原型）导出：RGBA、透明像素的 RGB 取调色板色，比较前统一归零。
 */
import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RgbaImage } from '../../src/gfx/errors';
import { decodeFlcFrames, flcFrameToRgba, parseFlc, verifyFlcRing } from '../../src/gfx/flc';
import { gndToIndexed, parseGnd } from '../../src/gfx/gnd';
import { packRects } from '../../src/gfx/pack';
import { encodePngIndexed, encodePngRgba } from '../../src/gfx/png';
import { decodeRaw16, raw16Dims } from '../../src/gfx/raw16';
import { decodeSmpFrame, parseSmp } from '../../src/gfx/smp';
import { countOwnerPixels, decodeSprFrame, parseSpr } from '../../src/gfx/spr';
import { parseWave } from '../../src/gfx/wave';
import { hashHex } from '../../src/io/hash';
import { MkfArchive } from '../../src/mkf/container';
import { ORIGINAL_MKFS, originalAvailable, readOriginal, researchPath } from '../helpers/originalMkf';
import { decodePng, normalizeRgba } from '../helpers/pngDecode';

const GAME = ['Data', 'Panel', 'jump', 'map'] as const;
const REQUIRED = ORIGINAL_MKFS.map((m) => m.rel);

describe.skipIf(!originalAvailable(REQUIRED))('gfx 解码器（本机原版文件）', () => {
  const archives = new Map<string, MkfArchive>();
  beforeAll(async () => {
    for (const m of ORIGINAL_MKFS) archives.set(m.rel, MkfArchive.open(await readOriginal(m.rel), m.rel));
  }, 60_000);
  const all = () => [...archives.values()];

  it('SPR/SMP 全部自洽（start、gsize、Σgsize 闭合），帧数与 sprites.md 一致；建筑 SPR 的索引 255 描边像素数与调研一致', () => {
    let sprFrames = 0;
    let smpFrames = 0;
    for (const a of all()) {
      for (const e of a.entries()) {
        const label = `${a.name}#${e.index}`;
        if (e.kind === 'SPR') sprFrames += parseSpr(a.read(e.index), label).count;
        else if (e.kind === 'SMP') smpFrames += parseSmp(a.read(e.index), label).count;
      }
    }
    // sprites.md §0：Data 8735、Panel 1451、jump 492、map 1110、help 12、MJ/map 2247 帧（SPR+SMP）
    expect(sprFrames + smpFrames).toBe(8735 + 1451 + 492 + 1110 + 12 + 2247);
    const map = archives.get('Game/map.mkf')!;
    // idx255-highlight：map #27 / #40 的外圈全是索引 255（帧 1：156 / 183 px）
    const house = (i: number) => decodeSprFrame(parseSpr(map.read(i)), 1).ownerPixels;
    expect([house(27), house(40)]).toEqual([156, 183]);
    expect(countOwnerPixels(parseSpr(map.read(27)))).toBeGreaterThan(8 * 100);
  }, 60_000);

  it('GND：4+8 张全部 72×72、恒等排布、2304²', () => {
    let n = 0;
    for (const rel of ['Game/map.mkf', 'MultiverseJourney/map.mkf']) {
      const a = archives.get(rel)!;
      for (const e of a.entries()) {
        if (e.kind !== 'GND') continue;
        const g = parseGnd(a.read(e.index), `${rel}#${e.index}`);
        expect([g.cols, g.rows, g.identityLayout, g.width, g.height, g.tilesOffset]).toEqual([
          72,
          72,
          true,
          2304,
          2304,
          0x2a90,
        ]);
        n++;
      }
    }
    expect(n).toBe(12);
  });

  it('RAW16：196 个全部命中字节数尺寸表', () => {
    const sizes: Record<string, number> = {};
    for (const a of all()) {
      for (const e of a.entries()) {
        if (e.kind !== 'RAW16') continue;
        const d = raw16Dims(e.rawSize);
        expect(d, `${a.name}#${e.index}`).not.toBeNull();
        const k = `${d!.w}x${d!.h}`;
        sizes[k] = (sizes[k] ?? 0) + 1;
      }
    }
    expect(sizes).toEqual({ '200x200': 83, '388x251': 76, '165x256': 30, '640x480': 6 });
  });

  it('FLC：105 段全部解码，子块统计与 sprites.md 一致，循环帧回到首帧，只有 Panel#20 有 COPY 怪癖', () => {
    const counts: Record<string, number> = {};
    const warnings: string[] = [];
    let n = 0;
    for (const a of all()) {
      for (const e of a.entries()) {
        if (e.kind !== 'FLIC') continue;
        const label = `${a.name}#${e.index}`;
        const f = parseFlc(a.read(e.index), label);
        expect(f.hasRingFrame, label).toBe(true);
        for (const [k, v] of Object.entries(f.subchunkCounts)) counts[k] = (counts[k] ?? 0) + v;
        for (const w of f.warnings) warnings.push(`${label} ${w.code}`);
        expect(verifyFlcRing(f), label).toBe(true);
        n++;
      }
    }
    expect(n).toBe(105);
    expect(counts).toEqual({ '4': 119, '7': 3048, '15': 105, '16': 1, '18': 105 });
    expect(warnings).toEqual(['Game/Panel.mkf#20 W_FLC_COPY_SIZE']);
  }, 120_000);

  it('WAVE：1473 段 PCM u8 单声道，Speaking 22050 Hz 1184 段 / 44100 Hz 190 段，RIFF 长度全部一致', () => {
    const rates: Record<string, number> = {};
    let seconds = 0;
    for (const rel of ['Game/Speaking.mkf', 'Game/Effect.mkf']) {
      const a = archives.get(rel)!;
      for (const e of a.entries()) {
        if (e.kind !== 'WAVE') continue;
        const w = parseWave(a.read(e.index), `${rel}#${e.index}`);
        expect([w.format, w.channels, w.bitsPerSample]).toEqual([1, 1, 8]);
        const k = `${rel}:${w.sampleRate}`;
        rates[k] = (rates[k] ?? 0) + 1;
        if (rel === 'Game/Speaking.mkf') seconds += w.durationSec;
      }
    }
    expect(rates).toEqual({
      'Game/Speaking.mkf:22050': 1184,
      'Game/Speaking.mkf:44100': 190,
      'Game/Effect.mkf:22050': 99,
    });
    // audio_video.md：Speaking 总时长 2283.9 s
    expect(seconds).toBeCloseTo(2283.9, 0);
  });

  it('装箱：Data#88（72 帧走路）一页装下、确定', () => {
    const s = parseSpr(archives.get('Game/Data.mkf')!.read(88));
    const items = s.frames.map((f) => ({ key: `88.${String(f.index).padStart(2, '0')}`, w: f.w, h: f.h }));
    const a = packRects(items);
    expect(a.pages).toHaveLength(1);
    expect(packRects([...items].reverse())).toEqual(a);
    const area = items.reduce((t, i) => t + i.w * i.h, 0);
    expect(area / (a.pages[0]!.w * a.pages[0]!.h)).toBeGreaterThan(0.75);
  });
});

// ───────────────────────── 与调研样图比对 ─────────────────────────

type Sample = { mkf: (typeof GAME)[number]; res: number; frames: number[] };

/** 调研样图（.cache/assets-research/samples/<mkf>/<res>_<frame>.png） */
const SAMPLES: Sample[] = [
  { mkf: 'Data', res: 88, frames: [0, 9, 17, 36, 71] }, // SPR 走路
  { mkf: 'Data', res: 0, frames: [0, 5, 42] }, // SMP（压缩）光标
  { mkf: 'Data', res: 476, frames: [0] }, // SMP（压缩）
  { mkf: 'Data', res: 355, frames: [0, 7] }, // SPR 神明
  { mkf: 'Data', res: 4, frames: [0] }, // RAW16（压缩）200×200
  { mkf: 'Data', res: 400, frames: [0] }, // RAW16（压缩）388×251
  { mkf: 'Data', res: 530, frames: [0] }, // RAW16（压缩）165×256 卡片
  { mkf: 'Data', res: 560, frames: [0] }, // RAW16 640×480
  { mkf: 'Data', res: 499, frames: [0, 10, 20] }, // FLIC（压缩）440×440
  { mkf: 'Panel', res: 0, frames: [0, 5] }, // SMP（压缩）侧栏
  { mkf: 'Panel', res: 3, frames: [0, 17] }, // SPR 骰子
  { mkf: 'Panel', res: 4, frames: [0, 16, 35] }, // FLIC 骰子
  { mkf: 'Panel', res: 72, frames: [0, 6] }, // SPR（压缩）
  { mkf: 'jump', res: 5, frames: [0, 19] }, // SPR（压缩）
  { mkf: 'jump', res: 0, frames: [0] }, // RAW16 640×480
  { mkf: 'jump', res: 42, frames: [0, 7, 14] }, // FLIC
  { mkf: 'jump', res: 43, frames: [10, 20, 30] }, // FLIC（DELTA_FLC 累积）
  { mkf: 'map', res: 8, frames: [0, 1] }, // SMP（压缩）小地图
  { mkf: 'map', res: 13, frames: [0, 11] }, // SPR（压缩）
  { mkf: 'map', res: 27, frames: [0, 7] }, // SPR 建筑（索引 255 按普通颜色导出）
  { mkf: 'map', res: 0, frames: [0] }, // GND 2304²
];

const samplesAvailable =
  originalAvailable(GAME.map((m) => `Game/${m}.mkf`)) && existsSync(researchPath('samples', 'Data', '88_0.png'));

/** 按调研导出时的规则解码（透明：SPR 索引 0、SMP 0x0000、FLIC 索引 0；RAW16 不透明） */
function decodeLikeResearch(a: MkfArchive, res: number): (frame: number) => { img: RgbaImage; png: Uint8Array } {
  const e = a.entry(res);
  const d = a.read(res);
  const rgbaPng = (img: RgbaImage) => ({ img, png: encodePngRgba(img.w, img.h, img.rgba) });
  switch (e.kind) {
    case 'SPR': {
      const s = parseSpr(d);
      return (f) => rgbaPng(decodeSprFrame(s, f));
    }
    case 'SMP': {
      const s = parseSmp(d);
      return (f) => rgbaPng(decodeSmpFrame(s, f));
    }
    case 'RAW16':
      return () => rgbaPng(decodeRaw16(d));
    case 'FLIC': {
      const flc = parseFlc(d);
      const frames = decodeFlcFrames(flc);
      return (f) => rgbaPng(flcFrameToRgba(frames[f]!, flc.width, flc.height));
    }
    case 'GND': {
      // 地面按索引色 PNG 导出（design-draft §2.5），比对时展开成 RGBA
      const idx = gndToIndexed(parseGnd(d));
      return () => {
        const png = encodePngIndexed(idx.w, idx.h, idx.pixels, idx.palette);
        return { img: { w: idx.w, h: idx.h, rgba: new Uint8Array(0) }, png };
      };
    }
    default:
      throw new Error(`样图不覆盖 ${e.kind}`);
  }
}

describe.skipIf(!samplesAvailable)('导出 PNG 的 RGBA 与调研样图一致（本机）', () => {
  const archives = new Map<string, MkfArchive>();
  beforeAll(async () => {
    for (const m of GAME) archives.set(m, MkfArchive.open(await readOriginal(`Game/${m}.mkf`), m));
  }, 60_000);

  for (const s of SAMPLES) {
    it(`${s.mkf}#${s.res} 帧 ${s.frames.join(',')}`, () => {
      const decode = decodeLikeResearch(archives.get(s.mkf)!, s.res);
      for (const f of s.frames) {
        const samplePath = researchPath('samples', s.mkf, `${s.res}_${f}.png`);
        expect(existsSync(samplePath), samplePath).toBe(true);
        const ref = decodePng(readFileSync(samplePath));
        const ours = decodePng(decode(f).png);
        expect([ours.w, ours.h]).toEqual([ref.w, ref.h]);
        expect(hashHex(normalizeRgba(ours.rgba), 'sha256'), `${s.mkf}#${s.res}:${f}`).toBe(
          hashHex(normalizeRgba(ref.rgba), 'sha256'),
        );
      }
    }, 60_000);
  }

  it('同输入同字节：同一资源两次导出的 PNG 完全相同', () => {
    const a = decodeLikeResearch(archives.get('Data')!, 88)(3).png;
    const b = decodeLikeResearch(archives.get('Data')!, 88)(3).png;
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
