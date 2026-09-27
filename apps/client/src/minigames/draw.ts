// 小游戏场景共用的程序化绘制（全部原创：平涂 + 深棕描边，与棋盘美术同一风格，design/client.md §6.1）。
import { Container, Graphics, Text } from 'pixi.js';

export const INK = 0x3a2a1a;
export const FONT_TITLE = '"ZCOOL KuaiLe", "PingFang SC", "Microsoft YaHei", sans-serif';
export const FONT_NUM = 'Fredoka, "ZCOOL KuaiLe", sans-serif';

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** 竖直渐变的近似：n 条平涂色带（避免依赖渐变纹理） */
export function bands(
  g: Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  top: number,
  bottom: number,
  n = 12,
): void {
  const tr = (top >> 16) & 0xff;
  const tg = (top >> 8) & 0xff;
  const tb = top & 0xff;
  const br = (bottom >> 16) & 0xff;
  const bg = (bottom >> 8) & 0xff;
  const bb = bottom & 0xff;
  const step = h / n;
  for (let i = 0; i < n; i++) {
    const k = n === 1 ? 0 : i / (n - 1);
    const c = (Math.round(lerp(tr, br, k)) << 16) | (Math.round(lerp(tg, bg, k)) << 8) | Math.round(lerp(tb, bb, k));
    g.rect(x, y + i * step, w, step + 1).fill(c);
  }
}

/** 一朵云（几个圆叠在一起） */
export function cloud(g: Graphics, x: number, y: number, s: number, color = 0xffffff, alpha = 1): void {
  g.circle(x, y, 18 * s).fill({ color, alpha });
  g.circle(x + 20 * s, y - 8 * s, 22 * s).fill({ color, alpha });
  g.circle(x + 44 * s, y, 18 * s).fill({ color, alpha });
  g.roundRect(x - 10 * s, y - 2 * s, 66 * s, 20 * s, 10 * s).fill({ color, alpha });
}

/** 金币（中间方孔） */
export function coin(g: Graphics, x: number, y: number, r: number): void {
  g.circle(x, y, r).fill(0xffd84d).stroke({ width: 2, color: INK });
  g.circle(x, y, r * 0.72).stroke({ width: 1.5, color: 0xc99a1a });
  g.rect(x - r * 0.25, y - r * 0.25, r * 0.5, r * 0.5).fill(0xc99a1a);
}

/** 宝石（多边形切面） */
export function gem(g: Graphics, x: number, y: number, r: number, color: number, light: number): void {
  g.poly([x - r, y - r * 0.3, x - r * 0.5, y - r * 0.8, x + r * 0.5, y - r * 0.8, x + r, y - r * 0.3, x, y + r])
    .fill(color)
    .stroke({ width: 2, color: INK });
  g.poly([x - r * 0.5, y - r * 0.8, x, y - r * 0.3, x + r * 0.5, y - r * 0.8]).fill({ color: light, alpha: 0.8 });
  g.poly([x - r, y - r * 0.3, x + r, y - r * 0.3, x, y + r]).stroke({ width: 1, color: INK, alpha: 0.4 });
}

/** 炸弹（黑球 + 引信 + 火花） */
export function bomb(g: Graphics, x: number, y: number, r: number, spark = true): void {
  g.circle(x, y, r).fill(0x2a2a33).stroke({ width: 2, color: INK });
  g.circle(x - r * 0.35, y - r * 0.35, r * 0.25).fill({ color: 0xffffff, alpha: 0.35 });
  g.moveTo(x + r * 0.5, y - r * 0.8)
    .quadraticCurveTo(x + r * 0.9, y - r * 1.4, x + r * 1.2, y - r * 1.2)
    .stroke({ width: 2.5, color: 0x8a6a3a });
  if (spark) g.star(x + r * 1.25, y - r * 1.25, 5, r * 0.45, r * 0.2).fill(0xff9f43);
}

/** 元宝 */
export function ingot(g: Graphics, x: number, y: number, s: number): void {
  g.poly([x - 18 * s, y - 4 * s, x - 10 * s, y + 8 * s, x + 10 * s, y + 8 * s, x + 18 * s, y - 4 * s])
    .fill(0xffc629)
    .stroke({ width: 2, color: INK });
  g.ellipse(x, y - 5 * s, 9 * s, 7 * s)
    .fill(0xffe27a)
    .stroke({ width: 2, color: INK });
}

