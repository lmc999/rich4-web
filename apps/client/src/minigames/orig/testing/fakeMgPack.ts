// 测试用的内存小游戏素材包（client-browser）：与合成包（tools/extract syntheticUi 的小游戏段）同一套逻辑键、分组与帧数，
// 帧尺寸与锚点取客户端依赖的原版值；图形是现场用 OffscreenCanvas 画的色块（帧号条），READY GO 是现场编码的色块 FLC。
// 不含任何原版字节。浏览器模式读不到 .cache/synthetic-pack（Vite server.fs.deny），所以在浏览器里现场生成。
import { type AssetEntry, type AtlasV1, atlasFrame, type FlicEntry, type PackManifestV1 } from '@rich4/shared/assets';
import { parseFlc } from '../../../skin/flic/FlcDecoder';
import { buildFlc } from '../../../skin/flic/testing/flcBuilder';
import type { MgPackSource } from '../keys';

interface Spec {
  key: string;
  group: string;
  count: number;
  /** 帧 i 的 [w, h, ax, ay] */
  dims(i: number): readonly [number, number, number, number];
}

const XICONG_CHAR_FRAMES: readonly number[] = [25, 25, 25, 33, 25, 31, 25, 27, 31, 27, 25, 27];

function specs(): Spec[] {
  const out: Spec[] = [];
  const add = (key: string, group: string, count: number, dims: Spec['dims']): void => {
    out.push({ key, group, count, dims });
  };
  add('mg.common.hud', 'mg.common', 20, (i) => (i < 10 ? [15, 28, 0, 0] : [60, 76, 30, 38]));
  add('mg.penguin.screen', 'mg.penguin', 10, (i) => (i === 0 ? [640, 480, 0, 0] : [40, 40, 20, 36]));
  add('mg.penguin.82', 'mg.penguin', 32, () => [40, 48, 20, 38]);
  add('mg.penguin.83', 'mg.penguin', 32, () => [40, 48, 20, 38]);
  add('mg.penguin.84', 'mg.penguin', 8, () => [48, 60, 23, 42]);
  add('mg.penguin.85', 'mg.penguin', 6, () => [48, 60, 23, 42]);
  for (let k = 86; k <= 90; k++) add(`mg.penguin.${k}`, 'mg.penguin', 6, (i) => [16, 14, 7, 44 + i * 5]);
  add('mg.balloon.screen', 'mg.balloon', 14, (i) =>
    i === 0 ? [640, 480, 0, 0] : i <= 6 ? [44, 141, 22, 30] : i <= 12 ? [36, 116, 18, 26] : [60, 122, 28, 40],
  );
  add('mg.xicong.93', 'mg.xicong', 19, () => [64, 66, 32, 64]);
  add('mg.xicong.94', 'mg.xicong', 12, () => [48, 40, 40, 39]);
  for (let k = 95; k <= 99; k++) add(`mg.xicong.${k}`, 'mg.xicong', 8, () => [32, 26, 16, 13]);
  XICONG_CHAR_FRAMES.forEach((n, c) => {
    add(`mg.xicong.char.${c}`, 'mg.xicong', n, () => [66, 72, 33, 71]);
  });
  return out;
}

const COLORS = ['#dc3c3c', '#e68c28', '#dcc828', '#78c83c', '#28aa5a', '#28b4b4', '#3282dc', '#5a50d2', '#a046c8'];

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** 每帧一列（宽取最大帧宽），帧 i 左上角 (i·W, 0) */
function layout(s: Spec): { W: number; H: number } {
  let W = 1;
  let H = 1;
  for (let i = 0; i < s.count; i++) {
    const [w, h] = s.dims(i);
    W = Math.max(W, w);
    H = Math.max(H, h);
  }
  return { W, H };
}

