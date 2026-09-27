// 光柱（神明降临、传送、显灵）与魔法阵（魔法屋）。光柱是从天而降的半透明光带 + 地面光圈 + 上升星点。
import { Container, Graphics } from 'pixi.js';
import { cubicOut } from '../anim/easing';
import type { Pt } from '../iso/projection';
import type { FxHost } from './FxSystem';

const PILLAR_H = 560;

/** 光柱：展开 → 停留 → 收窄淡出，ms 后 resolve */
export async function lightPillar(h: FxHost, at: Pt, color: number, ms: number, signal?: AbortSignal): Promise<void> {
  const c = new Container({ label: 'pillar' });
  const glow = new Graphics().ellipse(0, 0, 54, 26).fill({ color, alpha: 0.45 }).ellipse(0, 0, 30, 14).fill({
    color: 0xffffff,
    alpha: 0.6,
  });
  const beamG = new Graphics();
  // 由外到内三层，越往里越亮
  for (const [w, a] of [
    [60, 0.18],
    [40, 0.3],
    [20, 0.55],
  ] as const) {
    beamG.rect(-w / 2, -PILLAR_H, w, PILLAR_H).fill({ color, alpha: a });
  }
  beamG.rect(-4, -PILLAR_H, 8, PILLAR_H).fill({ color: 0xffffff, alpha: 0.8 });
  c.addChild(glow, beamG);
  c.position.set(at.x, at.y);
  const k = h.track(c, h.fxLayer, signal);
  let tick = 0;
  await h.tween(
    ms,
    (v) => {
      if (c.destroyed) return;
      const open = v < 0.25 ? cubicOut(v / 0.25) : v > 0.75 ? 1 - (v - 0.75) / 0.25 : 1;
      beamG.scale.set(Math.max(0.02, open), 1);
      beamG.alpha = open;
      glow.scale.set(0.6 + 0.4 * open);
      glow.alpha = open;
      if (++tick % 3 === 0 && v < 0.8) {
        h.particles.emit([
          {
            x: at.x + ((tick * 37) % 40) - 20,
            y: at.y - 10,
            vx: 0,
            vy: -220,
            life: 520,
            size: 7,
            color: 0xffffff,
            shape: 'star',
            spin: 5,
          },
        ]);
      }
    },
    k.signal,
  );
  k.done();
}

/** 魔法阵：地面上旋转的双环 + 六芒星，ms 后淡出 */
export async function magicCircle(h: FxHost, at: Pt, color: number, ms: number, signal?: AbortSignal): Promise<void> {
  const c = new Container({ label: 'magicCircle' });
  const g = new Graphics();
  const R = 40;
  g.circle(0, 0, R).stroke({ width: 3, color, alpha: 0.95 });
  g.circle(0, 0, R * 0.78).stroke({ width: 2, color: 0xffffff, alpha: 0.8 });
  const tri = (rot: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < 3; i++) {
      const a = rot + (i * Math.PI * 2) / 3;
      out.push(Math.cos(a) * R * 0.78, Math.sin(a) * R * 0.78);
    }
    return out;
  };
  g.poly(tri(-Math.PI / 2), true).stroke({ width: 2, color });
  g.poly(tri(Math.PI / 2), true).stroke({ width: 2, color });
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    g.circle(Math.cos(a) * R, Math.sin(a) * R, 4).fill(0xffffff);
  }
  // 等角地面：纵向压扁一半
  const plate = new Container();
  plate.addChild(g);
  plate.scale.set(1, 0.5);
  c.addChild(plate);
  c.position.set(at.x, at.y);
  const k = h.track(c, h.fxLayer, signal);
  await h.tween(
    ms,
    (v) => {
      if (c.destroyed) return;
      g.rotation = v * Math.PI * 1.5;
      const s = v < 0.2 ? cubicOut(v / 0.2) : 1;
      c.scale.set(s);
      c.alpha = v < 0.8 ? 1 : 1 - (v - 0.8) / 0.2;
    },
    k.signal,
  );
  k.done();
}
