/**
 * RAW16：无头 RGB555 整图，尺寸只能按字节数判定。移植自 test/sprite-proto.ts 的 decodeRaw555（本项目调研原型）。
 * 规格：containers.md §5、sprites.md §7。像素从偏移 0 开始（MKF 头里的 imageOffset=4 是打包工具怪癖，与像素起点无关）。
 *
 * | 字节数  | 尺寸     | 内容 |
 * | 80000   | 200×200  | 节日/日历插画 Data#4–86 |
 * | 194776  | 388×251  | 新闻/命运插画 Data#400–475 |
 * | 84480   | 165×256  | 卡片插画 Data#530–559 |
 * | 614400  | 640×480  | Loading、Panel#92、jump#0–3 |
 *
 * 透明：默认不透明；卡片用 'corner-zero'：从四角出发 4 连通地把值为 0x0000 的像素标成透明（圆角），
 * 图内部的黑色像素保持不透明。
 */
import { GfxError, type RgbaImage } from './errors';
import { putRgb555 } from './rgb555';

export interface Size {
  w: number;
  h: number;
}

export const RAW16_SIZES: ReadonlyMap<number, Size> = new Map([
  [80000, { w: 200, h: 200 }],
  [194776, { w: 388, h: 251 }],
  [84480, { w: 165, h: 256 }],
  [614400, { w: 640, h: 480 }],
]);

export function raw16Dims(byteLength: number): Size | null {
  return RAW16_SIZES.get(byteLength) ?? null;
}

export type Raw16Transparency = 'opaque' | 'corner-zero' | 'zero';

export interface Raw16Options {
  /** 显式尺寸；缺省按字节数查 RAW16_SIZES */
  size?: Size;
  transparency?: Raw16Transparency;
}

export function decodeRaw16(data: Uint8Array, opts: Raw16Options = {}, label = 'RAW16'): RgbaImage {
  const size = opts.size ?? raw16Dims(data.length);
  if (!size) throw new GfxError('E_RAW16_SIZE', `${label}: ${data.length} 字节不对应任何已知尺寸`);
  const { w, h } = size;
  if (!(w > 0 && h > 0) || w * h * 2 !== data.length) {
    throw new GfxError('E_RAW16_SIZE', `${label}: ${w}×${h}×2 ≠ ${data.length} 字节`);
  }
  const n = w * h;
  const mode = opts.transparency ?? 'opaque';
  const clear = new Uint8Array(n);
  const val = (p: number): number => data[2 * p]! | (data[2 * p + 1]! << 8);
  if (mode === 'zero') {
    for (let p = 0; p < n; p++) if (val(p) === 0) clear[p] = 1;
  } else if (mode === 'corner-zero') {
    // 从四角 4 连通泛洪（显式栈，确定性）
    const stack: number[] = [];
    for (const p of [0, w - 1, (h - 1) * w, n - 1]) {
      if (val(p) === 0 && !clear[p]) {
        clear[p] = 1;
        stack.push(p);
      }
    }
    while (stack.length > 0) {
      const p = stack.pop()!;
      const x = p % w;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p >= w ? p - w : -1, p + w < n ? p + w : -1];
      for (const q of nb) {
        if (q >= 0 && !clear[q] && val(q) === 0) {
          clear[q] = 1;
          stack.push(q);
        }
      }
    }
  }
  const rgba = new Uint8Array(n * 4);
  for (let p = 0; p < n; p++) if (!clear[p]) putRgb555(rgba, p * 4, val(p));
  return { w, h, rgba };
}
