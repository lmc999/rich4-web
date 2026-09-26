// 装饰物（树、石头、花）：MapDef.decorations 给出的格，放进 objects 层参与深度排序
import type { Decoration } from '@rich4/shared/data';
import { type Container, Graphics } from 'pixi.js';
import { DepthBias, depthOfCell } from '../iso/depth';
import { isoToScreen } from '../iso/projection';
import { INK, PALETTE } from '../procedural/building/styles';
import type { BoardGeometry } from './BoardGeometry';

function drawDecoration(g: Graphics, d: Decoration): void {
  switch (d.kind) {
    case 'tree': {
      const tall = 1 + (d.variant % 3) * 0.18;
      g.ellipse(0, 2, 18, 8).fill({ color: 0x000000, alpha: 0.15 });
      g.rect(-3, -22 * tall, 6, 22 * tall)
        .fill(PALETTE.door)
        .stroke({ width: 2, color: INK });
      if (d.variant % 2 === 0) {
        g.circle(0, -32 * tall, 17)
          .fill(PALETTE.green)
          .stroke({ width: 3, color: INK });
        g.circle(-6, -38 * tall, 5).fill({ color: 0xffffff, alpha: 0.35 });
      } else {
        g.poly([0, -62 * tall, 18, -18 * tall, -18, -18 * tall], true)
          .fill(PALETTE.grassDark)
          .stroke({ width: 3, color: INK, join: 'round' });
      }
      break;
    }
    case 'rock':
      g.ellipse(0, 2, 16, 7).fill({ color: 0x000000, alpha: 0.15 });
      g.poly([-16, 0, -10, -14, 4, -18, 16, -6, 12, 2], true)
        .fill(d.variant % 2 ? 0xb8b2a6 : 0x9c958a)
        .stroke({ width: 3, color: INK, join: 'round' });
      break;
    case 'flower': {
      const colors = [PALETTE.red, PALETTE.sun, PALETTE.pink, PALETTE.purple];
      for (let i = 0; i < 5; i++) {
        const x = -14 + i * 7;
        const y = (i % 2) * 6 - 2;
        g.moveTo(x, y)
          .lineTo(x, y - 8)
          .stroke({ width: 2, color: 0x2f6b2a });
        g.circle(x, y - 10, 3.5)
          .fill(colors[(i + d.variant) % colors.length]!)
          .stroke({ width: 1.5, color: INK });
      }
      break;
    }
  }
}

export class Decorations {
  private items: { d: Decoration; g: Graphics }[] = [];

  constructor(private readonly layer: Container) {}

  build(geo: BoardGeometry): void {
    this.clear();
    for (const d of geo.def.decorations) {
      const g = new Graphics({ label: `deco:${d.kind}` });
      drawDecoration(g, d);
      this.layer.addChild(g);
      this.items.push({ d, g });
    }
    this.layout(geo);
  }

  layout(geo: BoardGeometry): void {
    for (const { d, g } of this.items) {
      const v = geo.viewCell(d.cell);
      const p = isoToScreen(v.x + 0.5, v.y + 0.5);
      g.position.set(p.x, p.y);
      g.zIndex = depthOfCell(v, DepthBias.Building);
    }
  }

  get count(): number {
    return this.items.length;
  }

  clear(): void {
    for (const { g } of this.items) g.destroy();
    this.items = [];
  }
}
