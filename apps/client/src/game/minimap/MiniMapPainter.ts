// 小地图（design/client.md §3.9）：Canvas2D 按当前旋转画菱形格——地形、道路、特殊格、地块主人色、玩家彩点、视口框。
// 调用方负责节流（显示态变化后 250ms 内最多重绘一次）；点击用 miniToWorld 换算后交给 camera.panTo。
import type { MapDef, TileId } from '@rich4/shared/data';
import { buildRoadGraph } from '../board/RoadPainter';
import { TILE_STYLES } from '../board/tileStyles';
import {
  cellFromView,
  cellToView,
  type GridSize,
  gridScreenBounds,
  isoToScreen,
  logicalToScreen,
  type Pt,
  type Rotation,
  rectToView,
  viewGrid,
} from '../iso/projection';
import { PLAYER_COLORS, TERRAIN_COLORS } from '../procedural/building/styles';

export interface MiniMapLayout {
  scale: number;
  /** world 屏幕坐标 → 小地图像素：mini = (world - origin) * scale + pad */
  originX: number;
  originY: number;
  padX: number;
  padY: number;
}

/** 把整个棋盘（world 屏幕包围盒）等比放进 w×h 的画布 */
export function miniMapLayout(grid: GridSize, rot: Rotation, w: number, h: number, pad = 6): MiniMapLayout {
  const b = gridScreenBounds(grid, rot);
  const scale = Math.min((w - pad * 2) / b.w, (h - pad * 2) / b.h);
  const padX = (w - b.w * scale) / 2;
  const padY = (h - b.h * scale) / 2;
  return { scale, originX: b.x, originY: b.y, padX, padY };
}

export function worldToMini(l: MiniMapLayout, p: Pt): Pt {
  return { x: (p.x - l.originX) * l.scale + l.padX, y: (p.y - l.originY) * l.scale + l.padY };
}

export function miniToWorld(l: MiniMapLayout, p: Pt): Pt {
  return { x: (p.x - l.padX) / l.scale + l.originX, y: (p.y - l.padY) / l.scale + l.originY };
}

export interface MiniMapState {
  /** LotId → 座位（无主为 null） */
  owners?: Readonly<Record<string, number | null>>;
  players?: readonly { seat: number; tile: TileId }[];
  /** 视口四角（world 屏幕坐标），画成白框 */
  viewport?: readonly Pt[];
}

type Ctx2D = Pick<
  CanvasRenderingContext2D,
  | 'clearRect'
  | 'beginPath'
  | 'moveTo'
  | 'lineTo'
  | 'closePath'
  | 'fill'
  | 'stroke'
  | 'arc'
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'lineJoin'
  | 'save'
  | 'restore'
>;

const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

export class MiniMapPainter {
  private layoutCache: MiniMapLayout;
  private readonly roadCells: { x: number; y: number }[];

  constructor(
    private readonly ctx: Ctx2D,
    private readonly def: MapDef,
    private rot: Rotation,
    private readonly size: { w: number; h: number },
  ) {
    this.roadCells = buildRoadGraph(def).cells;
    this.layoutCache = miniMapLayout(def.grid, rot, size.w, size.h);
  }

  get layout(): MiniMapLayout {
    return this.layoutCache;
  }

  setRotation(rot: Rotation): void {
    this.rot = rot;
    this.layoutCache = miniMapLayout(this.def.grid, rot, this.size.w, this.size.h);
  }

  paint(state: MiniMapState = {}): void {
    const { ctx, def, rot } = this;
    const L = this.layoutCache;
    const grid = def.grid;
    const vg = viewGrid(grid, rot);
    ctx.clearRect(0, 0, this.size.w, this.size.h);
    const diamond = (vx: number, vy: number, color: string, inset = 0): void => {
      const pts = [
        isoToScreen(vx + inset, vy + inset),
        isoToScreen(vx + 1 - inset, vy + inset),
        isoToScreen(vx + 1 - inset, vy + 1 - inset),
        isoToScreen(vx + inset, vy + 1 - inset),
      ].map((p) => worldToMini(L, p));
      ctx.beginPath();
      ctx.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 1; i < 4; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    };
    // 地形
    for (let vy = 0; vy < vg.h; vy++) {
      for (let vx = 0; vx < vg.w; vx++) {
        const lc = cellFromView({ x: vx, y: vy }, rot, grid);
        const ch = def.terrain[lc.y]?.[lc.x] ?? 'g';
        diamond(vx, vy, hex(TERRAIN_COLORS[ch] ?? 0x8fd16a));
      }
    }
    // 地块（主人色）
    for (const l of [...def.lots, ...def.companies]) {
      const owner = state.owners?.[l.id] ?? null;
      const vr = rectToView(l.rect, rot, grid);
      const color = owner === null ? '#E9DCC0' : hex(PLAYER_COLORS[owner] ?? 0xffffff);
      for (let y = vr.y; y < vr.y + vr.h; y++) for (let x = vr.x; x < vr.x + vr.w; x++) diamond(x, y, color, 0.08);
    }
    for (const m of def.landmarks) {
      const vr = rectToView(m.rect, rot, grid);
      for (let y = vr.y; y < vr.y + vr.h; y++) for (let x = vr.x; x < vr.x + vr.w; x++) diamond(x, y, '#C9B79C', 0.08);
    }
    // 道路与特殊格
    for (const c of this.roadCells) {
      const v = cellToView(c, rot, grid);
      diamond(v.x, v.y, '#8A8F99', 0.12);
    }
    for (const t of def.tiles) {
      const v = cellToView(t.cell, rot, grid);
      const plate = TILE_STYLES[t.kind].plate;
      diamond(v.x, v.y, plate === null || t.kind === 'property' ? '#B7BCC6' : hex(plate), 0.12);
    }
    // 玩家
    for (const p of state.players ?? []) {
      const t = def.tiles.find((x) => x.id === p.tile);
      if (!t) continue;
      const m = worldToMini(L, logicalToScreen({ x: t.cell.x + 0.5, y: t.cell.y + 0.5 }, rot, grid));
      ctx.beginPath();
      ctx.arc(m.x, m.y, Math.max(3, L.scale * 26), 0, Math.PI * 2);
      ctx.fillStyle = hex(PLAYER_COLORS[p.seat] ?? 0xffffff);
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#3A2A1A';
      ctx.stroke();
    }
    // 视口框
    if (state.viewport && state.viewport.length >= 3) {
      const pts = state.viewport.map((p) => worldToMini(L, p));
      ctx.beginPath();
      ctx.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
      ctx.closePath();
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#FFFFFF';
      ctx.stroke();
    }
  }
}