function drawSheet(s: Spec): ImageBitmap {
  const { W, H } = layout(s);
  const ctx = new OffscreenCanvas(W * s.count, H).getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d 不可用');
  const color = COLORS[hash(s.key) % COLORS.length]!;
  for (let i = 0; i < s.count; i++) {
    const [w, h] = s.dims(i);
    ctx.fillStyle = color;
    ctx.fillRect(i * W + 1, 1, w - 2, h - 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(i * W + 2, 2, Math.min(w - 4, i + 1), 2);
  }
  return ctx.canvas.transferToImageBitmap();
}

export interface FakeMgPackOptions {
  /** 去掉这些条目（测试整局回退） */
  omit?: readonly string[];
  /** 把这些条目标成 guess（测试置信度回退） */
  guess?: readonly string[];
}

export interface FakeMgPack extends MgPackSource {
  readonly requested: string[];
  /** 位图借出计数（loadImage +1、releaseImage −1） */
  readonly borrowedImages: Map<string, number>;
}

const READY_W = 640;
const READY_H = 480;
const READY_FRAMES = 20;
const READY_MS = 114;

function readyFlcBytes(): Uint8Array {
  const palette = new Uint8Array(768);
  palette.set([230, 60, 60], 3);
  palette.set([60, 120, 230], 6);
  const frames = Array.from({ length: READY_FRAMES }, (_, f) => {
    const px = new Uint8Array(READY_W * READY_H);
    const y0 = 400 - f * 12;
    for (let y = Math.max(0, y0); y < Math.min(READY_H, y0 + 60); y++) {
      for (let x = 160; x < 480; x++) px[y * READY_W + x] = f < 12 ? 1 : 2;
    }
    return { pixels: px, encoding: 'byterun' as const, ...(f === 0 ? { palette } : {}) };
  });
  return buildFlc({ width: READY_W, height: READY_H, speed: READY_MS, frames });
}

export function buildFakeMgPack(o: FakeMgPackOptions = {}): FakeMgPack {
  const omit = new Set(o.omit ?? []);
  const guess = new Set(o.guess ?? []);
  const all = specs().filter((s) => !omit.has(s.key));
  const byAtlas = new Map(all.map((s) => [`sprites/fake-mg/${s.key}.json`, s]));
  const byPage = new Map(all.map((s) => [`sprites/fake-mg/${s.key}.png`, s]));
  const files: PackManifestV1['files'] = {};
  const fileEntry = (lp: string, kind: string, contentType: string) =>
    ({ path: lp, bytes: 1, sha256: '0'.repeat(64), kind, contentType }) as PackManifestV1['files'][string];
  const entries: Record<string, AssetEntry> = {};
  for (const s of all) {
    const atlas = `sprites/fake-mg/${s.key}.json`;
    files[atlas] = fileEntry(atlas, 'atlas', 'application/json');
    files[`sprites/fake-mg/${s.key}.png`] = fileEntry(`sprites/fake-mg/${s.key}.png`, 'image', 'image/png');
    entries[s.key] = {
      type: 'sprite',
      group: s.group,
      confidence: guess.has(s.key) ? 'guess' : 'visual',
      src: ['fake'],
      atlas: [atlas],
      frames: { base: `F#${s.key}`, start: 0, count: s.count },
      dirs: 1,
      frameMs: null,
      transparency: 'index0',
      ownerMask: false,
      anchor: 'frame',
    };
  }
  const bgFile = 'images/fake-mg/mg.xicong.bg.png';
  if (!omit.has('mg.xicong.bg')) {
    files[bgFile] = fileEntry(bgFile, 'image', 'image/png');
    entries['mg.xicong.bg'] = {
      type: 'image',
      group: 'mg.xicong',
      confidence: guess.has('mg.xicong.bg') ? 'guess' : 'visual',
      src: ['fake'],
      file: bgFile,
      w: 640,
      h: 480,
      transparency: 'opaque',
      anchor: null,
    };
  }
  const flcFile = 'flic/fake-mg/mg.ready.flc';
  const readyEntry: FlicEntry = {
    type: 'flic',
    group: 'mg.common',
    confidence: guess.has('mg.ready') ? 'guess' : 'visual',
    src: ['fake'],
    file: flcFile,
    w: READY_W,
    h: READY_H,
    frames: READY_FRAMES,
    frameMs: READY_MS,
    durationMs: READY_FRAMES * READY_MS,
    transparency: 'index0',
    sfx: null,
  };
  if (!omit.has('mg.ready')) {
    files[flcFile] = fileEntry(flcFile, 'flic', 'application/octet-stream');
    entries['mg.ready'] = readyEntry;
  }
  const manifest = {
    schema: 'rich4.assets/1',
    packId: 'fedcba9876543210',
    generator: 'fake',
    edition: 'v206',
    license: 'private-personal-use',
    source: { files: {}, exeSha256: null },
    tools: { ffmpeg: null },
    features: {
      board: false,
      ui: false,
      fx: false,
      minigames: true,
      audio: false,
      voice: false,
      music: false,
      video: false,
    },
    groups: {},
    files,
    entries,
    maps: {},
  } as unknown as PackManifestV1;
  const requested: string[] = [];
  const borrowedImages = new Map<string, number>();
  const lend = (lp: string, img: ImageBitmap): ImageBitmap => {
    borrowedImages.set(lp, (borrowedImages.get(lp) ?? 0) + 1);
    return img;
  };
  return {
    manifest,
    requested,
    borrowedImages,
    usableEntry(key, opts = {}) {
      const e = Object.hasOwn(entries, key) ? entries[key]! : null;
      if (!e) return null;
      if (e.confidence === 'guess' && opts.allowGuess !== true) return null;
      return e;
    },
    async loadAtlas(lp) {
      requested.push(lp);
      const s = byAtlas.get(lp);
      if (!s) throw new Error(`fake mg pack: 没有图集 ${lp}`);
      const { W, H } = layout(s);
      const frames: AtlasV1['frames'] = {};
      const anchorsPx: AtlasV1['meta']['r4']['anchorsPx'] = {};
      for (let i = 0; i < s.count; i++) {
        const [w, h, ax, ay] = s.dims(i);
        const name = `F#${s.key}/${i}`;
        frames[name] = atlasFrame({ x: i * W, y: 0, w, h }, ax, ay);
        anchorsPx[name] = [ax, ay];
      }
      return {
        schema: 'rich4.atlas/1',
        frames,
        meta: {
          app: 'fake',
          version: '1',
          image: `${s.key}.png`,
          format: 'RGBA8888',
          size: { w: W * s.count, h: H },
          scale: '1',
          r4: { anchorsPx, mask: null, transparency: 'index0', src: ['fake'] },
        },
      };
    },
    async loadImage(lp) {
      requested.push(lp);
      if (lp === bgFile) {
        const ctx = new OffscreenCanvas(640, 480).getContext('2d')!;
        ctx.fillStyle = '#c0503c';
        ctx.fillRect(0, 0, 640, 480);
        return lend(lp, ctx.canvas.transferToImageBitmap());
      }
      const s = byPage.get(lp);
      if (!s) throw new Error(`fake mg pack: 没有位图 ${lp}`);
      return lend(lp, drawSheet(s));
    },
    releaseImage(lp) {
      const n = (borrowedImages.get(lp) ?? 0) - 1;
      if (n === 0) borrowedImages.delete(lp);
      else borrowedImages.set(lp, n);
    },
    async loadFlic(key) {
      requested.push(key);
      if (key !== 'mg.ready' || omit.has(key)) throw new Error(`fake mg pack: 没有 FLC ${key}`);
      const bytes = readyFlcBytes();
      return { entry: readyEntry, flc: parseFlc(bytes.buffer as ArrayBuffer, key) };
    },
  };
}

/** 必需条目（与 orig/keys 的清单对照用） */
export function fakeMgKeys(): string[] {
  return [...specs().map((s) => s.key), 'mg.xicong.bg', 'mg.ready'];
}
