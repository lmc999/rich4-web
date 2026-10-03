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
 *
 * 原版场景的公共组件（ui/classic/common）另需：YES/NO（ui.yesno 3 帧 96×48）、计算器（ui.numpad 26 帧：本体 128×192、
 * 计量条亮格 108×12、MAX 49×25、↵ 57×25、键帽 12×33×17、LCD 数字 10×9×19）与它的命中掩膜（ui.numpad.mask 128×192，
 * 区号布局同原版：1 本体、2 MAX、3 ↵、4 C、5 0、6 ←、7–15 = 789/456/123、16 计量条）、12 套讲话头像（portrait.speaker.<c>
 * 7 帧：大头 72×72、4 个表情 34×34、小头 24×24、地图点 10×9，锚点居中）；共享 UI（ui.common）的讲话框、消息框、云形气泡、
 * 绿色数字的锚点与原版相同（讲话框锚点在尾巴尖所在的角，消息框 (97,81)，云形气泡 (98,69)）。
 */
import type { AssetEntry } from '@rich4/shared/assets';
import { FLC_CHUNK, FLC_FRAME_TYPE, FLC_HEADER_BYTES, FLC_MAGIC } from '../gfx/flc';
import type { PngOptions } from '../gfx/png';
import { encodePngRgba } from '../gfx/png';
import {
  type Catalog,
  type FlicItem,
  holidayArtKey,
  type ImageItem,
  type MaskItem,
  type SpriteItem,
} from './catalog.v206';
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

/**
 * 点数面（Panel#3 同结构：3 套角度 × 6 面）。锚点与原版包同语义：客户端在骰子 FLC 左上 +(0x55,0x91) 画第 i 颗
 * （exe 0x418de8–0x418e1c），三套锚点把它们分别摆到 FLC 底部的左、中、右（框内约 (1,243)、(96,248)、(153,244)）
 */
function diceFaceFrames(count: number): UiFrame[] {
  const sets: readonly { w: number; h: number; ax: number; ay: number }[] = [
    { w: 35, h: 41, ax: 84, ay: -98 },
    { w: 30, h: 36, ax: -11, ay: -103 },
    { w: 34, h: 40, ax: -68, ay: -99 },
  ];
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    const { w, h, ax, ay } = sets[Math.floor(f / 6) % 3]!;
    const face = (f % 6) + 1;
    const c = new Canvas(w, h);
    c.rect(1, 1, w - 2, h - 2, WHITE);
    c.frame(0, 0, w, h, INK, 2);
    c.dots(5, 5, face, face === 1 || face === 4 ? RED : INK, 4);
    out.push(frameOf(c, ax, ay));
  }
  return out;
}

/** 共享 UI 各帧的锚点（与原版包相同：讲话框在尾巴尖的角、消息框 / 气泡近中心、绿色数字近中心、标记点居中） */
function commonAnchor(f: number, w: number, h: number): [number, number] {
  if (f === 1) return [0, h];
  if (f === 2) return [w, 0];
  if (f === 3) return [w, h];
  if (f === 5) return [97, 81];
  if (f === 6) return [98, 69];
  if (f >= 8 && f <= 17) return [Math.round(w * 0.46), Math.round(h * 0.44)];
  if (f >= 22) return [w >> 1, h >> 1];
  return [0, 0];
}

/** 讲话框（图0–3）：蓝底方框，尾巴伸向锚点所在的角 */
function speechBox(f: number, w: number, h: number): Canvas {
  const c = new Canvas(w, h);
  const blue: Rgba = [30, 90, 170, 255];
  c.rect(14, 14, w - 28, h - 28, blue);
  c.frame(14, 14, w - 28, h - 28, [240, 150, 40, 255], 3);
  c.frame(17, 17, w - 34, h - 34, WHITE);
  const right = f === 2 || f === 3;
  const bottom = f === 1 || f === 3;
  for (let k = 0; k < 16; k++) {
    const x = right ? w - 1 - k : k;
    const y = bottom ? h - 1 - k : k;
    c.rect(right ? x - 1 : x, bottom ? y - 1 : y, 2, 2, [240, 150, 40, 255]);
  }
  return c;
}

/** 宝石消息框（图5）：顶部 38px 的饰带（中间一颗「宝石」），棕底金边 */
function messageBox(w: number, h: number): Canvas {
  const c = new Canvas(w, h);
  c.rect(4, 20, w - 8, h - 24, [110, 50, 12, 255]);
  c.frame(4, 20, w - 8, h - 24, [201, 139, 43, 255], 4);
  c.rect(4, 20, w - 8, 14, [150, 100, 30, 255]);
  for (let i = 0; i < 7; i++) c.disc(20 + i * 26, 27, 4, hue(i));
  c.disc(97, 12, 10, [230, 190, 40, 255]);
  c.disc(97, 12, 5, [200, 40, 40, 255]);
  return c;
}

/** 云形气泡（图6）：白底红边的圆团 */
function cloudBubble(w: number, h: number): Canvas {
  const c = new Canvas(w, h);
  const red: Rgba = [230, 60, 40, 255];
  const paper: Rgba = [255, 250, 238, 255];
  const blobs: readonly [number, number, number][] = [
    [60, 55, 40],
    [110, 45, 45],
    [155, 60, 40],
    [80, 95, 38],
    [135, 95, 40],
  ];
  for (const [x, y, r] of blobs) c.disc(x, y, r + 4, red);
  for (const [x, y, r] of blobs) c.disc(x, y, r, paper);
  // 尾巴朝左下（指向讲话头像）
  for (let k = 0; k < 14; k++) c.rect(40 - k * 2, 120 + k, 6, 2, red);
  return c;
}

function commonFrames(count: number): UiFrame[] {
  // 客户端用到：图0–3 讲话框 139×116、图5 消息框 195×133、图6 云形气泡 210×154、图18–21 小地图旋转钮 25×26
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
    let c = new Canvas(w, h);
    if (f <= 3) c = speechBox(f, w, h);
    else if (f === 5) c = messageBox(w, h);
    else if (f === 6) c = cloudBubble(w, h);
    else if (f >= 18 && f <= 21) {
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
    const [ax, ay] = commonAnchor(f, w, h);
    out.push(frameOf(c, ax, ay));
  }
  return out;
}

// ───────────────────────── YES/NO、计算器、讲话头像（原版场景的公共组件） ─────────────────────────

/** YES/NO（Data#399）：3 帧 96×48——常态 / YES 亮 / NO 亮；左半粉红（YES）、右半青绿（NO）、中间书脊 */
function yesNoFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    const c = new Canvas(96, 48);
    const yes: Rgba = f === 1 ? [255, 150, 190, 255] : [200, 90, 130, 255];
    const no: Rgba = f === 2 ? [90, 230, 200, 255] : [30, 140, 120, 255];
    c.rect(0, 0, 48, 48, yes);
    c.rect(48, 0, 48, 48, no);
    c.frame(0, 0, 96, 48, INK);
    c.rect(46, 0, 4, 48, [230, 190, 60, 255]);
    // 「Y」「N」的自绘点阵（非原版字形）
    c.rect(14, 14, 3, 8, WHITE);
    c.rect(26, 14, 3, 8, WHITE);
    c.rect(17, 22, 9, 3, WHITE);
    c.rect(20, 25, 3, 10, WHITE);
    c.rect(64, 14, 3, 21, WHITE);
    c.rect(78, 14, 3, 21, WHITE);
    for (let k = 0; k < 7; k++) c.rect(67 + k * 2, 16 + k * 3, 2, 3, WHITE);
    c.dots(4, 42, f + 1, INK);
    out.push(frameOf(c));
  }
  return out;
}

/** 计算器区号（与原版 Panel#22 相同的区位） */
export const NUMPAD_REGION = { body: 1, max: 2, enter: 3, keys0: 4, meter: 16 } as const;
const NUMPAD_COLS = [8, 48, 88] as const;
const NUMPAD_ROWS = [
  [96, 16],
  [121, 15],
  [144, 16],
  [168, 16],
] as const;

/** 计算器命中掩膜（128×192，区号 1–16；键区矩形与原版逐像素统计的包围盒一致） */
export function synthNumpadMask(): Uint8Array {
  const w = 128;
  const out = new Uint8Array(w * 192).fill(NUMPAD_REGION.body);
  const fill = (x: number, y: number, rw: number, rh: number, v: number): void => {
    for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) out[yy * w + xx] = v;
  };
  fill(8, 64, 47, 24, NUMPAD_REGION.max);
  fill(64, 64, 56, 24, NUMPAD_REGION.enter);
  for (let i = 0; i < 12; i++) {
    const [y, h] = NUMPAD_ROWS[Math.floor(i / 3)]!;
    fill(NUMPAD_COLS[i % 3]!, y, 32, h, NUMPAD_REGION.keys0 + i);
  }
  fill(9, 41, 110, 14, NUMPAD_REGION.meter);
  return out;
}

/** 7 段 LCD 数字（9×19）：a 上、b 右上、c 右下、d 下、e 左下、f 左上、g 中 */
const SEGMENTS: readonly string[] = [
  'abcdef',
  'bc',
  'abged',
  'abgcd',
  'fgbc',
  'afgcd',
  'afgedc',
  'abc',
  'abcdefg',
  'abcdfg',
];

function lcdDigit(d: number): Canvas {
  const c = new Canvas(9, 19);
  const on: Rgba = [16, 32, 16, 255];
  const seg = SEGMENTS[d] ?? '';
  if (seg.includes('a')) c.rect(1, 0, 7, 2, on);
  if (seg.includes('b')) c.rect(7, 1, 2, 8, on);
  if (seg.includes('c')) c.rect(7, 10, 2, 8, on);
  if (seg.includes('d')) c.rect(1, 17, 7, 2, on);
  if (seg.includes('e')) c.rect(0, 10, 2, 8, on);
  if (seg.includes('f')) c.rect(0, 1, 2, 8, on);
  if (seg.includes('g')) c.rect(1, 9, 7, 1, on);
  return c;
}

/** 计算器（Panel#21）：图0 本体、1 计量条亮格、2 MAX 按下、3 ↵ 按下、4–15 键帽按下、16–25 LCD 数字 0–9 */
function numpadFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  const mask = synthNumpadMask();
  const body = new Canvas(128, 192);
  body.rect(0, 0, 128, 192, [60, 60, 66, 255]);
  body.frame(0, 0, 128, 192, INK, 2);
  body.rect(9, 10, 110, 20, [160, 212, 150, 255]);
  body.frame(8, 9, 112, 22, INK);
  for (let y = 0; y < 192; y++) {
    for (let x = 0; x < 128; x++) {
      const r = mask[y * 128 + x]!;
      if (r === NUMPAD_REGION.meter) body.set(x, y, [24, 48, 24, 255]);
      else if (r === NUMPAD_REGION.max) body.set(x, y, [200, 60, 60, 255]);
      else if (r === NUMPAD_REGION.enter) body.set(x, y, [200, 205, 215, 255]);
      else if (r >= NUMPAD_REGION.keys0 && r < NUMPAD_REGION.meter) body.set(x, y, [205, 210, 218, 255]);
    }
  }
  for (let i = 0; i < 12; i++) {
    const [y] = NUMPAD_ROWS[Math.floor(i / 3)]!;
    body.dots(NUMPAD_COLS[i % 3]! + 4, y + 6, (i % 3) + 1, INK, 3);
  }
  const frames: Canvas[] = [body];
  const meter = new Canvas(108, 12);
  for (let x = 0; x < 108; x += 3) meter.rect(x, 1, 2, 10, [110, 230, 90, 255]);
  frames.push(meter);
  const pressed = (w: number, h: number, col: Rgba): Canvas => {
    const c = new Canvas(w, h);
    c.rect(0, 0, w, h, col);
    c.frame(0, 0, w, h, INK);
    return c;
  };
  frames.push(pressed(49, 25, [255, 120, 120, 255]));
  frames.push(pressed(57, 25, [255, 230, 120, 255]));
  for (let i = 0; i < 12; i++) frames.push(pressed(33, 17, [255, 220, 90, 255]));
  for (let d = 0; d < 10; d++) frames.push(lcdDigit(d));
  for (let f = 0; f < count; f++) out.push(frameOf(frames[f] ?? new Canvas(1, 1)));
  return out;
}

