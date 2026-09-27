// 计算器数字窗（ui.md §2.1：Panel#21 SPR 26 帧 + 命中掩膜 Panel#22）的布局与按键逻辑（纯函数）。
// 帧：0 本体 128×192、1 计量条亮格 108×12、2 MAX 按下 49×25、3 ↵ 按下 57×25、4–15 键帽按下 33×17、16–25 LCD 数字 0–9（9×19）。
// 掩膜区号（逐像素统计本机 v2.06 Panel#22，test/w3-mask-regions.mjs）：1 本体底、2 MAX、3 ↵、4 C、5 0、6 ←、7–9 = 7 8 9、
// 10–12 = 4 5 6、13–15 = 1 2 3、16 计量条。按下帧落点用 test/w3-atlas-match.mjs 在本体上逐像素比对得到（键帽比键区左上各多 1 行）。
import type { Rect } from '../layout';

export const NUMPAD_SHEET = 'ui.numpad';
export const NUMPAD_MASK = 'ui.numpad.mask';
export const NUMPAD_W = 128;
export const NUMPAD_H = 192;

export type CalcDigit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
export type CalcKey = CalcDigit | 'clear' | 'back' | 'max' | 'enter';

export interface NumpadKey {
  key: CalcKey;
  /** 掩膜区号 */
  region: number;
  /** 键区（计算器坐标，= 掩膜包围盒） */
  rect: Rect;
  /** 按下帧与落点（左上角） */
  frame: number;
  at: { x: number; y: number };
  /**
   * 手机扩展热区（互不重叠）。数字键与 C / ← 只分到键与键之间的空隙（补不到 44px；手机上用液晶屏的输入框代替：
   * 弹出系统数字键盘，获得焦点时全选——打字即替换（= C）、系统键盘的退格 = ←）；MAX / ↵ 往上补过计量条到 56 逻辑像素
   * （0.8125 倍时约 45px），手机上计量条因此只显示、不接收指针（数值用输入框或 MAX 设定；键盘仍可操作计量棒）
   */
  pad: Rect;
  /** 回退画法上的字 */
  cap: string;
}

const COLS = [8, 48, 88] as const;
const PAD_COLS = [4, 44, 84] as const;
const ROWS = [
  { y: 96, h: 16, at: 95, pad: 92, padH: 24 },
  { y: 121, h: 15, at: 119, pad: 116, padH: 24 },
  { y: 144, h: 16, at: 143, pad: 140, padH: 24 },
  { y: 168, h: 16, at: 167, pad: 164, padH: 24 },
] as const;
const GRID: readonly (readonly [CalcKey, string])[] = [
  ['clear', 'C'],
  ['0', '0'],
  ['back', '←'],
  ['7', '7'],
  ['8', '8'],
  ['9', '9'],
  ['4', '4'],
  ['5', '5'],
  ['6', '6'],
  ['1', '1'],
  ['2', '2'],
  ['3', '3'],
];

export const NUMPAD_KEYS: readonly NumpadKey[] = [
  {
    key: 'max',
    region: 2,
    rect: { x: 8, y: 64, w: 47, h: 24 },
    frame: 2,
    at: { x: 8, y: 63 },
    pad: { x: 0, y: 36, w: 60, h: 56 },
    cap: 'MAX',
  },
  {
    key: 'enter',
    region: 3,
    rect: { x: 64, y: 64, w: 56, h: 24 },
    frame: 3,
    at: { x: 64, y: 63 },
    pad: { x: 60, y: 36, w: 68, h: 56 },
    cap: '↵',
  },
  ...GRID.map(([key, cap], i): NumpadKey => {
    const col = i % 3;
    const row = ROWS[Math.floor(i / 3)]!;
    return {
      key,
      region: 4 + i,
      rect: { x: COLS[col]!, y: row.y, w: 32, h: row.h },
      frame: 4 + i,
      at: { x: COLS[col]!, y: row.at },
      pad: { x: PAD_COLS[col]!, y: row.pad, w: 40, h: row.padH },
      cap,
    };
  }),
];

