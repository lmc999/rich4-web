/**
 * 企鹅棋盘几何（design/minigames-ai.md §3.1、§3.3）：有效格、格心、菱形拾取、16.16 定点 DDA 路径。
 * sim、bot 与客户端共用；全部为纯函数（DDA 的 nextCell 原地修改传入的 walk）。
 */
import { idiv } from '../rng';
import {
  BOARD_N,
  CELL_COUNT,
  CELL_HALF_H,
  CELL_HALF_W,
  CELL_ORIGIN_X,
  CELL_ORIGIN_Y,
  FX_HALF,
  FX_SHIFT,
  VALID_COL_RANGES,
} from './constants';

function buildValid(): readonly boolean[] {
  const out: boolean[] = [];
  for (let r = 0; r < BOARD_N; r++) {
    const [lo, hi] = VALID_COL_RANGES[r]!;
    for (let c = 0; c < BOARD_N; c++) out.push(c >= lo && c <= hi && !(r === 4 && c === 4));
  }
  return Object.freeze(out);
}

/** VALID[cell]：是否为可走、可埋的有效格（共 64 个，冰屋 40 为 false） */
export const VALID: readonly boolean[] = buildValid();

/** 按格号升序的有效格列表 */
export const VALID_CELLS: readonly number[] = Object.freeze(VALID.flatMap((v, i) => (v ? [i] : [])));

export function rowOf(cell: number): number {
  return idiv(cell, BOARD_N);
}

export function colOf(cell: number): number {
  return cell % BOARD_N;
}

/** 越界返回 −1 */
export function cellAt(row: number, col: number): number {
  if (row < 0 || row >= BOARD_N || col < 0 || col >= BOARD_N) return -1;
  return row * BOARD_N + col;
}

export function isValidCell(cell: number): boolean {
  return Number.isInteger(cell) && cell >= 0 && cell < CELL_COUNT && VALID[cell] === true;
}

/** 格心舞台坐标 */
export function cellCenter(cell: number): { x: number; y: number } {
  const r = rowOf(cell);
  const c = colOf(cell);
  return { x: CELL_HALF_W * (r + c) + CELL_ORIGIN_X, y: CELL_HALF_H * (r - c) + CELL_ORIGIN_Y };
}

/**
 * 菱形拾取（DEV-07）：|dx|·24 + |dy|·48 ≤ 48·24 的有效格；落在多个菱形的公共边上时取度量最小者，再取格号小者。
 * 没有命中返回 −1。输入为整数舞台坐标。
 */
export function pickCell(px: number, py: number): number {
  let best = -1;
  let bestD = CELL_HALF_W * CELL_HALF_H + 1;
  for (const cell of VALID_CELLS) {
    const { x, y } = cellCenter(cell);
    const d = Math.abs(px - x) * CELL_HALF_H + Math.abs(py - y) * CELL_HALF_W;
    if (d < bestD) {
      bestD = d;
      best = cell;
    }
  }
  return best;
}

/** 八方位朝向（见 constants.DIR_INITIAL 的注释）；同格返回 −1 */
export function dirBetween(from: number, to: number): number {
  const dr = Math.sign(rowOf(to) - rowOf(from));
  const dc = Math.sign(colOf(to) - colOf(from));
  return DIR_TABLE[(dr + 1) * 3 + (dc + 1)]!;
}

// (dr,dc) → 方向：(-1,-1)=4 左, (-1,0)=5 左上, (-1,1)=6 上, (0,-1)=3 左下, (0,0)=−1, (0,1)=7 右上, (1,-1)=2 下, (1,0)=1 右下, (1,1)=0 右
const DIR_TABLE: readonly number[] = Object.freeze([4, 5, 6, 3, -1, 7, 2, 1, 0]);

/**
 * 行走状态（JSON 值，进入 PenguinState）。主轴每步 ±1，副轴 16.16 定点每步加 stepMin。
 * majorIsCol 为 true 时主轴是列（maj = 列、minFx = 行<<16）。
 */