/** 讲话头像（map#15–26）：图0 大头 72×72、图1–4 表情 34×34（叠在大头脸上）、图5 小头 24×24、图6 地图点 10×9；锚点居中 */
function speakerFrames(character: number): (count: number) => UiFrame[] {
  return (count) => {
    const out: UiFrame[] = [];
    const col = hue(character);
    for (let f = 0; f < count; f++) {
      if (f === 0) {
        const c = new Canvas(72, 72);
        c.disc(35.5, 35.5, 35, INK);
        c.disc(35.5, 35.5, 33, lighter(col, 0.35));
        c.disc(35.5, 38, 22, [250, 214, 170, 255]);
        c.dots(20, 62, character + 1, INK, 2);
        out.push(frameOf(c, 36, 36));
      } else if (f <= 4) {
        const c = new Canvas(34, 34);
        c.disc(16.5, 16.5, 16, [250, 214, 170, 255]);
        c.rect(9, 11, 4, 4, INK);
        c.rect(21, 11, 4, 4, INK);
        // 表情：嘴的弧度随帧号变化
        for (let k = 0; k < 10; k++) c.rect(12 + k, 23 + Math.round(((k - 4.5) ** 2 / 10) * (f - 2.5)), 1, 2, INK);
        out.push(frameOf(c, 17, 17));
      } else if (f === 5) {
        const c = new Canvas(24, 24);
        c.disc(11.5, 11.5, 11, col);
        out.push(frameOf(c, 12, 12));
      } else {
        const c = new Canvas(10, 9);
        c.rect(0, 0, 10, 9, col);
        out.push(frameOf(c, 5, 4));
      }
    }
    return out;
  };
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

// ───────────────────────── 场所屏第二组（venues/b：魔法屋、拍卖、公佈欄、监狱 / 医院 / 恶人） ─────────────────────────
// 客户端按原版的帧尺寸与锚点摆放（venues/b 的布局常量），所以这几张表的 [宽, 高, 锚点 x, 锚点 y] 取原版包的帧表
// （只是尺寸数字，不含像素）；画面全部是自绘色块：底图按原版的区位画出可辨认的轮廓（魔法屋六芒星与 12 个图标位、
// 监狱 8 个窗洞（透明孔，与原版同位）、医院 8 张床位名牌、公佈欄的软木板与 SALE / EXIT 钮位），其余帧画色块、描边与帧号点。

/** [宽, 高, 锚点 x, 锚点 y] */
type FrameDim = readonly [number, number, number, number];

const dimsRun = (n: number, d: FrameDim): FrameDim[] => Array.from({ length: n }, () => d);

/** Panel#18 魔法屋：图0 底图、1 女巫、2 施法女巫、3–5 脸部小图、6/7/9/10 提示框（四个尾巴方向）、8 大框、11–22 条件图标、23–34 效果图标 */
export const MAGIC_DIMS: readonly FrameDim[] = [
  [640, 480, 0, 0],
  [165, 213, 0, 0],
  [284, 210, 0, 0],
  [60, 35, 0, 0],
  [60, 18, 0, 0],
  [60, 21, 0, 0],
  [142, 120, 69, 56],
  [142, 120, 72, 56],
  [280, 173, 140, 86],
  [142, 120, 70, 64],
  [141, 120, 72, 64],
  [57, 53, 28, 26],
  [50, 47, 26, 24],
  [49, 44, 22, 19],
  [60, 61, 29, 30],
  [46, 60, 23, 30],
  [37, 40, 18, 21],
  [64, 38, 31, 17],
  [51, 47, 27, 24],
  [51, 39, 27, 20],
  [55, 58, 28, 30],
  [38, 55, 21, 28],
  [40, 48, 18, 24],
  [64, 42, 32, 21],
  [40, 55, 21, 26],
  [57, 50, 28, 25],
  [58, 50, 29, 26],
  [46, 49, 23, 27],
  [53, 51, 28, 26],
  [40, 64, 17, 32],
  [58, 58, 28, 29],
  [55, 55, 27, 28],
  [54, 44, 26, 21],
  [52, 54, 25, 27],
  [49, 57, 25, 28],
];

/** 魔法屋 12 个效果图标的画点（原版底图上暗色图标的位置；效果 e 在掩膜区 e+1） */
export const MAGIC_ICON_AT: readonly (readonly [number, number])[] = [
  [322, 91],
  [414, 82],
  [453, 157],
  [509, 242],
  [458, 314],
  [415, 387],
  [322, 394],
  [239, 393],
  [188, 316],
  [131, 222],
  [184, 161],
  [225, 83],
];

/** 魔法屋掩膜的几何：六芒星中心、外接圆半径（顶角 y=12，与原版相同）；区 1–12 从正上方的星角起顺时针，13 为中心六边形 */
export const MAGIC_STAR = { cx: 320, cy: 238, r: 226 } as const;

function inTriangle(px: number, py: number, t: readonly (readonly [number, number])[]): boolean {
  const [a, b, c] = t as [readonly [number, number], readonly [number, number], readonly [number, number]];
  const s = (p: readonly [number, number], q: readonly [number, number]): number =>
    (px - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (py - q[1]);
  const d1 = s(a, b);
  const d2 = s(b, c);
  const d3 = s(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** 魔法屋命中掩膜（640×480，区 0 外、1–12 六个星角与星角之间的外圈、13 中心），区位与原版 Panel#19 一致 */
export function synthMagicMask(): Uint8Array {
  const { cx, cy, r } = MAGIC_STAR;
  const vtx = (deg: number): [number, number] => [
    cx + r * Math.cos((deg * Math.PI) / 180),
    cy + r * Math.sin((deg * Math.PI) / 180),
  ];
  const up = [vtx(-90), vtx(30), vtx(150)];
  const down = [vtx(90), vtx(-150), vtx(-30)];
  const hexR = r / Math.sqrt(3);
  const out = new Uint8Array(640 * 480);
  for (let y = 0; y < 480; y++) {
    for (let x = 0; x < 640; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > r * r) continue;
      const deg = ((((Math.atan2(dy, dx) * 180) / Math.PI + 90) % 360) + 360) % 360;
      const inUp = inTriangle(x, y, up);
      const inDown = inTriangle(x, y, down);
      let v: number;
      if (inUp && inDown) v = 13;
      else if (inUp || inDown) v = 2 * (Math.round(deg / 60) % 6) + 1;
      else v = 2 * (Math.floor(deg / 60) % 6) + 2;
      // 中心六边形之外但离中心很近的点（数值误差）归中心
      if (v !== 13 && dx * dx + dy * dy < (hexR * 0.8) ** 2) v = 13;
      out[y * 640 + x] = v;
    }
  }
  return out;
}

/** 通用色块帧：底色 + 描边 + 帧号点 */
function blockCanvas(d: FrameDim, col: Rgba, n: number): Canvas {
  const c = new Canvas(d[0], d[1]);
  c.rect(0, 0, d[0], d[1], col);
  c.frame(0, 0, d[0], d[1], INK, Math.min(2, Math.max(1, Math.floor(Math.min(d[0], d[1]) / 8))));
  c.dots(3, 3, Math.min(n, Math.max(1, Math.floor((d[0] - 6) / 3))), WHITE);
  return c;
}

/** 圆形图标帧（透明底）：色盘 + 白边 + 帧号点 */
function iconCanvas(d: FrameDim, col: Rgba, n: number): Canvas {
  const c = new Canvas(d[0], d[1]);
  const r = Math.min(d[0], d[1]) / 2 - 1;
  c.disc((d[0] - 1) / 2, (d[1] - 1) / 2, r, WHITE);
  c.disc((d[0] - 1) / 2, (d[1] - 1) / 2, r - 2, col);
  c.dots(Math.max(1, Math.round(d[0] / 2 - 8)), Math.round(d[1] / 2 - 1), Math.min(n, 5), INK);
  return c;
}

/** 站立人形（透明底）：头 + 身体 + 帧号点 */
function figureCanvas(d: FrameDim, body: Rgba, n: number): Canvas {
  const [w, h] = d;
  const c = new Canvas(w, h);
  const head = Math.max(6, Math.round(Math.min(w, h) * 0.2));
  c.disc(w / 2 - 0.5, head + 1, head, [250, 214, 170, 255]);
  c.rect(Math.round(w * 0.2), head * 2 + 2, Math.round(w * 0.6), h - head * 2 - 2, body);
  c.frame(Math.round(w * 0.2), head * 2 + 2, Math.round(w * 0.6), h - head * 2 - 2, INK);
  c.dots(Math.round(w * 0.2) + 3, head * 2 + 6, Math.min(n, 6), WHITE);
  return c;
}

/** 带尾巴的框（尾巴尖在 corner：0 左上、1 左下、2 右上、3 右下） */
function tailBox(w: number, h: number, fill: Rgba, edge: Rgba, corner: 0 | 1 | 2 | 3, inset = 10): Canvas {
  const c = new Canvas(w, h);
  c.rect(inset, inset, w - 2 * inset, h - 2 * inset, fill);
  c.frame(inset, inset, w - 2 * inset, h - 2 * inset, edge, 3);
  const right = corner === 2 || corner === 3;
  const bottom = corner === 1 || corner === 3;
  for (let k = 0; k < inset + 4; k++) {
    const x = right ? w - 1 - k : k;
    const y = bottom ? h - 1 - k : k;
    c.rect(right ? x - 2 : x, bottom ? y - 2 : y, 3, 3, edge);
  }
  return c;
}

function magicFrames(count: number): UiFrame[] {
  const mask = synthMagicMask();
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    const d = MAGIC_DIMS[f] ?? ([8, 8, 0, 0] as const);
    let c: Canvas;
    if (f === 0) {
      c = new Canvas(640, 480);
      c.rect(0, 0, 640, 480, [70, 40, 20, 255]);
      for (let y = 0; y < 480; y++) {
        for (let x = 0; x < 640; x++) {
          const v = mask[y * 640 + x]!;
          if (v === 0) continue;
          c.set(x, y, v === 13 ? [96, 52, 28, 255] : v % 2 === 1 ? [128, 76, 36, 255] : [110, 64, 30, 255]);
        }
      }
      // 暗色图标位（原版底图上画着 12 个暗图标）
      for (const [i, [x, y]] of MAGIC_ICON_AT.entries()) c.disc(x, y, 16, lighter(hue(i), 0.1));
      c.rect(250, 0, 140, 28, [150, 110, 50, 255]);
      c.rect(250, 452, 140, 28, [150, 110, 50, 255]);
    } else if (f === 1 || f === 2) {
      c = figureCanvas(d, [120, 40, 150, 255], f);
      // 水晶球（施法前后都在底部中间）
      c.disc(d[0] / 2, d[1] - 42, 36, [80, 220, 240, 255]);
      c.disc(d[0] / 2, d[1] - 42, 18, [220, 250, 255, 255]);
    } else if (f <= 5) {
      c = blockCanvas(d, [250, 214, 170, 255], f);
    } else if (f === 6 || f === 7 || f === 9 || f === 10) {
      const corner = ({ 6: 3, 7: 1, 9: 2, 10: 0 } as const)[f];
      c = tailBox(d[0], d[1], [110, 50, 12, 255], [230, 150, 90, 255], corner);
    } else if (f === 8) {
      c = new Canvas(d[0], d[1]);
      c.rect(0, 0, d[0], d[1], [120, 150, 60, 255]);
      c.frame(0, 0, d[0], d[1], [230, 150, 40, 255], 4);
      c.rect(12, 25, d[0] - 24, d[1] - 50, [100, 44, 10, 255]);
      c.frame(12, 25, d[0] - 24, d[1] - 50, [240, 200, 120, 255]);
    } else if (f <= 22) {
      c = iconCanvas(d, lighter(hue(f - 11), 0.25), f - 10);
    } else {
      c = iconCanvas(d, hue(f - 23), f - 22);
    }
    out.push(frameOf(c, d[2], d[3]));
  }
  return out;
}

/** Panel#26 拍卖：图0 底图、1 星形闪框、2 十字花纹框（九宫格切边 16）、3–16 竞价钮 PASS/+100/+500/+1000/+5000/+10000/Give up 常态·悬停、
 * 17/20 女助手、18/19 眨眼、21/24/25 拍卖官、22/23/26–29 口型与眼、30–77 建筑缩图、78–89 12 角色描边、90–115 占地标志（小 / 大） */
export const AUCTION_DIMS: readonly FrameDim[] = [
  [640, 480, 0, 0],
  [142, 113, 74, 59],
  [244, 100, 122, 50],
  ...Array.from({ length: 7 }, (): FrameDim[] => [
    [87, 39, 43, 19],
    [94, 46, 43, 19],
  ]).flat(),
  [109, 388, 0, 0],
  [16, 14, 0, 0],
  [16, 14, 0, 0],
  [95, 387, 0, 0],
  [199, 349, 0, 0],
  [40, 30, 0, 0],
  [41, 30, 0, 0],
  [199, 349, 0, 0],
  [154, 352, 0, 0],
  [29, 15, 0, 0],
  [29, 15, 0, 0],
  [31, 25, 0, 0],
  [31, 25, 0, 0],
  [55, 53, 26, -8],
  [65, 54, 30, -4],
  [65, 78, 31, 20],
  [38, 62, 17, 2],
  [59, 112, 30, 52],
  [50, 37, 23, -19],
  [64, 27, 30, -29],
  [74, 29, 37, -28],
  [74, 38, 36, -19],
  [63, 66, 32, 9],
  [55, 39, 27, -22],
  [84, 43, 44, -15],
  [79, 48, 39, -10],
  [97, 47, 48, -11],
  [82, 57, 42, -1],
  [69, 45, 33, -12],
  [82, 44, 39, -13],
  [86, 52, 41, -5],
  [61, 72, 30, 15],
  [56, 99, 26, 42],
  [82, 37, 41, -20],
  [76, 40, 36, -16],
  [84, 42, 29, -26],
  [62, 50, 35, -24],
  [76, 75, 30, -24],
  [64, 31, 30, -25],
  [70, 74, 36, -12],
  [59, 31, 31, -27],
  [71, 33, 35, -24],
  [59, 33, 33, -25],
  [62, 32, 32, -27],
  [69, 48, 39, -8],
  [69, 57, 33, -2],
  [74, 56, 34, -3],
  [76, 45, 38, -14],
  [74, 55, 36, -5],
  [86, 49, 42, -10],
  [51, 48, 26, -15],
  [60, 37, 30, -27],
  [70, 34, 33, -30],
  [73, 32, 36, -30],
  [77, 34, 41, -29],
  [71, 85, 34, 25],
  [67, 66, 31, 6],
  [63, 51, 30, -9],
  [63, 71, 31, 11],
  [69, 82, 31, 22],
  [85, 48, 42, -9],
  [64, 68, 32, 66],
  [70, 72, 34, 71],
  [42, 64, 21, 61],
  [46, 74, 22, 71],
  [52, 70, 25, 66],
  [46, 70, 23, 65],
  [44, 74, 22, 71],
  [58, 73, 29, 69],
  [64, 72, 31, 68],
  [52, 78, 25, 73],
  [51, 67, 31, 63],
  [36, 55, 18, 52],
  [58, 43, 27, -14],
  [58, 48, 28, -9],
  [58, 48, 29, -12],
  [58, 44, 28, -12],
  [58, 37, 29, -23],
  [58, 41, 27, -16],
  [58, 48, 27, -12],
  [58, 48, 28, -12],
  [58, 46, 28, -12],
  [58, 41, 27, -20],
  [58, 41, 28, -18],
  [58, 46, 29, -14],
  [58, 41, 28, -18],
  [108, 45, 50, -15],
  [108, 56, 49, -3],
  [108, 58, 51, -4],
  [108, 50, 50, -11],
  [108, 45, 52, -13],
  [108, 46, 51, -13],
  [108, 56, 51, -8],
  [108, 58, 51, -3],
  [108, 50, 49, -9],
  [108, 45, 51, -12],
  [108, 49, 53, -12],
  [108, 52, 51, -6],
  [108, 42, 53, -13],
];

/** 竞价钮配色：PASS、+100、+500、+1000、+5000、+10000、Give up */
const BID_BUTTON_HUES: readonly Rgba[] = [
  [40, 200, 220, 255],
  [230, 220, 40, 255],
  [240, 150, 40, 255],
  [240, 120, 30, 255],
  [230, 60, 30, 255],
  [190, 40, 220, 255],
  [40, 40, 110, 255],
];

function auctionFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    const d = AUCTION_DIMS[f] ?? ([8, 8, 0, 0] as const);
    const [w, h] = d;
    let c: Canvas;
    if (f === 0) {
      c = new Canvas(640, 480);
      c.rect(0, 0, 640, 330, [214, 208, 196, 255]);
      c.rect(0, 330, 640, 150, [170, 50, 40, 255]);
      c.rect(0, 0, 110, 190, [200, 60, 70, 255]);
      c.rect(395, 85, 205, 125, [120, 90, 60, 255]);
      c.rect(405, 95, 185, 105, [110, 160, 210, 255]);
      c.rect(195, 185, 160, 215, [120, 70, 40, 255]);
      c.rect(415, 262, 220, 22, [110, 70, 40, 255]);
    } else if (f === 1) {
      c = new Canvas(w, h);
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const rr = k % 2 === 0 ? 54 : 38;
        c.disc(74 + Math.cos(a) * (rr - 14), 59 + Math.sin(a) * (rr - 14), 16, [255, 150, 90, 255]);
      }
      c.disc(74, 59, 40, [255, 240, 200, 255]);
    } else if (f === 2) {
      c = new Canvas(w, h);
      c.rect(0, 0, w, h, [40, 110, 200, 255]);
      c.rect(6, 6, w - 12, h - 12, [245, 238, 250, 255]);
      c.frame(6, 6, w - 12, h - 12, [170, 210, 250, 255], 2);
      for (let y = 20; y < h - 16; y += 16)
        for (let x = 20; x < w - 16; x += 16) c.rect(x, y + 2, 5, 1, [200, 180, 230, 255]);
    } else if (f <= 16) {
      const i = Math.floor((f - 3) / 2);
      const hover = (f - 3) % 2 === 1;
      c = new Canvas(w, h);
      const col = BID_BUTTON_HUES[i]!;
      c.rect(2, 2, 83, 35, INK);
      c.rect(3, 3, 81, 33, hover ? lighter(col, 0.4) : col);
      c.dots(10, 16, i + 1, WHITE, 3);
    } else if (f === 17 || f === 20) {
      c = figureCanvas(d, [70, 150, 230, 255], f);
    } else if (f === 21 || f === 24 || f === 25) {
      c = figureCanvas(d, [60, 70, 150, 255], f);
    } else if (f <= 29) {
      c = blockCanvas(d, [250, 214, 170, 255], f);
    } else if (f <= 77) {
      // 建筑缩图：屋顶三角 + 墙身（贴图底边对齐同一条地面线）
      c = new Canvas(w, h);
      const roof = Math.max(4, Math.round(h * 0.3));
      const col = hue(f);
      for (let y = 0; y < roof; y++) {
        const half = Math.round(((y + 1) / roof) * (w / 2));
        c.rect(Math.round(w / 2 - half), y, half * 2, 1, [150, 60, 40, 255]);
      }
      c.rect(2, roof, w - 4, h - roof, lighter(col, 0.3));
      c.frame(2, roof, w - 4, h - roof, INK);
      c.dots(5, roof + 3, Math.min(((f - 30) % 5) + 1, 5), INK);
    } else if (f <= 89) {
      c = new Canvas(w, h);
      c.frame(0, 0, w, h, [255, 230, 0, 255], 3);
    } else {
      c = new Canvas(w, h);
      c.rect(0, h - 10, w, 10, [60, 150, 60, 255]);
      c.disc(w / 2, (h - 10) / 2, Math.min(w, h - 10) / 2 - 2, f === 90 || f === 103 ? [240, 150, 40, 255] : hue(f));
    }
    out.push(frameOf(c, d[2], d[3]));
  }
  return out;
}

/** Panel#28 + 3c：12 角色 Q 版小人的待机帧（venue.chibi.<c>.1，各 1 帧，锚点在脚底中间） */
export const CHIBI_IDLE_DIMS: readonly FrameDim[] = [
  [65, 72, 31, 72],
  [66, 68, 32, 67],
  [42, 69, 21, 67],
  [42, 68, 20, 66],
  [48, 66, 24, 64],
  [42, 66, 20, 63],
  [45, 90, 22, 88],
  [54, 69, 26, 67],
  [60, 68, 29, 66],
  [46, 61, 22, 59],
  [51, 68, 31, 66],
  [32, 60, 16, 57],
];

function chibiIdleFrames(character: number): (count: number) => UiFrame[] {
  return (count) => {
    const d = CHIBI_IDLE_DIMS[character]!;
    const out: UiFrame[] = [];
    for (let f = 0; f < count; f++) out.push(frameOf(figureCanvas(d, hue(character), character + 1), d[2], d[3]));
    return out;
  };
}

/** Panel#73 公佈欄 */
export const BULLETIN_DIMS: readonly FrameDim[] = [
  [596, 348, 0, 0],
  [336, 416, 0, 0],
  [416, 416, 0, 0],
  [360, 128, 0, 0],
  [360, 128, 0, 0],
  [184, 88, 0, 0],
  [192, 224, 0, 0],
  [192, 256, 0, 0],
  [192, 288, 0, 0],
  ...dimsRun(8, [72, 72, 0, 0]),
  [144, 96, 0, 0],
  [21, 21, 0, 0],
  [80, 32, 0, 0],
];

function bulletinFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  const cork: Rgba = [222, 160, 100, 255];
  for (let f = 0; f < count; f++) {
    const d = BULLETIN_DIMS[f] ?? ([8, 8, 0, 0] as const);
    const [w, h] = d;
    let c: Canvas;
    if (f === 0) {
      c = new Canvas(w, h);
      c.rect(0, 0, w, h, [150, 80, 40, 255]);
      c.rect(8, 8, w - 16, h - 16, cork);
      c.rect(40, 10, 190, 60, [200, 40, 60, 255]);
      // SALE / EXIT 钮位（与原版同位）
      c.rect(443, 9, 68, 36, [50, 90, 200, 255]);
      c.frame(443, 9, 68, 36, WHITE, 2);
      c.rect(517, 9, 68, 36, [200, 60, 60, 255]);
      c.frame(517, 9, 68, 36, WHITE, 2);
      c.disc(495, 265, 60, [240, 220, 120, 255]);
    } else if (f === 1 || f === 2) {
      c = new Canvas(w, h);
      c.rect(0, 0, w, h, f === 1 ? [150, 170, 160, 255] : [210, 130, 60, 255]);
      const rows = f === 1 ? 13 : 13;
      for (let r = 0; r <= rows; r++) c.rect(0, Math.min(h - 1, Math.round((r * h) / rows)), w, 1, WHITE);
      const cols = f === 1 ? [0, 96, 192, 336] : [0, 96, 176, 256, 336, 408];
      for (const x of cols) c.rect(Math.min(w - 1, x), 0, 1, h, WHITE);
      if (f === 1) c.frame(w - 24, 4, 20, 20, INK, 2);
      else c.rect(w - 8, 0, 8, h, GRAY);
    } else if (f === 3 || f === 4) {
      c = new Canvas(w, h);
      c.rect(0, 0, 288, 32, INK);
      c.rect(288, 0, 72, 32, f === 3 ? [220, 150, 140, 255] : [120, 190, 150, 255]);
      for (let r = 0; r < 3; r++) {
        for (let k = 0; k < 5; k++) {
          c.rect(k * 72, 32 + r * 32, 72, 32, f === 3 ? [230, 170, 160, 255] : [120, 190, 150, 255]);
          c.frame(k * 72, 32 + r * 32, 72, 32, INK);
        }
      }
    } else if (f === 5) {
      c = blockCanvas(d, [200, 190, 180, 255], f);
    } else if (f <= 8) {
      c = new Canvas(w, h);
      c.rect(0, 0, w, h, [190, 110, 40, 255]);
      c.rect(4, 4, w - 8, h - 8, [80, 150, 110, 255]);
      c.rect(8, 22, 100, 28, [60, 110, 120, 255]);
      c.rect(112, 4, 72, 72, [230, 190, 200, 255]);
      c.dots(120, 60, f - 5, INK, 4);
      for (let r = 0; r < f - 3; r++) c.rect(58, 80 + r * 30, 130, 24, [60, 120, 90, 255]);
      c.rect(16, h - 38, 74, 22, [240, 90, 90, 255]);
      c.rect(104, h - 38, 74, 22, [240, 90, 90, 255]);
    } else if (f <= 16) {
      c = new Canvas(w, h);
      c.rect(0, 0, w, h, f <= 11 ? [240, 200, 210, 255] : [200, 215, 245, 255]);
      c.frame(0, 0, w, h, INK);
      c.disc(35.5, 28, 18, hue(f));
      c.rect(8, 52, 56, 10, [210, 210, 230, 255]);
    } else if (f === 17) {
      c = new Canvas(w, h);
      c.rect(0, 0, w, h, [220, 40, 30, 255]);
      for (let k = 0; k < 4; k++)
        c.rect(8 + (k % 2) * 66, 8 + Math.floor(k / 2) * 42, 62, 38, lighter(hue(k * 3), 0.2));
    } else if (f === 18) {
      c = blockCanvas(d, [230, 230, 230, 255], 1);
    } else {
      c = blockCanvas(d, [160, 170, 170, 255], f);
    }
    out.push(frameOf(c, d[2], d[3]));
  }
  return out;
}

/** 监狱底图的 8 个窗洞（透明孔；左上角与尺寸，与原版 Panel#63 图0 逐像素统计一致）：上排 4 格、下排 4 格 */
export const JAIL_WINDOWS: readonly (readonly [number, number, number, number])[] = [
  [34, 25, 123, 135],
  [179, 25, 127, 135],
  [336, 25, 123, 135],
  [487, 25, 125, 135],
  [33, 184, 122, 136],
  [184, 184, 122, 136],
  [335, 184, 121, 136],
  [486, 184, 122, 136],
];

/** Panel#63 监狱：图0 墙（8 个窗洞）、1 羊皮纸讲话框、2 蓝框、3 铁栏、4 开着的门、5–16 12 角色大头、17–20 四大恶人大头、21 点券框 */
export const JAIL_DIMS: readonly FrameDim[] = [
  [640, 480, 0, 0],
  [185, 81, 0, 0],
  [100, 95, 0, 0],
  [132, 137, 0, 0],
  [87, 137, 0, 0],
  [121, 120, 0, -10],
  [121, 118, 0, -12],
  [90, 117, -15, -13],
  [79, 119, -24, -11],
  [114, 126, -3, -4],
  [101, 124, -10, -6],
  [93, 128, -14, -2],
  [120, 119, 0, -11],
  [121, 128, 0, -2],
  [95, 119, -13, -11],
  [113, 114, -2, -16],
  [71, 100, -26, -30],
  [89, 105, -8, -25],
  [119, 112, 0, -18],
  [103, 124, -9, -6],
  [83, 114, -18, -16],
  [90, 40, 0, 0],
];

/** Panel#64 四大恶人全身像（小偷、强盗、流氓、间谍；锚点在脚底中间） */
export const VILLAIN_DIMS: readonly FrameDim[] = [
  [152, 184, 79, 181],
  [238, 230, 116, 213],
  [138, 180, 70, 179],
  [201, 181, 72, 181],
];

