import { describe, expect, it } from 'vitest';
import { CELL_COUNT, IGLOO_CELL, START_CELL, VALID_CELL_COUNT } from './constants';
import {
  cellAt,
  cellCenter,
  colOf,
  dirBetween,
  initWalk,
  isValidCell,
  pickCell,
  rowOf,
  tracePath,
  VALID,
  VALID_CELLS,
} from './geometry';

describe('企鹅棋盘几何', () => {
  it('有效格：64 个，按行 4/7/8/9/8/9/8/7/4，冰屋 40 无效，起点 56 有效', () => {
    expect(VALID).toHaveLength(CELL_COUNT);
    expect(VALID_CELLS).toHaveLength(VALID_CELL_COUNT);
    const perRow = Array.from({ length: 9 }, (_, r) => VALID_CELLS.filter((c) => rowOf(c) === r).length);
    expect(perRow).toEqual([4, 7, 8, 9, 8, 9, 8, 7, 4]);
    expect(VALID[IGLOO_CELL]).toBe(false);
    expect(isValidCell(IGLOO_CELL)).toBe(false);
    expect(START_CELL).toBe(cellAt(6, 2));
    expect(isValidCell(START_CELL)).toBe(true);
    expect(isValidCell(-1)).toBe(false);
    expect(isValidCell(81)).toBe(false);
    expect(isValidCell(1.5)).toBe(false);
    expect(cellAt(9, 0)).toBe(-1);
    expect(cellAt(0, -1)).toBe(-1);
  });

  it('格心：x = 48(r+c) − 64，y = 24(r−c) + 225；冰屋在 (320,225)', () => {
    expect(cellCenter(IGLOO_CELL)).toEqual({ x: 320, y: 225 });
    expect(cellCenter(cellAt(0, 3))).toEqual({ x: 80, y: 153 });
    expect(cellCenter(cellAt(8, 5))).toEqual({ x: 560, y: 297 });
    for (const c of VALID_CELLS) {
      const { x, y } = cellCenter(c);
      expect(x).toBe(48 * (rowOf(c) + colOf(c)) - 64);
      expect(y).toBe(24 * (rowOf(c) - colOf(c)) + 225);
    }
  });

  it('菱形拾取：格心命中本格，菱形顶点仍在格内，冰屋与棋盘外为 −1', () => {
    for (const c of VALID_CELLS) {
      const { x, y } = cellCenter(c);
      expect(pickCell(x, y)).toBe(c);
      expect(pickCell(x + 47, y)).toBe(c);
      expect(pickCell(x, y - 23)).toBe(c);
    }
    expect(pickCell(320, 225)).toBe(-1);
    expect(pickCell(0, 0)).toBe(-1);
    expect(pickCell(639, 479)).toBe(-1);
    // 两格公共边上取格号小者：(3,3) 与 (3,4) 的格心分别为 (224,225)、(272,201)，中点 (248,213)
    expect(pickCell(248, 213)).toBe(Math.min(cellAt(3, 3), cellAt(3, 4)));
  });

  it('八方位朝向', () => {
    const c = cellAt(4, 3);
    expect(dirBetween(c, cellAt(5, 4))).toBe(0);
    expect(dirBetween(c, cellAt(5, 3))).toBe(1);
    expect(dirBetween(c, cellAt(5, 2))).toBe(2);
    expect(dirBetween(c, cellAt(4, 2))).toBe(3);
    expect(dirBetween(c, cellAt(3, 2))).toBe(4);
    expect(dirBetween(c, cellAt(3, 3))).toBe(5);
    expect(dirBetween(c, cellAt(3, 4))).toBe(6);
    expect(dirBetween(c, cellAt(4, 4))).toBe(7);
    expect(dirBetween(c, c)).toBe(-1);
  });

  it('DDA 初始化：|dc| ≥ |dr| 时主轴为列，副轴步进为 16.16 截断除法', () => {
    expect(initWalk(5, 5)).toBeNull();
    expect(initWalk(cellAt(6, 2), cellAt(1, 4))).toMatchObject({
      majorIsCol: false,
      maj: 6,
      minFx: 2 << 16,
      sMaj: -1,
      stepMin: Math.trunc((2 << 16) / 5),
      left: 5,
    });
    expect(initWalk(cellAt(2, 2), cellAt(6, 6))).toMatchObject({ majorIsCol: true, sMaj: 1, stepMin: 65536, left: 4 });
  });

  // 路径 golden（起点 → 终点）：手算核对过前 4 组与 56→24、3→77、49→31
  const PATHS: [from: number, to: number, path: number[], digAt: number][] = [
    [56, 13, [47, 39, 30, 22, 13], 13], // 斜线，副轴取整 2.4→2、2.8→3…
    [38, 42, [39], 39], // 同行穿过冰屋：两轴都停不了，停在冰屋前挖
    [20, 60, [30, 31, 32, 33], 33], // 对角穿冰屋：副轴停，沿行走完 4 步
    [39, 41, [], 39], // 第一步就是冰屋：原地挖
    [56, 24, [48, 49, 50, 51], 51],
    [3, 77, [12, 22, 31], 31], // 主轴撞冰屋且副轴取整不变：停下
    [27, 35, [28, 29, 30, 31, 32, 33, 34, 35], 35], // 第 3 行横穿全盘
    [76, 4, [67, 58, 49], 49],
    [44, 36, [43, 42, 41], 41],
    [49, 31, [], 49],
    [12, 68, [21, 31], 31],
  ];

  it.each(PATHS)('路径 %i → %i', (from, to, path, digAt) => {
    expect(tracePath(from, to)).toEqual({ path, digAt });
    for (const c of path) expect(isValidCell(c)).toBe(true);
  });

  it('任意两有效格：路径只经过有效格、相邻两步最多差 1 行 1 列、步数不超过主轴距离', () => {
    for (const a of VALID_CELLS) {
      for (const b of VALID_CELLS) {
        const { path, digAt } = tracePath(a, b);
        const n = Math.max(Math.abs(rowOf(b) - rowOf(a)), Math.abs(colOf(b) - colOf(a)));
        expect(path.length).toBeLessThanOrEqual(n);
        let prev = a;
        for (const c of path) {
          expect(isValidCell(c)).toBe(true);
          expect(Math.abs(rowOf(c) - rowOf(prev))).toBeLessThanOrEqual(1);
          expect(Math.abs(colOf(c) - colOf(prev))).toBeLessThanOrEqual(1);
          prev = c;
        }
        expect(digAt).toBe(path.length > 0 ? path[path.length - 1] : a);
      }
    }
  });
});
