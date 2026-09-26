// 道路拼接（design/client.md §3.4；architecture §14 client 修订：支持 links + via 与 roadCells）。
// 每个路格（游戏格与 via 连接格）按 4 个方向的连通性得到 4 bit 掩码，选 16 种拼接之一：
// 孤立、尽头×4、直路×2、弯道×4、T 字×4、十字。掩码先在逻辑网格上算，再按视图旋转循环移位。
// 连通性只看 MapDef 的无向 links 及其 via 链：[from.cell, ...via, to.cell] 的相邻两格互相连通。
import { type Cell, cellKey, type MapDef, type TileId } from '@rich4/shared/data';
import type { Graphics } from 'pixi.js';
import { isoToScreen, type Pt, type Rotation } from '../iso/projection';

/** 逻辑方向位：N=-y、E=+x、S=+y、W=-x（与 fixture 槽号顺序一致） */
export const DIR_N = 1;
export const DIR_E = 2;
export const DIR_S = 4;
export const DIR_W = 8;
export const DIR_BITS = [DIR_N, DIR_E, DIR_S, DIR_W] as const;
const DIR_VECS: readonly Pt[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

/** 单位轴向步 → 方向位；非单位步返回 0 */
export function dirBit(dx: number, dy: number): number {
  for (let i = 0; i < 4; i++) {
    const v = DIR_VECS[i]!;
    if (v.x === dx && v.y === dy) return DIR_BITS[i]!;
  }
  return 0;
}

export function bitVec(bit: number): Pt {
  const i = DIR_BITS.indexOf(bit as (typeof DIR_BITS)[number]);
  return DIR_VECS[i] ?? { x: 0, y: 0 };
}

/** 把逻辑掩码转到视图：每转 90°，N→E→S→W→N（位循环左移） */
export function rotateMask(mask: number, rot: Rotation): number {
  const m = mask & 15;
  return ((m << rot) | (m >> (4 - rot))) & 15;
}

export type RoadPieceKind = 'isolated' | 'end' | 'straight' | 'corner' | 'tee' | 'cross';

/** 各拼接的基准掩码；实际掩码 = rotateMask(base, turns) */
export const ROAD_PIECE_BASE: Readonly<Record<RoadPieceKind, number>> = {
  isolated: 0,
  end: DIR_N,
  straight: DIR_N | DIR_S,
  corner: DIR_N | DIR_E,
  tee: DIR_N | DIR_E | DIR_S,
  cross: DIR_N | DIR_E | DIR_S | DIR_W,
};

export interface RoadPiece {
  kind: RoadPieceKind;
  /** 基准掩码需要旋转的 90° 次数（0..3，取最小者） */
  turns: Rotation;
  mask: number;
}

const PIECES: readonly RoadPiece[] = (() => {
  const out: RoadPiece[] = [];
  for (let mask = 0; mask < 16; mask++) {
    let found: RoadPiece | null = null;
    for (const kind of Object.keys(ROAD_PIECE_BASE) as RoadPieceKind[]) {
      for (let t = 0 as Rotation; t < 4; t = (t + 1) as Rotation) {
        if (rotateMask(ROAD_PIECE_BASE[kind], t) === mask) {
          found = { kind, turns: t, mask };
          break;
        }
      }
      if (found) break;
    }
    out.push(found!);
  }
  return out;
})();

/** 16 种掩码 → 拼接（查表） */
export function roadPieceFor(mask: number): RoadPiece {
  return PIECES[mask & 15]!;
}

export interface RoadGraph {
  /** cellKey → 逻辑掩码 */
  masks: Map<string, number>;
  /** 所有路格（游戏格 + 连接格），按首次出现顺序 */
  cells: Cell[];
  /** 游戏格所在的 cellKey → TileId */
  tileAt: Map<string, TileId>;
  /** 连接格（非游戏格） */
  viaCells: Set<string>;
  /** 链中出现非单位步（对角或跳格）的 link 数，正常应为 0 */
  brokenSteps: number;
}

/** link 的完整格链：[from.cell, ...via, to.cell] */
export function linkChain(def: MapDef, from: TileId, to: TileId): Cell[] {
  const a = def.tiles.find((t) => t.id === from);
  const b = def.tiles.find((t) => t.id === to);
  if (!a || !b) return [];
  const link = a.links.find((l) => l.to === to);
  const via = link?.via ?? [];
  return [a.cell, ...via, b.cell];
}

export function buildRoadGraph(def: MapDef): RoadGraph {
  const masks = new Map<string, number>();
  const cells: Cell[] = [];
  const tileAt = new Map<string, TileId>();
  const viaCells = new Set<string>();
  let brokenSteps = 0;
  const touch = (c: Cell): string => {
    const k = cellKey(c);
    if (!masks.has(k)) {
      masks.set(k, 0);
      cells.push({ x: c.x, y: c.y });
    }
    return k;
  };
  const byId = new Map(def.tiles.map((t) => [t.id, t] as const));
  for (const t of def.tiles) {
    tileAt.set(touch(t.cell), t.id);
  }
  for (const c of def.roadCells) {
    viaCells.add(touch(c));
  }
  for (const t of def.tiles) {
    for (const l of t.links) {
      const to = byId.get(l.to);
      if (!to) continue;
      const chain = [t.cell, ...(l.via ?? []), to.cell];
      for (let i = 1; i < chain.length; i++) {
        const p = chain[i - 1]!;
        const q = chain[i]!;
        const bit = dirBit(q.x - p.x, q.y - p.y);
        if (bit === 0) {
          brokenSteps++;
          continue;
        }
        const kp = touch(p);
        const kq = touch(q);
        const back = dirBit(p.x - q.x, p.y - q.y);
        masks.set(kp, (masks.get(kp) ?? 0) | bit);
        masks.set(kq, (masks.get(kq) ?? 0) | back);
        if (i > 0 && i < chain.length - 1) viaCells.add(kq);
      }
    }
  }
  return { masks, cells, tileAt, viaCells, brokenSteps };
}

// ───────────────────────── 绘制（Graphics 由调用方创建；这里只用类型） ─────────────────────────

export interface RoadStyle {
  asphalt: number;
  curb: number;
  lane: number;
  outline: number;
}

export const DEFAULT_ROAD_STYLE: RoadStyle = { asphalt: 0x8a8f99, curb: 0xe9e2cf, lane: 0xfff3b0, outline: 0x3a2a1a };

/** 路面半宽（格的比例）：中心方块 [0.5-HW, 0.5+HW]² 加上连通方向的臂 */
const HW = 0.3;

type Quad = [Pt, Pt, Pt, Pt];

function quad(vx: number, vy: number, x0: number, y0: number, x1: number, y1: number): number[] {
  const pts: Quad = [
    isoToScreen(vx + x0, vy + y0),
    isoToScreen(vx + x1, vy + y0),
    isoToScreen(vx + x1, vy + y1),
    isoToScreen(vx + x0, vy + y1),
  ];
  return pts.flatMap((p) => [p.x, p.y]);
}

/**
 * 在视图 cell (vx,vy) 画一块路面。viewMask 为视图方向掩码（已 rotateMask）。
 * 画法：中心方块 + 各连通方向的臂（都是视图网格里的轴对齐矩形，投影后为菱形/平行四边形），
 * 再在未连通的边画路缘，连通方向画中心虚线。
 */
export function drawRoadCell(g: Graphics, vx: number, vy: number, viewMask: number, style = DEFAULT_ROAD_STYLE): void {
  const lo = 0.5 - HW;
  const hi = 0.5 + HW;
  const polys: number[][] = [quad(vx, vy, lo, lo, hi, hi)];
  if (viewMask & DIR_N) polys.push(quad(vx, vy, lo, 0, hi, lo));
  if (viewMask & DIR_S) polys.push(quad(vx, vy, lo, hi, hi, 1));
  if (viewMask & DIR_W) polys.push(quad(vx, vy, 0, lo, lo, hi));
  if (viewMask & DIR_E) polys.push(quad(vx, vy, hi, lo, 1, hi));
  for (const p of polys) g.poly(p, true).fill(style.asphalt);

  // 路缘：沿路面外轮廓（未连通方向的中心方块边 + 臂的两侧）
  const edge = (x0: number, y0: number, x1: number, y1: number): void => {
    const a = isoToScreen(vx + x0, vy + y0);
    const b = isoToScreen(vx + x1, vy + y1);
    g.moveTo(a.x, a.y).lineTo(b.x, b.y);
  };
  if (!(viewMask & DIR_N)) edge(lo, lo, hi, lo);
  else {
    edge(lo, 0, lo, lo);
    edge(hi, 0, hi, lo);
  }
  if (!(viewMask & DIR_S)) edge(lo, hi, hi, hi);
  else {
    edge(lo, hi, lo, 1);
    edge(hi, hi, hi, 1);
  }
  if (!(viewMask & DIR_W)) edge(lo, lo, lo, hi);
  else {
    edge(0, lo, lo, lo);
    edge(0, hi, lo, hi);
  }
  if (!(viewMask & DIR_E)) edge(hi, lo, hi, hi);
  else {
    edge(hi, lo, 1, lo);
    edge(hi, hi, 1, hi);
  }
  g.stroke({ width: 3, color: style.curb, cap: 'round' });

  // 中心虚线：从中心到每个连通边的中点，两段短划
  for (const bit of DIR_BITS) {
    if (!(viewMask & bit)) continue;
    const d = bitVec(bit);
    for (const [t0, t1] of [
      [0.12, 0.26],
      [0.36, 0.48],
    ] as const) {
      const a = isoToScreen(vx + 0.5 + d.x * t0, vy + 0.5 + d.y * t0);
      const b = isoToScreen(vx + 0.5 + d.x * t1, vy + 0.5 + d.y * t1);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    }
  }
  if (viewMask !== 0) g.stroke({ width: 2.5, color: style.lane, cap: 'round' });
}
