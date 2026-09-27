// 原版小地图（original-skin.md §5 A6；design-draft §3.3「小地图」）：map#8+gm 的俯视缩略图（200² / 400²），
// 玩家点坐标 = world · 边长 / 世界尺寸；视口画成随视角旋转的四边形（8 视角）；地块归属与玩家点用角色代表色。
// 原版棋盘（game/orig/OrigRenderer）载入地图后在这里登记数据源；MiniMapPainter（程序化小地图与经典日历区共用）
// 每次绘制时查登记表，命中就改用这里的画法，并换用「棋盘坐标 ↔ 小地图像素」的换算（布局里的 toMini / toWorld），
// 这样对局页与路线 A 外壳不用区分皮肤。没有缩略图（合成素材包）时画示意图：海面底色 + 节点与连线。
import type { LotId, MapDef, TileId } from '@rich4/shared/data';
import type { Pt } from '../iso/projection';

export interface OrigMiniMapImage {
  /** 图集页位图 */
  bitmap: CanvasImageSource;
  /** 缩略图在页里的矩形 */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** 原版棋盘登记的小地图数据源 */
export interface OrigMiniMapSource {
  readonly def: MapDef;
  /** 世界尺寸（原版 2304²；fixture 为 cell×32） */
  readonly world: { w: number; h: number };
  /** 俯视缩略图（覆盖整个世界）；没有为 null */
  readonly image: OrigMiniMapImage | null;
  /** 当前视角 0..7 */
  view(): number;
  /** 棋盘坐标（镜头、视口四角所在的坐标系）↔ 世界 */
  toWorld(board: Pt): Pt;
  toBoard(world: Pt): Pt;
  tileWorld(id: TileId): Pt | null;
  lotWorld(id: LotId | string): Pt | null;
  /** 座位 → 代表色（角色） */
  seatColor(seat: number): number;
}

/** MiniMapPainter 的布局（与 MiniMapLayout 同形；带自定义换算） */
export interface OrigMiniLayout {
  scale: number;
  originX: number;
  originY: number;
  padX: number;
  padY: number;
  /** 棋盘坐标 → 小地图像素 */
  toMini(p: Pt): Pt;
  /** 小地图像素 → 棋盘坐标 */
  toWorld(p: Pt): Pt;
}

export interface OrigMiniState {
  owners?: Readonly<Record<string, number | null>>;
  players?: readonly { seat: number; tile: TileId }[];
  /** 视口四角（棋盘坐标） */
  viewport?: readonly Pt[];
}

/** 小地图用到的 2D 上下文能力（真实画布都有；node 测试的替身可以只给一部分） */
export type OrigMiniCtx = Pick<
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
> &
  Partial<Pick<CanvasRenderingContext2D, 'drawImage' | 'fillRect' | 'imageSmoothingEnabled'>>;

// ───────────────────────── 登记表 ─────────────────────────

const sources = new Set<OrigMiniMapSource>();

function sameMap(a: MapDef, b: MapDef): boolean {
  return a === b || (a.id === b.id && a.meta.dataHash === b.meta.dataHash);
}

/** 原版棋盘载入地图后登记；返回撤销函数（棋盘销毁时调用） */
export function registerOrigMiniMap(src: OrigMiniMapSource): () => void {
  sources.add(src);
  return () => {
    sources.delete(src);
  };
}

/** 这张地图当前有没有原版小地图（后登记的优先） */
export function origMiniMapFor(def: MapDef): OrigMiniMapSource | null {
  let hit: OrigMiniMapSource | null = null;
  for (const s of sources) if (sameMap(s.def, def)) hit = s;
  return hit;
}

// ───────────────────────── 布局与绘制 ─────────────────────────

const hex = (c: number): string => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;

/** 把整个世界（正方形俯视图）等比放进 w×h 的画布 */
export function origMiniLayout(src: OrigMiniMapSource, w: number, h: number, pad = 2): OrigMiniLayout {
  const scale = Math.min((w - pad * 2) / src.world.w, (h - pad * 2) / src.world.h);
  const padX = (w - src.world.w * scale) / 2;
  const padY = (h - src.world.h * scale) / 2;
  const worldToMini = (p: Pt): Pt => ({ x: p.x * scale + padX, y: p.y * scale + padY });
  return {
    scale,
    originX: 0,
    originY: 0,
    padX,
    padY,
    toMini: (board) => worldToMini(src.toWorld(board)),
    toWorld: (mini) => src.toBoard({ x: (mini.x - padX) / scale, y: (mini.y - padY) / scale }),
  };
}

export function paintOrigMiniMap(
  ctx: OrigMiniCtx,
  size: { w: number; h: number },
  src: OrigMiniMapSource,
  state: OrigMiniState = {},
): OrigMiniLayout {
  const L = origMiniLayout(src, size.w, size.h);
  const m = (p: Pt): Pt => ({ x: p.x * L.scale + L.padX, y: p.y * L.scale + L.padY });
  const W = src.world.w * L.scale;
  const H = src.world.h * L.scale;
  ctx.clearRect(0, 0, size.w, size.h);
  ctx.fillStyle = '#000000';
  ctx.fillRect?.(0, 0, size.w, size.h);
  if (src.image && ctx.drawImage) {
    const im = src.image;
    ctx.save();
    if ('imageSmoothingEnabled' in ctx) ctx.imageSmoothingEnabled = true;
    ctx.drawImage(im.bitmap, im.sx, im.sy, im.sw, im.sh, L.padX, L.padY, W, H);
    ctx.restore();
  } else {
    // 示意图：海面 + 节点连线 + 节点
    ctx.fillStyle = '#1d3f73';
    ctx.fillRect?.(L.padX, L.padY, W, H);
    ctx.strokeStyle = '#8a8f99';
    ctx.lineWidth = Math.max(1, L.scale * 10);
    for (const t of src.def.tiles) {
      const a = m(t.world);
      for (const k of t.links) {
        const b = src.tileWorld(k.to);
        if (!b) continue;
        const bm = m(b);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(bm.x, bm.y);
        ctx.stroke();
      }
    }
  }
  // 地块归属（角色代表色的小方块）
  for (const [id, owner] of Object.entries(state.owners ?? {})) {
    if (owner === null || owner === undefined) continue;
    const w = src.lotWorld(id);
    if (!w) continue;
    const p = m(w);
    const r = Math.max(2, L.scale * 14);
    ctx.fillStyle = hex(src.seatColor(owner));
    ctx.beginPath();
    ctx.moveTo(p.x - r, p.y - r);
    ctx.lineTo(p.x + r, p.y - r);
    ctx.lineTo(p.x + r, p.y + r);
    ctx.lineTo(p.x - r, p.y + r);
    ctx.closePath();
    ctx.fill();
  }
  // 玩家
  for (const pl of state.players ?? []) {
    const w = src.tileWorld(pl.tile);
    if (!w) continue;
    const p = m(w);
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(2.5, L.scale * 22), 0, Math.PI * 2);
    ctx.fillStyle = hex(src.seatColor(pl.seat));
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#000000';
    ctx.stroke();
  }
  // 视口（棋盘坐标 → 世界 → 小地图；随视角旋转的四边形）
  if (state.viewport && state.viewport.length >= 3) {
    const pts = state.viewport.map((p) => L.toMini(p));
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
    ctx.closePath();
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }
  return L;
}
