/**
 * 原版皮肤 A2：图像产物（图集页 + 图集 JSON、主人色掩膜、RAW16 整图、区域掩膜、地面切块、FLC）。
 * 只做「解码结果 → 字节」的纯变换，不读写文件；写入由 manifest.ts 的 PackWriter 完成。
 *
 * - SPR（8 位调色板）：同一资源的所有帧共用一套调色板，图集页直接输出索引色 PNG（PLTE + tRNS，索引 0 透明），
 *   比 RGBA 小得多；建筑类（ownerMask）另输出同布局的白色掩膜页（索引 255 → 255），底图里这些像素透明。
 * - SMP（16 位直接色）：RGBA PNG，0x0000 透明（整屏背景由条目的 transparency='rgb0-backdrop' 提示先铺黑底）。
 * - 图集：TexturePacker hash 格式（AtlasV1），帧名 `<mkf>#<res>/<i>`，anchor = 锚点像素 / 帧尺寸；
 *   确定性 MaxRects 装箱（gfx/pack.ts），页面不超过 2048²，帧间 1px；原版空帧补成 1×1 透明像素、锚点不变。
 */
import { type AtlasFrame, type AtlasV1, atlasFrame, hashedPath, spriteFrameName } from '@rich4/shared/assets';
import type { RgbaImage } from '../gfx/errors';
import { gndToIndexed, parseGnd, splitIndexed } from '../gfx/gnd';
import { composePages, type PackResult, packRects } from '../gfx/pack';
import { encodePngGray8, encodePngIndexed, encodePngRgba, type PngOptions } from '../gfx/png';
import { decodeRaw16 } from '../gfx/raw16';
import { paletteToRgb } from '../gfx/rgb555';
import { decodeSmpFrame, type SmpSheet } from '../gfx/smp';
import { SPR_OWNER_INDEX, type SprSheet, sprFrameIndices } from '../gfx/spr';
import { sha256Hex } from '../io/hash';
import { jsonBytes } from './manifest';

/** 图集页最大尺寸 */
export const ATLAS_MAX = 2048;
export const ATLAS_APP = 'rich4-extract';
export const ATLAS_VERSION = '1';

export interface IndexedFrame {
  w: number;
  h: number;
  ax: number;
  ay: number;
  /** w·h 字节索引 */
  pixels: Uint8Array;
}

export interface AnchoredRgba extends RgbaImage {
  ax: number;
  ay: number;
}

/** 一个精灵资源解码后的全部帧 */
export type FrameSet =
  | {
      kind: 'indexed';
      frames: IndexedFrame[];
      /** 256×3 RGB */
      palette: Uint8Array;
      /** 256 项 alpha */
      alpha: Uint8Array;
      /** 输出主人色掩膜页（索引 255） */
      ownerMask: boolean;
    }
  | { kind: 'rgba'; frames: AnchoredRgba[] };

/** SPR → 索引帧集：索引 0 透明（调色板色归零），ownerMask 时索引 255 在底图透明、另出掩膜 */
export function sprFrameSet(sheet: SprSheet, ownerMask: boolean): FrameSet {
  const palette = paletteToRgb(sheet.palette);
  const alpha = new Uint8Array(256).fill(255);
  palette.fill(0, 0, 3);
  alpha[0] = 0;
  if (ownerMask) {
    palette.fill(0, SPR_OWNER_INDEX * 3, SPR_OWNER_INDEX * 3 + 3);
    alpha[SPR_OWNER_INDEX] = 0;
  }
  const frames = sheet.frames.map((f, i) => ({
    w: f.w,
    h: f.h,
    ax: f.ax,
    ay: f.ay,
    pixels: sprFrameIndices(sheet, i),
  }));
  return { kind: 'indexed', frames, palette, alpha, ownerMask };
}

/** SMP → RGBA 帧集（0x0000 透明） */
export function smpFrameSet(sheet: SmpSheet): FrameSet {
  return { kind: 'rgba', frames: sheet.frames.map((_, i) => decodeSmpFrame(sheet, i)) };
}

export interface AtlasPageOut {
  /** 逻辑路径 */
  imagePath: string;
  imageBytes: Uint8Array;
  maskPath: string | null;
  maskBytes: Uint8Array | null;
  jsonPath: string;
  atlas: AtlasV1;
  jsonBytes: Uint8Array;
}

export interface AtlasBuildInput {
  /** 目录（逻辑路径），如 'sprites/data' */
  dir: string;
  /** 文件名主干，如 '88' */
  name: string;
  /** 帧名前缀，如 'Data#88' */
  base: string;
  set: FrameSet;
  transparency: AtlasV1['meta']['r4']['transparency'];
  src: string[];
  png?: PngOptions;
}

const pad4 = (i: number) => String(i).padStart(5, '0');

function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