export interface PenguinWalk {
  target: number;
  majorIsCol: boolean;
  maj: number;
  minFx: number;
  /** 主轴步向；0 表示主轴已停 */
  sMaj: number;
  /** 副轴每步增量；0 表示副轴已停 */
  stepMin: number;
  /** 剩余步数（初值为主轴距离） */
  left: number;
  /** 正在走向的格 */
  next: number;
  /** 当前格内已走的 tick（0..3） */
  sub: number;
}

function roundFx(fx: number): number {
  return (fx + FX_HALF) >> FX_SHIFT;
}

function walkCell(w: PenguinWalk, maj: number, min: number): number {
  return w.majorIsCol ? cellAt(min, maj) : cellAt(maj, min);
}

function ok(cell: number): boolean {
  return cell >= 0 && VALID[cell] === true;
}

/**
 * 从 from 走向 target 的初始 walk（next 尚未计算，为 −1）。from === target 时返回 null。
 * |dc| ≥ |dr| 时主轴为列。@source v311:0x41211c（B）
 */
export function initWalk(from: number, target: number): PenguinWalk | null {
  if (from === target) return null;
  const fr = rowOf(from);
  const fc = colOf(from);
  const dr = rowOf(target) - fr;
  const dc = colOf(target) - fc;
  const adr = Math.abs(dr);
  const adc = Math.abs(dc);
  if (adc >= adr) {
    return {
      target,
      majorIsCol: true,
      maj: fc,
      minFx: fr << FX_SHIFT,
      sMaj: Math.sign(dc),
      stepMin: idiv(dr << FX_SHIFT, adc),
      left: adc,
      next: -1,
      sub: 0,
    };
  }
  return {
    target,
    majorIsCol: false,
    maj: fr,
    minFx: fc << FX_SHIFT,
    sMaj: Math.sign(dr),
    stepMin: idiv(dc << FX_SHIFT, adr),
    left: adr,
    next: -1,
    sub: 0,
  };
}

/**
 * 计算下一格并提交到 w（原地修改），无路可走返回 −1。@source v311:0x412287 / 0x4123aa（B，⚑ M6）
 * 1) 两轴都走；2) 下一格无效时停副轴（副轴步进非 0 才可停）；3) 再不行就停主轴（副轴取整确实变化才可停）。
 */
export function nextCell(w: PenguinWalk): number {
  const nm = w.maj + w.sMaj;
  const nf = w.minFx + w.stepMin;
  const c1 = walkCell(w, nm, roundFx(nf));
  if (ok(c1)) {
    w.maj = nm;
    w.minFx = nf;
    return c1;
  }
  const c2 = walkCell(w, nm, roundFx(w.minFx));
  if (w.stepMin !== 0 && ok(c2)) {
    w.stepMin = 0;
    w.maj = nm;
    return c2;
  }
  const c3 = walkCell(w, w.maj, roundFx(nf));
  if (roundFx(nf) !== roundFx(w.minFx) && ok(c3)) {
    w.sMaj = 0;
    w.minFx = nf;
    return c3;
  }
  return -1;
}

/**
 * 完整路径（不含起点）：模拟 sim 的行走，直到到达 target、步数用完或无路可走。
 * 返回途经的格与最终挖掘的格（第一步就无路可走时 path 为空、digAt = from）。bot、测试与客户端预览用。
 */
export function tracePath(from: number, target: number): { path: number[]; digAt: number } {
  const w = initWalk(from, target);
  if (w === null) return { path: [], digAt: from };
  const path: number[] = [];
  let cell = from;
  for (;;) {
    const n = nextCell(w);
    if (n < 0) break;
    cell = n;
    path.push(n);
    w.left--;
    if (cell === w.target || w.left === 0) break;
  }
  return { path, digAt: cell };
}
