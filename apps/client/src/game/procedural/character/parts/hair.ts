// 发型：后层（在身体之后，长发/波波头/辫子根部）、前层（刘海与头顶）、背面视图（整颗后脑）
import type { CharacterConfig } from '../defs';
import { n, type Skeleton } from '../rig';
import { circle, ellipse, path, S, S2 } from './common';

/** 头顶发帽：覆盖上半个头的弧形，下缘为刘海（锯齿或直线） */
function cap(sk: Skeleton, color: string, fringe: 'zig' | 'straight' | 'part', depth = 0.12): string {
  const { headCx: cx, headCy: cy, headR: r } = sk;
  const yEdge = cy - r * depth;
  let d = `M${n(cx - r * 1.02)} ${n(cy + r * 0.1)} C${n(cx - r * 1.1)} ${n(cy - r * 1.25)} ${n(cx + r * 1.1)} ${n(cy - r * 1.25)} ${n(cx + r * 1.02)} ${n(cy + r * 0.1)}`;
  if (fringe === 'zig') {
    const k = 6;
    for (let i = k; i >= 0; i--) {
      const x = cx - r * 0.95 + (r * 1.9 * i) / k;
      d += ` L${n(x)} ${n(i % 2 ? yEdge + 7 : yEdge - 2)}`;
    }
  } else if (fringe === 'part') {
    d += ` Q${n(cx + r * 0.6)} ${n(yEdge - 4)} ${n(cx + 2)} ${n(yEdge - 8)} Q${n(cx - r * 0.6)} ${n(yEdge - 4)} ${n(cx - r * 1.02)} ${n(cy + r * 0.1)}`;
  } else {
    d += ` L${n(cx + r * 0.9)} ${n(yEdge + 4)} L${n(cx - r * 0.9)} ${n(yEdge + 4)}`;
  }
  return path(`${d} Z`, color);
}

/** 身体之前绘制的后层头发 */
export function hairBackSvg(c: CharacterConfig, sk: Skeleton): string {
  const { headCx: cx, headCy: cy, headR: r } = sk;
  const col = c.hair.color;
  switch (c.hair.style) {
    case 'long':
      return path(
        `M${n(cx - r * 1.05)} ${n(cy - r * 0.2)} Q${n(cx - r * 1.3)} ${n(cy + r * 1.6)} ${n(cx - r * 0.7)} ${n(cy + r * 2.25)} L${n(cx + r * 0.7)} ${n(cy + r * 2.25)} Q${n(cx + r * 1.3)} ${n(cy + r * 1.6)} ${n(cx + r * 1.05)} ${n(cy - r * 0.2)} Z`,
        col,
      );
    case 'bob':
      return path(
        `M${n(cx - r * 1.1)} ${n(cy - r * 0.1)} Q${n(cx - r * 1.2)} ${n(cy + r * 0.95)} ${n(cx - r * 0.75)} ${n(cy + r * 1.0)} L${n(cx + r * 0.75)} ${n(cy + r * 1.0)} Q${n(cx + r * 1.2)} ${n(cy + r * 0.95)} ${n(cx + r * 1.1)} ${n(cy - r * 0.1)} Z`,
        col,
      );
    case 'curly': {
      let s = '';
      for (const [dx, dy, rr] of [
        [-0.95, 0.35, 0.36],
        [0.95, 0.35, 0.36],
        [-0.85, 0.85, 0.3],
        [0.85, 0.85, 0.3],
      ] as const) {
        s += circle(cx + dx * r, cy + dy * r, rr * r, col);
      }
      return s;
    }
    default:
      return '';
  }
}