/** 计量条（区 16）与亮格帧（图1）落点 */
export const NUMPAD_METER = { region: 16, rect: { x: 9, y: 41, w: 110, h: 14 }, fill: { x: 10, y: 42, w: 108, h: 12 } };

/** 液晶屏：数字帧 16–25（0–9，9×19）右对齐，步距 10，最多 11 位 */
export const NUMPAD_LCD = {
  rect: { x: 9, y: 10, w: 110, h: 20 },
  digitW: 9,
  digitH: 19,
  step: 10,
  right: 117,
  y: 11,
  cells: 11,
};
export const LCD_DIGIT_FRAME0 = 16;

export interface CalcBounds {
  min: number;
  max: number;
  /** 步长（≥1；金额通常 1，股数通常 10） */
  step: number;
}

export function clampAmount(v: number, b: CalcBounds): number {
  if (b.max < b.min) return b.min;
  return Math.min(b.max, Math.max(b.min, Math.trunc(v)));
}

/** 合法值：夹到 [min, max] 后按步长向下取整（以 min 为起点） */
export function snapAmount(v: number, b: CalcBounds): number {
  if (b.max < b.min) return b.min;
  const step = Math.max(1, Math.trunc(b.step));
  const c = clampAmount(v, b);
  return b.min + Math.floor((c - b.min) / step) * step;
}

/** 按键：数字追加一位（超过 max 时停在 max）、C 归零、← 去掉末位、MAX 取最大合法值、↵ 规整为合法值 */
export function calcPress(value: number, key: CalcKey, b: CalcBounds): number {
  const v = Math.max(0, Math.trunc(value));
  switch (key) {
    case 'clear':
      return 0;
    case 'back':
      return Math.floor(v / 10);
    case 'max':
      return snapAmount(b.max, b);
    case 'enter':
      return snapAmount(v, b);
    default: {
      const d = Number(key);
      const next = v * 10 + d;
      if (b.max >= 0 && next > b.max) return Math.max(0, b.max);
      return next;
    }
  }
}

/** 输入框里的文字 → 数值（只取数字；空为 0；超过 max 停在 max） */
export function parseTyped(text: string, b: CalcBounds): number {
  const digits = text.replace(/\D+/g, '').slice(0, 12);
  if (digits === '') return 0;
  const n = Number(digits);
  return b.max >= 0 && n > b.max ? Math.max(0, b.max) : n;
}

/** 计量条比例 0..1 */
export function meterRatio(v: number, b: CalcBounds): number {
  if (b.max <= b.min) return v >= b.max ? 1 : 0;
  return (clampAmount(v, b) - b.min) / (b.max - b.min);
}

/** 计量条上的比例 → 合法值（就近取步长整数倍） */
export function valueAtRatio(r: number, b: CalcBounds): number {
  if (b.max <= b.min) return b.min;
  const step = Math.max(1, Math.trunc(b.step));
  const k = Math.round((Math.min(1, Math.max(0, r)) * (b.max - b.min)) / step);
  return snapAmount(b.min + k * step, b);
}

/** 值是否可以提交 */
export function isValidAmount(v: number, b: CalcBounds): boolean {
  return b.max >= b.min && v >= b.min && v <= b.max && snapAmount(v, b) === v;
}

/** 液晶屏上的数字（最多 cells 位，超出只留低位） */
export function lcdDigits(v: number, cells = NUMPAD_LCD.cells): number[] {
  const s = String(Math.max(0, Math.trunc(v)));
  return [...s.slice(-cells)].map(Number);
}

/** 键盘按键 → 计算器键 */
export function keyOfKeyboard(key: string): CalcKey | null {
  if (/^[0-9]$/.test(key)) return key as CalcDigit;
  if (key === 'Backspace') return 'back';
  if (key === 'Delete' || key === 'c' || key === 'C') return 'clear';
  if (key === 'Enter') return 'enter';
  if (key === 'm' || key === 'M') return 'max';
  return null;
}
