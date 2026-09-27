/**
 * 合成素材包的经典外壳 UI 条目（original-skin.md §5 A10；审查修正：E2E 此前只走 CSS 回退画法）。
 *
 * 目的：CI 没有原版文件，也要能走一遍经典外壳的「原版 UI 精灵」路径——工具列、资料栏、日历页与太阳 / 月亮钮、GO 钮
 * （含命中掩膜）、骰子数小图、骰子定格面、共享 UI（消息框、小地图旋转钮）、72×72 头像、滚骰 FLC。
 * 内容全部是我们自己画的色块、边框与点阵，**不含任何原版字节或像素**；逻辑键、分组、帧数与原版包相同，
 * 帧尺寸与锚点取客户端布局依赖的那几项（GO 72×67、骰子数小图 15×15、日历页 200×200 与钮 24×23 / 20×20、
 * 旋转钮 25×26、消息框 195×133、头像 72×72），其余按我们自己的取值。
 *
 * GO 钮掩膜的区号语义与原版一致（客户端按它判定命中）：1 = 左侧骰子数竖槽（钮内 x7..22、y9..56）、2 = 边框、
 * 3 = 钮面、4 = 钮外的透明四角；月历页（图4–7）与原版一样在 (10,9) / (42,11) 画上太阳（图9）与月亮（图10）。
 */
import type { AssetEntry } from '@rich4/shared/assets';
import { FLC_CHUNK, FLC_FRAME_TYPE, FLC_HEADER_BYTES, FLC_MAGIC } from '../gfx/flc';
import type { PngOptions } from '../gfx/png';
import type { Catalog, FlicItem, MaskItem, SpriteItem } from './catalog.v206';
import { type AnchoredRgba, buildAtlasPages, maskPng } from './images';
import type { PackWriter } from './manifest';

type Rgba = readonly [number, number, number, number];

/** 简单的 RGBA 画布（整数坐标，越界忽略） */
class Canvas {
  readonly rgba: Uint8Array;

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.rgba = new Uint8Array(w * h * 4);
  }

  set(x: number, y: number, c: Rgba): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 4;
    this.rgba[o] = c[0];
    this.rgba[o + 1] = c[1];
    this.rgba[o + 2] = c[2];
    this.rgba[o + 3] = c[3];
  }

  rect(x: number, y: number, w: number, h: number, c: Rgba): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, c);
  }

  frame(x: number, y: number, w: number, h: number, c: Rgba, t = 1): void {
    this.rect(x, y, w, t, c);
    this.rect(x, y + h - t, w, t, c);
    this.rect(x, y, t, h, c);
    this.rect(x + w - t, y, t, h, c);
  }

  disc(cx: number, cy: number, r: number, c: Rgba): void {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) this.set(x, y, c);
      }
    }
  }

  /** n 个小方点排成一行（识别帧号用） */
  dots(x: number, y: number, n: number, c: Rgba, size = 2): void {
    for (let i = 0; i < n; i++) this.rect(x + i * (size + 1), y, size, size, c);
  }

  /** 在 (x, y) 贴另一张画布（透明像素跳过） */
  blit(src: Canvas, x: number, y: number): void {
    for (let yy = 0; yy < src.h; yy++) {
      for (let xx = 0; xx < src.w; xx++) {
        const o = (yy * src.w + xx) * 4;
        if (src.rgba[o + 3] === 0) continue;
        this.set(x + xx, y + yy, [src.rgba[o]!, src.rgba[o + 1]!, src.rgba[o + 2]!, src.rgba[o + 3]!]);
      }
    }
  }
}

const INK: Rgba = [24, 16, 8, 255];
const WHITE: Rgba = [245, 245, 245, 255];
const RED: Rgba = [210, 30, 30, 255];
const GRAY: Rgba = [150, 150, 150, 255];
const GRAY_LIGHT: Rgba = [200, 200, 200, 255];

const HUES: readonly Rgba[] = [
  [220, 60, 60, 255],
  [230, 140, 40, 255],
  [220, 200, 40, 255],
  [120, 200, 60, 255],
  [40, 170, 90, 255],
  [40, 180, 180, 255],
  [50, 130, 220, 255],
  [90, 80, 210, 255],
  [160, 70, 200, 255],
  [210, 70, 160, 255],
  [150, 110, 70, 255],
  [120, 120, 130, 255],
];