/** 医院底图 8 张床的名牌（外框左上角；2 列 × 4 行，与原版 Panel#65 图0 同位） */
export const HOSPITAL_PLATES: readonly (readonly [number, number])[] = [
  [297, 66],
  [297, 186],
  [297, 306],
  [297, 426],
  [481, 66],
  [481, 186],
  [481, 306],
  [481, 426],
];

/** Panel#65 医院：图0 走廊底图、1 讲话框、2 十字花纹框、3 蓝框、4/9 护士、5–8/10–13 脸部小图、14–25 12 角色病床、26–29 恶人病床、30 点券框 */
export const HOSPITAL_DIMS: readonly FrameDim[] = [
  [640, 480, 0, 0],
  [185, 81, 0, 0],
  [280, 100, 0, 0],
  [98, 95, 0, 0],
  [134, 357, 0, 0],
  [40, 22, 0, 0],
  [40, 22, 0, 0],
  [40, 18, 0, 0],
  [40, 18, 0, 0],
  [172, 340, 0, 0],
  [40, 25, 0, 0],
  [40, 25, 0, 0],
  [40, 15, 0, 0],
  [40, 15, 0, 0],
  [119, 67, -7, -18],
  [119, 66, -7, -19],
  [121, 68, -6, -18],
  [122, 85, -4, -5],
  [115, 69, -11, -16],
  [120, 75, -6, -10],
  [126, 76, 0, -9],
  [126, 79, 0, -9],
  [126, 73, 0, -12],
  [125, 69, -1, -16],
  [122, 63, -4, -22],
  [113, 64, -13, -21],
  [117, 64, -9, -30],
  [125, 55, -1, -30],
  [125, 66, -1, -19],
  [125, 55, -1, -30],
  [90, 40, 0, 0],
];

/** 点券框（蓝底 + 左侧宝石） */
function pointsBox(d: FrameDim): Canvas {
  const c = new Canvas(d[0], d[1]);
  c.rect(0, 0, d[0], d[1], WHITE);
  c.rect(2, 2, d[0] - 4, d[1] - 4, [90, 120, 220, 255]);
  for (let k = 0; k < 3; k++) c.rect(8 + k * 6, 12 - k, 6, 16, [60, 220, 220, 255]);
  return c;
}

function jailFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    const d = JAIL_DIMS[f] ?? ([8, 8, 0, 0] as const);
    let c: Canvas;
    if (f === 0) {
      c = new Canvas(640, 480);
      c.rect(0, 0, 640, 480, [100, 100, 104, 255]);
      for (let y = 0; y < 480; y += 16) c.rect(0, y, 640, 1, [70, 70, 74, 255]);
      c.rect(16, 400, 70, 8, [110, 60, 30, 255]);
      // 窗洞：透明孔（色键 0）
      for (const [x, y, w, h] of JAIL_WINDOWS) c.rect(x, y, w, h, [0, 0, 0, 0]);
    } else if (f === 1) {
      c = tailBox(d[0], d[1], [236, 214, 170, 255], [30, 110, 60, 255], 3, 6);
    } else if (f === 2) {
      c = tailBox(d[0], d[1], [170, 210, 240, 255], [40, 110, 200, 255], 0, 8);
    } else if (f === 3) {
      c = new Canvas(d[0], d[1]);
      c.frame(0, 0, d[0], d[1], [90, 80, 70, 255], 6);
      for (let x = 20; x < d[0] - 10; x += 22) c.rect(x, 0, 6, d[1], [60, 55, 50, 255]);
    } else if (f === 4) {
      c = blockCanvas(d, [90, 80, 70, 255], 4);
    } else if (f <= 20) {
      c = iconCanvas(d, f <= 16 ? hue(f - 5) : [110, 60, 150, 255], f <= 16 ? f - 4 : f - 16);
    } else {
      c = pointsBox(d);
    }
    out.push(frameOf(c, d[2], d[3]));
  }
  return out;
}

function villainFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    const d = VILLAIN_DIMS[f] ?? ([8, 8, 0, 0] as const);
    out.push(frameOf(figureCanvas(d, [90 + f * 30, 40, 150 - f * 20, 255], f + 1), d[2], d[3]));
  }
  return out;
}

function hospitalFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    const d = HOSPITAL_DIMS[f] ?? ([8, 8, 0, 0] as const);
    const [w, h] = d;
    let c: Canvas;
    if (f === 0) {
      c = new Canvas(640, 480);
      c.rect(0, 0, 640, 300, [236, 236, 230, 255]);
      c.rect(0, 300, 640, 180, [150, 110, 80, 255]);
      for (const [x, y] of HOSPITAL_PLATES) {
        c.rect(x + 4, y - 60, 3, 60, GRAY);
        c.rect(x, y, 147, 37, [30, 40, 120, 255]);
        c.rect(x + 3, y + 3, 141, 31, [150, 170, 250, 255]);
      }
    } else if (f === 1) {
      c = tailBox(w, h, [236, 214, 170, 255], [30, 110, 60, 255], 3, 6);
    } else if (f === 2) {
      c = new Canvas(w, h);
      c.rect(0, 0, w, h, [40, 110, 200, 255]);
      c.rect(8, 8, w - 16, h - 16, [245, 238, 250, 255]);
    } else if (f === 3) {
      c = tailBox(w, h, [170, 210, 240, 255], [40, 110, 200, 255], 2, 8);
    } else if (f === 4 || f === 9) {
      c = figureCanvas(d, [250, 180, 200, 255], f);
    } else if (f <= 13) {
      c = blockCanvas(d, [250, 214, 170, 255], f);
    } else if (f <= 29) {
      // 病床：白被子 + 左边的头
      c = new Canvas(w, h);
      c.rect(30, Math.round(h * 0.35), w - 32, Math.round(h * 0.6), WHITE);
      c.frame(30, Math.round(h * 0.35), w - 32, Math.round(h * 0.6), GRAY);
      c.disc(18, h * 0.5, 16, f <= 25 ? hue(f - 14) : [110, 60, 150, 255]);
    } else {
      c = pointsBox(d);
    }
    out.push(frameOf(c, d[2], d[3]));
  }
  return out;
}

/** 场所屏第二组的合成精灵（逻辑键 → 帧生成函数；帧数取资源目录） */
const VENUES_B_FRAMES: Readonly<Record<string, (count: number) => UiFrame[]>> = {
  'venue.magic.screen': magicFrames,
  'venue.auction.screen': auctionFrames,
  'venue.bulletin.screen': bulletinFrames,
  'venue.jail.screen': jailFrames,
  'venue.jail.villains': villainFrames,
  'venue.hospital.screen': hospitalFrames,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, c) => [`venue.chibi.${c}.1`, chibiIdleFrames(c)])),
};

/** 场所屏第二组的合成掩膜 */
const VENUES_B_MASKS: Readonly<Record<string, { w: number; h: number; data: () => Uint8Array }>> = {
  'venue.magic.mask': { w: 640, h: 480, data: synthMagicMask },
};

/** 魔法屋施法 FLC（Panel#20 640×480×25，不透明）：暗底上的六芒星由小到大、最后泛白 */
function magicCastFlc(w: number, h: number, frames: number, frameMs: number): Uint8Array {
  const palette = new Uint8Array(768);
  palette.set([40, 20, 10], 0);
  palette.set([150, 90, 230], 3);
  palette.set([230, 250, 255], 6);
  const out: Uint8Array[] = [];
  for (let f = 0; f < frames; f++) {
    const px = new Uint8Array(w * h);
    const t = f / Math.max(1, frames - 1);
    const r = 40 + t * 320;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.hypot(x - w / 2, y - h / 2);
        if (d < r) px[y * w + x] = d > r - 18 || t > 0.8 ? 2 : 1;
      }
    }
    out.push(px);
  }
  return encodeFlc(w, h, frameMs, out, palette);
}

/** 场所屏第二组的合成 FLC：逻辑键 → 生成函数 */
const VENUES_B_FLICS: Readonly<Record<string, (w: number, h: number, frames: number, frameMs: number) => Uint8Array>> =
  {
    'venue.magic.cast': magicCastFlc,
  };

/** 合成包里场所屏第二组的键（测试用） */
export const SYNTH_VENUES_B = {
  sprites: Object.keys(VENUES_B_FRAMES),
  masks: Object.keys(VENUES_B_MASKS),
  flics: Object.keys(VENUES_B_FLICS),
} as const;

const UI_FRAMES: Readonly<Record<string, (count: number) => UiFrame[]>> = {
  'ui.toolbar': toolbarFrames,
  'ui.sidebar': sidebarFrames,
  'ui.calendar': calendarFrames,
  'ui.goButton': goButtonFrames,
  'ui.diceFaces': diceFaceFrames,
  'ui.common': commonFrames,
  'portrait.face72': portraitFrames,
  'ui.yesno': yesNoFrames,
  'ui.numpad': numpadFrames,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, c) => [`portrait.speaker.${c}`, speakerFrames(c)])),
  ...VENUES_B_FRAMES,
  ...venuesAFrames(),
  ...a11UiFrames(),
};

/** 合成包里的经典外壳 / 原版场景公共组件的 UI 精灵键 */
export const SYNTH_UI_SPRITES = Object.keys(UI_FRAMES);
export const SYNTH_UI_MASK = 'ui.goButton.mask';
/** 合成包里的命中掩膜：逻辑键 → 区域图 */
export const SYNTH_UI_MASKS: Readonly<Record<string, { w: number; h: number; data: () => Uint8Array }>> = {
  [SYNTH_UI_MASK]: { w: GO_W, h: GO_H, data: synthGoMask },
  'ui.numpad.mask': { w: 128, h: 192, data: synthNumpadMask },
  ...VENUES_B_MASKS,
};
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

  for (const [key, spec] of Object.entries(SYNTH_UI_MASKS)) {
    const mk = byKey.get(key);
    if (mk?.type !== 'mask') throw new Error(`资源目录缺少 ${key}`);
    const maskItem = mk as MaskItem;
    const m = maskPng(spec.data(), { w: spec.w, h: spec.h }, png);
    const maskFile = `masks/synthetic-ui/${key}.png`;
    await writer.writeFile(maskFile, m.bytes, 'mask', maskItem.group);
    writer.addEntry(key, {
      type: 'mask',
      group: maskItem.group,
      confidence: maskItem.confidence,
      src: ['synthetic'],
      file: maskFile,
      w: spec.w,
      h: spec.h,
      regions: m.maxRegion,
    });
  }

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

  // 场所屏第一组的 FLC（乐透跑马灯、摇奖机）
  await addSyntheticVenuesAFlics(writer, byKey);

  // 场所屏第二组的 FLC（魔法屋施法）
  for (const [key, make] of Object.entries(VENUES_B_FLICS)) {
    const it = byKey.get(key);
    if (it?.type !== 'flic') throw new Error(`资源目录缺少 ${key}`);
    const d = (it as FlicItem).def;
    const file = `flic/synthetic-ui/${key}.flc`;
    await writer.writeFile(file, make(d.w, d.h, d.frames, d.frameMs), 'flic', it.group);
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

  // 原版皮肤 A14：标题、开局设置、选人走动、背景与 Loading（见文件末尾）
  await addSyntheticTitle(writer, cat, png);
  // 原版皮肤 A13：三款小游戏的原版视图条目（见文件末尾）
  await addSyntheticMinigames(writer, cat, png);
  // 原版皮肤 A11：通用对话框与弹窗的整图（卡片插画、新闻插图；见文件末尾）
  await addSyntheticA11Images(writer, byKey, png);
}

// ───────────────────────── A14：标题 / 开局设置 / 选人 / Loading ─────────────────────────
//
// 客户端布局依赖的尺寸与锚点取原版值（ui/classic/screens/layout.ts）：
// - title.screen（Data#1）：图0 640×480 底图（在三个画点上「烘焙」START / LOAD / OPTION 常态图标）；图1–6 三钮的常态 /
//   悬停（108×105 / 116×113、107×92 / 114×99、98×90 / 103×98，锚点同原版）；图7–8 EXIT 53×18 / 58×19；
// - title.setup.ui（jump#4）：图0 头像格 440×155（6×2 格，68×68 色块、间距 72）；图1 竖栏 192×461（关卡行、OK / EXIT 框、
//   6 个下拉白框的位置同原版）；图2–15 按钮、箭头、下拉列表、勾 / 叉 / 星、关卡横幅，尺寸与锚点同原版；
// - title.sidewalk.<c>.<walk|moto|car>（jump#5+3c+v）：帧数同原版，帧尺寸取原版的代表值（步行 124×143、机车 142×162、
//   汽车 155×134），锚点在脚底中点；小人随帧号摆腿，便于看出动画；
// - title.setup.bg（jump#0）、title.loading（Data#560）：640×480 不透明整图；另有其他三张图的开局背景
//   title.setup.bg.<china|japan|usa>（jump#1–3）：按图换天色，左上角画 gm 个白方块，E2E 看选关切换背景用。
// 内容全部是自绘色块与点阵，不含原版像素。

/** 标题画面三钮的画点（与客户端 TITLE_BUTTONS 相同） */
export const SYNTH_TITLE_POINTS: readonly [number, number][] = [
  [190, 380],
  [328, 381],
  [469, 377],
];

/** 标题画面各帧的尺寸与锚点（原版值） */
export const SYNTH_TITLE_FRAME_SPECS: readonly { w: number; h: number; ax: number; ay: number }[] = [
  { w: 640, h: 480, ax: 0, ay: 0 },
  { w: 108, h: 105, ax: 55, ay: 53 },
  { w: 116, h: 113, ax: 59, ay: 57 },
  { w: 107, h: 92, ax: 51, ay: 51 },
  { w: 114, h: 99, ax: 55, ay: 54 },
  { w: 98, h: 90, ax: 51, ay: 42 },
  { w: 103, h: 98, ax: 53, ay: 46 },
  { w: 53, h: 18, ax: 27, ay: 9 },
  { w: 58, h: 19, ax: 29, ay: 10 },
];

/** 开局设置部件各帧的尺寸与锚点（原版值） */
export const SYNTH_SETUP_FRAME_SPECS: readonly { w: number; h: number; ax: number; ay: number }[] = [
  { w: 440, h: 155, ax: 0, ay: 0 },
  { w: 192, h: 461, ax: 0, ay: 0 },
  { w: 80, h: 40, ax: 0, ay: 0 },
  { w: 80, h: 40, ax: 0, ay: 0 },
  { w: 24, h: 25, ax: 0, ay: 0 },
  { w: 42, h: 71, ax: 0, ay: 0 },
  { w: 67, h: 140, ax: 0, ay: 0 },
  { w: 87, h: 140, ax: 0, ay: 0 },
  { w: 27, h: 25, ax: 0, ay: 0 },
  { w: 50, h: 52, ax: 25, ay: 26 },
  { w: 27, h: 27, ax: 14, ay: 14 },
  { w: 257, h: 45, ax: 128, ay: 22 },
  { w: 257, h: 45, ax: 128, ay: 22 },
  { w: 257, h: 45, ax: 128, ay: 22 },
  { w: 257, h: 45, ax: 128, ay: 22 },
  { w: 257, h: 177, ax: 128, ay: 88 },
];

/** 竖栏里 6 个下拉白框（原版实测位置） */
export const SYNTH_SETUP_BOXES: readonly [number, number, number][] = [
  [118, 218, 38],
  [93, 254, 63],
  [118, 290, 38],
  [93, 326, 63],
  [93, 362, 63],
  [73, 398, 83],
];

/** 侧视走动的代表帧尺寸与锚点（原版各帧略有出入，取第 0 帧附近的值） */
export const SYNTH_SIDEWALK_SIZE: Readonly<Record<string, { w: number; h: number; ax: number; ay: number }>> = {
  walk: { w: 124, h: 143, ax: 62, ay: 143 },
  moto: { w: 142, h: 162, ax: 72, ay: 161 },
  car: { w: 155, h: 134, ax: 75, ay: 134 },
};

const SKY: Rgba = [70, 130, 210, 255];
const SEA: Rgba = [30, 70, 150, 255];
const LAND: Rgba = [70, 140, 70, 255];
const GOLD: Rgba = [230, 180, 60, 255];
const BLUE: Rgba = [60, 120, 210, 255];
const CREAM: Rgba = [236, 226, 196, 255];
const PINK: Rgba = [214, 120, 150, 255];
const GREEN: Rgba = [40, 150, 110, 255];

function titleIcon(i: number, w: number, h: number, hover: boolean): Canvas {
  const c = new Canvas(w, h);
  const col = [[230, 140, 40, 255] as Rgba, [210, 60, 60, 255] as Rgba, GRAY_LIGHT][i]!;
  c.disc(w / 2 - 0.5, h / 2 - 0.5, Math.min(w, h) / 2 - 2, INK);
  c.disc(w / 2 - 0.5, h / 2 - 0.5, Math.min(w, h) / 2 - 4, hover ? lighter(col, 0.35) : col);
  c.rect(Math.round(w / 2 - 20), Math.round(h * 0.62), 40, 12, [40, 90, 200, 255]);
  c.dots(Math.round(w / 2 - 14), Math.round(h * 0.62) + 4, i + 1, WHITE, 3);
  return c;
}

function titleScreenFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  const icons: Canvas[] = [];
  for (let f = 1; f < count; f++) {
    const sp = SYNTH_TITLE_FRAME_SPECS[f]!;
    let c: Canvas;
    if (f <= 6) {
      c = titleIcon(Math.floor((f - 1) / 2), sp.w, sp.h, f % 2 === 0);
    } else {
      c = new Canvas(sp.w, sp.h);
      c.rect(0, 0, sp.w, sp.h, INK);
      c.rect(1, 1, sp.w - 2, sp.h - 2, f === 8 ? lighter(BLUE, 0.4) : BLUE);
      c.dots(4, Math.floor(sp.h / 2) - 1, 4, GOLD, 3);
    }
    icons[f] = c;
  }
  const bg = new Canvas(640, 480);
  bg.rect(0, 0, 640, 480, SEA);
  bg.rect(60, 40, 180, 140, LAND);
  bg.rect(380, 60, 200, 160, LAND);
  bg.rect(200, 250, 120, 120, LAND);
  // 标题字：三块金色方牌与一个「4」字形
  for (let k = 0; k < 3; k++) {
    bg.rect(90 + k * 170, 70, 110, 90, GOLD);
    bg.frame(90 + k * 170, 70, 110, 90, INK, 3);
  }
  bg.rect(290, 190, 24, 90, GOLD);
  bg.rect(250, 250, 90, 22, GOLD);
  bg.rect(250, 190, 22, 70, GOLD);
  // 在三个画点上烘焙常态图标（与原版底图一样）
  SYNTH_TITLE_POINTS.forEach(([x, y], k) => {
    const sp = SYNTH_TITLE_FRAME_SPECS[1 + 2 * k]!;
    bg.blit(icons[1 + 2 * k]!, x - sp.ax, y - sp.ay);
  });
  out.push(frameOf(bg));
  for (let f = 1; f < count; f++) {
    const sp = SYNTH_TITLE_FRAME_SPECS[f]!;
    out.push(frameOf(icons[f]!, sp.ax, sp.ay));
  }
  return out;
}

function setupUiFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    const sp = SYNTH_SETUP_FRAME_SPECS[f]!;
    const c = new Canvas(sp.w, sp.h);
    if (f === 0) {
      for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 6; i++) {
          const x = 6 + 72 * i;
          const y = 7 + 72 * j;
          c.frame(x - 1, y - 1, 70, 70, WHITE);
          c.rect(x, y, 68, 68, (i + j) % 2 === 0 ? BLUE : GOLD);
        }
      }
    } else if (f === 1) {
      c.rect(0, 0, sp.w, sp.h, GOLD);
      c.rect(4, 4, sp.w - 8, sp.h - 8, [30, 50, 120, 255]);
      for (let k = 0; k < 4; k++) {
        c.rect(10, 21 + 32 * k, 170, 30, k % 2 === 0 ? CREAM : [150, 190, 210, 255]);
        c.dots(20, 32 + 32 * k, k + 1, RED, 4);
        c.rect(150, 28 + 32 * k, 20, 14, WHITE);
      }
      c.rect(12, 167, 77, 37, PINK);
      c.frame(12, 167, 77, 37, WHITE, 2);
      c.dots(36, 183, 2, WHITE, 4);
      c.rect(100, 167, 77, 37, GREEN);
      c.frame(100, 167, 77, 37, WHITE, 2);
      c.dots(120, 183, 4, WHITE, 4);
      for (const [x, y, w] of SYNTH_SETUP_BOXES) {
        c.rect(x, y, w, 20, WHITE);
        c.rect(x + w + 1, y - 1, 24, 22, PINK);
        c.rect(x + w + 8, y + 7, 10, 6, WHITE);
      }
    } else if (f === 2 || f === 3) {
      c.rect(0, 0, sp.w, sp.h, f === 2 ? PINK : GREEN);
      c.frame(0, 0, sp.w, sp.h, WHITE, 2);
      c.dots(20, 18, f === 2 ? 2 : 4, WHITE, 4);
    } else if (f === 4) {
      c.rect(0, 0, sp.w, sp.h, PINK);
      c.rect(7, 9, 10, 6, WHITE);
    } else if (f >= 5 && f <= 7) {
      c.rect(0, 0, sp.w, sp.h, WHITE);
      for (let y = 23; y < sp.h; y += 23) c.rect(0, y, sp.w, 1, GOLD);
    } else if (f === 8) {
      for (let k = 0; k < 8; k++) c.rect(4 + k, 12 + Math.min(k, 7 - k), 3, 3, RED);
      for (let k = 0; k < 14; k++) c.rect(10 + k, 18 - k, 3, 3, RED);
    } else if (f === 9) {
      for (let k = 0; k < 46; k++) {
        c.rect(2 + k, 3 + k, 4, 4, RED);
        c.rect(46 - k, 3 + k, 4, 4, RED);
      }
    } else if (f === 10) {
      c.disc(13, 13, 12, BLUE);
      c.disc(13, 13, 5, WHITE);
    } else if (f >= 11 && f <= 14) {
      c.rect(0, 0, sp.w, sp.h, PINK);
      c.rect(3, 3, sp.w - 6, sp.h - 6, (f - 11) % 2 === 0 ? GOLD : GREEN);
      c.dots(100, 20, f - 10, RED, 5);
    } else {
      c.rect(0, 0, sp.w, sp.h, PINK);
      for (let k = 0; k < 4; k++) {
        c.rect(8, 8 + 41 * k, sp.w - 16, 39, k % 2 === 0 ? GOLD : GREEN);
        c.dots(100, 24 + 41 * k, k + 1, RED, 5);
      }
    }
    out.push(frameOf(c, sp.ax, sp.ay));
  }
  return out;
}

/** 侧视走动：c 号角色、v 种交通工具的第 f 帧（小人摆腿；机车 / 汽车画车身） */
function sidewalkFrames(c: number, v: string): (count: number) => UiFrame[] {
  return (count) => {
    const sp = SYNTH_SIDEWALK_SIZE[v]!;
    const col = hue(c);
    const out: UiFrame[] = [];
    for (let f = 0; f < count; f++) {
      const cv = new Canvas(sp.w, sp.h);
      const cx = sp.ax;
      const foot = sp.h - 1;
      const swing = Math.round(Math.sin((f / count) * Math.PI * 2) * 10);
      if (v === 'walk') {
        cv.rect(cx - 4 + swing, foot - 40, 8, 40, INK);
        cv.rect(cx - 4 - swing, foot - 40, 8, 40, INK);
        cv.rect(cx - 18, foot - 90, 36, 52, col);
        cv.disc(cx, foot - 110, 20, [250, 214, 170, 255]);
        cv.dots(cx - 12, foot - 70, c + 1, WHITE, 3);
      } else {
        const body: Rgba = v === 'moto' ? GRAY : col;
        const wheelY = foot - 16;
        cv.disc(cx - 40, wheelY, 15, INK);
        cv.disc(cx + 40, wheelY, 15, INK);
        cv.disc(cx - 40, wheelY, 5 + (f % 3), GRAY_LIGHT);
        cv.disc(cx + 40, wheelY, 5 + ((f + 1) % 3), GRAY_LIGHT);
        cv.rect(cx - 60, foot - 60, 120, 36, body);
        cv.disc(cx, foot - (v === 'moto' ? 110 : 80), 18, [250, 214, 170, 255]);
        if (v === 'moto') cv.rect(cx - 14, foot - 94, 28, 36, col);
        cv.dots(cx - 30, foot - 50, c + 1, WHITE, 3);
      }
      out.push(frameOf(cv, sp.ax, sp.ay));
    }
    return out;
  };
}

/** 开局设置背景的键（下标即 gm：台湾沿用 title.setup.bg，其他图 title.setup.bg.<mapId>） */
export const SYNTH_SETUP_BGS = [
  'title.setup.bg',
  'title.setup.bg.china',
  'title.setup.bg.japan',
  'title.setup.bg.usa',
] as const;
/** 各图开局背景的天色（台湾同旧版） */
const SETUP_SKY: readonly Rgba[] = [SKY, [200, 110, 70, 255], [220, 150, 190, 255], [110, 100, 170, 255]];

/** 640×480 不透明整图：开局设置背景（天空、房屋；gm>0 时左上角 gm 个白方块）与 Loading（深色底 + 进度条） */
function titleImage(key: string, w: number, h: number): Uint8Array {
  const c = new Canvas(w, h);
  const gm = (SYNTH_SETUP_BGS as readonly string[]).indexOf(key);
  if (gm >= 0) {
    for (let y = 0; y < h; y++) c.rect(0, y, w, 1, lighter(SETUP_SKY[gm]!, (y / h) * 0.5));
    c.rect(0, h - 80, w, 80, LAND);
    for (let k = 0; k < 6; k++) c.rect(40 + k * 100, h - 180 + (k % 3) * 20, 70, 110, [200, 80 + k * 20, 60, 255]);
    if (gm > 0) c.dots(24, 24, gm, WHITE, 16);
  } else {
    for (let y = 0; y < h; y++) c.rect(0, y, w, 1, [20 + Math.round((y / h) * 40), 16, 40, 255]);
    c.frame(170, 360, 300, 24, GOLD, 3);
    c.rect(176, 366, 180, 12, GOLD);
    c.dots(280, 200, 7, WHITE, 8);
  }
  return c.rgba;
}

const TITLE_UI_FRAMES: Readonly<Record<string, (count: number) => UiFrame[]>> = {
  'title.screen': titleScreenFrames,
  'title.setup.ui': setupUiFrames,
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, c) =>
      (['walk', 'moto', 'car'] as const).map((v) => [`title.sidewalk.${c}.${v}`, sidewalkFrames(c, v)] as const),
    ).flat(),
  ),
};

/** 合成包里 A14 画面用到的精灵键与整图键 */
export const SYNTH_TITLE_SPRITES = Object.keys(TITLE_UI_FRAMES);
export const SYNTH_TITLE_IMAGES = [...SYNTH_SETUP_BGS, 'title.loading'] as const;

/** 把 A14 的标题 / 开局 / 选人条目写进合成包（键、分组、帧数、置信度按资源目录） */
export async function addSyntheticTitle(writer: PackWriter, cat: Catalog, png: PngOptions): Promise<void> {
  const byKey = new Map(cat.items.map((it) => [it.key, it]));
  for (const key of SYNTH_TITLE_SPRITES) {
    const it = byKey.get(key);
    if (it?.type !== 'sprite' || typeof it.frames !== 'number') throw new Error(`资源目录缺少精灵 ${key}`);
    const item = it as SpriteItem & { frames: number };
    const frames = TITLE_UI_FRAMES[key]!(item.frames);
    const base = `S#${key}`;
    const pages = buildAtlasPages({
      dir: 'sprites/synthetic-title',
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
    writer.addEntry(key, {
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
    });
  }
  for (const key of SYNTH_TITLE_IMAGES) {
    const it = byKey.get(key);
    if (it?.type !== 'image') throw new Error(`资源目录缺少整图 ${key}`);
    const item = it as ImageItem;
    const file = `images/synthetic-title/${key}.png`;
    await writer.writeFile(
      file,
      encodePngRgba(item.w, item.h, titleImage(key, item.w, item.h), png),
      'image',
      item.group,
    );
    writer.addEntry(key, {
      type: 'image',
      group: item.group,
      confidence: item.confidence,
      src: ['synthetic'],
      file,
      w: item.w,
      h: item.h,
      transparency: item.transparency,
      anchor: null,
    });
  }
}

// ───────────────────────── 小游戏（A13） ─────────────────────────
//
// 三款小游戏原版视图用到的条目（逻辑键、分组、帧数同原版包；帧尺寸与锚点：底图 640×480、HUD 数字 15×28、
// 气球大 44×141 锚点 (22,30) / 小 36×116 锚点 (18,26) / 爆开 60×122 锚点 (28,40) 与原版一致；大号数字（hud 图10–19，
// 60×76 居中）与接物者（66×72 锚点 (33,71)）是我们自己的取值——原版逐帧不同（例如 hud 图15 为 58×78 锚点 (26,37)、
// 接物者 3 图0 为 51×68 锚点 (20,66)），客户端按图集里的逐帧尺寸与锚点绘制，不依赖这两组值；其余同样按我们自己的取值）。
// 图形全部自绘：色块、描边、方向箭头与帧号点。
// 底图的 HUD 条与原版同位置留白框（y = 419，高 33），企鹅掩膜的区号 = 格号（与 sim 的菱形拾取同一几何）。

/** 3×5 点阵数字（HUD 与大号数字的自绘字形） */
const MG_GLYPHS: readonly string[] = [
  '111101101101111',
  '010110010010111',
  '111001111100111',
  '111001111001111',
  '101101111001001',
  '111100111001111',
  '111100111101111',
  '111001010010010',
  '111101111101111',
  '111101111001111',
];

function mgGlyph(c: Canvas, d: number, x: number, y: number, k: number, col: Rgba): void {
  const g = MG_GLYPHS[d]!;
  for (let i = 0; i < 15; i++) if (g[i] === '1') c.rect(x + (i % 3) * k, y + Math.floor(i / 3) * k, k, k, col);
}

/** 箭头方向点（8 方向，0 = 下，逆时针：下、右下、右、右上、上、左上、左、左下） */
function mgArrow(c: Canvas, cx: number, cy: number, group: number, col: Rgba): void {
  const a = Math.PI / 2 - (group * Math.PI) / 4;
  for (let r = 0; r < 10; r++)
    c.rect(Math.round(cx + Math.cos(a) * r) - 1, Math.round(cy + Math.sin(a) * r) - 1, 3, 3, col);
}

/** HUD 条（y ≥ top）：深色底、白色数字框（与原版框位相同） */
function mgHudBar(c: Canvas, top: number, boxes: readonly (readonly [number, number])[], col: Rgba): void {
  c.rect(0, top, 640, 480 - top, col);
  c.rect(0, top, 640, 3, INK);
  for (const [x, w] of boxes) {
    c.rect(x, 419, w, 33, WHITE);
    c.frame(x - 1, 418, w + 2, 35, INK);
  }
}

const MG_TIME_BOXES: readonly (readonly [number, number])[] = [
  [48, 18],
  [67, 19],
  [93, 18],
  [112, 19],
];
const MG_PAIR_BOXES: readonly (readonly [number, number])[] = [
  [184, 18],
  [203, 19],
  [275, 18],
  [294, 19],
  [366, 18],
  [385, 19],
  [457, 18],
  [476, 19],
];
const MG_SCORE3_BOXES: readonly (readonly [number, number])[] = [
  [548, 18],
  [567, 19],
  [587, 19],
];
const MG_SCORE4_BOXES: readonly (readonly [number, number])[] = [[528, 18], ...MG_SCORE3_BOXES.slice(1), [567, 19]];

function mgScreen(sky: Rgba, ground: Rgba, top: number, boxes: readonly (readonly [number, number])[]): Canvas {
  const c = new Canvas(640, 480);
  for (let y = 0; y < top; y++) {
    const t = y / top;
    c.rect(0, y, 640, 1, [
      Math.round(sky[0] + (ground[0] - sky[0]) * t),
      Math.round(sky[1] + (ground[1] - sky[1]) * t),
      Math.round(sky[2] + (ground[2] - sky[2]) * t),
      255,
    ]);
  }
  mgHudBar(c, top, boxes, lighter(INK, 0.25));
  return c;
}

/** 一格自绘小人 / 物件：填色矩形 + 描边 + 帧号点，锚点 (ax, ay) */
function mgBlock(w: number, h: number, ax: number, ay: number, col: Rgba, dots: number): UiFrame {
  const c = new Canvas(w, h);
  c.rect(1, 1, w - 2, h - 2, col);
  c.frame(0, 0, w, h, INK);
  c.dots(3, h - 5, Math.min(dots, Math.floor((w - 4) / 3)), INK, 2);
  return frameOf(c, ax, ay);
}

/** Panel#79：图0–9 液晶数字 15×28（白底黑字）、图10–19 大号彩色数字 60×76（锚点居中） */
function mgHudFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    if (f < 10) {
      const c = new Canvas(15, 28);
      c.rect(0, 0, 15, 28, WHITE);
      mgGlyph(c, f, 2, 4, 4, INK);
      out.push(frameOf(c));
    } else {
      const d = f - 10;
      const c = new Canvas(60, 76);
      c.disc(29.5, 37.5, 29, hue(d));
      mgGlyph(c, d, 12, 13, 12, WHITE);
      out.push(frameOf(c, 30, 38));
    }
  }
  return out;
}

const MG_PENGUIN_DIMS: readonly (readonly [number, number, number, number])[] = [
  [640, 480, 0, 0],
  [38, 47, 21, 41],
  [48, 53, 22, 48],
  [85, 58, 42, 44],
  [30, 26, 15, 19],
  [28, 15, 13, 8],
  [28, 15, 13, 8],
  [28, 15, 13, 8],
  [28, 17, 13, 10],
  [34, 20, 17, 10],
];

/** Panel#80：冰原底图（HUD 条 y ≥ 387）、站立、焦黑、冰屋、埋藏物露头 ×5、雪坑 */
function mgPenguinScreenFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    const [w, h, ax, ay] = MG_PENGUIN_DIMS[f] ?? [24, 24, 12, 12];
    if (f === 0) {
      const c = mgScreen([150, 210, 240, 255], [225, 245, 252, 255], 387, [
        ...MG_TIME_BOXES,
        ...MG_PAIR_BOXES,
        ...MG_SCORE3_BOXES,
      ]);
      out.push(frameOf(c));
    } else if (f === 1 || f === 2) {
      out.push(mgBlock(w, h, ax, ay, f === 1 ? [40, 60, 200, 255] : [30, 30, 30, 255], f));
    } else if (f === 3) {
      const c = new Canvas(w, h);
      c.disc(42, 44, 40, [235, 248, 255, 255]);
      c.rect(0, 45, w, h - 45, [0, 0, 0, 0]);
      c.rect(34, 28, 16, 17, INK);
      out.push(frameOf(c, ax, ay));
    } else if (f <= 8) {
      const c = new Canvas(w, h);
      c.disc(w / 2, h / 2, h / 2, WHITE);
      c.disc(w / 2, h / 2 - 2, 5, hue(f));
      out.push(frameOf(c, ax, ay));
    } else {
      const c = new Canvas(w, h);
      c.disc(w / 2, h / 2, h / 2, [60, 90, 120, 255]);
      out.push(frameOf(c, ax, ay));
    }
  }
  return out;
}

/** Panel#82 / #83：企鹅走路 / 挖掘，8 方向 × 4 帧（方向箭头 + 帧号点） */
function mgPenguinMoveFrames(dig: boolean): (count: number) => UiFrame[] {
  return (count) => {
    const out: UiFrame[] = [];
    for (let f = 0; f < count; f++) {
      const g = Math.floor(f / 4);
      const c = new Canvas(40, 48);
      c.disc(19.5, 26, 17, dig ? [70, 70, 220, 255] : [40, 60, 200, 255]);
      c.disc(19.5, 26, 10, WHITE);
      mgArrow(c, 19.5, 26, g, INK);
      c.rect(8 + (f % 4) * 6, 44, 5, 3, [240, 190, 40, 255]);
      out.push(frameOf(c, 20, 38));
    }
    return out;
  };
}

/** Panel#84 / #85：结算姿势（高分跳起 / 低分吐舌），各帧上下错开 */
function mgPenguinPoseFrames(high: boolean): (count: number) => UiFrame[] {
  return (count) =>
    Array.from({ length: count }, (_, f) => {
      const c = new Canvas(48, 60);
      const dy = (f % 3) * 3;
      c.disc(23.5, 30 - dy, 20, high ? [250, 200, 40, 255] : [120, 160, 230, 255]);
      c.dots(10, 50, f + 1, INK, 3);
      return frameOf(c, 23, 42);
    });
}

/** Panel#86–90：揭晓 6 帧（86 爆炸，87–90 宝物升起：锚点 y 逐帧增大 = 画得更高） */
function mgPenguinRevealFrames(kind: number): (count: number) => UiFrame[] {
  return (count) =>
    Array.from({ length: count }, (_, f) => {
      if (kind === 1) {
        const c = new Canvas(24 + f * 6, 22 + f * 5);
        c.disc(c.w / 2, c.h / 2, Math.min(c.w, c.h) / 2, [255, 150 - f * 15, 40, 255]);
        return frameOf(c, c.w >> 1, c.h - 4);
      }
      const c = new Canvas(16, 14);
      c.disc(7.5, 6.5, 6.5, hue(kind + 2));
      c.frame(0, 0, 16, 14, INK);
      return frameOf(c, 7, 44 + Math.min(3, f) * 9);
    });
}

/** Panel#91：游乐园底图（HUD 条 y ≥ 387）、气球 1–9（大 1–6、小 7–9）、×2、÷2、?、爆开 */
function mgBalloonFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    if (f === 0) {
      out.push(
        frameOf(mgScreen([90, 180, 240, 255], [120, 200, 110, 255], 387, [...MG_TIME_BOXES, ...MG_SCORE4_BOXES])),
      );
    } else if (f <= 12) {
      const big = f <= 6;
      const [w, h, ax, ay] = big ? [44, 141, 22, 30] : [36, 116, 18, 26];
      const c = new Canvas(w, h);
      c.disc(w / 2 - 0.5, ay, w / 2 - 1, hue(f));
      if (f <= 9) mgGlyph(c, f, w / 2 - 6, ay - 10, 4, WHITE);
      else c.dots(w / 2 - 6, ay - 2, f - 9, WHITE, 3);
      for (let y = ay + w / 2; y < h; y++) c.set(ax + (y % 6 < 3 ? 0 : 1), y, INK);
      out.push(frameOf(c, ax, ay));
    } else {
      const c = new Canvas(60, 122);
      for (let k = 0; k < 12; k++) {
        const a = (k * Math.PI) / 6;
        c.rect(Math.round(28 + Math.cos(a) * 22), Math.round(40 + Math.sin(a) * 22), 4, 4, [120, 230, 250, 255]);
      }
      out.push(frameOf(c, 28, 40));
    }
  }
  return out;
}