/** 按帧集装箱并输出各页（页序与帧序确定，与输入顺序无关） */
export function buildAtlasPages(input: AtlasBuildInput): AtlasPageOut[] {
  const { set } = input;
  const dims = set.frames.map((f) => ({ w: Math.max(1, f.w), h: Math.max(1, f.h) }));
  const packed: PackResult = packRects(
    dims.map((d, i) => ({ key: pad4(i), w: d.w, h: d.h })),
    { maxWidth: ATLAS_MAX, maxHeight: ATLAS_MAX, padding: 1 },
  );
  const pageOf = new Map(packed.placements.map((p) => [Number(p.key), p]));
  let rgbaPages: RgbaImage[] | null = null;
  if (set.kind === 'rgba') {
    const imgs = new Map<string, RgbaImage>();
    set.frames.forEach((f, i) => {
      imgs.set(pad4(i), f.w > 0 && f.h > 0 ? f : { w: 1, h: 1, rgba: new Uint8Array(4) });
    });
    rgbaPages = composePages(packed, imgs);
  }
  const out: AtlasPageOut[] = [];
  for (const page of packed.pages) {
    const stem = page.index === 0 ? input.name : `${input.name}-${page.index}`;
    const imagePath = `${input.dir}/${stem}.png`;
    let imageBytes: Uint8Array;
    let maskPath: string | null = null;
    let maskBytes: Uint8Array | null = null;
    if (set.kind === 'indexed') {
      const px = new Uint8Array(page.w * page.h);
      const mask = set.ownerMask ? new Uint8Array(page.w * page.h) : null;
      for (const pl of page.items) {
        const f = set.frames[Number(pl.key)]!;
        if (f.w === 0 || f.h === 0) continue;
        for (let r = 0; r < f.h; r++) {
          const row = f.pixels.subarray(r * f.w, (r + 1) * f.w);
          const o = (pl.y + r) * page.w + pl.x;
          px.set(row, o);
          if (mask) for (let x = 0; x < f.w; x++) if (row[x] === SPR_OWNER_INDEX) mask[o + x] = 255;
        }
      }
      imageBytes = encodePngIndexed(page.w, page.h, px, set.palette, set.alpha, input.png);
      if (mask) {
        maskPath = `${input.dir}/${stem}.mask.png`;
        maskBytes = encodePngGray8(page.w, page.h, mask, input.png);
      }
    } else {
      const img = rgbaPages![page.index]!;
      imageBytes = encodePngRgba(img.w, img.h, img.rgba, input.png);
    }
    const frames: Record<string, AtlasFrame> = {};
    const anchorsPx: Record<string, [number, number]> = {};
    const names = page.items.map((pl) => Number(pl.key)).sort((a, b) => a - b);
    for (const i of names) {
      const pl = pageOf.get(i)!;
      const f = set.frames[i]!;
      const name = spriteFrameName(input.base, i);
      frames[name] = atlasFrame({ x: pl.x, y: pl.y, w: pl.w, h: pl.h }, f.ax, f.ay);
      anchorsPx[name] = [f.ax, f.ay];
    }
    const atlas: AtlasV1 = {
      schema: 'rich4.atlas/1',
      frames,
      meta: {
        app: ATLAS_APP,
        version: ATLAS_VERSION,
        image: basename(hashedPath(imagePath, sha256Hex(imageBytes))),
        format: 'RGBA8888',
        size: { w: page.w, h: page.h },
        scale: '1',
        r4: {
          anchorsPx,
          mask: maskPath && maskBytes ? basename(hashedPath(maskPath, sha256Hex(maskBytes))) : null,
          transparency: input.transparency,
          src: input.src,
        },
      },
    };
    out.push({
      imagePath,
      imageBytes,
      maskPath,
      maskBytes,
      jsonPath: `${input.dir}/${stem}.json`,
      atlas,
      jsonBytes: jsonBytes(atlas),
    });
  }
  return out;
}

/** RAW16 整图 → RGBA PNG */
export function raw16Png(
  data: Uint8Array,
  size: { w: number; h: number },
  transparency: 'opaque' | 'corner-rgb0',
  label: string,
  png?: PngOptions,
): Uint8Array {
  const img = decodeRaw16(data, { size, transparency: transparency === 'opaque' ? 'opaque' : 'corner-zero' }, label);
  return encodePngRgba(img.w, img.h, img.rgba, png);
}

/** u8 区域图 → 8 位灰度 PNG（值即区号）；返回最大区号 */
export function maskPng(
  data: Uint8Array,
  size: { w: number; h: number },
  png?: PngOptions,
): { bytes: Uint8Array; maxRegion: number } {
  if (data.length !== size.w * size.h) {
    throw new RangeError(`区域图 ${data.length} 字节 ≠ ${size.w}×${size.h}`);
  }
  let maxRegion = 0;
  for (const v of data) if (v > maxRegion) maxRegion = v;
  return { bytes: encodePngGray8(size.w, size.h, data, png), maxRegion };
}

export interface GroundChunkOut {
  col: number;
  row: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 逻辑路径 ground/<mapId>/<col>_<row>.png */
  path: string;
  bytes: Uint8Array;
}

/** GND → 索引色切块（每块向右、向下多带 overlap 像素）；返回切块与世界尺寸 */
export function groundChunks(
  gnd: Uint8Array,
  mapId: string,
  cols: number,
  rows: number,
  overlap: number,
  label: string,
  png?: PngOptions,
): { world: { w: number; h: number }; chunks: GroundChunkOut[] } {
  const g = parseGnd(gnd, label);
  const img = gndToIndexed(g);
  const tiles = splitIndexed(img, cols, rows, overlap);
  return {
    world: { w: img.w, h: img.h },
    chunks: tiles.map((t) => ({
      col: t.col,
      row: t.row,
      x: t.x,
      y: t.y,
      w: t.w,
      h: t.h,
      path: `ground/${mapId}/${t.col}_${t.row}.png`,
      bytes: encodePngIndexed(t.w, t.h, t.pixels, img.palette, null, png),
    })),
  };
}
