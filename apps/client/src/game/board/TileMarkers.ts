// 格标记（marks 层）：选中格脉动描边、候选格高亮、路径预览脚印、调试用格号标签
import type { TileId } from '@rich4/shared/data';
import { Container, Graphics, Text } from 'pixi.js';
import type { AnimClock } from '../anim/AnimClock';
import { diamondPoints, isoToScreen } from '../iso/projection';
import { INK } from '../procedural/building/styles';
import type { BoardGeometry } from './BoardGeometry';

export class TileMarkers {
  readonly root = new Container({ label: 'tileMarkers' });
  private readonly highlight = new Graphics();
  private readonly selection = new Graphics();
  private readonly path = new Graphics();
  private readonly ids = new Container({ label: 'tileIds', visible: false });
  private selected: TileId | null = null;
  private highlighted: { ids: TileId[]; color: number } = { ids: [], color: 0xffd84d };
  private pathIds: TileId[] = [];
  private offFrame: (() => void) | null = null;
  private geo: BoardGeometry | null = null;

  constructor(layer: Container, clock: AnimClock) {
    this.root.addChild(this.highlight, this.path, this.selection, this.ids);
    layer.addChild(this.root);
    // 选中格的脉动（alpha 呼吸）
    this.offFrame = clock.onFrame((now) => {
      if (this.selected !== null) this.selection.alpha = 0.65 + 0.35 * Math.sin(now / 160);
    });
  }

  attach(geo: BoardGeometry): void {
    this.geo = geo;
    this.rebuildIds();
    this.redraw();
  }

  select(id: TileId | null): void {
    this.selected = id;
    this.redraw();
  }

  get selectedTile(): TileId | null {
    return this.selected;
  }

  setHighlight(ids: TileId[], color = 0xffd84d): void {
    this.highlighted = { ids: [...ids], color };
    this.redraw();
  }

  setPath(ids: TileId[]): void {
    this.pathIds = [...ids];
    this.redraw();
  }

  showIds(on: boolean): void {
    this.ids.visible = on;
  }

  get idsVisible(): boolean {
    return this.ids.visible;
  }

  /** 旋转后重新布局 */
  redraw(): void {
    const geo = this.geo;
    this.highlight.clear();
    this.selection.clear();
    this.path.clear();
    if (!geo) return;
    for (const id of this.highlighted.ids) {
      if (!geo.hasTile(id)) continue;
      const v = geo.viewCell(geo.tileCell(id));
      this.highlight.poly(diamondPoints(v.x, v.y, 0.06), true).fill({ color: this.highlighted.color, alpha: 0.35 });
      this.highlight.stroke({ width: 3, color: this.highlighted.color });
    }
    for (const [i, id] of this.pathIds.entries()) {
      if (!geo.hasTile(id)) continue;
      const v = geo.viewCell(geo.tileCell(id));
      const p = isoToScreen(v.x + 0.5, v.y + 0.5);
      this.path.ellipse(p.x, p.y, 9, 5).fill({ color: 0xffffff, alpha: 0.5 + (0.5 * (i + 1)) / this.pathIds.length });
      this.path.stroke({ width: 1.5, color: INK, alpha: 0.6 });
    }
    if (this.selected !== null && geo.hasTile(this.selected)) {
      const v = geo.viewCell(geo.tileCell(this.selected));
      this.selection.poly(diamondPoints(v.x, v.y, 0.02), true).stroke({ width: 5, color: 0xffffff, join: 'round' });
      this.selection.poly(diamondPoints(v.x, v.y, 0.02), true).stroke({ width: 2, color: INK, join: 'round' });
    }
    this.layoutIds();
  }

  private rebuildIds(): void {
    for (const c of this.ids.removeChildren()) c.destroy();
    if (!this.geo) return;
    for (const t of this.geo.def.tiles) {
      const label = new Text({
        text: String(t.id),
        style: { fontFamily: 'Fredoka, sans-serif', fontSize: 14, fill: 0xffffff, stroke: { color: INK, width: 3 } },
        resolution: 2,
      });
      label.anchor.set(0.5);
      label.label = `tileId:${t.id}`;
      this.ids.addChild(label);
    }
  }

  private layoutIds(): void {
    const geo = this.geo;
    if (!geo) return;
    for (const child of this.ids.children) {
      const id = Number((child.label ?? '').slice('tileId:'.length));
      if (!geo.hasTile(id)) continue;
      const v = geo.viewCell(geo.tileCell(id));
      const p = isoToScreen(v.x + 0.5, v.y + 0.82);
      child.position.set(p.x, p.y);
    }
  }

  destroy(): void {
    this.offFrame?.();
    this.offFrame = null;
    this.root.destroy({ children: true });
  }
}