/** Panel#93：财神 19 帧（0–6 向右、7–11 转身、12–18 向左；方向箭头 + 帧号点） */
function mgGodFrames(count: number): UiFrame[] {
  return Array.from({ length: count }, (_, f) => {
    const c = new Canvas(64, 66);
    c.disc(31.5, 34, 30, [210, 50, 50, 255]);
    c.disc(31.5, 24, 12, [250, 214, 170, 255]);
    mgArrow(c, 31.5, 46, f <= 6 ? 2 : f >= 12 ? 6 : 0, INK);
    c.dots(4, 60, (f % 7) + 1, INK, 2);
    return frameOf(c, 32, 64);
  });
}

/** Panel#94：捣蛋鬼预警 12 帧（冒出、抱炸弹、扔、缩回；锚点在右下 = 炸弹处） */
function mgWarnFrames(count: number): UiFrame[] {
  return Array.from({ length: count }, (_, f) => {
    const h = 10 + Math.min(f, 11 - f, 5) * 8;
    const c = new Canvas(48, h);
    c.rect(1, 1, 30, h - 2, [60, 170, 70, 255]);
    c.frame(0, 0, 32, h, INK);
    if (f >= 3 && f <= 7) c.disc(40, h - 9, 8, [60, 60, 60, 255]);
    return frameOf(c, 40, h - 1);
  });
}

/** Panel#95–99：宝箱 / 钱袋 / 元宝 / 金币 / 炸弹，8 个摆动帧（锚点居中） */
function mgXicongItemFrames(kind: number): (count: number) => UiFrame[] {
  return (count) =>
    Array.from({ length: count }, (_, f) => {
      const c = new Canvas(32, 26);
      const col: Rgba = kind === 4 ? [60, 60, 60, 255] : hue(kind * 3 + 1);
      c.disc(15.5, 12.5, 12, col);
      c.frame(0, 0, 32, 26, INK);
      c.rect(
        14 + Math.round(Math.cos((f * Math.PI) / 4) * 9),
        11 + Math.round(Math.sin((f * Math.PI) / 4) * 7),
        3,
        3,
        WHITE,
      );
      return frameOf(c, 16, 13);
    });
}

/** Panel#100+c：接物者（图0–3 站立与结算表情、图4 被炸、其后左走、右走各半；66×72 锚点 (33,71) 为我们的取值，原版逐帧不同） */
function mgCatcherFrames(character: number): (count: number) => UiFrame[] {
  return (count) => {
    const per = Math.max(1, (count - 5) >> 1);
    return Array.from({ length: count }, (_, f) => {
      const c = new Canvas(66, 72);
      const col: Rgba = f === 4 ? [40, 30, 30, 255] : hue(character);
      c.rect(13, 20, 40, 51, col);
      c.frame(12, 19, 42, 53, INK);
      c.disc(32.5, 16, 14, f === 4 ? [60, 50, 50, 255] : [250, 214, 170, 255]);
      if (f < 4) c.dots(20, 28, f + 1, WHITE, 4);
      else if (f > 4) mgArrow(c, 32.5, 45, f - 5 < per ? 6 : 2, WHITE);
      c.dots(15, 64, character + 1, INK, 2);
      return frameOf(c, 33, 71);
    });
  };
}

/** 喜从天降底图（Panel#92，640×480 不透明整图，HUD 条 y ≥ 387） */
function mgXicongBg(): Canvas {
  const c = mgScreen([250, 190, 120, 255], [180, 60, 40, 255], 387, [
    ...MG_TIME_BOXES,
    ...MG_PAIR_BOXES,
    ...MG_SCORE3_BOXES,
  ]);
  for (let k = 0; k < 10; k++) c.rect(0, 140 + k * 24, 640, 3, [150, 40, 30, 255]);
  return c;
}

/** 企鹅命中掩膜（Panel#81 同语义：区号 = 格号）：与 sim 的菱形拾取同一几何（格心、有效格、并列取度量小者再取格号小者） */
function mgPenguinMask(): Uint8Array {
  const ranges: readonly (readonly [number, number])[] = [
    [3, 6],
    [1, 7],
    [1, 8],
    [0, 8],
    [0, 8],
    [0, 8],
    [0, 7],
    [1, 7],
    [2, 5],
  ];
  const cells: [number, number, number][] = [];
  for (let r = 0; r < 9; r++) {
    for (let col = ranges[r]![0]; col <= ranges[r]![1]; col++) {
      if (r === 4 && col === 4) continue;
      cells.push([r * 9 + col, 48 * (r + col) - 64, 24 * (r - col) + 225]);
    }
  }
  const out = new Uint8Array(640 * 480);
  for (let y = 0; y < 480; y++) {
    for (let x = 0; x < 640; x++) {
      let best = 0;
      let bestD = 48 * 24 + 1;
      for (const [id, cx, cy] of cells) {
        const d = Math.abs(x - cx) * 24 + Math.abs(y - cy) * 48;
        if (d < bestD) {
          bestD = d;
          best = id;
        }
      }
      out[y * 640 + x] = best;
    }
  }
  return out;
}

/** 入场 READY GO（Panel#78 640×480，索引 0 透明）：五个色块自下飞入排成一行，最后两块 GO 落下 */
function mgReadyFlc(w: number, h: number, frames: number, frameMs: number): Uint8Array {
  const palette = new Uint8Array(768);
  const cols = [
    [150, 60, 220],
    [240, 140, 40],
    [230, 40, 60],
    [40, 120, 230],
    [250, 210, 40],
    [230, 60, 150],
    [40, 190, 90],
  ];
  cols.forEach((c, i) => {
    palette.set(c, (i + 1) * 3);
  });
  const out: Uint8Array[] = [];
  for (let f = 0; f < frames; f++) {
    const px = new Uint8Array(w * h);
    const t = Math.min(1, f / Math.max(1, frames * 0.4));
    const block = (x0: number, y0: number, bw: number, bh: number, v: number): void => {
      for (let y = Math.max(0, y0); y < Math.min(h, y0 + bh); y++)
        for (let x = Math.max(0, x0); x < Math.min(w, x0 + bw); x++) px[y * w + x] = v;
    };
    for (let k = 0; k < 5; k++) block(130 + k * 80, Math.round(480 - (480 - 160) * t), 60, 70, k + 1);
    if (f >= frames * 0.6) for (let k = 0; k < 2; k++) block(230 + k * 110, 260, 70, 70, k + 6);
    out.push(px);
  }
  return encodeFlc(w, h, frameMs, out, palette);
}

/** 小游戏的合成精灵（逻辑键 → 帧生成函数；帧数取资源目录） */
const MG_FRAMES: Readonly<Record<string, (count: number) => UiFrame[]>> = {
  'mg.common.hud': mgHudFrames,
  'mg.penguin.screen': mgPenguinScreenFrames,
  'mg.penguin.82': mgPenguinMoveFrames(false),
  'mg.penguin.83': mgPenguinMoveFrames(true),
  'mg.penguin.84': mgPenguinPoseFrames(true),
  'mg.penguin.85': mgPenguinPoseFrames(false),
  ...Object.fromEntries([1, 2, 3, 4, 5].map((k) => [`mg.penguin.${85 + k}`, mgPenguinRevealFrames(k)])),
  'mg.balloon.screen': mgBalloonFrames,
  'mg.xicong.93': mgGodFrames,
  'mg.xicong.94': mgWarnFrames,
  ...Object.fromEntries([0, 1, 2, 3, 4].map((k) => [`mg.xicong.${95 + k}`, mgXicongItemFrames(k)])),
  ...Object.fromEntries(Array.from({ length: 12 }, (_, c) => [`mg.xicong.char.${c}`, mgCatcherFrames(c)])),
};

/** 合成包里的小游戏条目（测试用） */
export const SYNTH_MINIGAMES = {
  sprites: Object.keys(MG_FRAMES),
  images: ['mg.xicong.bg'],
  masks: ['mg.penguin.mask'],
  flics: ['mg.ready'],
} as const;

/** 把小游戏条目写进合成包（由 addSyntheticUi 调用；键、分组、帧数与置信度按资源目录） */
export async function addSyntheticMinigames(writer: PackWriter, cat: Catalog, png: PngOptions): Promise<void> {
  const byKey = new Map(cat.items.map((it) => [it.key, it]));
  for (const [key, make] of Object.entries(MG_FRAMES)) {
    const it = byKey.get(key);
    if (it?.type !== 'sprite' || typeof it.frames !== 'number') throw new Error(`资源目录缺少小游戏精灵 ${key}`);
    const item = it as SpriteItem & { frames: number };
    const frames = make(item.frames);
    const base = `S#${key}`;
    const pages = buildAtlasPages({
      dir: 'sprites/synthetic-mg',
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
    writer.addEntry(key, {
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
    });
  }

  const bg = byKey.get('mg.xicong.bg');
  if (bg?.type !== 'image') throw new Error('资源目录缺少 mg.xicong.bg');
  const { encodePngRgba } = await import('../gfx/png');
  const bgFile = 'images/synthetic-mg/mg.xicong.bg.png';
  const canvas = mgXicongBg();
  await writer.writeFile(bgFile, encodePngRgba(canvas.w, canvas.h, canvas.rgba, png), 'image', bg.group);
  writer.addEntry('mg.xicong.bg', {
    type: 'image',
    group: bg.group,
    confidence: bg.confidence,
    src: ['synthetic'],
    file: bgFile,
    w: canvas.w,
    h: canvas.h,
    transparency: 'opaque',
    anchor: null,
  });

  const mk = byKey.get('mg.penguin.mask');
  if (mk?.type !== 'mask') throw new Error('资源目录缺少 mg.penguin.mask');
  const m = maskPng(mgPenguinMask(), { w: 640, h: 480 }, png);
  const maskFile = 'masks/synthetic-mg/mg.penguin.mask.png';
  await writer.writeFile(maskFile, m.bytes, 'mask', mk.group);
  writer.addEntry('mg.penguin.mask', {
    type: 'mask',
    group: mk.group,
    confidence: mk.confidence,
    src: ['synthetic'],
    file: maskFile,
    w: 640,
    h: 480,
    regions: m.maxRegion,
  });

  const rd = byKey.get('mg.ready');
  if (rd?.type !== 'flic') throw new Error('资源目录缺少 mg.ready');
  const d = (rd as FlicItem).def;
  const flcFile = 'flic/synthetic-mg/mg.ready.flc';
  await writer.writeFile(flcFile, mgReadyFlc(d.w, d.h, d.frames, d.frameMs), 'flic', rd.group);
  writer.addEntry('mg.ready', {
    type: 'flic',
    group: rd.group,
    confidence: rd.confidence,
    src: ['synthetic'],
    file: flcFile,
    w: d.w,
    h: d.h,
    frames: d.frames,
    frameMs: d.frameMs,
    durationMs: d.frames * d.frameMs,
    transparency: d.opaque ? 'opaque' : 'index0',
    sfx: null,
  });
}

// ───────────────────────── 场所屏第一组（A12：银行 / ATM、百货、乐透投注与开奖、股市） ─────────────────────────
//
// 客户端 ui/classic/venues/a 依赖的条目：venue.bank.screen（Panel#23）、venue.bank.atm（Panel#24）、venue.shop.screen（Panel#10）、
// venue.lottery.bet（Panel#12）、venue.lottery.draw（Panel#15）、venue.stock.screen（Panel#75），以及跑马灯（Panel#14）与
// 摇奖机（Panel#16）两段 FLC。全部是自绘色块；帧数、帧尺寸、锚点与原版相同，底图上烘焙的部件（ATM 键位、柜台 EXIT、
// 号码盘 36 格、股市表格线）画在与原版相同的位置，客户端按原版坐标摆放的热区在合成包里也对得上。
// 这里只用函数声明（提升），UI_FRAMES 在模块求值时调用 venuesAFrames() 不会碰到尚未初始化的常量。

type VaDim = readonly [number, number, number, number];

function vaRep(n: number, d: VaDim): VaDim[] {
  return Array.from({ length: n }, () => d);
}

/** 3×5 点阵数字（号码球、LCD、号码盘） */
function vaDigit(c: Canvas, x: number, y: number, d: number, s: number, col: Rgba): void {
  const FONT = [
    '111101101101111',
    '010110010010111',
    '111001111100111',
    '111001111001111',
    '101101111001001',
    '111100111001111',
    '111100111101111',
    '111001001001001',
    '111101111101111',
    '111101111001111',
  ];
  const g = FONT[((d % 10) + 10) % 10]!;
  for (let r = 0; r < 5; r++)
    for (let k = 0; k < 3; k++) if (g[r * 3 + k] === '1') c.rect(x + k * s, y + r * s, s, s, col);
}

/** 通用色块：底色 + 描边 + 帧号点 */
function vaBlock(d: VaDim, col: Rgba, n: number): Canvas {
  const c = new Canvas(d[0], d[1]);
  c.rect(0, 0, d[0], d[1], col);
  c.frame(0, 0, d[0], d[1], INK, Math.min(2, Math.max(1, Math.floor(Math.min(d[0], d[1]) / 8))));
  c.dots(3, 3, Math.min(n, Math.max(1, Math.floor((d[0] - 6) / 3))), WHITE);
  return c;
}

/** 站立人形（透明底） */
function vaFigure(d: VaDim, body: Rgba, n: number): Canvas {
  const [w, h] = d;
  const c = new Canvas(w, h);
  const head = Math.max(6, Math.round(Math.min(w, h) * 0.2));
  c.disc(w / 2 - 0.5, head + 1, head, [250, 214, 170, 255]);
  c.rect(Math.round(w * 0.2), head * 2 + 2, Math.round(w * 0.6), h - head * 2 - 2, body);
  c.frame(Math.round(w * 0.2), head * 2 + 2, Math.round(w * 0.6), h - head * 2 - 2, INK);
  c.dots(Math.round(w * 0.2) + 3, head * 2 + 6, Math.min(n, 6), WHITE);
  return c;
}

/** 气泡：椭圆 + 尾巴（side：尾巴在左 / 右 / 右下） */
function vaBalloon(w: number, h: number, fill: Rgba, edge: Rgba, side: 'left' | 'right' | 'rightDown'): Canvas {
  const c = new Canvas(w, h);
  const tail = 26;
  const x0 = side === 'left' ? tail : 2;
  const x1 = side === 'left' ? w - 3 : w - tail;
  const y1 = side === 'rightDown' ? h - tail : h - 3;
  const cx = (x0 + x1) / 2;
  const cy = (2 + y1) / 2;
  const rx = (x1 - x0) / 2;
  const ry = (y1 - 2) / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const e = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (e <= 1) c.set(x, y, e > 0.86 ? edge : fill);
    }
  }
  for (let k = 0; k < tail; k++) {
    const t = Math.round(k / 3);
    if (side === 'left') c.rect(k, Math.round(cy) - t, 2, 2 * t + 2, k < 2 ? edge : fill);
    else if (side === 'right') c.rect(w - 1 - k, Math.round(cy) - t, 2, 2 * t + 2, k < 2 ? edge : fill);
    else c.rect(w - 1 - k - t, h - 1 - k, 2 * t + 2, 2, k < 2 ? edge : fill);
  }
  return c;
}

/** 禁止符号（29×29，锚点居中） */
function vaBan(): Canvas {
  const c = new Canvas(29, 29);
  c.disc(14, 14, 14, RED);
  c.disc(14, 14, 10, [0, 0, 0, 0]);
  for (let k = 4; k < 25; k++) c.rect(k, k - 1, 2, 3, RED);
  return c;
}

// Panel#23 银行：图0 柜台、1 百叶窗（锚点 62,198）、2 董事长办公室、3–14 表情、15 羊皮纸、16/17 蓝钮、18/19 EXIT、
// 20 借还款卡、21 心形气泡（尾巴在左）、22 讲话框（尾巴在右下）、23 禁止符号
const VA_BANK_DIMS: readonly VaDim[] = [
  [640, 480, 0, 0],
  [344, 240, 62, 198],
  [640, 480, 0, 0],
  ...vaRep(5, [80, 40, 0, 0]),
  [80, 30, 0, 0],
  [79, 30, 0, 0],
  [80, 30, 0, 0],
  [70, 35, 0, 0],
  [70, 35, 0, 0],
  [66, 25, 0, 0],
  [67, 25, 0, 0],
  [200, 280, 0, 0],
  [114, 40, 0, 0],
  [114, 40, 0, 0],
  [80, 40, 0, 0],
  [80, 40, 0, 0],
  [137, 165, 0, 0],
  [195, 142, 0, 0],
  [250, 110, 0, 0],
  [29, 29, 14, 14],
];

function vaExit(w: number, h: number, lit: boolean): Canvas {
  const c = new Canvas(w, h);
  c.rect(0, 0, w, h, WHITE);
  c.rect(2, 2, w - 4, h - 4, lit ? [120, 150, 250, 255] : [80, 110, 220, 255]);
  // 「E X I T」四块
  for (let k = 0; k < 4; k++)
    c.rect(12 + k * Math.floor((w - 24) / 4), h / 2 - 5, Math.floor((w - 24) / 4) - 4, 10, WHITE);
  return c;
}

function bankFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    const d = VA_BANK_DIMS[f] ?? ([8, 8, 0, 0] as const);
    let c: Canvas;
    if (f === 0 || f === 2) {
      c = new Canvas(640, 480);
      c.rect(0, 0, 640, 480, f === 0 ? [214, 206, 196, 255] : [190, 200, 214, 255]);
      c.rect(0, 290, 640, 190, [120, 40, 30, 255]);
      if (f === 0) {
        // 董事长画框、柜员、两块名牌、EXIT（与原版烘焙的位置相同）
        c.rect(258, 42, 342, 240, [196, 164, 80, 255]);
        c.rect(268, 52, 322, 220, [150, 170, 190, 255]);
        c.blit(vaFigure([180, 430, 0, 0], [240, 190, 210, 255], 1), 80, 50);
        c.rect(280, 320, 130, 45, WHITE);
        c.rect(465, 320, 125, 45, WHITE);
        c.blit(vaExit(80, 40, false), 548, 431);
      } else {
        c.rect(380, 170, 240, 120, [150, 120, 90, 255]);
        c.blit(vaFigure([160, 240, 0, 0], [40, 70, 160, 255], 2), 460, 120);
      }
      c.dots(4, 4, f + 1, INK, 3);
    } else if (f === 1) {
      c = new Canvas(d[0], d[1]);
      for (let y = 0; y < d[1]; y += 8) c.rect(0, y, d[0], 6, [230, 222, 214, 255]);
    } else if (f <= 14) {
      c = vaBlock(d, [250, 214, 170, 255], f);
    } else if (f === 15) {
      c = new Canvas(200, 280);
      c.rect(0, 0, 200, 280, [238, 214, 160, 255]);
      c.frame(0, 0, 200, 280, [150, 110, 60, 255], 2);
      const bars = [98, 160, 223];
      for (const [i, y] of bars.entries()) {
        c.rect(10, y, 183, 32, [196, 214, 216, 255]);
        c.disc(24, y + 16, 9, hue(i * 3 + 1));
      }
    } else if (f === 16 || f === 17) {
      c = new Canvas(114, 40);
      c.rect(0, 0, 114, 40, WHITE);
      c.rect(2, 2, 110, 36, f === 17 ? [120, 150, 250, 255] : [80, 110, 220, 255]);
    } else if (f === 18 || f === 19) {
      c = vaExit(80, 40, f === 19);
    } else if (f === 20) {
      c = new Canvas(137, 165);
      c.rect(0, 0, 137, 165, [230, 120, 40, 255]);
      c.frame(0, 0, 137, 165, [60, 120, 60, 255], 3);
      for (let k = 1; k < 5; k++) c.rect(6, k * 33, 125, 2, [240, 200, 60, 255]);
    } else if (f === 21) {
      c = vaBalloon(195, 142, [255, 236, 240, 255], [250, 100, 20, 255], 'left');
    } else if (f === 22) {
      c = vaBalloon(250, 110, [250, 214, 170, 255], [140, 70, 30, 255], 'rightDown');
    } else {
      c = vaBan();
    }
    out.push(frameOf(c, d[2], d[3]));
  }
  return out;
}

