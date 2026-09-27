// 光束：出卡、用道具时从施放者连到目标（design/client.md §4.5 cardUsed「光束连目标」）。
// 一条带外光晕的弧线从 a 延伸到 b，末端星点爆开，随后淡出。
import { Graphics } from 'pixi.js';
import { cubicOut } from '../anim/easing';
import type { Pt } from '../iso/projection';
import type { FxHost } from './FxSystem';
import { radial } from './Particles';

export async function beam(h: FxHost, a: Pt, b: Pt, color: number, ms: number, signal?: AbortSignal): Promise<void> {
  const g = new Graphics();
  const k = h.track(g, h.fxLayer, signal);
  const ctrl = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - 60 - Math.abs(a.x - b.x) * 0.1 };
  const at = (t: number): Pt => {
    const u = 1 - t;
    return { x: u * u * a.x + 2 * u * t * ctrl.x + t * t * b.x, y: u * u * a.y + 2 * u * t * ctrl.y + t * t * b.y };
  };
  let hit = false;
  await h.tween(
    ms,
    (v) => {
      if (g.destroyed) return;
      const reach = Math.min(1, cubicOut(Math.min(1, v / 0.6)));
      const fade = v < 0.6 ? 1 : 1 - (v - 0.6) / 0.4;
      g.clear();
      const pts: number[] = [];
      const steps = 16;
      for (let i = 0; i <= steps; i++) {
        const p = at((i / steps) * reach);
        pts.push(p.x, p.y);
      }
      g.poly(pts, false).stroke({ width: 14, color, alpha: 0.35 * fade, cap: 'round', join: 'round' });
      g.poly(pts, false).stroke({ width: 5, color: 0xffffff, alpha: 0.9 * fade, cap: 'round', join: 'round' });
      if (!hit && reach >= 1) {
        hit = true;
        h.particles.emit(
          radial(b.x, b.y, 12, {
            speed: [80, 200],
            life: [300, 520],
            size: [6, 11],
            colors: [color, 0xffffff],
            shape: 'star',
            drag: 1.5,
            spin: 6,
          }),
        );
      }
    },
    k.signal,
  );
  k.done();
}
