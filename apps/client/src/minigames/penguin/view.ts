// 企鹅挖宝的 Pixi 场景（design/minigames-ai.md §3；全部原创绘制）：
// 冰原上的菱形棋盘（64 个有效格）与中央冰屋；记忆阶段（intro）所有埋藏格画土堆（看不出种类），开玩后土堆消失；
// 企鹅在两个格心之间按 (sub + α)/4 插值逐格行走，挖掘时上下点头并扬起雪花；揭晓的宝物（金币 / 蓝宝石 / 红宝石 / 钻石）
// 与炸弹留在挖开的洞里；指针所在的有效格显示蓝色椭圆靶圈。
import { type PenguinState, penguin, type SimFx } from '@rich4/shared/minigames';
import { Container, Graphics } from 'pixi.js';
import { bands, bomb, cloud, coin, FONT_TITLE, FxLayer, gem, INK, label, lerp } from '../draw';
import { mgText } from '../text';
import type { MinigameView, Pt, ViewContext } from '../types';

const {
  CELL_HALF_H: HH,
  CELL_HALF_W: HW,
  VALID_CELLS,
  cellCenter,
  pickCell,
  IGLOO_CELL,
  TICKS_PER_CELL,
  DIG_TICKS,
} = penguin;

/** 各类型的分值（飘字用） */
const ITEM_POINTS = penguin.ITEM_SCORE;

function diamond(g: Graphics, x: number, y: number, fill: number, alpha = 1): void {
  g.poly([x, y - HH, x + HW, y, x, y + HH, x - HW, y]).fill({ color: fill, alpha });
}

/** 埋藏物图标：2 金币（5）、3 红宝石（12）、4 蓝宝石（8）、5 钻石（20）、1 炸弹 */
export function drawItem(g: Graphics, kind: number, x: number, y: number, s = 1): void {
  if (kind === 1) bomb(g, x, y - 4 * s, 11 * s);
  else if (kind === 2) coin(g, x, y - 4 * s, 11 * s);
  else if (kind === 3) gem(g, x, y - 4 * s, 12 * s, 0xe8453c, 0xffb3b3);
  else if (kind === 4) gem(g, x, y - 4 * s, 12 * s, 0x2f80ed, 0xb8dcff);
  else if (kind === 5) gem(g, x, y - 4 * s, 13 * s, 0xd8f4ff, 0xffffff);
}

function drawPenguin(g: Graphics): void {
  // 以脚底为原点，面朝右
  g.ellipse(0, -2, 16, 5).fill({ color: 0x000000, alpha: 0.18 });
  g.ellipse(-7, -1, 7, 3.5).fill(0xff9f43).stroke({ width: 1.5, color: INK });
  g.ellipse(7, -1, 7, 3.5).fill(0xff9f43).stroke({ width: 1.5, color: INK });
  g.ellipse(0, -22, 17, 21).fill(0x24303f).stroke({ width: 2.5, color: INK });
  g.ellipse(2, -19, 11, 15).fill(0xfffdf6);
  g.ellipse(-15, -22, 5, 11).fill(0x24303f).stroke({ width: 2, color: INK });
  g.circle(0, -44, 13).fill(0x24303f).stroke({ width: 2.5, color: INK });
  g.ellipse(4, -43, 8, 7).fill(0xfffdf6);
  g.circle(6, -46, 2.4).fill(INK);
  g.poly([10, -43, 20, -40, 10, -38]).fill(0xff9f43).stroke({ width: 1.5, color: INK });
  // 小铲子
  g.rect(12, -26, 3, 16).fill(0x8a6a3a);
  g.poly([9, -10, 18, -10, 16, -3, 11, -3]).fill(0xc0c8d0).stroke({ width: 1.5, color: INK });
}

function drawIgloo(g: Graphics, x: number, y: number): void {
  g.ellipse(x, y + 6, 46, 14).fill({ color: 0x000000, alpha: 0.12 });
  g.moveTo(x - 42, y + 6)
    .arc(x, y + 6, 42, Math.PI, 0)
    .closePath()
    .fill(0xf4fbff)
    .stroke({ width: 3, color: INK });
  // 冰砖缝：离地 h 处的弦长 2·√(42² − h²)
  for (const h of [12, 24, 34]) {
    const half = Math.sqrt(42 * 42 - h * h);
    g.moveTo(x - half + 2, y + 6 - h)
      .lineTo(x + half - 2, y + 6 - h)
      .stroke({ width: 1.5, color: 0xa8c8dc });
  }
  g.moveTo(x - 14, y + 6)
    .arc(x, y + 6, 14, Math.PI, 0)
    .closePath()
    .fill(0x2a3a4a)
    .stroke({ width: 2.5, color: INK });
}

export class PenguinView implements MinigameView<PenguinState> {
  readonly root = new Container();
  private readonly board = new Graphics();
  private readonly mounds = new Graphics();
  private readonly holes = new Graphics();
  private readonly target = new Graphics();
  private readonly actor = new Container();
  private readonly body = new Graphics();
  private readonly fx = new FxLayer();
  private readonly banner: Container;
  private dugKey = '';
  private moundShown: boolean | null = null;
  private pointer: Pt | null = null;
  private targetCell = -2;