// Panel#24 ATM：图0 本体、1/2 业务亮钮、3 EXIT 亮、4 计量条亮格、5–16 键帽按下、17 MAX、18 ↵、19–28 LCD 数字 0–9、29 禁止符号
const VA_ATM_COLS = [58, 97, 136] as const;
const VA_ATM_ROWS = [211, 230, 249, 268] as const;

function atmFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  const screen: Rgba = [96, 214, 170, 255];
  for (let f = 0; f < count; f++) {
    let c: Canvas;
    let ax = 0;
    let ay = 0;
    if (f === 0) {
      c = new Canvas(320, 338);
      c.rect(0, 0, 320, 338, [200, 200, 206, 255]);
      c.rect(0, 0, 320, 20, [40, 40, 20, 255]);
      c.rect(0, 318, 320, 20, [40, 40, 20, 255]);
      c.rect(50, 42, 220, 142, screen);
      c.frame(50, 42, 220, 142, [20, 60, 20, 255], 2);
      c.rect(57, 49, 80, 41, [20, 40, 140, 255]);
      c.rect(139, 49, 80, 41, [20, 40, 140, 255]);
      c.rect(221, 49, 43, 41, [140, 110, 40, 255]);
      for (let x = 58; x < 262; x += 6) c.rect(x, 145, 3, 16, [50, 150, 110, 255]);
      c.rect(52, 204, 186, 96, [20, 20, 24, 255]);
      for (let i = 0; i < 12; i++) {
        const x = VA_ATM_COLS[i % 3]!;
        const y = VA_ATM_ROWS[Math.floor(i / 3)]!;
        c.rect(x, y, 33, 17, [200, 212, 220, 255]);
        c.dots(x + 4, y + 6, (i % 3) + 1, INK, 3);
      }
      c.rect(183, 233, 49, 25, [210, 100, 90, 255]);
      c.rect(175, 260, 57, 25, [200, 212, 220, 255]);
    } else if (f <= 3) {
      const w = f === 3 ? 43 : 80;
      c = new Canvas(w, 41);
      c.rect(0, 0, w, 41, f === 3 ? [240, 110, 60, 255] : [60, 90, 240, 255]);
      c.frame(0, 0, w, 41, WHITE, 2);
      c.dots(4, 4, f, WHITE, 3);
    } else if (f === 4) {
      c = new Canvas(204, 26);
      for (let x = 0; x < 204; x += 6) c.rect(x, 4, 3, 18, [110, 240, 150, 255]);
    } else if (f <= 16) {
      c = vaBlock([33, 17, 0, 0], [255, 220, 90, 255], f - 4);
    } else if (f === 17) {
      c = vaBlock([49, 25, 0, 0], [255, 140, 120, 255], 1);
    } else if (f === 18) {
      c = vaBlock([57, 25, 0, 0], [255, 230, 120, 255], 1);
    } else if (f <= 28) {
      c = new Canvas(18, 32);
      c.rect(0, 0, 18, 32, screen);
      vaDigit(c, 3, 4, f - 19, 4, [16, 48, 24, 255]);
    } else {
      c = vaBan();
      ax = 14;
      ay = 14;
    }
    out.push(frameOf(c, ax, ay));
  }
  return out;
}

// Panel#10 百货：38 帧（见 ui.md §2.3）；图2 女巫锚点 (−52,208)、图3 (−3,146)、图18 女孩 (−21,229)、图19 (−21,212)、
// 图20–27 (6,0)、图28 (6,9)、图31 (6,8)、图32/33 (7,7)
const VA_SHOP_DIMS: readonly VaDim[] = [
  [640, 480, 0, 0],
  [222, 462, 0, 0],
  [173, 448, -52, 208],
  [93, 133, -3, 146],
  [50, 33, 0, 0],
  [50, 33, 0, 0],
  [50, 34, 0, 0],
  [50, 33, 0, 0],
  [50, 34, 0, 0],
  [50, 19, 0, 0],
  [50, 19, 0, 0],
  [50, 19, 0, 0],
  [50, 50, 0, 0],
  [85, 85, 0, 0],
  [85, 85, 0, 0],
  [270, 219, 0, 0],
  [640, 480, 0, 0],
  [222, 462, 0, 0],
  [182, 256, -21, 229],
  [68, 165, -21, 212],
  [70, 45, 6, 0],
  [70, 44, 6, 0],
  [70, 45, 6, 0],
  [70, 44, 6, 0],
  [70, 44, 6, 0],
  [70, 21, 6, 0],
  [70, 21, 6, 0],
  [70, 21, 6, 0],
  [70, 69, 6, 9],
  [85, 85, 0, 0],
  [85, 85, 0, 0],
  [13, 17, 6, 8],
  [14, 14, 7, 7],
  [14, 14, 7, 7],
  [235, 172, 0, 0],
  [80, 40, 0, 0],
  [80, 40, 0, 0],
  [90, 40, 0, 0],
];

/** 货架：页首 + 分隔线（卡片 15 行 × 26 从 60 起；道具 8 行 × 48 从 70 起） */
function vaShelf(item: boolean): Canvas {
  const c = new Canvas(222, 462);
  c.rect(0, 0, 222, 462, [230, 190, 60, 255]);
  c.rect(4, 4, 214, 454, item ? [214, 212, 200, 255] : [240, 160, 90, 255]);
  c.rect(8, 8, 206, item ? 58 : 48, [70, 110, 130, 255]);
  const [y0, h, n] = item ? [70, 48, 8] : [60, 26, 15];
  for (let k = 0; k <= n; k++) c.rect(8, y0 + k * h - 1, 206, 1, item ? WHITE : [220, 120, 70, 255]);
  if (!item) for (let k = 0; k < n; k++) c.rect(9, y0 + k * h + 4, 12, 16, [240, 100, 60, 255]);
  return c;
}

/** 翻页角（右上三角） */
function vaCorner(lit: boolean, col: Rgba): Canvas {
  const c = new Canvas(85, 85);
  for (let y = 0; y < 85; y++) for (let x = y; x < 85; x++) c.set(x, y, lit ? lighter(col, 0.3) : col);
  c.disc(62, 22, 10, WHITE);
  return c;
}

function shopFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    const d = VA_SHOP_DIMS[f] ?? ([8, 8, 0, 0] as const);
    let c: Canvas;
    if (f === 0 || f === 16) {
      c = new Canvas(640, 480);
      c.rect(0, 0, 640, 480, f === 0 ? [120, 70, 70, 255] : [150, 110, 80, 255]);
      c.rect(0, f === 0 ? 300 : 270, 640, 210, f === 0 ? [90, 110, 90, 255] : [130, 80, 50, 255]);
      c.dots(4, 4, f === 0 ? 1 : 2, WHITE, 3);
    } else if (f === 1 || f === 17) {
      c = vaShelf(f === 17);
    } else if (f === 2 || f === 18) {
      c = vaFigure(d, f === 2 ? [60, 160, 80, 255] : [60, 90, 200, 255], f === 2 ? 1 : 2);
    } else if (f === 3 || f === 19) {
      c = new Canvas(d[0], d[1]);
      c.rect(Math.round(d[0] / 3), 0, Math.round(d[0] / 3), d[1], [250, 214, 170, 255]);
    } else if (f === 13 || f === 14) {
      c = vaCorner(f === 14, [200, 120, 90, 255]);
    } else if (f === 29 || f === 30) {
      c = vaCorner(f === 30, [60, 160, 140, 255]);
    } else if (f === 15) {
      c = vaBalloon(270, 219, [220, 240, 250, 255], [110, 100, 200, 255], 'right');
    } else if (f === 34) {
      c = vaBalloon(235, 172, [255, 236, 240, 255], [250, 100, 20, 255], 'right');
    } else if (f === 35 || f === 36) {
      c = vaExit(80, 40, f === 36);
    } else if (f === 37) {
      c = new Canvas(90, 40);
      c.rect(0, 0, 90, 40, WHITE);
      c.rect(2, 2, 86, 36, [90, 120, 220, 255]);
      for (let k = 0; k < 3; k++) c.rect(8 + k * 6, 12 - k, 6, 16, [60, 220, 220, 255]);
    } else {
      c = vaBlock(d, [250, 214, 170, 255], f);
    }
    out.push(frameOf(c, d[2], d[3]));
  }
  return out;
}

// Panel#12 乐透投注：图0 底图（号码盘 9×4 格烘焙在图里）、1/2 猫女、3–6 表情、7 选号圈（锚点 28,25）、8 气泡、9 蓝条
function lotteryBetFrames(count: number): UiFrame[] {
  const dims: readonly VaDim[] = [
    [640, 480, 0, 0],
    [358, 298, 0, 0],
    [414, 302, 0, 0],
    [70, 42, 0, 0],
    [70, 42, 0, 0],
    [70, 18, 0, 0],
    [70, 18, 0, 0],
    [58, 47, 28, 25],
    [237, 192, 0, 0],
    [172, 28, 0, 0],
  ];
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    const d = dims[f] ?? ([8, 8, 0, 0] as const);
    let c: Canvas;
    if (f === 0) {
      c = new Canvas(640, 480);
      c.rect(0, 0, 640, 255, [30, 34, 40, 255]);
      c.rect(8, 255, 624, 222, [200, 120, 130, 255]);
      c.frame(8, 255, 624, 222, [240, 200, 120, 255], 4);
      for (let i = 0; i < 36; i++) {
        const cx = 60 + 64 * (i % 9);
        const cy = Math.trunc(296 + 47.67 * Math.floor(i / 9));
        const n = i + 1;
        vaDigit(c, cx - 12, cy - 7, Math.floor(n / 10), 3, [250, 230, 120, 255]);
        vaDigit(c, cx + 2, cy - 7, n % 10, 3, [250, 230, 120, 255]);
      }
    } else if (f === 1 || f === 2) {
      c = vaFigure(d, [240, 160, 40, 255], f);
    } else if (f === 7) {
      c = new Canvas(58, 47);
      for (let y = 0; y < 47; y++) {
        for (let x = 0; x < 58; x++) {
          const e = ((x - 28) / 27) ** 2 + ((y - 23) / 22) ** 2;
          if (e <= 1 && e >= 0.72) c.set(x, y, RED);
        }
      }
    } else if (f === 8) {
      c = vaBalloon(237, 192, [220, 240, 250, 255], [110, 100, 200, 255], 'left');
    } else if (f === 9) {
      c = new Canvas(172, 28);
      c.rect(0, 0, 172, 28, [20, 20, 230, 255]);
    } else {
      c = vaBlock(d, [250, 214, 170, 255], f);
    }
    out.push(frameOf(c, d[2], d[3]));
  }
  return out;
}

// Panel#15 乐透开奖：图0 舞台、1–6 主持人、7–21 表情、22 心形气泡（尾巴在右）、23/24 爆炸框、25–36 角色小头、37–46 号码球 0–9
const VA_DRAW_HEADS: readonly VaDim[] = [
  [40, 34, 20, 17],
  [31, 30, 16, 18],
  [28, 25, 12, 12],
  [32, 36, 17, 17],
  [36, 31, 19, 15],
  [37, 33, 19, 16],
  [35, 33, 18, 16],
  [35, 30, 18, 15],
  [35, 35, 18, 18],
  [33, 34, 17, 17],
  [34, 29, 18, 14],
  [28, 32, 15, 15],
];
const VA_DRAW_DIMS: readonly VaDim[] = [
  [640, 480, 0, 0],
  [152, 413, 0, 0],
  [206, 413, 0, 0],
  [134, 422, 0, 0],
  [127, 364, 0, 0],
  [124, 411, 0, 0],
  [162, 460, 0, 0],
  ...vaRep(4, [50, 17, 0, 0]),
  ...vaRep(3, [50, 23, 0, 0]),
  ...vaRep(4, [50, 26, 0, 0]),
  ...vaRep(3, [50, 14, 0, 0]),
  [50, 40, 0, 0],
  [187, 140, 0, 0],
  [233, 192, 120, 98],
  [295, 262, 147, 130],
  ...VA_DRAW_HEADS,
  ...vaRep(10, [71, 70, 35, 35]),
];

/** 爆炸框：锯齿星形 */
function vaBurst(w: number, h: number, fill: Rgba, edge: Rgba): Canvas {
  const c = new Canvas(w, h);
  const cx = w / 2;
  const cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = Math.atan2(y - cy, x - cx);
      const r = 0.78 + 0.22 * Math.abs(Math.sin(a * 6));
      const e = ((x - cx) / (w / 2)) ** 2 + ((y - cy) / (h / 2)) ** 2;
      if (e <= r * r) c.set(x, y, e > (r - 0.08) ** 2 ? edge : fill);
    }
  }
  return c;
}

function lotteryDrawFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    const d = VA_DRAW_DIMS[f] ?? ([8, 8, 0, 0] as const);
    let c: Canvas;
    if (f === 0) {
      c = new Canvas(640, 480);
      c.rect(0, 0, 640, 480, [30, 50, 150, 255]);
      c.rect(0, 380, 640, 100, [70, 110, 190, 255]);
      c.disc(319, 230, 130, [150, 180, 230, 255]);
      c.rect(250, 340, 140, 60, [200, 200, 210, 255]);
      c.rect(160, 20, 320, 30, [230, 60, 60, 255]);
    } else if (f <= 6) {
      c = vaFigure(d, [60, 160, 60, 255], f);
      if (f === 3 || f === 6) c.rect(8, 90, d[0] - 16, 120, [250, 190, 60, 255]);
    } else if (f === 22) {
      c = vaBalloon(187, 140, [255, 236, 240, 255], [250, 100, 20, 255], 'right');
    } else if (f === 23) {
      c = vaBurst(233, 192, [255, 240, 170, 255], [40, 140, 140, 255]);
    } else if (f === 24) {
      c = vaBurst(295, 262, [255, 214, 190, 255], [240, 50, 30, 255]);
    } else if (f >= 25 && f <= 36) {
      c = new Canvas(d[0], d[1]);
      c.disc((d[0] - 1) / 2, (d[1] - 1) / 2, Math.min(d[0], d[1]) / 2 - 1, hue(f - 25));
      c.dots(Math.max(1, Math.round(d[0] / 2 - 8)), Math.round(d[1] / 2 - 1), Math.min(f - 24, 5), INK);
    } else if (f >= 37) {
      c = new Canvas(71, 70);
      c.disc(35, 34.5, 34, [60, 60, 70, 255]);
      c.disc(35, 34.5, 31, [210, 214, 226, 255]);
      vaDigit(c, 26, 20, f - 37, 6, INK);
    } else {
      c = vaBlock(d, [250, 214, 170, 255], f);
    }
    out.push(frameOf(c, d[2], d[3]));
  }
  return out;
}

// Panel#75 股市：图0/1 两页 640×480 表格（顶栏 6 格、6 列、13 行 × 32 从 48 起）、图2 详情 587×375、图3–11 行业图 80×112
const VA_STOCK_COLS = [15, 136, 240, 320, 416, 521, 624] as const;
const VA_STOCK_HEAD: readonly (readonly [number, number])[] = [
  [16, 124],
  [128, 198],
  [202, 271],
  [276, 409],
  [414, 548],
  [553, 622],
];

function stockFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    let c: Canvas;
    if (f <= 1) {
      c = new Canvas(640, 480);
      c.rect(0, 0, 640, 480, [10, 12, 24, 255]);
      for (const [x0, x1] of VA_STOCK_HEAD) c.rect(x0, 8, x1 - x0, 30, [40, 80, 200, 255]);
      c.rect(600, 12, 18, 22, [200, 40, 40, 255]);
      c.rect(15, 48, 609, 416, f === 0 ? [50, 90, 50, 255] : [200, 140, 50, 255]);
      for (let r = 0; r <= 13; r++) c.rect(15, 48 + r * 32, 609, 1, [80, 70, 90, 255]);
      for (const x of VA_STOCK_COLS) c.rect(x, 48, 1, 416, [80, 70, 90, 255]);
    } else if (f === 2) {
      c = new Canvas(587, 375);
      c.rect(0, 0, 587, 375, [200, 140, 50, 255]);
      c.frame(0, 0, 587, 375, [120, 80, 30, 255], 4);
      c.frame(21, 51, 87, 120, INK, 2);
      const bands: Rgba[] = [
        [240, 170, 20, 255],
        [250, 100, 20, 255],
        [40, 70, 170, 255],
        [20, 110, 40, 255],
        [180, 30, 60, 255],
        [220, 50, 60, 255],
      ];
      for (const [i, col] of bands.entries()) c.rect(66 + i * 48, 208, 48, 128, col);
      for (let y = 0; y < 375; y++) {
        for (let x = 0; x < 587; x++) {
          const e = ((x - 476) / 88) ** 2 + ((y - 310) / 32) ** 2;
          if (e <= 1) c.set(x, y, e > 0.8 ? [0, 60, 200, 255] : [0, 170, 210, 255]);
        }
      }
    } else {
      c = vaBlock([80, 112, 0, 0], lighter(hue(f - 3), 0.2), f - 2);
    }
    out.push(frameOf(c));
  }
  return out;
}

/** 场所屏第一组的精灵条目：逻辑键 → 帧生成函数 */
function venuesAFrames(): Record<string, (count: number) => UiFrame[]> {
  return {
    'venue.bank.screen': bankFrames,
    'venue.bank.atm': atmFrames,
    'venue.shop.screen': shopFrames,
    'venue.lottery.bet': lotteryBetFrames,
    'venue.lottery.draw': lotteryDrawFrames,
    'venue.stock.screen': stockFrames,
  };
}

/** 跑马灯（Panel#14 213×68×5，索引 0 透明）：一圈灯泡轮流亮 */
function marqueeFlc(w: number, h: number, frames: number, frameMs: number): Uint8Array {
  const palette = new Uint8Array(768);
  palette.set([120, 80, 20], 3);
  palette.set([255, 240, 150], 6);
  palette.set([10, 10, 10], 9);
  const out: Uint8Array[] = [];
  for (let f = 0; f < frames; f++) {
    const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const edge = x < 12 || y < 12 || x >= w - 12 || y >= h - 12;
        if (edge) px[y * w + x] = Math.floor((x + y) / 12) % frames === f ? 2 : 1;
        else if (x >= 16 && y >= 16 && x < w - 16 && y < h - 16) px[y * w + x] = 3;
      }
    }
    out.push(px);
  }
  return encodeFlc(w, h, frameMs, out, palette);
}

/** 摇奖机（Panel#16 275×270×42，不透明）：玻璃球里的号码球绕圈 */
function lotteryMachineFlc(w: number, h: number, frames: number, frameMs: number): Uint8Array {
  const palette = new Uint8Array(768);
  palette.set([30, 50, 150], 0);
  palette.set([150, 180, 230], 3);
  palette.set([210, 214, 226], 6);
  palette.set([24, 16, 8], 9);
  const out: Uint8Array[] = [];
  for (let f = 0; f < frames; f++) {
    const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++)
        if ((x - w / 2) ** 2 + (y - h / 2) ** 2 <= (Math.min(w, h) / 2 - 4) ** 2) px[y * w + x] = 1;
    }
    for (let k = 0; k < 8; k++) {
      const a = (f / frames) * Math.PI * 4 + (k * Math.PI * 2) / 8;
      const cx = Math.round(w / 2 + Math.cos(a) * 80);
      const cy = Math.round(h / 2 + Math.sin(a * 1.3) * 70);
      for (let y = -12; y <= 12; y++) {
        for (let x = -12; x <= 12; x++) {
          if (x * x + y * y > 144) continue;
          px[(cy + y) * w + cx + x] = x * x + y * y > 110 ? 3 : 2;
        }
      }
    }
    out.push(px);
  }
  return encodeFlc(w, h, frameMs, out, palette);
}

