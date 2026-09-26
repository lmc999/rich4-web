// 拾取：屏幕点 → 逻辑格 → 该格上的游戏格 / 地块 / 企业 / 地标 / 连接格（design/client.md §3.2「拾取」）。
// 采用「worldToIso 取整后查表」，不依赖 Pixi 的命中测试，旋转后同样成立。
import { type Cell, cellKey, type LotId, type MapDef, type TileDef, type TileId } from '@rich4/shared/data';
import { type GridSize, type Rotation, screenToCell } from './projection';

export interface PickResult {
  cell: Cell;
  inGrid: boolean;
  terrain: string | null;
  tile: TileId | null;
  lot: LotId | null;
  landmark: string | null;
  /** 连接格（via / roadCells），不是游戏格 */
  road: boolean;
}

export class PickIndex {
  readonly grid: GridSize;
  private readonly tiles = new Map<string, TileId>();
  private readonly lots = new Map<string, LotId>();
  private readonly landmarks = new Map<string, string>();
  private readonly roads = new Set<string>();

  constructor(readonly def: MapDef) {
    this.grid = { w: def.grid.w, h: def.grid.h };
    for (const t of def.tiles) this.tiles.set(cellKey(t.cell), t.id);
    for (const c of def.roadCells) this.roads.add(cellKey(c));
    for (const l of [...def.lots, ...def.companies]) {
      for (let y = l.rect.y; y < l.rect.y + l.rect.h; y++)
        for (let x = l.rect.x; x < l.rect.x + l.rect.w; x++) this.lots.set(`${x},${y}`, l.id);
    }
    for (const m of def.landmarks) {
      for (let y = m.rect.y; y < m.rect.y + m.rect.h; y++)
        for (let x = m.rect.x; x < m.rect.x + m.rect.w; x++) this.landmarks.set(`${x},${y}`, m.id);
    }
  }

  at(cell: Cell): PickResult {
    const k = cellKey(cell);
    const inGrid = cell.x >= 0 && cell.y >= 0 && cell.x < this.grid.w && cell.y < this.grid.h;
    const row = inGrid ? this.def.terrain[cell.y] : undefined;
    return {
      cell: { x: cell.x, y: cell.y },
      inGrid,
      terrain: row ? (row[cell.x] ?? null) : null,
      tile: this.tiles.get(k) ?? null,
      lot: this.lots.get(k) ?? null,
      landmark: this.landmarks.get(k) ?? null,
      road: this.roads.has(k),
    };
  }

  /** world 容器本地像素 → 拾取结果 */
  pickScreen(sx: number, sy: number, rot: Rotation): PickResult {
    return this.at(screenToCell(sx, sy, rot, this.grid));
  }

  tileDef(id: TileId): TileDef | undefined {
    return this.def.tiles.find((t) => t.id === id);
  }
}
