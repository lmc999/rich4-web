// 头部：耳朵、脸型、五官与表情（正面）；背面只画后脑，由发型覆盖
import type { CharacterConfig } from '../defs';
import { type Expression, INK, n, type Skeleton } from '../rig';
import { circle, ellipse, path, S, S2 } from './common';

export interface FaceAnchors {
  eyeY: number;
  eyeDx: number;
  mouthY: number;
}

export function faceAnchors(sk: Skeleton): FaceAnchors {
  return { eyeY: sk.headCy + sk.headR * 0.18, eyeDx: sk.headR * 0.36, mouthY: sk.headCy + sk.headR * 0.55 };
}

export function headBaseSvg(c: CharacterConfig, sk: Skeleton): string {
  const { headCx: cx, headCy: cy, headR: r } = sk;
  let s = '';
  s += circle(cx - r * 0.96, cy + 4, 7, c.skin);
  s += circle(cx + r * 0.96, cy + 4, 7, c.skin);
  s += ellipse(cx, cy, r, r * 0.95, c.skin);
  return s;
}

function eye(x: number, y: number, c: CharacterConfig, expr: Expression, side: -1 | 1): string {
  const style = c.eyes;
  if (expr === 'happy')
    return `<path d="M${n(x - 5)} ${n(y + 1)} Q${n(x)} ${n(y - 6)} ${n(x + 5)} ${n(y + 1)}" fill="none" ${S}/>`;
  if (expr === 'sleep')
    return `<path d="M${n(x - 5)} ${n(y)} Q${n(x)} ${n(y + 5)} ${n(x + 5)} ${n(y)}" fill="none" ${S}/>`;
  if (expr === 'shock') return circle(x, y, 5.5, '#FFFFFF', S2) + circle(x, y, 1.8, INK, 'stroke="none"');
  let s = '';
  if (style === 'dot') {
    s += circle(x, y, 3, INK, 'stroke="none"');
  } else {
    const rx = style === 'narrow' ? 5 : 4.6;
    const ry = style === 'narrow' ? 3.4 : 6;
    s += ellipse(x, y, rx, ry, INK, 'stroke="none"');
    s += circle(
      x - 1.4,
      y - (style === 'narrow' ? 1 : 2.2),
      style === 'narrow' ? 1.2 : 1.9,
      '#FFFFFF',
      'stroke="none"',
    );
    if (style === 'lashes') {
      s += `<path d="M${n(x + side * 3.5)} ${n(y - 5)} L${n(x + side * 7)} ${n(y - 8)}" ${S2}/>`;
    }
  }
  return s;
}

function brows(cx: number, a: FaceAnchors, expr: Expression, c: CharacterConfig): string {
  const y = a.eyeY - 10;
  const color = c.hair.style === 'bald' ? '#8A8A8A' : c.hair.color;
  const w = 'stroke-width="3" stroke-linecap="round" fill="none"';
  let l: string;
  let r: string;
  if (expr === 'sad') {
    l = `M${n(cx - a.eyeDx - 5)} ${n(y + 1)} L${n(cx - a.eyeDx + 4)} ${n(y - 3)}`;
    r = `M${n(cx + a.eyeDx + 5)} ${n(y + 1)} L${n(cx + a.eyeDx - 4)} ${n(y - 3)}`;
  } else if (expr === 'angry') {
    l = `M${n(cx - a.eyeDx - 5)} ${n(y - 3)} L${n(cx - a.eyeDx + 4)} ${n(y + 1)}`;
    r = `M${n(cx + a.eyeDx + 5)} ${n(y - 3)} L${n(cx + a.eyeDx - 4)} ${n(y + 1)}`;
  } else if (expr === 'shock') {
    l = `M${n(cx - a.eyeDx - 5)} ${n(y - 4)} Q${n(cx - a.eyeDx)} ${n(y - 8)} ${n(cx - a.eyeDx + 5)} ${n(y - 4)}`;
    r = `M${n(cx + a.eyeDx - 5)} ${n(y - 4)} Q${n(cx + a.eyeDx)} ${n(y - 8)} ${n(cx + a.eyeDx + 5)} ${n(y - 4)}`;
  } else {
    l = `M${n(cx - a.eyeDx - 5)} ${n(y)} Q${n(cx - a.eyeDx)} ${n(y - 3)} ${n(cx - a.eyeDx + 5)} ${n(y)}`;
    r = `M${n(cx + a.eyeDx - 5)} ${n(y)} Q${n(cx + a.eyeDx)} ${n(y - 3)} ${n(cx + a.eyeDx + 5)} ${n(y)}`;
  }
  return `<path d="${l} ${r}" stroke="${color}" ${w}/>`;
}

