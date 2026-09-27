// 神明精灵（design/client.md §3.6）：路上神明漂浮 + 柔光 + 上下浮动；附身时缩小挂在角色头顶，带神明配色光环。
// 纹理来自造型 SVG（figures.godSvg）异步栅格化；未就绪（或 node 单测）时显示同配色的占位图形。
import type { GodKind } from '@rich4/shared/engine';
import { Container, Graphics, Sprite } from 'pixi.js';
import type { AnimClock } from '../anim/AnimClock';
import { INK } from '../procedural/building/styles';
import { GOD_PALETTES, godSvg } from './figures';
import type { FigureTextures } from './figureTextures';

export type GodMode = 'road' | 'attached';

/** 路上 / 附身时的精灵缩放（128×160 的 SVG 帧） */
export const GOD_SCALE: Readonly<Record<GodMode, number>> = { road: 0.56, attached: 0.34 };

export class GodSprite {
  readonly root = new Container({ label: 'god' });
  private readonly glow = new Graphics();
  private readonly body = new Container();
  private readonly sprite = new Sprite();
  private readonly placeholder = new Graphics();
  private readonly offFrame: () => void;
  private t = 0;
  private dead = false;
  /** 额外的整体偏移（动画用，叠加在浮动之上） */
  lift = 0;

  constructor(
    readonly kind: GodKind,
    clock: AnimClock,
    figures: FigureTextures | null,
    readonly mode: GodMode,
  ) {
    const pal = GOD_PALETTES[kind];
    const dog = kind === 11;
    this.root.label = `god:${kind}:${mode}`;
    // 柔光：路上是地面光晕，附身是头顶光环
    if (mode === 'road') {
      if (!dog) this.glow.ellipse(0, 0, 34, 15).fill({ color: pal.aura, alpha: 0.45 });
      this.glow.ellipse(0, 0, 18, 7).fill({ color: 0x000000, alpha: 0.18 });
    } else {
      this.glow.ellipse(0, -20, 28, 30).fill({ color: pal.aura, alpha: 0.35 });
      this.glow.ellipse(0, 0, 20, 6).stroke({ width: 3, color: pal.aura, alpha: 0.9 });
    }
    this.sprite.anchor.set(0.5, 0.94);
    this.sprite.visible = false;
    this.drawPlaceholder();
    this.body.addChild(this.placeholder, this.sprite);
    this.body.scale.set(GOD_SCALE[mode]);
    this.root.addChild(this.glow, this.body);
    if (figures) {
      void figures
        .texture(`god:${kind}`, () => godSvg(kind))
        .then((tex) => {
          if (!tex || this.destroyed) return;
          this.sprite.texture = tex;
          this.sprite.visible = true;
          this.placeholder.visible = false;
        });
    }
    this.offFrame = clock.onFrame((_now, dt) => this.tick(dt));
    this.tick(0);
  }

  /** 自己销毁，或根节点被演出（Fx.track 的 clear）连带销毁 */
  get destroyed(): boolean {
    return this.dead || this.root.destroyed;
  }

  /** 缩放倍数（动画用，1 = 该模式的正常大小） */
  setScale(k: number): void {
    if (!this.destroyed) this.body.scale.set(GOD_SCALE[this.mode] * k);
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    this.offFrame();
    this.root.destroy({ children: true });
  }

  private tick(dt: number): void {
    if (this.destroyed) {
      // 根节点被外部销毁：注销帧回调，之后不再写已销毁的 Pixi 对象
      this.destroy();
      return;
    }
    this.t += dt;
    const float = this.kind === 11 ? 0 : Math.sin(this.t / 420) * (this.mode === 'road' ? 5 : 3);
    this.body.position.set(0, (this.mode === 'road' ? -10 : 0) + float - this.lift);
    this.glow.alpha = 0.75 + 0.25 * Math.sin(this.t / 300);
  }

  /** 占位：光环 + 长袍小人（配色同神明） */
  private drawPlaceholder(): void {
    const pal = GOD_PALETTES[this.kind];
    const g = this.placeholder;
    if (this.kind === 11) {
      g.ellipse(0, -30, 34, 18).fill(0xa0643c).stroke({ width: 3, color: INK });
      g.circle(-30, -52, 18).fill(0xa0643c).stroke({ width: 3, color: INK });
      return;
    }
    g.ellipse(0, -78, 44, 52).fill({ color: pal.aura, alpha: 0.45 });
    g.poly([-26, -14, 0, -76, 26, -14], true)
      .fill(pal.good ? 0xe8453c : 0x6b5b8a)
      .stroke({ width: 3, color: INK });
    g.circle(0, -92, 24).fill(0xffe0c2).stroke({ width: 3, color: INK });
    g.ellipse(0, -122, 16, 5).stroke({ width: 4, color: 0xffd84d });
    g.ellipse(0, -6, 40, 10).fill(0xffffff).stroke({ width: 2, color: INK });
  }
}