const hue = (i: number): Rgba => HUES[((i % HUES.length) + HUES.length) % HUES.length]!;
const lighter = (c: Rgba, k = 0.45): Rgba => [
  Math.round(c[0] + (255 - c[0]) * k),
  Math.round(c[1] + (255 - c[1]) * k),
  Math.round(c[2] + (255 - c[2]) * k),
  c[3],
];

interface UiFrame extends AnchoredRgba {}

function frameOf(c: Canvas, ax = 0, ay = 0): UiFrame {
  return { w: c.w, h: c.h, rgba: c.rgba, ax, ay };
}

// ───────────────────────── GO 钮与掩膜 ─────────────────────────

export const GO_W = 72;
export const GO_H = 67;
/** 区号：1 骰子数竖槽、2 边框、3 钮面、4 钮外（与原版掩膜的语义一致） */
export const GO_REGION = { slot: 1, rim: 2, face: 3, outside: 4 } as const;
/** 骰子数竖槽（钮内坐标，含端点）：客户端 layout.ts 的 DICE_COUNT_RECT 按它摆放 */
export const GO_SLOT = { x0: 7, y0: 9, x1: 22, y1: 56 } as const;

function inRoundRect(x: number, y: number, x0: number, y0: number, x1: number, y1: number, r: number): boolean {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** GO 钮的区域图（72×67，每像素 1–4） */
export function synthGoMask(): Uint8Array {
  const out = new Uint8Array(GO_W * GO_H);
  for (let y = 0; y < GO_H; y++) {
    for (let x = 0; x < GO_W; x++) {
      let r: number = GO_REGION.outside;
      if (inRoundRect(x, y, 2, 1, 70, 65, 12)) r = GO_REGION.rim;
      if (inRoundRect(x, y, 28, 12, 64, 54, 8)) r = GO_REGION.face;
      if (x >= GO_SLOT.x0 && x <= GO_SLOT.x1 && y >= GO_SLOT.y0 && y <= GO_SLOT.y1) r = GO_REGION.slot;
      out[y * GO_W + x] = r;
    }
  }
  return out;
}

function goFrame(i: number, mask: Uint8Array): UiFrame {
  // 0 常态 / 1 悬停 / 2 禁止 / 3 禁止悬停 / 4–5 乌龟
  const faces: readonly Rgba[] = [
    [220, 205, 255, 255],
    [255, 236, 120, 255],
    [150, 150, 160, 255],
    [180, 180, 190, 255],
    [110, 200, 110, 255],
    [150, 230, 150, 255],
  ];
  const c = new Canvas(GO_W, GO_H);
  for (let y = 0; y < GO_H; y++) {
    for (let x = 0; x < GO_W; x++) {
      const r = mask[y * GO_W + x];
      if (r === GO_REGION.rim) c.set(x, y, [90, 45, 145, 255]);
      else if (r === GO_REGION.face) c.set(x, y, faces[i]!);
      else if (r === GO_REGION.slot) c.set(x, y, [43, 21, 82, 255]);
    }
  }
  // 「GO」两个方块字（自绘）+ 帧号点
  c.frame(34, 22, 12, 22, INK, 3);
  c.rect(40, 33, 6, 3, INK);
  c.frame(50, 22, 12, 22, INK, 3);
  c.dots(30, 57, i + 1, WHITE);
  return frameOf(c);
}

/** 骰子数小图：图6–11 两两成对（1/2/3 点），每对先灰（不能切换）后白底红点（可切换） */
function diceCountFrame(i: number): UiFrame {
  const n = 1 + Math.floor(i / 2);
  const active = i % 2 === 1;
  const c = new Canvas(15, 15);
  c.rect(0, 0, 15, 15, active ? WHITE : GRAY_LIGHT);
  c.frame(0, 0, 15, 15, INK);
  const pip = active ? RED : GRAY;
  const spots: readonly (readonly [number, number])[][] = [
    [[6, 6]],
    [
      [3, 3],
      [9, 9],
    ],
    [
      [2, 2],
      [6, 6],
      [10, 10],
    ],
  ];
  for (const [x, y] of spots[n - 1]!) c.rect(x, y, 3, 3, pip);
  return frameOf(c);
}

// ───────────────────────── 各条目的帧 ─────────────────────────

function toolbarFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  const bar = new Canvas(439, 40);
  bar.rect(0, 0, 439, 40, [232, 200, 120, 255]);
  bar.rect(0, 37, 439, 3, [138, 99, 38, 255]);
  for (let i = 1; i < 11; i++) bar.rect(i * 40, 4, 1, 32, [170, 130, 60, 255]);
  out.push(frameOf(bar));
  for (let f = 1; f < count; f++) {
    const hover = f >= 12;
    const i = hover ? f - 12 : f - 1;
    const s = hover ? 36 : 32;
    const c = new Canvas(s, s);
    c.rect(0, 0, s, s, hover ? lighter(hue(i)) : hue(i));
    c.frame(0, 0, s, s, hover ? [255, 230, 60, 255] : INK, 2);
    c.dots(4, 4, i + 1, WHITE);
    out.push(frameOf(c, s >> 1, s >> 1));
  }
  return out;
}

function sidebarFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    const h = f === 4 ? 80 : 280;
    const c = new Canvas(200, h);
    c.rect(0, 0, 200, h, [240, 220, 160, 255]);
    c.frame(0, 0, 200, h, [122, 85, 32, 255], 2);
    if (f <= 3 && h === 280) {
      for (let t = 0; t < 4; t++) c.rect(176, t * 70, 24, 70, t === f ? hue(t) : lighter(hue(t), 0.6));
      for (let r = 0; r < 5; r++) c.rect(8, 100 + r * 36, 162, 34, [201, 219, 212, 255]);
    }
    c.dots(8, h - 8, f + 1, INK);
    out.push(frameOf(c));
  }
  return out;
}

/** 太阳（bright = 图8 选中 / 图9 未选中）24×23，锚点 (12,11) */
function sunCanvas(bright: boolean): Canvas {
  const c = new Canvas(24, 23);
  c.disc(11.5, 11, 10.5, bright ? [240, 60, 30, 255] : [150, 60, 20, 255]);
  c.disc(11.5, 11, 5, bright ? [255, 220, 90, 255] : [190, 150, 60, 255]);
  return c;
}

/** 月亮（bright = 图10 选中 / 图11 未选中）20×20，锚点 (10,10) */
function moonCanvas(bright: boolean): Canvas {
  const c = new Canvas(20, 20);
  const col: Rgba = bright ? [245, 205, 60, 255] : [120, 110, 80, 255];
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      const inBig = (x - 9.5) ** 2 + (y - 9.5) ** 2 <= 9.5 ** 2;
      const inCut = (x - 5) ** 2 + (y - 6) ** 2 <= 7 ** 2;
      if (inBig && !inCut) c.set(x, y, col);
    }
  }
  return c;
}

/** 月历页的星期圆圈列中心（与客户端 MONTH_GRID 一致：30.5 + 22.67·列） */
const WEEK_COLS = [0, 1, 2, 3, 4, 5, 6].map((i) => Math.round(30.5 + (136 / 6) * i));

function calendarFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  const seasons: readonly [Rgba, Rgba][] = [
    [
      [90, 167, 232, 255],
      [143, 212, 107, 255],
    ],
    [
      [79, 179, 240, 255],
      [242, 223, 176, 255],
    ],
    [
      [62, 120, 184, 255],
      [184, 86, 45, 255],
    ],
    [
      [201, 212, 234, 255],
      [244, 246, 251, 255],
    ],
  ];
  for (let f = 0; f < Math.min(8, count); f++) {
    const [sky, ground] = seasons[f % 4]!;
    const c = new Canvas(200, 200);
    const month = f >= 4;
    c.rect(0, 0, 200, 110, month ? lighter(sky, 0.7) : sky);
    c.rect(0, 110, 200, 90, month ? lighter(ground, 0.7) : ground);
    if (month) {
      // 与原版一样把「月历模式」的太阳（未选中）与月亮（选中）画进页图
      c.blit(sunCanvas(false), 10, 9);
      c.blit(moonCanvas(true), 42, 11);
      for (const x of WEEK_COLS) c.disc(x, 79.5, 6.5, [20, 20, 20, 255]);
    }
    c.dots(186, 190, (f % 4) + 1, INK);
    out.push(frameOf(c));
  }
  if (count > 8) out.push(frameOf(sunCanvas(true), 12, 11));
  if (count > 9) out.push(frameOf(sunCanvas(false), 12, 11));
  if (count > 10) out.push(frameOf(moonCanvas(true), 10, 10));
  if (count > 11) out.push(frameOf(moonCanvas(false), 10, 10));
  return out;
}