/** 场所屏第一组的合成 FLC */
function venuesAFlics(): Record<string, (w: number, h: number, frames: number, frameMs: number) => Uint8Array> {
  return {
    'venue.lottery.marquee': marqueeFlc,
    'venue.lottery.machine': lotteryMachineFlc,
  };
}

/** 合成包里场所屏第一组的键（测试用） */
export function synthVenuesA(): { sprites: string[]; flics: string[] } {
  return { sprites: Object.keys(venuesAFrames()), flics: Object.keys(venuesAFlics()) };
}

/** 测试用：直接生成某个精灵条目的帧（[w, h, ax, ay]），不必整包构建 */
export function synthVenuesASpriteDims(key: string, count: number): [number, number, number, number][] {
  const make = venuesAFrames()[key];
  if (!make) throw new Error(`场所屏第一组没有精灵 ${key}`);
  return make(count).map((f) => [f.w, f.h, f.ax, f.ay]);
}

/** 测试用：直接生成某段 FLC 的字节 */
export function synthVenuesAFlic(key: string, w: number, h: number, frames: number, frameMs: number): Uint8Array {
  const make = venuesAFlics()[key];
  if (!make) throw new Error(`场所屏第一组没有 FLC ${key}`);
  return make(w, h, frames, frameMs);
}

/** 写进合成包：场所屏第一组的 FLC（精灵随 UI_FRAMES 一起写） */
async function addSyntheticVenuesAFlics(
  writer: PackWriter,
  byKey: ReadonlyMap<string, Catalog['items'][number]>,
): Promise<void> {
  for (const [key, make] of Object.entries(venuesAFlics())) {
    const it = byKey.get(key);
    if (it?.type !== 'flic') throw new Error(`资源目录缺少 ${key}`);
    const d = (it as FlicItem).def;
    const file = `flic/synthetic-ui/${key}.flc`;
    await writer.writeFile(file, make(d.w, d.h, d.frames, d.frameMs), 'flic', it.group);
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

// ───────────────────────── A11：原版通用对话框与弹窗 ─────────────────────────
//
// 客户端布局依赖的尺寸、锚点与格子位置取原版值（ui/classic/dialogs/parts.tsx、ui/classic/popups/layout.ts；本机素材包
// 逐像素统计）：
// - ui.cursor（Data#0，43 帧）：帧尺寸与锚点同原版；图27 手形（锚点在指尖 10,2）、图6–11 准星、图34–41 八向箭头；
// - ui.itemBar（Panel#11）：图0/1 卡片欄 / 道具欄 412×180，5×3 格（格子 78×54、左上 (6,6)、步距 80×56）；图2–14 道具图标、
//   图15/16 80×56；ui.itemIcons（Panel#74）13 个小图标；
// - ui.playerPicker（Data#477）：177/257/337×97（锚点居中），格子 72×72、左上 (12,12)、步距 80；
// - ui.newsBoard（Panel#66）：440×480，插图框 (25,44) 388×251；ui.godSlot（Panel#67）：机身、拉杆、滚轮条 38×36
//   （图 4+2d = 数字 d）；ui.roulette.0–3（Panel#68–71 = 航空 / 旅馆 / 购物中心 / 保险）：天使两帧 + 转盘 12 帧（每帧顺时针
//   30°，扇区数值同原版盘面；转盘帧锚点一律 (82,82) 是我们的取值，原版逐帧在 (81..83, 81..83) 之间浮动）；
// - venue.monthly.screen（Panel#25，83 帧）：底图、MONEY 卡（名次格 (19+83i,41) 64×88）、名次 1–4、主持人、Q 版小人；
// - venue.assets.screen（Panel#9，25 帧）：三页 640×480（数值栏、道具 / 卡片格、表格线同原版位置）、EXIT、箭头、蓝钮、神明小像；
// - ui.autoplay（Panel#77，18 帧）：托管对话框 435×355（红点、滑杆刻度、框钮位置同原版）、页签、红点、箭头、12 个圆头像；
// - card.1–30（Data#530–559）165×256、illustration.news.0–35（Data#400–435）388×251、illustration.fate.0–39
//   （Data#436–475，命运板插图，按 exe 0x473dd8 的插图表被 49 个命运表项引用）388×251，都是不透明整图（卡片四角涂黑）。
// - illustration.holiday.<n>（SYNTH_HOLIDAY_ART：四张图各自的首末 slot）200×200 不透明占位，按 gm 换底色、中间画 slot。
// 内容全部是自绘色块、线条与点阵，不含原版像素。

/** [宽, 高, 锚点 x, 锚点 y] */
type A11Geom = readonly [number, number, number, number];

const A11_CURSOR: readonly A11Geom[] = [
  [27, 18, 14, 9],
  [29, 29, 15, 15],
  [18, 31, 9, 16],
  [12, 29, 5, 14],
  [12, 28, 6, 14],
  [32, 32, 16, 16],
  [32, 30, 15, 15],
  [32, 29, 15, 14],
  [31, 29, 15, 14],
  [31, 29, 15, 14],
  [31, 29, 15, 14],
  [31, 29, 15, 14],
  [20, 26, 10, 13],
  [18, 26, 10, 13],
  [14, 28, 8, 14],
  [10, 28, 6, 14],
  [3, 28, 3, 14],
  [4, 28, 4, 14],
  [11, 28, 8, 14],
  [15, 28, 10, 14],
  [18, 26, 12, 13],
  [20, 25, 12, 13],
  [4, 28, 1, 14],
  [3, 28, 1, 14],
  [10, 28, 5, 14],
  [14, 28, 7, 14],
  [18, 26, 9, 13],
  [30, 31, 10, 2],
  [29, 27, 0, 0],
  [28, 27, 1, 1],
  [30, 29, 4, 4],
  [28, 28, 4, 4],
  [32, 30, 16, 15],
  [32, 26, 16, 13],
  [24, 32, 12, 2],
  [25, 25, 23, 2],
  [32, 24, 30, 12],
  [25, 25, 23, 23],
  [24, 32, 12, 30],
  [25, 25, 2, 23],
  [32, 24, 2, 12],
  [23, 23, 1, 1],
  [31, 17, 16, 9],
];

const A11_ITEM_ICONS: readonly A11Geom[] = [
  [40, 34, 20, 17],
  [38, 25, 19, 12],
  [39, 39, 20, 20],
  [22, 38, 11, 19],
  [34, 19, 17, 11],
  [39, 20, 20, 10],
  [14, 32, 7, 16],
  [38, 38, 19, 19],
  [32, 40, 16, 20],
  [36, 32, 18, 16],
  [34, 15, 17, 7],
  [34, 19, 17, 8],
  [14, 36, 7, 18],
];

const A11_SMALL_ICONS: readonly A11Geom[] = [
  [24, 20, 12, 10],
  [24, 16, 12, 8],
  [23, 24, 10, 12],
  [14, 23, 7, 12],
  [21, 12, 11, 7],
  [23, 13, 12, 6],
  [10, 21, 5, 10],
  [22, 22, 12, 10],
  [20, 24, 10, 12],
  [24, 20, 12, 10],
  [20, 9, 10, 4],
  [21, 12, 11, 5],
  [10, 23, 5, 12],
];

/** Panel#25：83 帧（底图、对话框、羊皮纸、MONEY 卡、名次、主持人与表情、Q 版小人） */
const A11_MONTHLY: readonly A11Geom[] = [
  [640, 480, 0, 0],
  [290, 201, 0, 0],
  [278, 98, 139, 49],
  [239, 193, 0, 0],
  [195, 142, 0, 0],
  [353, 450, 0, 0],
  [43, 75, 18, 39],
  [53, 72, 24, 35],
  [60, 76, 31, 38],
  [63, 83, 32, 40],
  [26, 16, 12, 7],
  [160, 71, 0, 0],
  [159, 71, 0, 0],
  [159, 71, 0, 0],
  [159, 71, 0, 0],
  [142, 348, 0, 0],
  [142, 348, 0, 0],
  [142, 348, 0, 0],
  [142, 348, 0, 0],
  [186, 410, 0, 0],
  [80, 40, 0, 0],
  [80, 40, 0, 0],
  [80, 20, 0, 0],
  [80, 20, 0, 0],
  [233, 410, 0, 0],
  [60, 38, 0, 0],
  [60, 38, 0, 0],
  [60, 37, 0, 0],
  [60, 38, 0, 0],
  [60, 25, 0, 0],
  [60, 25, 0, 0],
  [277, 409, 0, 0],
  [173, 413, 0, 0],
  [76, 43, 0, 0],
  [76, 43, 0, 0],
  [76, 27, 0, 0],
  [76, 27, 0, 0],
  [313, 391, 0, 0],
  [238, 415, 0, 0],
  [70, 33, 0, 0],
  [70, 33, 0, 0],
  [70, 27, 0, 0],
  [195, 416, 0, 0],
  [60, 40, 0, 0],
  [60, 40, 0, 0],
  [210, 420, 0, 0],
  [81, 42, 0, 0],
  [66, 72, 33, 36],
  [66, 72, 33, 36],
  [65, 72, 33, 36],
  [66, 68, 33, 34],
  [66, 68, 33, 34],
  [66, 68, 33, 34],
  [42, 68, 22, 31],
  [43, 69, 21, 35],
  [42, 68, 22, 31],
  [36, 58, 18, 29],
  [36, 58, 18, 29],
  [36, 58, 18, 29],
  [48, 66, 24, 33],
  [48, 66, 24, 33],
  [48, 66, 24, 33],
  [42, 58, 21, 28],
  [42, 58, 21, 28],
  [42, 57, 21, 28],
  [44, 78, 22, 39],
  [45, 89, 22, 50],
  [44, 78, 22, 39],
  [62, 78, 31, 39],
  [62, 78, 31, 39],
  [62, 78, 31, 39],
  [60, 68, 30, 34],
  [60, 68, 30, 34],
  [60, 68, 30, 34],
  [46, 61, 23, 30],
  [48, 61, 24, 30],
  [46, 60, 23, 30],
  [51, 69, 32, 34],
  [50, 68, 30, 34],
  [52, 69, 31, 34],
  [32, 58, 16, 27],
  [32, 58, 16, 27],
  [32, 58, 16, 27],
];

/** Panel#9 图3–24 */
const A11_ASSETS_PARTS: readonly A11Geom[] = [
  [88, 33, 0, 0],
  [88, 32, 0, 0],
  [58, 19, 29, 9],
  [53, 18, 27, 9],
  [30, 30, 0, 0],
  [30, 30, 0, 0],
  [30, 30, 0, 0],
  [30, 30, 0, 0],
  [75, 33, 0, 0],
  [97, 40, 0, 0],
  [42, 54, 21, 27],
  [57, 61, 28, 30],
  [44, 63, 22, 33],
  [47, 51, 23, 25],
  [52, 38, 26, 19],
  [42, 54, 22, 27],
  [43, 45, 22, 23],
  [30, 55, 15, 27],
  [39, 50, 19, 25],
  [40, 49, 20, 24],
  [43, 45, 22, 22],
  [38, 54, 19, 27],
];

/** Panel#77 图6–17 圆头像 */
const A11_HEADS: readonly A11Geom[] = [
  [85, 71, 42, 34],
  [70, 65, 35, 32],
  [66, 60, 33, 31],
  [67, 74, 34, 37],
  [77, 65, 40, 35],
  [77, 71, 39, 37],
  [76, 72, 39, 37],
  [79, 67, 40, 33],
  [78, 76, 39, 40],
  [73, 72, 37, 35],
  [74, 64, 35, 32],
  [58, 66, 34, 33],
];

/** 转盘扇区（从正上方起顺时针，与客户端 popups/layout.ts 的 WHEELS 同序） */
const A11_WHEELS: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 2, 1],
  [1, 2, 3, 4],
  [6, 1, 2, 3, 4, 5],
  [3, 5, 10, 15, 20, 30],
];

const A11_GRID_LINE: Rgba = [20, 20, 20, 255];

/** 一个通用色块帧：底色 + 描边 + 帧号点阵 */
function a11Box(g: A11Geom, color: Rgba, n: number): UiFrame {
  const [w, h, ax, ay] = g;
  const c = new Canvas(w, h);
  c.rect(0, 0, w, h, color);
  if (w > 2 && h > 2) c.frame(0, 0, w, h, INK);
  if (w >= 8 && h >= 6) c.dots(2, 2, Math.min(n + 1, Math.max(1, Math.floor((w - 4) / 3))), INK);
  return frameOf(c, ax, ay);
}

/** 画一个数字（放大的 7 段字模，scale 倍） */
function a11Digit(c: Canvas, d: number, x: number, y: number, scale: number, col: Rgba): void {
  const src = lcdDigit(d);
  for (let yy = 0; yy < src.h; yy++) {
    for (let xx = 0; xx < src.w; xx++) {
      if ((src.rgba[(yy * src.w + xx) * 4 + 3] ?? 0) === 0) continue;
      c.rect(x + xx * scale, y + yy * scale, scale, scale, col);
    }
  }
}

function a11Number(c: Canvas, v: number, cx: number, cy: number, scale: number, col: Rgba): void {
  const s = String(Math.max(0, Math.trunc(v)));
  const w = s.length * 10 * scale;
  let x = Math.round(cx - w / 2);
  for (const ch of s) {
    a11Digit(c, Number(ch), x, Math.round(cy - 9.5 * scale), scale, col);
    x += 10 * scale;
  }
}

function a11CursorFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    const g = A11_CURSOR[f] ?? [16, 16, 8, 8];
    const [w, h, ax, ay] = g;
    if (f === 27) {
      // 手形：食指朝上，指尖在锚点
      const c = new Canvas(w, h);
      c.rect(ax - 2, ay, 5, 16, INK);
      c.rect(ax - 1, ay + 1, 3, 14, WHITE);
      c.rect(ax - 3, ay + 13, 20, 16, INK);
      c.rect(ax - 2, ay + 14, 18, 14, WHITE);
      out.push(frameOf(c, ax, ay));
    } else if (f >= 6 && f <= 11) {
      // 准星：圆圈 + 十字（图9–11 红靶）
      const c = new Canvas(w, h);
      const col: Rgba = f >= 9 ? RED : WHITE;
      for (let a = 0; a < 64; a++) {
        const t = (a / 64) * Math.PI * 2;
        c.rect(Math.round(ax + Math.cos(t) * 11), Math.round(ay + Math.sin(t) * 11), 2, 2, col);
      }
      c.rect(ax - 14, ay, 29, 1, col);
      c.rect(ax, ay - 13, 1, 27, col);
      out.push(frameOf(c, ax, ay));
    } else if (f >= 34 && f <= 41) {
      // 箭头：从帧中心指向锚点
      const c = new Canvas(w, h);
      const cx = w / 2;
      const cy = h / 2;
      for (let k = 0; k <= 20; k++) {
        const x = Math.round(cx + ((ax - cx) * k) / 20);
        const y = Math.round(cy + ((ay - cy) * k) / 20);
        c.rect(x - 2, y - 2, 4, 4, [255, 200, 40, 255]);
      }
      c.rect(ax - 1, ay - 1, 3, 3, INK);
      out.push(frameOf(c, ax, ay));
    } else {
      out.push(a11Box(g, lighter(hue(f), 0.3), f));
    }
  }
  return out;
}

/** 卡片欄 / 道具欄底图（5×3 格，格线位置同原版） */
function a11Bar(base: Rgba): Canvas {
  const c = new Canvas(412, 180);
  c.rect(0, 0, 412, 180, [214, 170, 60, 255]);
  c.rect(5, 5, 400, 168, A11_GRID_LINE);
  for (let r = 0; r < 3; r++) {
    for (let k = 0; k < 5; k++) c.rect(6 + k * 80, 6 + r * 56, 78, 54, lighter(base, ((r + k) % 2) * 0.12));
  }
  return c;
}

function a11ItemBarFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    if (f === 0) out.push(frameOf(a11Bar([88, 168, 150, 255])));
    else if (f === 1) out.push(frameOf(a11Bar([212, 128, 100, 255])));
    else if (f <= 14) {
      const g = A11_ITEM_ICONS[f - 2]!;
      const [w, h, ax, ay] = g;
      const c = new Canvas(w, h);
      c.disc((w - 1) / 2, (h - 1) / 2, Math.min(w, h) / 2 - 0.5, hue(f));
      c.dots(Math.max(0, Math.round(w / 2 - 6)), Math.round(h / 2 - 1), Math.min(4, f - 1), WHITE);
      out.push(frameOf(c, ax, ay));
    } else {
      const c = new Canvas(80, 56);
      c.rect(0, 0, 80, 56, [212, 128, 100, 255]);
      c.frame(0, 0, 80, 56, INK);
      for (let k = 0; k < 40; k++) c.rect(20 + k, 8 + k, 3, 3, RED);
      out.push(frameOf(c));
    }
  }
  return out;
}

function a11ItemIconFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    const [w, h, ax, ay] = A11_SMALL_ICONS[f] ?? [16, 16, 8, 8];
    const c = new Canvas(w, h);
    c.rect(1, 1, w - 2, h - 2, hue(f + 2));
    c.frame(0, 0, w, h, INK);
    out.push(frameOf(c, ax, ay));
  }
  return out;
}

function a11PickerFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    const n = f + 2;
    const w = 17 + 80 * n;
    const c = new Canvas(w, 97);
    c.rect(0, 0, w, 97, [40, 130, 70, 255]);
    c.frame(0, 0, w, 97, [200, 240, 220, 255], 2);
    for (let i = 0; i < n; i++) c.rect(12 + i * 80, 12, 72, 72, [255, 250, 205, 255]);
    out.push(frameOf(c, Math.floor(w / 2), 48));
  }
  return out;
}

function a11NewsBoardFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    const c = new Canvas(440, 480);
    const top: Rgba = f === 0 ? [90, 210, 240, 255] : [200, 70, 170, 255];
    const bottom: Rgba = f === 0 ? [60, 80, 130, 255] : [80, 40, 90, 255];
    for (let y = 0; y < 480; y++) {
      const k = y / 479;
      c.rect(0, y, 440, 1, [
        Math.round(top[0] + (bottom[0] - top[0]) * k),
        Math.round(top[1] + (bottom[1] - top[1]) * k),
        Math.round(top[2] + (bottom[2] - top[2]) * k),
        255,
      ]);
    }
    // 斜排的点阵花纹（代替 NEWS / ? 字样）
    for (let y = 8; y < 480; y += 32)
      for (let x = (y % 64) - 8; x < 440; x += 64) c.dots(x, y, f === 0 ? 4 : 1, WHITE, 3);
    c.rect(28, 47, 388, 251, [20, 20, 30, 255]);
    c.rect(25, 44, 388, 251, WHITE);
    out.push(frameOf(c));
  }
  return out;
}

/** 老虎机滚轮条：数字 d 居中；half 时 d 往上、d+1 从下方露出一半 */
function a11Reel(d: number, half: boolean): Canvas {
  const c = new Canvas(38, 36);
  c.rect(0, 0, 38, 36, WHITE);
  c.frame(0, 0, 38, 36, [120, 120, 120, 255]);
  const reel = new Canvas(38, 36);
  if (half) {
    a11Digit(reel, d % 10, 10, -10, 2, INK);
    a11Digit(reel, (d + 1) % 10, 10, 26, 2, INK);
  } else a11Digit(reel, d % 10, 10, -1, 2, INK);
  c.blit(reel, 0, 0);
  return c;
}

