// 七彩气球的 Pixi 场景（design/minigames-ai.md §4；全部原创绘制）：
// 晴空与草地，8 条跑道上升的 16 个气球槽；数字气球（1–9，大球 1–6、小球 7–9）按数字配色，
// 特殊气球 ×2（金）、÷2（灰蓝）、?（紫）；y 在相邻 tick 之间插值（与「最近 tick 归属」一致）；
// 打中后爆开 3 个 tick；冻结时气球蒙一层冰色；准星光标三帧轮播。
import { type BalloonState, balloon, type SimFx } from '@rich4/shared/minigames';
import { Container, Graphics, type Text } from 'pixi.js';
import { bands, burst, cloud, FxLayer, INK, label, lerp } from '../draw';
import { mgText } from '../text';
import type { MinigameView, Pt, ViewContext } from '../types';

const { SLOT_COUNT, KIND_DOUBLE, KIND_HALF, KIND_MYSTERY, BIG_KIND_BELOW, HIT_BIG, HIT_SMALL, SPEED_FAST, SPEED_SLOW } =
  balloon;

/** 数字气球配色（按数字 1..9） */
const DIGIT_COLORS = [0xf2545b, 0xff9f43, 0xffd84d, 0x5cc85a, 0x3dc6d8, 0x3d8bfd, 0x9b6bff, 0xff6fb5, 0xe8453c];

export function balloonLabel(kind: number): string {
  if (kind === KIND_DOUBLE) return '×2';
  if (kind === KIND_HALF) return '÷2';
  if (kind === KIND_MYSTERY) return '?';
  return String(kind + 1);
}

function balloonColor(kind: number): number {
  if (kind === KIND_DOUBLE) return 0xffc629;
  if (kind === KIND_HALF) return 0x8aa4c0;
  if (kind === KIND_MYSTERY) return 0x7a4de8;
  return DIGIT_COLORS[kind] ?? 0xf2545b;
}

function drawBalloon(g: Graphics, kind: number): void {
  const box = kind < BIG_KIND_BELOW ? HIT_BIG : HIT_SMALL;
  const rx = box.hw + 2;
  const ry = box.hh;
  const c = balloonColor(kind);
  g.clear();
  // 绳子（从球底向下）
  g.moveTo(0, ry + 4)
    .quadraticCurveTo(6, ry + 18, 0, ry + 30)
    .quadraticCurveTo(-5, ry + 40, 2, ry + 52)
    .stroke({ width: 1.5, color: INK, alpha: 0.7 });
  g.poly([-5, ry + 5, 5, ry + 5, 0, ry - 2])
    .fill(c)
    .stroke({ width: 1.5, color: INK });
  g.ellipse(0, 0, rx, ry).fill(c).stroke({ width: 3, color: INK });
  g.ellipse(-rx * 0.38, -ry * 0.42, rx * 0.22, ry * 0.3).fill({ color: 0xffffff, alpha: 0.55 });
  if (kind === KIND_MYSTERY) g.star(rx * 0.45, -ry * 0.55, 4, 5, 2).fill(0xffffff);
}

interface Slot {
  c: Container;
  g: Graphics;
  t: Text;
  pop: Graphics;
  kind: number;
}

export class BalloonView implements MinigameView<BalloonState> {
  readonly root = new Container();
  private readonly layer = new Container();
  private readonly slots: Slot[] = [];
  private readonly iceTint = new Graphics();
  private readonly reticle = new Graphics();
  private readonly fx = new FxLayer();
  private pointer: Pt | null = null;

  constructor(readonly ctx: ViewContext) {
    const bg = new Graphics();
    bands(bg, 0, 0, 640, 480, 0x5ec8f2, 0xd8f3ff, 12);
    bg.circle(560, 70, 34).fill(0xffe27a).stroke({ width: 3, color: 0xffc629 });
    cloud(bg, 40, 90, 1, 0xffffff, 0.85);
    cloud(bg, 250, 50, 0.8, 0xffffff, 0.8);
    cloud(bg, 420, 150, 1.1, 0xffffff, 0.75);
    // 远山与草地
    bg.poly([0, 440, 90, 380, 190, 430, 300, 370, 420, 430, 530, 385, 640, 430, 640, 480, 0, 480]).fill(0x7ccf6a);
    bg.rect(0, 440, 640, 40).fill(0x5cb84a);
    for (let x = 12; x < 640; x += 36) bg.poly([x, 446, x + 6, 434, x + 12, 446]).fill(0x4aa23c);
    this.root.addChild(bg, this.layer, this.iceTint, this.fx.root, this.reticle);
    for (let i = 0; i < SLOT_COUNT; i++) {
      const c = new Container();
      const g = new Graphics();
      const t = label('', 22, 0xffffff);
      const pop = new Graphics();
      burst(pop, 0, 0, 30, 0xffd84d);
      pop.visible = false;
      c.addChild(g, t, pop);
      c.visible = false;
      this.layer.addChild(c);
      this.slots.push({ c, g, t, pop, kind: -1 });
    }
    this.iceTint.rect(0, 0, 640, 480).fill({ color: 0xbfe8ff, alpha: 0.28 });
    this.iceTint.visible = false;
    this.drawReticle(0);
  }

