// 地面层（design/client.md §3.3）：地形菱形 + 棋盘边缘厚度 + 道路拼接 + 特殊格底板与字符。
// 按视图网格分块（CHUNK×CHUNK 格），每块可 cacheAsTexture；旋转时整体重建。
import { Container, Graphics, Text } from 'pixi.js';
import { FONT_TITLE } from '../../ui/theme/fontFamilies';
import { cellFromView, diamondPoints, isoToScreen, type Rotation, viewGrid } from '../iso/projection';
import { shade } from '../procedural/building/geometry';
import { INK, PALETTE, TERRAIN_COLORS } from '../procedural/building/styles';
import type { BoardGeometry } from './BoardGeometry';
import { drawRoadCell, type RoadGraph, rotateMask } from './RoadPainter';
import { TILE_STYLES } from './tileStyles';

export interface GroundOptions {
  /** 分块烘焙为纹理（高画质可关闭以获得缩放时的矢量清晰度） */
  cacheChunks: boolean;
  /** 烘焙分辨率 */
  resolution: number;
  /** 分块边长（格） */
  chunkCells: number;
}

export const DEFAULT_GROUND_OPTIONS: GroundOptions = { cacheChunks: true, resolution: 2, chunkCells: 12 };

/** 棋盘边缘「厚度」像素 */
const SLAB_PX = 18;

interface Chunk {
  root: Container;
  terrain: Graphics;
  roads: Graphics;
  plates: Graphics;
  glyphs: Container;
}

export class GroundLayer {
  private chunks = new Map<string, Chunk>();

  constructor(
    private readonly layer: Container,
    private readonly opts: GroundOptions = DEFAULT_GROUND_OPTIONS,
  ) {}

  get chunkCount(): number {
    return this.chunks.size;
  }

  build(geo: BoardGeometry, road: RoadGraph): void {
    this.clear();
    const rot: Rotation = geo.rotation;
    const vg = viewGrid(geo.grid, rot);
    const C = this.opts.chunkCells;
    const def = geo.def;

    // 1) 地形 + 边缘厚度
    for (let vy = 0; vy < vg.h; vy++) {
      for (let vx = 0; vx < vg.w; vx++) {
        const lc = this.logicalCell(geo, vx, vy);
        const ch = def.terrain[lc.y]?.[lc.x] ?? 'g';
        const base = TERRAIN_COLORS[ch] ?? PALETTE.grass;
        const color = ch === 'g' && (lc.x + lc.y) % 2 === 1 ? shade(base, 0.96) : base;
        const chunk = this.chunkFor(vx, vy, C);
        chunk.terrain.poly(diamondPoints(vx, vy), true).fill(color);
        if (ch === 'w') {
          const a = isoToScreen(vx + 0.3, vy + 0.55);
          const b = isoToScreen(vx + 0.62, vy + 0.4);
          chunk.terrain.moveTo(a.x, a.y).quadraticCurveTo((a.x + b.x) / 2, a.y - 6, b.x, b.y);
          chunk.terrain.stroke({ width: 2, color: 0xffffff, alpha: 0.45, cap: 'round' });
        }
        // 视图网格的 SW 边（vy 最大）与 SE 边（vx 最大）画厚度
        if (vy === vg.h - 1) {
          const w0 = isoToScreen(vx, vy + 1);
          const s0 = isoToScreen(vx + 1, vy + 1);
          chunk.terrain
            .poly([w0.x, w0.y, s0.x, s0.y, s0.x, s0.y + SLAB_PX, w0.x, w0.y + SLAB_PX], true)
            .fill(ch === 'w' ? shade(PALETTE.water, 0.7) : 0xb07a4a);
        }
        if (vx === vg.w - 1) {
          const s0 = isoToScreen(vx + 1, vy + 1);
          const e0 = isoToScreen(vx + 1, vy);
          chunk.terrain
            .poly([s0.x, s0.y, e0.x, e0.y, e0.x, e0.y + SLAB_PX, s0.x, s0.y + SLAB_PX], true)
            .fill(ch === 'w' ? shade(PALETTE.water, 0.55) : 0x8a5a33);
        }
      }
    }

    // 2) 道路
    for (const c of road.cells) {
      const v = geo.viewCell(c);
      const mask = road.masks.get(`${c.x},${c.y}`) ?? 0;
      drawRoadCell(this.chunkFor(v.x, v.y, C).roads, v.x, v.y, rotateMask(mask, rot));
    }

    // 3) 游戏格底板与字符
    for (const t of def.tiles) {
      const style = TILE_STYLES[t.kind];
      const v = geo.viewCell(t.cell);
      const chunk = this.chunkFor(v.x, v.y, C);
      if (style.plate !== null) {
        const inset = t.kind === 'property' ? 0.2 : 0.16;
        chunk.plates.poly(diamondPoints(v.x, v.y, inset), true).fill({
          color: style.plate,
          alpha: t.kind === 'property' ? 0.55 : 1,
        });
        chunk.plates.stroke({ width: 2.5, color: INK, alpha: t.kind === 'property' ? 0.25 : 1, join: 'round' });
      }
      if (style.glyph) {
        const center = isoToScreen(v.x + 0.5, v.y + 0.5);
        const txt = new Text({
          text: style.glyph,
          style: {
            fontFamily: FONT_TITLE,
            fontSize: style.glyph.length > 1 ? 20 : 24,
            fill: style.glyphColor,
            stroke: { color: INK, width: style.glyphColor === INK ? 0 : 3, join: 'round' },
            fontWeight: '700',
          },
          resolution: 2,
        });
        txt.anchor.set(0.5);
        txt.position.set(center.x, center.y);
        txt.scale.y = 0.82;
        chunk.glyphs.addChild(txt);
      }
    }

    if (this.opts.cacheChunks) {
      for (const c of this.chunks.values())
        c.root.cacheAsTexture({ resolution: this.opts.resolution, antialias: true });
    }
  }

  clear(): void {
    for (const c of this.chunks.values()) {
      if (this.opts.cacheChunks) c.root.cacheAsTexture(false);
      c.root.destroy({ children: true });
    }
    this.chunks.clear();
  }

  private logicalCell(geo: BoardGeometry, vx: number, vy: number): { x: number; y: number } {
    return cellFromView({ x: vx, y: vy }, geo.rotation, geo.grid);
  }

  private chunkFor(vx: number, vy: number, C: number): Chunk {
    const key = `${Math.floor(vx / C)},${Math.floor(vy / C)}`;
    let c = this.chunks.get(key);
    if (!c) {
      const root = new Container({ label: `ground:${key}` });
      const terrain = new Graphics();
      const roads = new Graphics();
      const plates = new Graphics();
      const glyphs = new Container();
      root.addChild(terrain, roads, plates, glyphs);
      this.layer.addChild(root);
      c = { root, terrain, roads, plates, glyphs };
      this.chunks.set(key, c);
    }
    return c;
  }
}