function mouth(cx: number, y: number, expr: Expression, c: CharacterConfig): string {
  const lip = c.accessories.includes('lipstick') ? '#D6264A' : INK;
  switch (expr) {
    case 'happy':
      return path(`M${n(cx - 7)} ${n(y - 2)} Q${n(cx)} ${n(y + 10)} ${n(cx + 7)} ${n(y - 2)} Z`, '#B8323F', S2);
    case 'sad':
      return `<path d="M${n(cx - 6)} ${n(y + 3)} Q${n(cx)} ${n(y - 3)} ${n(cx + 6)} ${n(y + 3)}" fill="none" stroke="${lip}" stroke-width="3" stroke-linecap="round"/>`;
    case 'shock':
      return ellipse(cx, y + 1, 4, 5.5, '#B8323F', S2);
    case 'sleep':
      return ellipse(cx, y + 1, 2.4, 2, '#B8323F', S2);
    case 'angry':
      return `<path d="M${n(cx - 6)} ${n(y + 1)} L${n(cx + 6)} ${n(y - 1)}" stroke="${lip}" stroke-width="3" stroke-linecap="round"/>`;
    default:
      return `<path d="M${n(cx - 6)} ${n(y - 1)} Q${n(cx)} ${n(y + 5)} ${n(cx + 6)} ${n(y - 1)}" fill="none" stroke="${lip}" stroke-width="3" stroke-linecap="round"/>`;
  }
}

/** 五官（正面）；带口罩/兜帽的角色由 hats.ts 覆盖下半张脸 */
/** 只画双眼（兜帽遮住脸后，在眼部开口里补画） */
export function eyesSvg(c: CharacterConfig, sk: Skeleton, expr: Expression): string {
  const a = faceAnchors(sk);
  return eye(sk.headCx - a.eyeDx, a.eyeY, c, expr, -1) + eye(sk.headCx + a.eyeDx, a.eyeY, c, expr, 1);
}

export function faceSvg(c: CharacterConfig, sk: Skeleton, expr: Expression): string {
  const cx = sk.headCx;
  const a = faceAnchors(sk);
  let s = '';
  // 腮红
  s += `<ellipse cx="${n(cx - sk.headR * 0.56)}" cy="${n(a.eyeY + 10)}" rx="5.5" ry="3.2" fill="#FF8FA3" opacity="0.55"/>`;
  s += `<ellipse cx="${n(cx + sk.headR * 0.56)}" cy="${n(a.eyeY + 10)}" rx="5.5" ry="3.2" fill="#FF8FA3" opacity="0.55"/>`;
  s += eye(cx - a.eyeDx, a.eyeY, c, expr, -1);
  s += eye(cx + a.eyeDx, a.eyeY, c, expr, 1);
  if (c.hat.style !== 'hood') s += brows(cx, a, expr, c);
  if (c.build !== 'baby') {
    s += `<path d="M${n(cx - 1.5)} ${n(a.eyeY + 8)} Q${n(cx + 1.5)} ${n(a.eyeY + 11)} ${n(cx - 1)} ${n(a.eyeY + 13)}" fill="none" stroke="#C98A6B" stroke-width="2" stroke-linecap="round"/>`;
  }
  if (c.accessories.includes('freckles')) {
    for (const dx of [-15, -11, 11, 15])
      s += circle(cx + dx, a.eyeY + 9 + (Math.abs(dx) > 12 ? 1 : 0), 0.9, '#C98A6B', 'stroke="none"');
  }
  if (c.accessories.includes('beard')) {
    s += path(
      `M${n(cx - sk.headR * 0.62)} ${n(a.eyeY + 8)} Q${n(cx)} ${n(sk.headCy + sk.headR * 1.25)} ${n(cx + sk.headR * 0.62)} ${n(a.eyeY + 8)} Q${n(cx)} ${n(a.mouthY + 6)} ${n(cx - sk.headR * 0.62)} ${n(a.eyeY + 8)} Z`,
      c.hair.color,
      S2,
    );
  }
  if (c.hat.style !== 'hood') s += mouth(cx, a.mouthY, expr, c);
  if (c.accessories.includes('mustache')) {
    const col = c.hair.style === 'bald' ? '#9A9A9A' : c.hair.color;
    s += path(
      `M${n(cx)} ${n(a.mouthY - 5)} Q${n(cx - 8)} ${n(a.mouthY - 9)} ${n(cx - 13)} ${n(a.mouthY - 2)} Q${n(cx - 6)} ${n(a.mouthY - 3)} ${n(cx)} ${n(a.mouthY - 3)} Q${n(cx + 6)} ${n(a.mouthY - 3)} ${n(cx + 13)} ${n(a.mouthY - 2)} Q${n(cx + 8)} ${n(a.mouthY - 9)} ${n(cx)} ${n(a.mouthY - 5)} Z`,
      col,
      S2,
    );
  }
  return s;
}
