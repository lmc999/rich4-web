import type { Cell, Rect } from '@rich4/shared/data';

export type { Cell, Rect };

/** 浮点二维量（格点坐标下的世界位置等）。 */
export interface Vec {
  x: number;
  y: number;
}

export type Transform = 'identity' | 'rot90' | 'rot180' | 'rot270' | 'flipX' | 'flipY';
export const TRANSFORMS: readonly Transform[] = ['identity', 'rot90', 'rot180', 'rot270', 'flipX', 'flipY'];

export type GeoSeverity = 'error' | 'warn' | 'info';

/** 几何归一化的问题记录；error 即「需要 override」（CLI exit 5）。 */
export interface GeoIssue {
  code: string;
  severity: GeoSeverity;
  msg: string;
  tiles?: number[];
  cells?: Cell[];
}

export class GeoIssues {
  readonly list: GeoIssue[] = [];

  add(code: string, severity: GeoSeverity, msg: string, extra: { tiles?: number[]; cells?: Cell[] } = {}): void {
    const issue: GeoIssue = { code, severity, msg };
    if (extra.tiles && extra.tiles.length > 0) issue.tiles = [...extra.tiles];
    if (extra.cells && extra.cells.length > 0) issue.cells = extra.cells.map((c) => ({ x: c.x, y: c.y }));
    this.list.push(issue);
  }

  get errors(): GeoIssue[] {
    return this.list.filter((i) => i.severity === 'error');
  }
}

/** 4-邻方向，顺序 N、E、S、W（与 fixture 槽号约定一致，仅用作确定性的平手次序）。 */
export const DIRS4: readonly Cell[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

export function ck(c: Cell): string {
  return `${c.x},${c.y}`;
}

export function add(a: Cell, b: Cell): Cell {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function eqCell(a: Cell, b: Cell): boolean {
  return a.x === b.x && a.y === b.y;
}

export function manhattan(a: Vec, b: Vec): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function dist2(a: Vec, b: Vec): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function neighbors4(c: Cell): Cell[] {
  return DIRS4.map((d) => add(c, d));
}

/** 4-相邻方向下标（0..3），不相邻返回 -1。 */
export function dirIndex(from: Cell, to: Cell): number {
  return DIRS4.findIndex((d) => from.x + d.x === to.x && from.y + d.y === to.y);
}

export function rectCells(r: Rect): Cell[] {
  const out: Cell[] = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push({ x, y });
  return out;
}

export function rectCenter(r: Rect): Vec {
  return { x: r.x + (r.w - 1) / 2, y: r.y + (r.h - 1) / 2 };
}

/** 四舍五入（.5 向 +∞），避免 Math.round 的 -0。 */
export function roundHalfUp(v: number): number {
  const r = Math.floor(v + 0.5);
  return r === 0 ? 0 : r;
}

export function compareCells(a: Cell, b: Cell): number {
  return a.y - b.y || a.x - b.x;
}

export type OccKind = 'tile' | 'road' | 'lot' | 'landmark';

export interface OccOwner {
  kind: OccKind;
  id: string;
}

/** 格子占用表：同一格只能归属一个元素。 */
export class Occupancy {
  private readonly m = new Map<string, OccOwner>();

  owner(c: Cell): OccOwner | undefined {
    return this.m.get(ck(c));
  }

  isFree(c: Cell): boolean {
    return !this.m.has(ck(c));
  }

  rectFree(r: Rect): boolean {
    return rectCells(r).every((c) => this.isFree(c));
  }

  claim(c: Cell, owner: OccOwner): void {
    const k = ck(c);
    const prev = this.m.get(k);
    if (prev) throw new Error(`cell ${k} already owned by ${prev.kind} ${prev.id}`);
    this.m.set(k, owner);
  }

  claimRect(r: Rect, owner: OccOwner): void {
    for (const c of rectCells(r)) this.claim(c, owner);
  }

  get size(): number {
    return this.m.size;
  }

  cells(): Cell[] {
    return [...this.m.keys()]
      .map((k) => {
        const [x, y] = k.split(',').map(Number);
        return { x: x!, y: y! };
      })
      .sort(compareCells);
  }
}