  private drawReticle(frame: number): void {
    const g = this.reticle;
    g.clear();
    g.circle(0, 0, 16).stroke({ width: 3, color: 0xf2545b });
    g.circle(0, 0, 3).fill(0xf2545b);
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2 + (frame * Math.PI) / 6;
      g.moveTo(Math.cos(a) * 10, Math.sin(a) * 10)
        .lineTo(Math.cos(a) * 24, Math.sin(a) * 24)
        .stroke({ width: 3, color: INK });
    }
  }

  setPointer(p: Pt | null): void {
    this.pointer = p;
  }

  render(
    prev: Readonly<BalloonState>,
    s: Readonly<BalloonState>,
    alpha: number,
    fx: readonly SimFx[],
    now: number,
  ): void {
    for (let i = 0; i < SLOT_COUNT; i++) {
      const sl = this.slots[i]!;
      const x = s.x[i]!;
      if (x === 0) {
        sl.c.visible = false;
        sl.kind = -1;
        continue;
      }
      const k = s.kind[i]!;
      if (sl.kind !== k) {
        sl.kind = k;
        drawBalloon(sl.g, k);
        sl.t.text = balloonLabel(k);
        sl.t.style.fontSize = k < BIG_KIND_BELOW ? 24 : 20;
      }
      // 同一个气球（上一 tick 也在同一跑道、同一类型、更低处）才插值
      const same = prev.x[i] === x && prev.kind[i] === k && prev.y[i]! >= s.y[i]!;
      const y = same ? lerp(prev.y[i]!, s.y[i]!, alpha) : s.y[i]!;
      sl.c.visible = true;
      sl.c.position.set(x, y);
      const popping = s.pop[i]! > 0;
      sl.g.visible = !popping;
      sl.t.visible = !popping;
      sl.pop.visible = popping;
      if (popping) sl.pop.scale.set(0.7 + (3 - s.pop[i]! + alpha) * 0.25);
      else sl.c.rotation = Math.sin(now / 400 + i) * 0.05;
    }
    this.iceTint.visible = s.freeze > 0;
    const p = this.pointer;
    this.reticle.visible = p !== null && this.ctx.mode === 'play';
    if (p) {
      this.reticle.position.set(p.x, p.y);
      this.drawReticle(Math.floor(now / 120) % 3);
    }
    for (const f of fx) {
      if (f.t === 'pop') {
        const x = s.x[f.slot] || prev.x[f.slot] || 320;
        const y = s.y[f.slot] || prev.y[f.slot] || 240;
        const txt =
          f.kind === KIND_DOUBLE
            ? '×2'
            : f.kind === KIND_HALF
              ? '÷2'
              : f.kind === KIND_MYSTERY
                ? '?'
                : `+${f.kind + 1}`;
        this.fx.text(txt, x, y - 36, now, f.kind === KIND_HALF ? 0xbfd4ea : 0xffd84d);
      } else if (f.t === 'effect') {
        this.fx.text(mgText(`balloon.effect.${f.effect}`), 320, 220, now, 0xffffff, 40, 1400);
      } else if (f.t === 'miss' && p) {
        this.fx.puff(p.x, p.y, now, 0xffffff, 300);
      } else if (f.t === 'timeup') {
        this.fx.text(mgText('balloon.effect.0'), 320, 200, now, 0xffe27a, 36, 1200);
      }
    }
    this.fx.update(now);
    // 速度状态的角标
    this.layer.alpha = s.speedMode === SPEED_FAST || s.speedMode === SPEED_SLOW ? 0.95 : 1;
  }

  destroy(): void {
    this.fx.destroy();
    this.root.destroy({ children: true });
  }
}