  constructor(readonly ctx: ViewContext) {
    const bg = new Graphics();
    bands(bg, 0, 0, 640, 480, 0x9fdcf5, 0xe8f7ff, 10);
    cloud(bg, 30, 40, 0.8, 0xffffff, 0.9);
    cloud(bg, 520, 36, 0.9, 0xffffff, 0.9);
    // 远处的冰山
    bg.poly([0, 150, 70, 90, 130, 140, 190, 70, 260, 150]).fill(0xd4eefa).stroke({ width: 2, color: 0x9cc4dc });
    bg.poly([430, 150, 500, 80, 560, 130, 610, 60, 640, 90, 640, 150])
      .fill(0xd4eefa)
      .stroke({ width: 2, color: 0x9cc4dc });
    bg.rect(0, 150, 640, 330).fill(0xeaf6fc);
    this.root.addChild(bg);
    for (const c of VALID_CELLS) {
      const { x, y } = cellCenter(c);
      const r = penguin.rowOf(c);
      const col = penguin.colOf(c);
      diamond(this.board, x, y, (r + col) % 2 === 0 ? 0xc8ecfb : 0xb2e1f5);
      this.board.poly([x, y - HH, x + HW, y, x, y + HH, x - HW, y]).stroke({ width: 1.5, color: 0x7fb8d4, alpha: 0.9 });
      // 冰面反光
      this.board
        .moveTo(x - 18, y - 4)
        .lineTo(x - 6, y - 10)
        .stroke({ width: 2, color: 0xffffff, alpha: 0.7 });
    }
    const ig = cellCenter(IGLOO_CELL);
    drawIgloo(this.board, ig.x, ig.y);
    drawPenguin(this.body);
    this.actor.addChild(this.body);
    this.root.addChild(this.board, this.holes, this.mounds, this.target, this.actor, this.fx.root);
    const tip = new Graphics();
    tip.roundRect(-150, -18, 300, 36, 18).fill({ color: 0x3a2a1a, alpha: 0.75 });
    this.banner = new Container();
    this.banner.addChild(tip);
    this.banner.addChild(label(mgText('penguin.memorize'), 20, 0xffffff, FONT_TITLE));
    this.banner.position.set(320, 452);
    this.root.addChild(this.banner);
  }

  setPointer(p: Pt | null): void {
    this.pointer = p;
  }

  render(
    prev: Readonly<PenguinState>,
    s: Readonly<PenguinState>,
    alpha: number,
    fx: readonly SimFx[],
    now: number,
  ): void {
    // 土堆：只在 intro 显示
    const showMounds = s.phase === 'intro';
    if (showMounds !== this.moundShown) {
      this.moundShown = showMounds;
      this.mounds.clear();
      if (showMounds) {
        for (const c of VALID_CELLS) {
          if (s.mound[c] !== 1) continue;
          const { x, y } = cellCenter(c);
          this.mounds
            .ellipse(x, y + 2, 20, 9)
            .fill(0x9a7a5a)
            .stroke({ width: 2, color: INK });
          this.mounds.ellipse(x - 4, y - 2, 10, 5).fill(0xb89a78);
          this.mounds.ellipse(x + 6, y + 4, 5, 2.5).fill(0xffffff);
        }
      }
      this.banner.visible = showMounds;
    }
    // 挖开的洞与揭晓物
    const key = s.dug.join('');
    if (key !== this.dugKey) {
      this.dugKey = key;
      this.holes.clear();
      for (const c of VALID_CELLS) {
        if (s.dug[c] !== 1) continue;
        const { x, y } = cellCenter(c);
        this.holes
          .ellipse(x, y + 2, 20, 9)
          .fill(0x3a5a70)
          .stroke({ width: 2, color: INK });
        this.holes.ellipse(x, y + 4, 14, 5).fill(0x243a4a);
        drawItem(this.holes, s.found[c]!, x, y, 0.9);
      }
    }
    // 企鹅：两个格心之间插值
    let pos = cellCenter(s.cell);
    let bob = 0;
    if (s.walk !== null && s.walk.next >= 0) {
      const a = cellCenter(s.cell);
      const b = cellCenter(s.walk.next);
      const k = Math.min(1, (s.walk.sub + alpha) / TICKS_PER_CELL);
      pos = { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) };
      bob = -Math.abs(Math.sin(k * Math.PI * 2)) * 4;
    } else if (s.digLeft > 0) {
      const k = (DIG_TICKS - s.digLeft + alpha) / DIG_TICKS;
      bob = Math.sin(k * Math.PI * 4) * 3;
    } else if (prev.cell !== s.cell && s.walk === null) {
      pos = cellCenter(s.cell);
    }
    this.actor.position.set(pos.x, pos.y + 6 + bob);
    this.body.scale.x = s.dir >= 2 && s.dir <= 5 ? -1 : 1;
    // 靶圈
    const cell = this.pointer && s.phase !== 'over' ? pickCell(this.pointer.x, this.pointer.y) : -1;
    if (cell !== this.targetCell) {
      this.targetCell = cell;
      this.target.clear();
      if (cell >= 0) {
        const { x, y } = cellCenter(cell);
        this.target.ellipse(x, y, HW * 0.62, HH * 0.62).stroke({ width: 3, color: 0x2f80ed });
        this.target.ellipse(x, y, HW * 0.36, HH * 0.36).stroke({ width: 2, color: 0x2f80ed, alpha: 0.7 });
      }
    }
    this.target.alpha = 0.6 + 0.4 * Math.abs(Math.sin(now / 250));
    for (const f of fx) {
      if (f.t === 'dig') {
        const { x, y } = cellCenter(f.cell);
        this.fx.puff(x, y, now);
      } else if (f.t === 'reveal' && f.item > 1) {
        const { x, y } = cellCenter(f.cell);
        this.fx.text(`+${ITEM_POINTS[f.item] ?? 0}`, x, y - 30, now);
      } else if (f.t === 'bomb') {
        const { x, y } = cellCenter(s.cell);
        this.fx.burst(x, y - 20, now, 46, 0xff6b3d, 600);
      }
    }
    this.fx.update(now);
  }

  destroy(): void {
    this.fx.destroy();
    this.root.destroy({ children: true });
  }
}
