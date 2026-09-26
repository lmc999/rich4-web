// 姿势附带的小特效：睡觉 zzz、受伤金星、欢呼/施法闪光、眼泪、汗滴
import { n, type PoseFx, type Skeleton } from '../rig';
import type { Limbs } from './body';
import { path, S2, sparkle, star } from './common';
import { faceAnchors } from './head';

export function fxSvg(fx: PoseFx, sk: Skeleton, L: Limbs): string {
  const { headCx: cx, headCy: cy, headR: r } = sk;
  switch (fx) {
    case 'none':
      return '';
    case 'zzz':
      return [
        [cx + r * 0.85, cy - r * 0.55, 12],
        [cx + r * 1.2, cy - r * 0.95, 15],
        [cx + r * 1.55, cy - r * 1.35, 18],
      ]
        .map(
          ([x, y, s]) =>
            `<text x="${n(x!)}" y="${n(y!)}" font-size="${s}" font-family="Arial Black, Arial, sans-serif" font-weight="900" fill="#FFFFFF" stroke="#3A2A1A" stroke-width="2.5" paint-order="stroke">Z</text>`,
        )
        .join('');
    case 'stars':
      return [
        [cx - r * 0.8, cy - r * 1.1],
        [cx, cy - r * 1.35],
        [cx + r * 0.8, cy - r * 1.1],
      ]
        .map(([x, y]) => star(x!, y!, 6))
        .join('');
    case 'sparkle':
      return (
        sparkle(L.handR.x + 6, L.handR.y - 8, 7) +
        sparkle(L.handL.x - 6, L.handL.y - 6, 5) +
        sparkle(cx + r * 1.1, cy - r * 0.9, 6)
      );
    case 'tear': {
      const a = faceAnchors(sk);
      const x = cx + a.eyeDx + 2;
      const y = a.eyeY + 7;
      return path(
        `M${n(x)} ${n(y)} Q${n(x + 5)} ${n(y + 8)} ${n(x)} ${n(y + 10)} Q${n(x - 5)} ${n(y + 8)} ${n(x)} ${n(y)} Z`,
        '#7FD3FF',
        S2,
      );
    }
    case 'sweat': {
      const x = cx + r * 0.8;
      const y = cy - r * 0.5;
      return path(
        `M${n(x)} ${n(y)} Q${n(x + 5)} ${n(y + 8)} ${n(x)} ${n(y + 10)} Q${n(x - 5)} ${n(y + 8)} ${n(x)} ${n(y)} Z`,
        '#7FD3FF',
        S2,
      );
    }
  }
}
