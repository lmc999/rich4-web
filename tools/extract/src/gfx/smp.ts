/**
 * SMP：16 位 RGB555 直接色精灵（无调色板）。移植自 test/sprite-proto.ts 的 parseSheet/decodeFrame（本项目调研原型）。
 * 规格：sprites.md §5、ui.md §1。
 *
 * - 透明值是 0x0000（exe fcn.004542B2 `lodsw; or ax,ax; je skip`）。
 * - 整屏背景类资源（由资源目录标记 opaque）不抠黑：0x0000 输出为不透明黑色，
 *   与原版「先铺黑底再合成」的两种 blit 结果一致。
 */
import type { AnchoredImage } from './errors';
import { rgb555RunToRgba } from './rgb555';
import { parseSheetHeader, type SheetHeader, sheetFrame } from './sheet';

export interface SmpSheet extends SheetHeader {
  kind: 'SMP';
  data: Uint8Array;
  label: string;
}

export function parseSmp(data: Uint8Array, label = 'SMP'): SmpSheet {
  const h = parseSheetHeader(data, 'SMP', label);
  return { ...h, kind: 'SMP', data, label };
}

/** 帧的原始 RGB555 字节（零拷贝，2·w·h 字节） */
export function smpFrameBytes(sheet: SmpSheet, i: number): Uint8Array {
  const f = sheetFrame(sheet, i, sheet.label);
  return sheet.data.subarray(f.offset, f.offset + f.gsize);
}

export interface SmpDecodeOptions {
  /** 整屏背景：0x0000 输出为不透明黑，默认 false（0x0000 透明） */
  opaque?: boolean;
}

export function decodeSmpFrame(sheet: SmpSheet, i: number, opts: SmpDecodeOptions = {}): AnchoredImage {
  const f = sheetFrame(sheet, i, sheet.label);
  const rgba = rgb555RunToRgba(sheet.data, f.offset, f.w * f.h, { zeroTransparent: !(opts.opaque ?? false) });
  return { w: f.w, h: f.h, ax: f.ax, ay: f.ay, rgba };
}