/** 钱袋 */
export function moneyBag(g: Graphics, x: number, y: number, s: number): void {
  g.ellipse(x, y + 4 * s, 15 * s, 13 * s)
    .fill(0xd08a3a)
    .stroke({ width: 2, color: INK });
  g.poly([x - 6 * s, y - 8 * s, x + 6 * s, y - 8 * s, x + 9 * s, y - 14 * s, x - 9 * s, y - 14 * s])
    .fill(0xd08a3a)
    .stroke({ width: 2, color: INK });
  g.rect(x - 7 * s, y - 9 * s, 14 * s, 3 * s).fill(0x8a3a2a);
  g.circle(x, y + 5 * s, 5 * s).fill(0xffd84d);
}

/** 宝箱 */
export function chest(g: Graphics, x: number, y: number, s: number): void {
  g.roundRect(x - 16 * s, y - 6 * s, 32 * s, 20 * s, 3 * s)
    .fill(0xa0643c)
    .stroke({ width: 2, color: INK });
  g.roundRect(x - 16 * s, y - 16 * s, 32 * s, 12 * s, 6 * s)
    .fill(0xc07a44)
    .stroke({ width: 2, color: INK });
  g.rect(x - 16 * s, y - 6 * s, 32 * s, 3 * s).fill(0xffd84d);
  g.rect(x - 3 * s, y - 8 * s, 6 * s, 8 * s)
    .fill(0xffd84d)
    .stroke({ width: 1.5, color: INK });
}

/** 爆炸星 */
export function burst(g: Graphics, x: number, y: number, r: number, color = 0xff9f43, points = 9): void {
  g.star(x, y, points, r, r * 0.5)
    .fill(color)
    .stroke({ width: 2, color: INK });
  g.star(x, y, points, r * 0.55, r * 0.3).fill(0xfff3b0);
}

export function label(text: string, size: number, color = 0xffffff, font = FONT_NUM): Text {
  const t = new Text({
    text,
    style: { fontFamily: font, fontSize: size, fontWeight: '700', fill: color, stroke: { color: INK, width: 4 } },
    resolution: 2,
  });
  t.anchor.set(0.5);
  return t;
}

interface FxItem {
  obj: Container;
  born: number;
  life: number;
  update(k: number): void;
}

/** 短暂的飘字与爆开特效（本机时间驱动，只做装饰） */
export class FxLayer {
  readonly root = new Container();
  private items: FxItem[] = [];

  text(str: string, x: number, y: number, now: number, color = 0xffd84d, size = 26, life = 800): void {
    const t = label(str, size, color);
    t.position.set(x, y);
    this.root.addChild(t);
    this.items.push({
      obj: t,
      born: now,
      life,
      update: (k) => {
        t.y = y - 40 * k;
        t.alpha = 1 - k * k;
      },
    });
  }

  burst(x: number, y: number, now: number, r = 26, color = 0xff9f43, life = 380): void {
    const g = new Graphics();
    burst(g, 0, 0, r, color);
    g.position.set(x, y);
    this.root.addChild(g);
    this.items.push({
      obj: g,
      born: now,
      life,
      update: (k) => {
        g.scale.set(0.6 + 0.8 * k);
        g.alpha = 1 - k;
      },
    });
  }

  puff(x: number, y: number, now: number, color = 0xffffff, life = 420): void {
    const g = new Graphics();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      g.circle(Math.cos(a) * 10, Math.sin(a) * 6, 5).fill({ color, alpha: 0.9 });
    }
    g.position.set(x, y);
    this.root.addChild(g);
    this.items.push({
      obj: g,
      born: now,
      life,
      update: (k) => {
        g.scale.set(1 + 1.5 * k);
        g.alpha = 1 - k;
      },
    });
  }

  update(now: number): void {
    const keep: FxItem[] = [];
    for (const it of this.items) {
      const k = (now - it.born) / it.life;
      if (k >= 1) {
        it.obj.destroy();
        continue;
      }
      it.update(clamp01(k));
      keep.push(it);
    }
    this.items = keep;
  }

  destroy(): void {
    for (const it of this.items) it.obj.destroy();
    this.items = [];
    this.root.destroy({ children: true });
  }
}
