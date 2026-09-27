// 爆炸类特效（design/client.md §3.6、§4.5）：普通爆炸（地雷、身上的定时炸弹）、冲击波、
// 飞弹从天而降 + 3×3 冲击、核弹全屏白闪 + 蘑菇云。时长常数见 timings.ts（handler 按它们编排）。
import { Container, Graphics } from 'pixi.js';
import { cubicOut, quadIn } from '../anim/easing';
import type { Pt } from '../iso/projection';
import { INK } from '../procedural/building/styles';
import type { FxHost } from './FxSystem';
import { radial } from './Particles';
import { screenFlash } from './ScreenFlash';
import { FX_EXPLODE_MS, FX_MISSILE_BLAST_MS, FX_MISSILE_FALL_MS, FX_NUKE_BLAST_MS, FX_NUKE_FALL_MS } from './timings';

const FIRE = [0xfff3b0, 0xffd84d, 0xff9f43, 0xf2545b] as const;
const DEBRIS = [0x8a5a2b, 0x6e6a7e, 0x3a2a1a, 0xc98b5a] as const;

/** 冲击波：等角地面上的椭圆环，放大淡出 */
export function shockwave(h: FxHost, at: Pt, radius: number, color: number, ms: number, signal?: AbortSignal) {
  const g = new Graphics();
  g.position.set(at.x, at.y);
  const k = h.track(g, h.fxLayer, signal);
  return h
    .tween(
      ms,
      (v) => {
        if (g.destroyed) return;
        const r = Math.max(2, radius * cubicOut(v));
        g.clear()
          .ellipse(0, 0, r, r / 2)
          .stroke({ width: 10 * (1 - v) + 2, color, alpha: 1 - v })
          .ellipse(0, 0, r * 0.82, r * 0.41)
          .stroke({ width: 3, color: 0xffffff, alpha: (1 - v) * 0.7 });
      },
      k.signal,
    )
    .then(k.done);
}

/** 爆炸：闪光球 + 火焰碎片 + 烟团 + 冲击环；FX_EXPLODE_MS 后 resolve */
export async function explosion(h: FxHost, at: Pt, size: 'small' | 'big', signal?: AbortSignal): Promise<void> {
  // 已中止（reset / skipAll 之后才轮到这里）：直达终态，不再新建节点与粒子
  if (signal?.aborted) return;
  const s = size === 'big' ? 1.6 : 1;
  const ball = new Graphics()
    .circle(0, 0, 30)
    .fill(0xfff3b0)
    .circle(0, 0, 22)
    .fill(0xffd84d)
    .circle(0, 0, 12)
    .fill(0xffffff);
  ball.position.set(at.x, at.y - 14 * s);
  const k = h.track(ball, h.fxLayer, signal);
  h.particles.emit(
    radial(at.x, at.y - 10, Math.round(22 * s), {
      speed: [120 * s, 320 * s],
      life: [360, 700],
      size: [8, 16],
      colors: FIRE,
      gravity: 260,
      drag: 1.5,
      squash: 0.7,
    }),
  );
  h.particles.emit(
    radial(at.x, at.y - 6, Math.round(10 * s), {
      speed: [140, 300],
      life: [500, 800],
      size: [5, 9],
      colors: DEBRIS,
      shape: 'square',
      gravity: 700,
      spin: 8,
    }),
  );
  h.particles.emit(
    radial(at.x, at.y - 20, Math.round(8 * s), {
      speed: [20, 60],
      life: [600, 900],
      size: [18, 30],
      colors: [0x9a9a9a, 0x6e6a7e],
      shape: 'smoke',
      gravity: -80,
      endScale: 2.2,
    }),
  );
  const flashBall = h
    .tween(
      FX_EXPLODE_MS * 0.45,
      (v) => {
        if (ball.destroyed) return;
        ball.scale.set((0.3 + 1.5 * cubicOut(v)) * s);
        ball.alpha = 1 - v;
      },
      k.signal,
    )
    .then(k.done);
  await Promise.all([
    flashBall,
    shockwave(h, at, 90 * s, 0xff9f43, FX_EXPLODE_MS * 0.8, signal),
    h.wait(FX_EXPLODE_MS, signal),
  ]);
}