function goButtonFrames(count: number): UiFrame[] {
  const mask = synthGoMask();
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) out.push(f < 6 ? goFrame(f, mask) : diceCountFrame(f - 6));
  return out;
}

function diceFaceFrames(count: number): UiFrame[] {
  const sizes: readonly [number, number][] = [
    [35, 41],
    [30, 36],
    [34, 40],
  ];
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    const [w, h] = sizes[Math.floor(f / 6) % 3]!;
    const face = (f % 6) + 1;
    const c = new Canvas(w, h);
    c.rect(1, 1, w - 2, h - 2, WHITE);
    c.frame(0, 0, w, h, INK, 2);
    c.dots(5, 5, face, face === 1 || face === 4 ? RED : INK, 4);
    out.push(frameOf(c));
  }
  return out;
}

function commonFrames(count: number): UiFrame[] {
  // 客户端用到：图5 消息框 195×133、图18–21 小地图旋转钮 25×26（左常态 / 右常态 / 左悬停 / 右悬停）
  const size = (f: number): [number, number] => {
    if (f <= 3) return [139, 116];
    if (f === 4) return [355, 83];
    if (f === 5) return [195, 133];
    if (f === 6) return [210, 154];
    if (f === 7) return [400, 89];
    if (f <= 17) return [35, 43];
    if (f <= 21) return [25, 26];
    const d = [3, 5, 7, 11, 9, 11, 17, 23][f - 22] ?? 5;
    return [d, d];
  };
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    const [w, h] = size(f);
    const c = new Canvas(w, h);
    if (f === 5) {
      c.rect(0, 0, w, h, [74, 34, 8, 255]);
      c.frame(0, 0, w, h, [201, 139, 43, 255], 3);
    } else if (f >= 18 && f <= 21) {
      const left = f % 2 === 0;
      c.rect(0, 0, w, h, f >= 20 ? [140, 190, 255, 255] : [47, 95, 208, 255]);
      c.frame(0, 0, w, h, INK);
      for (let k = 0; k < 7; k++) c.rect(left ? 8 + k : 16 - k, 12 - k, 1, 2 * k + 2, WHITE);
    } else if (f >= 22) {
      c.disc((w - 1) / 2, (h - 1) / 2, w / 2, hue(f));
    } else {
      c.rect(0, 0, w, h, lighter(hue(f), 0.6));
      c.frame(0, 0, w, h, INK);
      c.dots(3, 3, (f % 10) + 1, INK);
    }
    out.push(frameOf(c, f >= 22 ? w >> 1 : 0, f >= 22 ? h >> 1 : 0));
  }
  return out;
}

function portraitFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    const c = new Canvas(72, 72);
    c.rect(0, 0, 72, 72, [255, 244, 212, 255]);
    c.frame(0, 0, 72, 72, hue(f), 3);
    c.disc(35.5, 32, 20, lighter(hue(f), 0.3));
    c.rect(26, 28, 5, 5, INK);
    c.rect(41, 28, 5, 5, INK);
    c.dots(6, 62, f + 1, INK, 3);
    out.push(frameOf(c));
  }
  return out;
}

const UI_FRAMES: Readonly<Record<string, (count: number) => UiFrame[]>> = {
  'ui.toolbar': toolbarFrames,
  'ui.sidebar': sidebarFrames,
  'ui.calendar': calendarFrames,
  'ui.goButton': goButtonFrames,
  'ui.diceFaces': diceFaceFrames,
  'ui.common': commonFrames,
  'portrait.face72': portraitFrames,
};

