// 地块视图基类 + 住宅地（design/client.md §3.5）：marks 层画地块底板与归属色带，objects 层放建筑精灵（按深度排序）。
// 住宅地 0–5 级：0 级为空地（无主「出售」牌 / 有主插旗），1–5 级按 styles.HOUSE_LEVELS 生成。
import type { Cell, LandLot, Rect } from '@rich4/shared/data';
import { type Container, Graphics, Sprite } from 'pixi.js';
import { DepthBias, depthOfRect } from '../iso/depth';
import { isoToScreen } from '../iso/projection';
import { type BuildingSpec, getBuildingTexture } from '../procedural/building/generate';
import { INK, PLAYER_COLORS } from '../procedural/building/styles';
import type { TextureCache } from '../procedural/textureCache';
import type { BoardGeometry } from './BoardGeometry';

export interface ViewContext {
  geo: BoardGeometry;
  cache: TextureCache;
  marks: Container;
  objects: Container;
  /** i18n 查询：返回 undefined 时用兜底文字 */
  label(key: string): string | undefined;
  /** 地图文案（MapDef.strings 的 zh-CN） */
  mapString(key: string): string | undefined;
}

export interface OwnedState {
  owner: number | null;
  level: number;
}

/** 字符串的稳定小哈希（选外观变体） */
export function variantOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export abstract class FootprintView {
  readonly plate = new Graphics();
  readonly building = new Sprite();
  heightPx = 0;
  /** 最近一次布局的视图矩形 */
  viewRect: Rect = { x: 0, y: 0, w: 1, h: 1 };

  protected constructor(
    protected readonly ctx: ViewContext,
    readonly id: string,
    readonly rect: Rect,
    readonly frontCells: readonly Cell[],
  ) {
    this.plate.label = `plate:${id}`;
    this.building.label = `building:${id}`;
    ctx.marks.addChild(this.plate);
    ctx.objects.addChild(this.building);
  }

  /** 门朝向：前沿格在视图 +x 侧 → 右面（SE），+y 侧 → 左面（SW），否则门在背面 */
  doorSide(vr: Rect): 'left' | 'right' | 'none' {
    for (const c of this.frontCells) {
      const v = this.ctx.geo.viewCell(c);
      if (v.x >= vr.x + vr.w && v.y >= vr.y && v.y < vr.y + vr.h) return 'right';
      if (v.y >= vr.y + vr.h && v.x >= vr.x && v.x < vr.x + vr.w) return 'left';
    }
    for (const c of this.frontCells) {
      const v = this.ctx.geo.viewCell(c);
      if (v.x >= vr.x + vr.w) return 'right';
      if (v.y >= vr.y + vr.h) return 'left';
    }
    return 'none';
  }

  layout(): void {
    const vr = this.ctx.geo.viewRect(this.rect);
    this.viewRect = vr;
    // 底板
    const style = this.plateStyle();
    const m = 0.05;
    const pts = [
      isoToScreen(vr.x + m, vr.y + m),
      isoToScreen(vr.x + vr.w - m, vr.y + m),
      isoToScreen(vr.x + vr.w - m, vr.y + vr.h - m),
      isoToScreen(vr.x + m, vr.y + vr.h - m),
    ].flatMap((p) => [p.x, p.y]);
    this.plate.clear();
    this.plate.poly(pts, true).fill(style.fill);
    if (style.ring !== null) this.plate.stroke({ width: 6, color: style.ring, join: 'round', alignment: 1 });
    else this.plate.stroke({ width: 2, color: INK, alpha: 0.35, join: 'round' });
    // 建筑
    const spec = this.spec(vr, this.doorSide(vr));
    if (!spec) {
      this.building.visible = false;
      this.heightPx = 0;
      return;
    }
    const tex = getBuildingTexture(this.ctx.cache, spec);
    this.building.texture = tex.texture;
    this.building.anchor.set(tex.anchor.x, tex.anchor.y);
    const c = isoToScreen(vr.x + vr.w / 2, vr.y + vr.h / 2);
    this.building.position.set(c.x, c.y);
    this.building.zIndex = depthOfRect(vr, DepthBias.Building);
    this.building.visible = true;
    this.heightPx = -tex.frame.y;
  }

  protected abstract spec(vr: Rect, door: 'left' | 'right' | 'none'): BuildingSpec | null;
  protected abstract plateStyle(): { fill: number; ring: number | null };

  destroy(): void {
    this.plate.destroy();
    this.building.destroy();
  }
}

/** 住宅地（1×1） */
export class LotView extends FootprintView {
  state: OwnedState = { owner: null, level: 0 };

  constructor(
    ctx: ViewContext,
    readonly lot: LandLot,
  ) {
    super(
      ctx,
      lot.id,
      lot.rect,
      lot.frontTiles.map((t) => ctx.geo.tileCell(t)),
    );
  }

  setState(s: Partial<OwnedState>): void {
    this.state = { ...this.state, ...s };
    this.layout();
  }

  protected spec(vr: Rect, door: 'left' | 'right' | 'none'): BuildingSpec {
    return {
      kind: 'house',
      level: this.state.level,
      w: vr.w,
      d: vr.h,
      owner: this.state.owner,
      variant: variantOf(this.lot.id) % 4,
      door,
      sign: this.state.level === 0 && this.state.owner === null ? this.ctx.label('ui:board.forSale') : undefined,
    };
  }

  protected plateStyle(): { fill: number; ring: number | null } {
    const ring = this.state.owner === null ? null : (PLAYER_COLORS[this.state.owner] ?? null);
    return { fill: 0xd7efb0, ring };
  }
}