function a11GodSlotFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    if (f <= 1) {
      const n = f === 0 ? 4 : 3;
      const w = f === 0 ? 193 : 156;
      const c = new Canvas(w, 183);
      c.rect(0, 0, w, 183, [214, 120, 60, 255]);
      c.frame(0, 0, w, 183, [120, 50, 20, 255], 3);
      c.rect(12, 20, w - 24, 50, [70, 120, 220, 255]);
      c.rect(16, 94, 37 * n + 10, 42, [40, 40, 40, 255]);
      for (let i = 0; i < n; i++) c.blit(a11Reel(6, false), 21 + i * 37, 97);
      c.rect(14, 150, w - 28, 18, [200, 200, 205, 255]);
      out.push(frameOf(c, f === 0 ? 96 : 78, 98));
    } else if (f === 2) {
      const c = new Canvas(31, 108);
      c.rect(12, 14, 7, 94, [60, 60, 60, 255]);
      c.disc(15, 10, 9, RED);
      out.push(frameOf(c));
    } else if (f === 3) {
      const c = new Canvas(31, 72);
      c.rect(12, 0, 7, 60, [60, 60, 60, 255]);
      c.disc(15, 62, 9, RED);
      out.push(frameOf(c, 0, -35));
    } else {
      const k = f - 4;
      out.push(frameOf(a11Reel(Math.floor(k / 2), k % 2 === 1)));
    }
  }
  return out;
}

function a11RouletteFrames(wheel: number): (count: number) => UiFrame[] {
  return (count) => {
    const sectors = A11_WHEELS[wheel]!;
    const n = sectors.length;
    const out: UiFrame[] = [];
    for (let f = 0; f < count; f++) {
      if (f <= 1) {
        // 天使：白翼 + 金色魔杖（两态）
        const w = f === 0 ? 75 : 87;
        const c = new Canvas(w, 61);
        c.disc(22, 30, 16, [255, 236, 210, 255]);
        c.disc(12, 20, 10, WHITE);
        c.rect(34, 30, w - 40, 3, [240, 200, 40, 255]);
        if (f === 1) c.disc(w - 6, 31, 5, [255, 240, 120, 255]);
        out.push(frameOf(c, f === 0 ? -6 : 0, 0));
        continue;
      }
      const rot = ((f - 2) * 30 * Math.PI) / 180;
      const c = new Canvas(165, 165);
      const cx = 82;
      const cy = 82;
      const step = (Math.PI * 2) / n;
      for (let y = 0; y < 165; y++) {
        for (let x = 0; x < 165; x++) {
          const dx = x - cx;
          const dy = y - cy;
          const r = Math.hypot(dx, dy);
          if (r > 81) continue;
          if (r > 78) {
            c.set(x, y, WHITE);
            continue;
          }
          // 顺时针、从正上方起算的角度，扣掉转盘的旋转
          const a = (Math.atan2(dx, -dy) - rot + Math.PI * 4 + step / 2) % (Math.PI * 2);
          const j = Math.floor(a / step) % n;
          c.set(x, y, j === 0 ? lighter(hue(sectors[j]!), 0.25) : hue(sectors[j]!));
        }
      }
      for (let j = 0; j < n; j++) {
        const t = j * step + rot;
        a11Number(c, sectors[j]!, cx + Math.sin(t) * 55, cy - Math.cos(t) * 55, 1, WHITE);
      }
      c.disc(cx, cy, 5, WHITE);
      out.push(frameOf(c, 82, 82));
    }
    return out;
  };
}

function a11MonthlyFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    const g = A11_MONTHLY[f] ?? [16, 16, 0, 0];
    const [w, h, ax, ay] = g;
    const c = new Canvas(w, h);
    if (f === 0) {
      c.rect(0, 0, w, h, [110, 150, 210, 255]);
      for (let y = 10; y < h; y += 40)
        for (let x = (y % 80) / 2; x < w; x += 40) c.dots(x, y, 3, [150, 190, 240, 255], 4);
    } else if (f === 2) {
      c.rect(0, 0, w, h, [60, 140, 70, 255]);
      c.rect(6, 6, w - 12, h - 12, [245, 232, 200, 255]);
    } else if (f === 5) {
      c.rect(0, 0, w, h, [200, 110, 60, 255]);
      c.rect(5, 5, w - 10, h - 10, [252, 236, 205, 255]);
      for (let i = 0; i < 4; i++) c.rect(19 + i * 83, 41, 64, 88, [246, 198, 160, 255]);
      for (let k = 0; k < 120; k++) c.rect(40 + k * 2, 380 - k, 3, 3, [240, 170, 180, 255]);
    } else if (f >= 6 && f <= 9) {
      a11Digit(c, f - 5, Math.round(w / 2 - 13), Math.round(h / 2 - 28), 3, hue(f));
    } else if (f === 19) {
      c.disc(w / 2, 60, 40, [120, 70, 40, 255]);
      c.disc(w / 2, 64, 30, [250, 214, 180, 255]);
      c.rect(w / 2 - 50, 100, 100, 150, [250, 200, 220, 255]);
      c.rect(w / 2 - 45, 250, 90, 100, [60, 130, 220, 255]);
    } else if (f >= 47) {
      const ch = Math.floor((f - 47) / 3);
      const pose = (f - 47) % 3;
      c.disc(w / 2, h * 0.28, Math.min(w, h) * 0.26, hue(ch));
      c.disc(w / 2, h * 0.3, Math.min(w, h) * 0.18, [250, 214, 170, 255]);
      c.rect(Math.round(w * 0.25), Math.round(h * 0.52), Math.round(w * 0.5), Math.round(h * 0.3), hue(ch));
      c.rect(Math.round(w * 0.25) + pose * 3, Math.round(h * 0.82), 6, Math.round(h * 0.16), INK);
      c.rect(Math.round(w * 0.65) - pose * 3, Math.round(h * 0.82), 6, Math.round(h * 0.16), INK);
    } else {
      out.push(a11Box(g, lighter(hue(f), 0.5), f));
      continue;
    }
    out.push(frameOf(c, ax, ay));
  }
  return out;
}

/** 资产表页面（格局同原版：标题栏与牌匾、数值栏、道具 / 卡片格、表格线） */
function a11AssetsPage(page: number): Canvas {
  const c = new Canvas(640, 480);
  c.rect(0, 0, 640, 480, [160, 200, 205, 255]);
  c.frame(0, 0, 640, 480, [200, 110, 60, 255], 5);
  c.rect(5, 5, 630, 40, [40, 110, 120, 255]);
  c.rect(492, 10, 108, 27, [200, 140, 60, 255]);
  c.frame(24, 57, 74, 74, [60, 100, 110, 255]);
  c.frame(25, 153, 70, 94, [60, 100, 110, 255], 2);
  if (page === 0) {
    for (let i = 0; i < 4; i++) {
      c.rect(176, 72 + i * 48, 160, 32, [150, 200, 225, 255]);
      c.rect(464, 72 + i * 48, 144, 32, [150, 200, 225, 255]);
      c.rect(176, 280 + i * 48, 82, 32, [150, 200, 225, 255]);
    }
    const grid = (y0: number, col: Rgba): void => {
      c.rect(264, y0 - 1, 360, 98, A11_GRID_LINE);
      for (let r = 0; r < 3; r++) for (let k = 0; k < 5; k++) c.rect(265 + k * 72, y0 + r * 32, 70, 30, col);
    };
    grid(266, [230, 156, 115, 255]);
    grid(369, [110, 160, 130, 255]);
  } else if (page === 1) {
    for (const x of [120, 215, 311, 399, 495, 583]) c.rect(x, 64, 1, 384, A11_GRID_LINE);
    for (let r = 0; r <= 12; r++) c.rect(120, 64 + r * 32, 464, 1, A11_GRID_LINE);
    c.rect(121, 65, 462, 30, [170, 95, 45, 255]);
  } else {
    for (const x of [144, 263, 399, 551]) c.rect(x, 83, 1, 354, A11_GRID_LINE);
    for (let r = 0; r <= 11; r++) c.rect(144, 83 + r * 32, 408, 1, A11_GRID_LINE);
    c.rect(145, 85, 406, 30, [230, 150, 150, 255]);
  }
  for (let i = 0; i < 3; i++) c.frame(13, 284 + i * 64, 97, 40, [20, 40, 120, 255], 2);
  c.dots(12, 460, page + 1, INK, 4);
  return c;
}

function a11AssetsFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    if (f <= 2) {
      out.push(frameOf(a11AssetsPage(f)));
      continue;
    }
    const g = A11_ASSETS_PARTS[f - 3] ?? [16, 16, 0, 0];
    if (f === 12) {
      const c = new Canvas(97, 40);
      c.rect(0, 0, 97, 40, [20, 30, 80, 255]);
      c.rect(3, 3, 91, 34, [90, 123, 231, 255]);
      out.push(frameOf(c));
    } else if (f >= 13) {
      const [w, h, ax, ay] = g;
      const c = new Canvas(w, h);
      c.disc(w / 2, h / 3, Math.min(w, h) / 3, hue(f));
      c.rect(Math.round(w / 4), Math.round(h / 2), Math.round(w / 2), Math.round(h / 2) - 1, lighter(hue(f), 0.3));
      out.push(frameOf(c, ax, ay));
    } else out.push(a11Box(g, f === 5 || f === 6 ? [60, 120, 230, 255] : lighter(hue(f), 0.4), f));
  }
  return out;
}

function a11AutoplayFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    if (f === 0) {
      const c = new Canvas(435, 355);
      c.rect(0, 0, 435, 355, [240, 210, 120, 255]);
      c.rect(122, 8, 238, 334, [30, 110, 60, 255]);
      c.frame(122, 8, 238, 334, [10, 50, 30, 255], 2);
      c.rect(366, 8, 64, 334, [240, 190, 200, 255]);
      for (const [x, y] of [
        [374, 95],
        [374, 180],
      ] as const) {
        c.rect(x, y, 46, 60, [240, 230, 180, 255]);
        c.frame(x, y, 46, 60, [150, 80, 60, 255], 2);
      }
      for (const [x, y] of [
        [137, 20],
        [137, 108],
        [193, 240],
      ] as const)
        c.rect(x, y, 72, 16, [16, 80, 45, 255]);
      for (const y of [45, 77, 133, 165, 197]) {
        c.disc(193, y + 7, 7, [148, 90, 110, 255]);
        c.rect(208, y - 1, 76, 18, [16, 80, 45, 255]);
      }
      for (const y of [266, 299]) {
        c.rect(155, y, 188, 22, [8, 100, 50, 255]);
        for (let k = 0; k < 10; k++) c.rect(209 + k * 8, y + 2, 6, 18, [10, 50, 25, 255]);
        c.rect(196, y + 4, 9, 14, [200, 230, 120, 255]);
        c.rect(290, y + 4, 9, 14, [200, 230, 120, 255]);
      }
      out.push(frameOf(c));
    } else if (f <= 2) {
      const c = new Canvas(116, 86);
      c.rect(0, 0, 116, 86, f === 1 ? [70, 150, 90, 255] : [30, 80, 45, 255]);
      c.frame(0, 0, 116, 86, INK);
      c.disc(15, 43, 6, [148, 90, 110, 255]);
      out.push(frameOf(c));
    } else if (f === 3) {
      const c = new Canvas(15, 15);
      c.disc(7, 7, 7, [255, 60, 90, 255]);
      out.push(frameOf(c));
    } else if (f <= 5) {
      const c = new Canvas(9, 20);
      for (let k = 0; k < 9; k++)
        c.rect(f === 4 ? 8 - k : k, 10 - Math.floor(k / 2 + 1), 1, k + 2, [250, 240, 160, 255]);
      out.push(frameOf(c));
    } else {
      const [w, h, ax, ay] = A11_HEADS[f - 6] ?? [70, 65, 35, 32];
      const c = new Canvas(w, h);
      c.disc((w - 1) / 2, (h - 1) / 2, Math.min(w, h) / 2 - 1, INK);
      c.disc((w - 1) / 2, (h - 1) / 2, Math.min(w, h) / 2 - 3, lighter(hue(f - 6), 0.35));
      c.dots(Math.round(w / 2 - 8), Math.round(h / 2), f - 5, INK, 2);
      out.push(frameOf(c, ax, ay));
    }
  }
  return out;
}

/** LOAD / SAVE 窗（Data#479）：图0 555×451、图1 555×381（左栏 0..71 透明、大框 x=74..552）；图2–5 地图缩图、图6 空白 */
function a11SaveLoadFrames(count: number): UiFrame[] {
  const out: UiFrame[] = [];
  for (let f = 0; f < count; f++) {
    if (f <= 1) {
      const h = f === 0 ? 451 : 381;
      const c = new Canvas(555, h);
      c.rect(2, 4, 68, 24, f === 0 ? [230, 120, 60, 255] : [60, 140, 230, 255]);
      c.rect(74, 2, 479, h - 4, [110, 150, 130, 255]);
      c.frame(74, 2, 479, h - 4, [40, 70, 60, 255], 2);
      for (let r = 1; r < 6; r++) c.rect(76, 2 + Math.round(((h - 4) * r) / 6), 475, 1, [150, 190, 170, 255]);
      out.push(frameOf(c));
    } else {
      const c = new Canvas(72, 72);
      c.rect(0, 0, 72, 72, f === 6 ? [240, 170, 180, 255] : [40, 90, 200, 255]);
      if (f < 6) c.disc(35.5, 35.5, 22 - (f - 2) * 3, [60, 170, 70, 255]);
      c.frame(0, 0, 72, 72, WHITE);
      out.push(frameOf(c));
    }
  }
  return out;
}

/** A11 的合成精灵（逻辑键 → 帧生成函数；UI_FRAMES 展开它，调用时只建表、不读后面的常量） */
function a11UiFrames(): Record<string, (count: number) => UiFrame[]> {
  return {
    'ui.cursor': a11CursorFrames,
    'ui.itemBar': a11ItemBarFrames,
    'ui.itemIcons': a11ItemIconFrames,
    'ui.playerPicker': a11PickerFrames,
    'ui.newsBoard': a11NewsBoardFrames,
    'ui.godSlot': a11GodSlotFrames,
    'ui.roulette.0': a11RouletteFrames(0),
    'ui.roulette.1': a11RouletteFrames(1),
    'ui.roulette.2': a11RouletteFrames(2),
    'ui.roulette.3': a11RouletteFrames(3),
    'venue.monthly.screen': a11MonthlyFrames,
    'venue.assets.screen': a11AssetsFrames,
    'ui.autoplay': a11AutoplayFrames,
    'ui.saveLoad': a11SaveLoadFrames,
  };
}

/** 卡片插画（165×256，不透明：与原版一样四角与外框是黑色，没有透明像素） */
function a11CardImage(k: number): Canvas {
  const c = new Canvas(165, 256);
  const col = hue(k);
  c.rect(0, 0, 165, 256, [0, 0, 0, 255]);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 165; x++) {
      if (inRoundRect(x, y, 0, 0, 164, 255, 10)) c.set(x, y, col);
      if (inRoundRect(x, y, 6, 6, 158, 249, 6)) c.set(x, y, [255, 248, 230, 255]);
    }
  }
  a11Number(c, k, 82, 110, 5, col);
  c.dots(12, 236, Math.min(k, 30), col, 3);
  return c;
}

/** 新闻插图（388×251，不透明） */
function a11NewsImage(i: number): Canvas {
  const c = new Canvas(388, 251);
  const sky = lighter(hue(i), 0.55);
  c.rect(0, 0, 388, 160, sky);
  c.rect(0, 160, 388, 91, lighter(hue(i + 5), 0.2));
  c.disc(320, 50, 26, [255, 230, 120, 255]);
  a11Number(c, i, 150, 110, 5, INK);
  c.dots(10, 236, Math.min(i + 1, 36), INK, 3);
  return c;
}

/** 命运插图（388×251，不透明）：紫色调（与命运板同色系），中间画插图号 i */
function a11FateImage(i: number): Canvas {
  const c = new Canvas(388, 251);
  c.rect(0, 0, 388, 251, lighter([150, 70, 170, 255], 0.5));
  c.rect(0, 180, 388, 71, lighter(hue(i + 3), 0.3));
  c.frame(0, 0, 388, 251, [110, 40, 130, 255], 4);
  a11Number(c, i, 194, 110, 5, INK);
  c.dots(10, 236, Math.min(i + 1, 40), INK, 3);
  return c;
}

/** 节日插画占位（200×200，不透明）：按 gm 换底色，中间画 slot */
function a11HolidayImage(gm: number, slot: number): Canvas {
  const c = new Canvas(200, 200);
  c.rect(0, 0, 200, 200, lighter(hue(3 * gm + 1), 0.35));
  c.frame(0, 0, 200, 200, hue(3 * gm), 6);
  a11Number(c, slot, 100, 100, 5, INK);
  c.dots(12, 180, gm + 1, INK, 6);
  return c;
}

/**
 * 合成包里的节日插画占位：每张图的首末 slot（键 = illustration.holiday.<[0,24,43,63][gm] + slot>，与原版包同键同组）。
 * 全量 82 张只在原版包里有；客户端测试用这几张看台湾 / 其他图的键偏移。
 */
export const SYNTH_HOLIDAY_ART: readonly { key: string; gm: number; slot: number }[] = [
  [0, 0],
  [0, 23],
  [1, 0],
  [1, 18],
  [2, 0],
  [2, 18],
  [3, 0],
  [3, 19],
].map(([gm, slot]) => ({ key: holidayArtKey(gm!, slot!), gm: gm!, slot: slot! }));

/** 合成包里 A11 的键（测试用） */
export const SYNTH_A11 = {
  sprites: Object.keys(a11UiFrames()),
  images: [
    ...Array.from({ length: 30 }, (_, k) => `card.${k + 1}`),
    ...Array.from({ length: 36 }, (_, i) => `illustration.news.${i}`),
    ...Array.from({ length: 40 }, (_, i) => `illustration.fate.${i}`),
  ],
} as const;

/** 写进合成包：A11 的整图（卡片插画、新闻插图、命运插图；精灵随 UI_FRAMES 一起写） */
async function addSyntheticA11Images(
  writer: PackWriter,
  byKey: ReadonlyMap<string, Catalog['items'][number]>,
  png: PngOptions,
): Promise<void> {
  for (const key of SYNTH_A11.images) {
    const it = byKey.get(key);
    if (it?.type !== 'image') throw new Error(`资源目录缺少整图 ${key}`);
    const item = it as ImageItem;
    const card = /^card\.(\d+)$/.exec(key);
    const n = Number(key.split('.').at(-1));
    const canvas = card
      ? a11CardImage(Number(card[1]))
      : key.startsWith('illustration.fate.')
        ? a11FateImage(n)
        : a11NewsImage(n);
    if (canvas.w !== item.w || canvas.h !== item.h) throw new Error(`${key} 尺寸与资源目录不符`);
    const file = `images/synthetic-ui/${key}.png`;
    await writer.writeFile(file, encodePngRgba(canvas.w, canvas.h, canvas.rgba, png), 'image', item.group);
    writer.addEntry(key, {
      type: 'image',
      group: item.group,
      confidence: item.confidence,
      src: ['synthetic'],
      file,
      w: item.w,
      h: item.h,
      transparency: item.transparency,
      anchor: null,
    });
  }
  for (const { key, gm, slot } of SYNTH_HOLIDAY_ART) {
    const it = byKey.get(key);
    if (it?.type !== 'image') throw new Error(`资源目录缺少节日插画 ${key}`);
    const item = it as ImageItem;
    const canvas = a11HolidayImage(gm, slot);
    if (canvas.w !== item.w || canvas.h !== item.h) throw new Error(`${key} 尺寸与资源目录不符`);
    const file = `images/synthetic-ui/${key}.png`;
    await writer.writeFile(file, encodePngRgba(canvas.w, canvas.h, canvas.rgba, png), 'image', item.group);
    writer.addEntry(key, {
      type: 'image',
      group: item.group,
      confidence: item.confidence,
      src: ['synthetic'],
      file,
      w: item.w,
      h: item.h,
      transparency: item.transparency,
      anchor: null,
    });
  }
}