/** 正面的前层头发（画在脸之后、帽子之前） */
export function hairFrontSvg(c: CharacterConfig, sk: Skeleton): string {
  const { headCx: cx, headCy: cy, headR: r } = sk;
  const col = c.hair.color;
  switch (c.hair.style) {
    case 'short':
      return cap(sk, col, 'zig');
    case 'spiky': {
      let s = cap(sk, col, 'zig');
      let d = `M${n(cx - r * 0.8)} ${n(cy - r * 0.7)}`;
      for (let i = 0; i < 5; i++) {
        const x0 = cx - r * 0.8 + (r * 1.6 * i) / 5;
        d += ` L${n(x0 + (r * 0.8) / 5)} ${n(cy - r * 1.3 - (i % 2) * 4)} L${n(x0 + (r * 1.6) / 5)} ${n(cy - r * 0.75)}`;
      }
      s += path(`${d} Z`, col);
      return s;
    }
    case 'bald':
      return (
        ellipse(cx - r * 0.92, cy - r * 0.05, 6, 9, col, S2) +
        ellipse(cx + r * 0.92, cy - r * 0.05, 6, 9, col, S2) +
        `<path d="M${n(cx - 8)} ${n(cy - r * 0.62)} Q${n(cx)} ${n(cy - r * 0.72)} ${n(cx + 8)} ${n(cy - r * 0.62)}" fill="none" stroke="#FFFFFF" stroke-width="3" opacity="0.6"/>`
      );
    case 'curly': {
      let s = cap(sk, col, 'straight', 0.3);
      for (let i = 0; i < 5; i++)
        s += circle(cx - r * 0.7 + (r * 1.4 * i) / 4, cy - r * 0.62 - (i % 2) * 5, r * 0.26, col);
      s += circle(cx, cy - r * 1.12, r * 0.34, col);
      s += circle(cx + r * 0.1, cy - r * 1.18, 3, '#FFFFFF', 'stroke="none" opacity="0.5"');
      return s;
    }
    case 'long':
      return cap(sk, col, 'part', 0.18);
    case 'topknot':
      return circle(cx, cy - r * 1.08, r * 0.24, col) + cap(sk, col, 'zig', 0.2);
    case 'bob':
      return cap(sk, col, 'straight', 0.22);
    case 'braids': {
      let s = cap(sk, col, 'part', 0.16);
      for (const side of [-1, 1]) {
        const x = cx + side * r * 0.95;
        for (let i = 0; i < 4; i++) s += ellipse(x + side * 1, cy + r * 0.35 + i * 10, 6, 6.5, col, S2);
        s += `<rect x="${n(x - 5)}" y="${n(cy + r * 0.35 + 38)}" width="10" height="5" rx="2" fill="#F2545B" ${S2}/>`;
      }
      return s;
    }
    case 'pigtails': {
      let s = '';
      for (const side of [-1, 1]) s += circle(cx + side * r * 1.02, cy - r * 0.45, r * 0.34, col);
      s += cap(sk, col, 'zig', 0.2);
      for (const side of [-1, 1]) s += circle(cx + side * r * 0.82, cy - r * 0.72, 3.2, '#F2545B', S2);
      return s;
    }
    case 'tuft':
      return `<path d="M${n(cx - 2)} ${n(cy - r * 0.92)} Q${n(cx - 6)} ${n(cy - r * 1.35)} ${n(cx + 4)} ${n(cy - r * 1.32)} Q${n(cx + 8)} ${n(cy - r * 1.2)} ${n(cx + 2)} ${n(cy - r * 1.12)}" fill="${col}" ${S}/>`;
  }
}

/** 背面视图：整颗后脑的头发 */
export function hairBackViewSvg(c: CharacterConfig, sk: Skeleton): string {
  const { headCx: cx, headCy: cy, headR: r } = sk;
  const col = c.hair.color;
  switch (c.hair.style) {
    case 'bald':
      return ellipse(cx, cy + r * 0.25, r * 0.9, r * 0.45, col, S2);
    case 'tuft':
      return hairFrontSvg(c, sk);
    case 'long':
      return path(
        `M${n(cx - r * 1.05)} ${n(cy - r * 0.3)} C${n(cx - r * 1.2)} ${n(cy - r * 1.3)} ${n(cx + r * 1.2)} ${n(cy - r * 1.3)} ${n(cx + r * 1.05)} ${n(cy - r * 0.3)} Q${n(cx + r * 1.25)} ${n(cy + r * 1.6)} ${n(cx + r * 0.7)} ${n(cy + r * 2.25)} L${n(cx - r * 0.7)} ${n(cy + r * 2.25)} Q${n(cx - r * 1.25)} ${n(cy + r * 1.6)} ${n(cx - r * 1.05)} ${n(cy - r * 0.3)} Z`,
        col,
      );
    case 'braids':
    case 'pigtails':
    case 'topknot':
    case 'curly': {
      let s = ellipse(cx, cy - r * 0.05, r * 1.02, r * 0.98, col);
      if (c.hair.style === 'topknot') s += circle(cx, cy - r * 1.08, r * 0.24, col);
      if (c.hair.style === 'pigtails')
        for (const side of [-1, 1]) s += circle(cx + side * r * 1.02, cy - r * 0.45, r * 0.34, col);
      if (c.hair.style === 'curly') s += circle(cx, cy - r * 1.12, r * 0.34, col);
      if (c.hair.style === 'braids')
        for (const side of [-1, 1])
          for (let i = 0; i < 4; i++) s += ellipse(cx + side * r * 0.95, cy + r * 0.35 + i * 10, 6, 6.5, col, S2);
      return s;
    }
    default:
      return ellipse(cx, cy - r * 0.05, r * 1.02, r * 0.98, col);
  }
}
