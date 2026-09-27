/**
 * 确定性 MaxRects 装箱（Best Short Side Fit，不旋转；按公开算法描述新写，无调研原型）。design-draft §2.2/§2.7：
 * 输入先按 (高 desc, 宽 desc, key 升序码点) 排序；页面不超过 maxWidth×maxHeight（默认 2048²）；
 * 帧间留 padding（默认 1px）空隙、页边不留；同输入同输出，与输入顺序无关。
 *
 * 每页先在候选尺寸（32 的倍数，按面积、长边、宽升序）里找能装下全部剩余矩形的最小页；
 * 最大页也装不下时，按排序顺序贪心填满一张最大页，剩余的进入下一页。最后把每页裁到实际用到的包围盒。
 * 宽或高为 0 的矩形不占空间，放在第 0 页 (0,0)。
 */
import { GfxError, type RgbaImage } from './errors';

export interface PackItem {
  key: string;
  w: number;
  h: number;
}

export interface PackPlacement {
  key: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PackPage {
  index: number;
  w: number;
  h: number;
  /** 按 key 码点升序 */
  items: PackPlacement[];
}

export interface PackOptions {
  maxWidth?: number;
  maxHeight?: number;
  /** 矩形之间的最小间隔（像素），默认 1 */
  padding?: number;
  /** 候选页尺寸步长，默认 32 */
  step?: number;
}

export interface PackResult {
  pages: PackPage[];
  /** 按 key 码点升序 */
  placements: PackPlacement[];
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const byCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function sortPackItems(items: readonly PackItem[]): PackItem[] {
  return [...items].sort((a, b) => b.h - a.h || b.w - a.w || byCodepoint(a.key, b.key));
}

/** 单个 MaxRects 箱（坐标含 padding：箱宽 = 页宽 + padding，矩形宽 = w + padding） */
class MaxRectsBin {
  private free: Rect[];
  readonly used: Rect[] = [];
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.free = [{ x: 0, y: 0, w: width, h: height }];
  }

  /** BSSF：短边余量最小，其次长边余量，再次 y、x 最小 */
  find(w: number, h: number): Rect | null {
    let best: Rect | null = null;
    let bShort = Infinity;
    let bLong = Infinity;
    for (const f of this.free) {
      if (w > f.w || h > f.h) continue;
      const dw = f.w - w;
      const dh = f.h - h;
      const s = Math.min(dw, dh);
      const l = Math.max(dw, dh);
      if (
        s < bShort ||
        (s === bShort &&
          (l < bLong || (l === bLong && best !== null && (f.y < best.y || (f.y === best.y && f.x < best.x)))))
      ) {
        best = { x: f.x, y: f.y, w, h };
        bShort = s;
        bLong = l;
      }
    }
    return best;
  }