/** 飞弹本体（尖头 + 尾翼），朝下 */
function missileBody(scale: number, color: number): Container {
  const c = new Container();
  const g = new Graphics()
    .roundRect(-7, -46, 14, 40, 6)
    .fill(0xd8dce6)
    .stroke({ width: 3, color: INK })
    .poly([-7, -6, 7, -6, 0, 10], true)
    .fill(color)
    .stroke({ width: 3, color: INK, join: 'round' })
    .poly([-7, -44, -16, -54, -7, -32], true)
    .fill(color)
    .stroke({ width: 2.5, color: INK, join: 'round' })
    .poly([7, -44, 16, -54, 7, -32], true)
    .fill(color)
    .stroke({ width: 2.5, color: INK, join: 'round' });
  c.addChild(g);
  c.scale.set(scale);
  return c;
}

/** 从天而降：落到 at，拖尾烟 */
async function fall(h: FxHost, at: Pt, ms: number, scale: number, color: number, signal?: AbortSignal) {
  const m = missileBody(scale, color);
  const k = h.track(m, h.fxLayer, signal);
  const top = at.y - 620;
  let trail = 0;
  await h.tween(
    ms,
    (v) => {
      if (m.destroyed) return;
      const y = top + (at.y - top) * quadIn(v);
      m.position.set(at.x, y);
      if (++trail % 2 === 0) {
        h.particles.emit([
          {
            x: at.x + (trail % 4) - 2,
            y: y - 50 * scale,
            vx: 0,
            vy: -30,
            life: 420,
            size: 12 * scale,
            color: 0xdddddd,
            shape: 'smoke',
            endScale: 2,
          },
        ]);
      }
    },
    k.signal,
  );
  k.done();
}

/** 飞弹：FX_MISSILE_FALL_MS 落下 + FX_MISSILE_BLAST_MS 爆炸与冲击（半径 radius） */
export async function missileStrike(h: FxHost, at: Pt, radius: number, signal?: AbortSignal): Promise<void> {
  await fall(h, at, FX_MISSILE_FALL_MS, 1, 0xf2545b, signal);
  if (signal?.aborted) return;
  void screenFlash(h, 0xfff3b0, 220, 0.5, signal);
  await Promise.all([
    explosion(h, at, 'big', signal),
    shockwave(h, at, radius, 0xf2545b, FX_MISSILE_BLAST_MS * 0.9, signal),
    h.wait(FX_MISSILE_BLAST_MS, signal),
  ]);
}

/** 蘑菇云：烟柱 + 云帽，缓慢上升 */
function mushroom(h: FxHost, at: Pt, ms: number, signal?: AbortSignal): Promise<void> {
  const c = new Container();
  const stem = new Graphics().roundRect(-18, -120, 36, 120, 16).fill({ color: 0xff9f43, alpha: 0.9 });
  const cap = new Graphics()
    .ellipse(0, -130, 80, 42)
    .fill({ color: 0xf2545b, alpha: 0.9 })
    .ellipse(0, -140, 60, 30)
    .fill({ color: 0xff9f43, alpha: 0.95 })
    .ellipse(0, -146, 34, 16)
    .fill({ color: 0xfff3b0, alpha: 0.95 });
  c.addChild(stem, cap);
  c.position.set(at.x, at.y);
  const k = h.track(c, h.fxLayer, signal);
  return h
    .tween(
      ms,
      (v) => {
        if (c.destroyed) return;
        c.scale.set(0.3 + 0.9 * cubicOut(v), 0.2 + 1.1 * cubicOut(v));
        c.alpha = v < 0.7 ? 1 : 1 - (v - 0.7) / 0.3;
      },
      k.signal,
    )
    .then(k.done);
}

/** 核弹：落下 → 全屏白闪 → 蘑菇云 + 大冲击波（FX_NUKE_MS） */
export async function nukeStrike(h: FxHost, at: Pt, radius: number, signal?: AbortSignal): Promise<void> {
  await fall(h, at, FX_NUKE_FALL_MS, 1.5, 0x27ae60, signal);
  if (signal?.aborted) return;
  void screenFlash(h, 0xffffff, FX_NUKE_BLAST_MS * 0.7, 1, signal);
  h.particles.emit(
    radial(at.x, at.y - 20, 40, {
      speed: [200, 520],
      life: [500, 1000],
      size: [10, 22],
      colors: FIRE,
      gravity: 120,
      drag: 1.2,
      squash: 0.55,
    }),
  );
  await Promise.all([
    mushroom(h, at, FX_NUKE_BLAST_MS, signal),
    shockwave(h, at, radius, 0xffffff, FX_NUKE_BLAST_MS * 0.8, signal),
    shockwave(h, at, radius * 0.6, 0xff9f43, FX_NUKE_BLAST_MS * 0.6, signal),
    h.wait(FX_NUKE_BLAST_MS, signal),
  ]);
}
