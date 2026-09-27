// 原版棋盘的拾取（design-draft §3.3「拾取与高亮」）：
// 1) 高层建筑先用精灵 alpha 命中（按深度从前往后）：命中哪栋楼就是哪块地；
// 2) 屏幕点经仿射求逆得到世界点：24 世界像素内最近的节点算命中；
// 3) 否则 32 世界像素内最近的地块中心（lot.world）。
// 纯逻辑，不引入 Pixi：精灵的 alpha 由调用方以 hit(lx, ly) 回调给出。
import type { LotId, MapDef, TileId } from '@rich4/shared/data';
import type { Pt } from '../iso/projection';

export const TILE_PICK_RADIUS = 24;
export const LOT_PICK_RADIUS = 32;

/** 可命中的建筑精灵（棋盘坐标的包围盒 + 深度 + 局部像素 alpha 测试） */
export interface SpriteHitBox {
  lot: LotId;
  /** 左上角（棋盘坐标，源像素） */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 深度键（越大越靠前） */
  z: number;
  /** 局部像素 (lx, ly)（0 ≤ lx < w）是否不透明 */
  hit(lx: number, ly: number): boolean;
}

export interface OrigPick {
  tile: TileId | null;
  lot: LotId | null;
}

interface LotPoint {
  id: LotId;
  world: Pt;
  front: TileId | null;
}

export class OrigPickIndex {
  private readonly tiles: { id: TileId; world: Pt; lot: LotId | null }[];
  private readonly lots: LotPoint[];
  private readonly frontOf = new Map<LotId, TileId | null>();

  constructor(def: Pick<MapDef, 'tiles' | 'lots' | 'companies'>) {
    this.tiles = def.tiles.map((t) => ({ id: t.id, world: t.world, lot: t.ref?.lot ?? null }));
    this.lots = [...def.lots, ...def.companies].map((l) => ({
      id: l.id,
      world: l.world,
      front: l.frontTiles[0] ?? null,
    }));
    for (const l of this.lots) this.frontOf.set(l.id, l.front);
  }

  /** radius 世界像素内最近的节点 */
  nearestTile(w: Pt, radius = TILE_PICK_RADIUS): TileId | null {
    let best: TileId | null = null;
    let bd = radius * radius;
    for (const t of this.tiles) {
      const d = (t.world.x - w.x) ** 2 + (t.world.y - w.y) ** 2;
      if (d <= bd) {
        bd = d;
        best = t.id;
      }
    }
    return best;
  }

  /** radius 世界像素内最近的地块（住宅、设施、企业的 world 点） */
  nearestLot(w: Pt, radius = LOT_PICK_RADIUS): LotId | null {
    let best: LotId | null = null;
    let bd = radius * radius;
    for (const l of this.lots) {
      const d = (l.world.x - w.x) ** 2 + (l.world.y - w.y) ** 2;
      if (d <= bd) {
        bd = d;
        best = l.id;
      }
    }
    return best;
  }

  /** 地块的第一个前沿格（棋盘点选回传要求有格） */
  frontTile(lot: LotId): TileId | null {
    return this.frontOf.get(lot) ?? null;
  }

  /**
   * 拾取：board 为棋盘坐标（精灵命中用），world 为对应的世界点。
   * 命中建筑或地块时 tile 取该地块的第一个前沿格。
   */
  pick(world: Pt, board: Pt, sprites: readonly SpriteHitBox[] = []): OrigPick | null {
    const lot = pickSprite(board, sprites);
    if (lot) return { tile: this.frontTile(lot), lot };
    const tile = this.nearestTile(world);
    if (tile !== null) return { tile, lot: this.tiles.find((t) => t.id === tile)?.lot ?? null };
    const near = this.nearestLot(world);
    if (near) return { tile: this.frontTile(near), lot: near };
    return null;
  }
}

/** 按深度从前往后找第一个 alpha 命中的精灵 */
export function pickSprite(board: Pt, sprites: readonly SpriteHitBox[]): LotId | null {
  const order = [...sprites].sort((a, b) => b.z - a.z);
  for (const s of order) {
    const lx = Math.floor(board.x - s.x);
    const ly = Math.floor(board.y - s.y);
    if (lx < 0 || ly < 0 || lx >= s.w || ly >= s.h) continue;
    if (s.hit(lx, ly)) return s.lot;
  }
  return null;
}