  place(r: Rect): void {
    const next: Rect[] = [];
    for (const f of this.free) {
      if (r.x >= f.x + f.w || r.x + r.w <= f.x || r.y >= f.y + f.h || r.y + r.h <= f.y) {
        next.push(f);
        continue;
      }
      if (r.x > f.x) next.push({ x: f.x, y: f.y, w: r.x - f.x, h: f.h });
      if (r.x + r.w < f.x + f.w) next.push({ x: r.x + r.w, y: f.y, w: f.x + f.w - (r.x + r.w), h: f.h });
      if (r.y > f.y) next.push({ x: f.x, y: f.y, w: f.w, h: r.y - f.y });
      if (r.y + r.h < f.y + f.h) next.push({ x: f.x, y: r.y + r.h, w: f.w, h: f.y + f.h - (r.y + r.h) });
    }
    // 去掉被其他空闲矩形包含的（相同的只留第一个）
    const pruned: Rect[] = [];
    for (let i = 0; i < next.length; i++) {
      const a = next[i]!;
      let contained = false;
      for (let j = 0; j < next.length && !contained; j++) {
        if (i === j) continue;
        const b = next[j]!;
        const inside = a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
        const same = a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
        if (inside && (!same || j < i)) contained = true;
      }
      if (!contained) pruned.push(a);
    }
    this.free = pruned;
    this.used.push(r);
  }
}

interface Trial {
  placed: { item: PackItem; x: number; y: number }[];
  rest: PackItem[];
}

function tryPack(items: readonly PackItem[], W: number, H: number, pad: number, greedy: boolean): Trial | null {
  const bin = new MaxRectsBin(W + pad, H + pad);
  const placed: Trial['placed'] = [];
  const rest: PackItem[] = [];
  for (const it of items) {
    const r = bin.find(it.w + pad, it.h + pad);
    if (!r) {
      if (!greedy) return null;
      rest.push(it);
      continue;
    }
    bin.place(r);
    placed.push({ item: it, x: r.x, y: r.y });
  }
  return { placed, rest };
}

export function packRects(items: readonly PackItem[], opts: PackOptions = {}): PackResult {
  const maxW = opts.maxWidth ?? 2048;
  const maxH = opts.maxHeight ?? 2048;
  const pad = opts.padding ?? 1;
  const step = opts.step ?? 32;
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.key)) throw new GfxError('E_PACK_DUP', `重复的 key：${it.key}`);
    seen.add(it.key);
    if (!Number.isInteger(it.w) || !Number.isInteger(it.h) || it.w < 0 || it.h < 0) {
      throw new GfxError('E_PACK_SIZE', `${it.key}: 非法尺寸 ${it.w}×${it.h}`);
    }
    if (it.w > maxW || it.h > maxH) {
      throw new GfxError('E_PACK_TOO_LARGE', `${it.key}: ${it.w}×${it.h} 超过页面上限 ${maxW}×${maxH}`);
    }
  }
  const sorted = sortPackItems(items);
  const empty = sorted.filter((it) => it.w === 0 || it.h === 0);
  let rest = sorted.filter((it) => it.w > 0 && it.h > 0);

  const sides = (max: number): number[] => {
    const out: number[] = [];
    for (let s = step; s < max; s += step) out.push(s);
    out.push(max);
    return out;
  };
  const widths = sides(maxW);
  const heights = sides(maxH);

  const pages: PackPage[] = [];
  while (rest.length > 0) {
    const area = rest.reduce((s, it) => s + (it.w + pad) * (it.h + pad), 0);
    const needW = Math.max(...rest.map((it) => it.w));
    const needH = Math.max(...rest.map((it) => it.h));
    const cands: [number, number][] = [];
    for (const W of widths) {
      if (W < needW) continue;
      for (const H of heights) {
        if (H < needH || (W + pad) * (H + pad) < area) continue;
        cands.push([W, H]);
      }
    }
    cands.sort((a, b) => a[0] * a[1] - b[0] * b[1] || Math.max(...a) - Math.max(...b) || a[0] - b[0]);
    let trial: Trial | null = null;
    for (const [W, H] of cands) {
      trial = tryPack(rest, W, H, pad, false);
      if (trial) break;
    }
    if (!trial) trial = tryPack(rest, maxW, maxH, pad, true)!;
    if (trial.placed.length === 0) throw new GfxError('E_PACK_STUCK', '无法放入任何矩形');
    const index = pages.length;
    const placements = trial.placed.map(
      ({ item, x, y }): PackPlacement => ({ key: item.key, page: index, x, y, w: item.w, h: item.h }),
    );
    const w = Math.max(...placements.map((p) => p.x + p.w));
    const h = Math.max(...placements.map((p) => p.y + p.h));
    pages.push({ index, w, h, items: placements.sort((a, b) => byCodepoint(a.key, b.key)) });
    rest = trial.rest;
  }
  if (empty.length > 0) {
    if (pages.length === 0) pages.push({ index: 0, w: 1, h: 1, items: [] });
    const p0 = pages[0]!;
    for (const it of empty) p0.items.push({ key: it.key, page: 0, x: 0, y: 0, w: it.w, h: it.h });
    p0.items.sort((a, b) => byCodepoint(a.key, b.key));
  }
  const placements = pages.flatMap((p) => p.items).sort((a, b) => byCodepoint(a.key, b.key));
  return { pages, placements };
}

/** 把 src 整张拷贝到 dst 的 (x, y)（RGBA，越界报错） */
export function blitRgba(dst: RgbaImage, src: RgbaImage, x: number, y: number): void {
  if (x < 0 || y < 0 || x + src.w > dst.w || y + src.h > dst.h) {
    throw new GfxError('E_PACK_BLIT', `${src.w}×${src.h} 放到 (${x},${y}) 越出 ${dst.w}×${dst.h}`);
  }
  for (let r = 0; r < src.h; r++) {
    dst.rgba.set(src.rgba.subarray(r * src.w * 4, (r + 1) * src.w * 4), ((y + r) * dst.w + x) * 4);
  }
}

/** 按装箱结果合成各页 RGBA（未覆盖处为透明） */
export function composePages(result: PackResult, images: ReadonlyMap<string, RgbaImage>): RgbaImage[] {
  return result.pages.map((page) => {
    const out: RgbaImage = { w: page.w, h: page.h, rgba: new Uint8Array(page.w * page.h * 4) };
    for (const p of page.items) {
      if (p.w === 0 || p.h === 0) continue;
      const img = images.get(p.key);
      if (!img || img.w !== p.w || img.h !== p.h) {
        throw new GfxError('E_PACK_IMAGE', `${p.key}: 缺少图像或尺寸与装箱结果不符`);
      }
      blitRgba(out, img, p.x, p.y);
    }
    return out;
  });
}