/** 合成包里的经典外壳 UI 精灵键 */
export const SYNTH_UI_SPRITES = Object.keys(UI_FRAMES);
export const SYNTH_UI_MASK = 'ui.goButton.mask';
export const SYNTH_UI_FLICS = ['ui.dice.roll1', 'ui.dice.roll2', 'ui.dice.roll3'] as const;

// ───────────────────────── 滚骰 FLC ─────────────────────────

/** BYTE_RUN 一行：相同字节成段复制（≤127），其余成段原样（≤127） */
function byteRunLine(row: Uint8Array, out: number[]): void {
  out.push(0); // 包计数（解码器按宽度读，不看这个字节）
  let x = 0;
  while (x < row.length) {
    let run = 1;
    while (x + run < row.length && run < 127 && row[x + run] === row[x]) run++;
    if (run >= 3) {
      out.push(run, row[x]!);
      x += run;
      continue;
    }
    let lit = 0;
    while (x + lit < row.length && lit < 127) {
      const v = row[x + lit];
      if (x + lit + 2 < row.length && row[x + lit + 1] === v && row[x + lit + 2] === v) break;
      lit++;
    }
    out.push(256 - lit);
    for (let i = 0; i < lit; i++) out.push(row[x + i]!);
    x += lit;
  }
}

function u16(out: number[], v: number): void {
  out.push(v & 0xff, (v >>> 8) & 0xff);
}

function u32(out: number[], v: number): void {
  u16(out, v & 0xffff);
  u16(out, (v >>> 16) & 0xffff);
}

function setU32(buf: number[], at: number, v: number): void {
  buf[at] = v & 0xff;
  buf[at + 1] = (v >>> 8) & 0xff;
  buf[at + 2] = (v >>> 16) & 0xff;
  buf[at + 3] = (v >>> 24) & 0xff;
}

/** 自写的 8 位 FLC（0xAF12）：首帧带 COLOR_256，每帧一个 BYTE_RUN 整帧块；不写 ring 帧 */
export function encodeFlc(
  w: number,
  h: number,
  speedMs: number,
  frames: Uint8Array[],
  palette: Uint8Array,
): Uint8Array {
  const out: number[] = new Array<number>(FLC_HEADER_BYTES).fill(0);
  for (let f = 0; f < frames.length; f++) {
    const start = out.length;
    u32(out, 0);
    u16(out, FLC_FRAME_TYPE);
    u16(out, f === 0 ? 2 : 1);
    u16(out, 0);
    u16(out, 0);
    u16(out, 0);
    u16(out, 0);
    if (f === 0) {
      const cs = out.length;
      u32(out, 0);
      u16(out, FLC_CHUNK.COLOR_256);
      u16(out, 1);
      out.push(0, 0);
      for (let i = 0; i < 768; i++) out.push(palette[i] ?? 0);
      setU32(out, cs, out.length - cs);
    }
    const bs = out.length;
    u32(out, 0);
    u16(out, FLC_CHUNK.BYTE_RUN);
    const px = frames[f]!;
    for (let y = 0; y < h; y++) byteRunLine(px.subarray(y * w, y * w + w), out);
    if ((out.length - bs) % 2 === 1) out.push(0);
    setU32(out, bs, out.length - bs);
    setU32(out, start, out.length - start);
  }
  const head: number[] = [];
  u32(head, 0);
  u16(head, FLC_MAGIC);
  u16(head, frames.length);
  u16(head, w);
  u16(head, h);
  u16(head, 8);
  u16(head, 0);
  u32(head, speedMs);
  for (let i = 0; i < head.length; i++) out[i] = head[i]!;
  setU32(out, 0, out.length);
  return Uint8Array.from(out);
}

