// 棋盘几何（纯计算，不依赖渲染器）：当前旋转下的格 ↔ 屏幕换算、link 的格链（含 via）、包围盒。
// BoardView、PlayerActor、MiniMap 共用；node 单测可直接构造。
import { type Cell, cellKey, type MapDef, type TileDef, type TileId } from '@rich4/shared/data';
import type { WorldRect } from '../camera/Camera';
import {
  cellToView,
  type GridSize,
  gridScreenBounds,
  logicalToScreen,
  normRotation,
  type Pt,
  type Rotation,
  rectToView,
  toView,
} from '../iso/projection';

export class BoardGeometry {
  readonly grid: GridSize;
  private rot: Rotation = 0;
  private readonly tiles = new Map<TileId, TileDef>();
  private readonly tileByCell = new Map<string, TileId>();

  constructor(
    readonly def: MapDef,
    rotation: Rotation = 0,
  ) {
    this.grid = { w: def.grid.w, h: def.grid.h };
    this.rot = rotation;
    for (const t of def.tiles) {
      this.tiles.set(t.id, t);
      this.tileByCell.set(cellKey(t.cell), t.id);
    }
  }

  get rotation(): Rotation {
    return this.rot;
  }

  setRotation(r: number): void {
    this.rot = normRotation(r);
  }

  tile(id: TileId): TileDef {
    const t = this.tiles.get(id);
    if (!t) throw new Error(`map ${this.def.id} has no tile ${id}`);
    return t;
  }

  hasTile(id: TileId): boolean {
    return this.tiles.has(id);
  }

  tileAtCell(c: Cell): TileId | null {
    return this.tileByCell.get(cellKey(c)) ?? null;
  }

  tileCell(id: TileId): Cell {
    return this.tile(id).cell;
  }

  /** from→to 的格链 [from.cell, ...via, to.cell]；两格不相连时返回直线两点 */
  linkCells(from: TileId, to: TileId): Cell[] {
    const a = this.tile(from);
    const b = this.tile(to);
    const direct = a.links.find((l) => l.to === to);
    if (direct) return [a.cell, ...(direct.via ?? []), b.cell];
    // 反向 link 带 via 时倒序使用（无向语义）
    const back = b.links.find((l) => l.to === from);
    if (back?.via) return [a.cell, ...[...back.via].reverse(), b.cell];
    return [a.cell, b.cell];
  }

  /** 逻辑连续坐标 → 屏幕（world 容器本地像素） */
  toScreen(p: Pt, z = 0): Pt {
    return logicalToScreen(p, this.rot, this.grid, z);
  }

  /** 逻辑格中心 → 屏幕 */
  cellCenter(c: Cell): Pt {
    return this.toScreen({ x: c.x + 0.5, y: c.y + 0.5 });
  }

  tileScreenPos(id: TileId): Pt {
    return this.cellCenter(this.tileCell(id));
  }

  viewCell(c: Cell): Cell {
    return cellToView(c, this.rot, this.grid);
  }

  viewPoint(p: Pt): Pt {
    return toView(p, this.rot, this.grid);
  }

  viewRect(r: { x: number; y: number; w: number; h: number }) {
    return rectToView(r, this.rot, this.grid);
  }

  /** 整个网格的屏幕包围盒（含建筑高度余量） */
  bounds(topMargin = 160): WorldRect {
    const b = gridScreenBounds(this.grid, this.rot);
    return { x: b.x, y: b.y - topMargin, w: b.w, h: b.h + topMargin };
  }
}