/** 滚骰：n 颗白骰子在画面里转圈（索引 0 透明、1 描边、2 白、3 红点） */
function diceRollFlc(n: number, w: number, h: number, frames: number, frameMs: number): Uint8Array {
  const palette = new Uint8Array(768);
  palette.set([24, 16, 8], 3);
  palette.set([245, 245, 245], 6);
  palette.set([210, 30, 30], 9);
  const out: Uint8Array[] = [];
  const s = 36;
  for (let f = 0; f < frames; f++) {
    const px = new Uint8Array(w * h);
    for (let k = 0; k < n; k++) {
      const a = (f / frames) * Math.PI * 2 + (k * Math.PI * 2) / n;
      const cx = Math.round(w / 2 + Math.cos(a) * 40);
      const cy = Math.round(h / 2 + Math.sin(a) * 60);
      const x0 = cx - s / 2;
      const y0 = cy - s / 2;
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const edge = x < 2 || y < 2 || x >= s - 2 || y >= s - 2;
          const X = x0 + x;
          const Y = y0 + y;
          if (X >= 0 && Y >= 0 && X < w && Y < h) px[Y * w + X] = edge ? 1 : 2;
        }
      }
      const pips = ((f + k) % 6) + 1;
      for (let p = 0; p < pips; p++) {
        const X = x0 + 6 + (p % 3) * 9;
        const Y = y0 + 8 + Math.floor(p / 3) * 12;
        for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) px[(Y + y) * w + X + x] = 3;
      }
    }
    out.push(px);
  }
  return encodeFlc(w, h, frameMs, out, palette);
}

// ───────────────────────── 写入 ─────────────────────────

/** 把经典外壳的 UI 条目写进合成包（键、分组、置信度按资源目录） */
export async function addSyntheticUi(writer: PackWriter, cat: Catalog, png: PngOptions): Promise<void> {
  const byKey = new Map(cat.items.map((it) => [it.key, it]));
  for (const key of SYNTH_UI_SPRITES) {
    const it = byKey.get(key);
    if (it?.type !== 'sprite' || typeof it.frames !== 'number') throw new Error(`资源目录缺少 UI 精灵 ${key}`);
    const item = it as SpriteItem & { frames: number };
    const frames = UI_FRAMES[key]!(item.frames);
    const base = `S#${key}`;
    const pages = buildAtlasPages({
      dir: 'sprites/synthetic-ui',
      name: key,
      base,
      set: { kind: 'rgba', frames },
      transparency: item.transparency,
      src: ['synthetic'],
      png,
    });
    for (const p of pages) {
      await writer.writeFile(p.imagePath, p.imageBytes, 'image', item.group);
      await writer.writeFile(p.jsonPath, p.jsonBytes, 'atlas', item.group);
    }
    const entry: AssetEntry = {
      type: 'sprite',
      group: item.group,
      confidence: item.confidence,
      src: ['synthetic'],
      atlas: pages.map((p) => p.jsonPath),
      frames: { base, start: 0, count: frames.length },
      dirs: 1,
      frameMs: null,
      transparency: item.transparency,
      ownerMask: false,
      anchor: item.anchor,
    };
    writer.addEntry(key, entry);
  }

  const mk = byKey.get(SYNTH_UI_MASK);
  if (mk?.type !== 'mask') throw new Error(`资源目录缺少 ${SYNTH_UI_MASK}`);
  const maskItem = mk as MaskItem;
  const m = maskPng(synthGoMask(), { w: GO_W, h: GO_H }, png);
  const maskFile = `masks/synthetic-ui/${SYNTH_UI_MASK}.png`;
  await writer.writeFile(maskFile, m.bytes, 'mask', maskItem.group);
  writer.addEntry(SYNTH_UI_MASK, {
    type: 'mask',
    group: maskItem.group,
    confidence: maskItem.confidence,
    src: ['synthetic'],
    file: maskFile,
    w: GO_W,
    h: GO_H,
    regions: m.maxRegion,
  });

  for (const [i, key] of SYNTH_UI_FLICS.entries()) {
    const it = byKey.get(key);
    if (it?.type !== 'flic') throw new Error(`资源目录缺少 ${key}`);
    const d = (it as FlicItem).def;
    const file = `flic/synthetic-ui/${key}.flc`;
    await writer.writeFile(file, diceRollFlc(i + 1, d.w, d.h, d.frames, d.frameMs), 'flic', it.group);
    writer.addEntry(key, {
      type: 'flic',
      group: it.group,
      confidence: it.confidence,
      src: ['synthetic'],
      file,
      w: d.w,
      h: d.h,
      frames: d.frames,
      frameMs: d.frameMs,
      durationMs: d.frames * d.frameMs,
      transparency: d.opaque ? 'opaque' : 'index0',
      sfx: null,
    });
  }
}
