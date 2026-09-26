// SVG 片段的公共小工具：统一描边、带描边的粗肢体、基本形状
import { INK, n, STROKE_W } from '../rig';

/** 统一描边属性 */
export const S = `stroke="${INK}" stroke-width="${STROKE_W}" stroke-linejoin="round" stroke-linecap="round"`;
export const S2 = `stroke="${INK}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"`;

export function circle(cx: number, cy: number, r: number, fill: string, stroke = S): string {
  return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${fill}" ${stroke}/>`;
}

export function ellipse(cx: number, cy: number, rx: number, ry: number, fill: string, stroke = S): string {
  return `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx)}" ry="${n(ry)}" fill="${fill}" ${stroke}/>`;
}

export function path(d: string, fill: string, stroke = S): string {
  return `<path d="${d}" fill="${fill}" ${stroke}/>`;
}

export function poly(points: readonly (readonly [number, number])[], fill: string, stroke = S): string {
  return `<polygon points="${points.map(([x, y]) => `${n(x)},${n(y)}`).join(' ')}" fill="${fill}" ${stroke}/>`;
}

/** 带描边的粗肢体：先画深色宽线，再叠一条细一点的颜色线 */
export function limb(x1: number, y1: number, x2: number, y2: number, color: string, width: number): string {
  const c = `x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke-linecap="round"`;
  return `<line ${c} stroke="${INK}" stroke-width="${n(width + STROKE_W * 2 - 1)}"/><line ${c} stroke="${color}" stroke-width="${n(width)}"/>`;
}

/** 四角星闪光 */
export function sparkle(cx: number, cy: number, r: number, fill = '#FFE066'): string {
  const k = r * 0.28;
  const d = `M${n(cx)} ${n(cy - r)} L${n(cx + k)} ${n(cy - k)} L${n(cx + r)} ${n(cy)} L${n(cx + k)} ${n(cy + k)} L${n(cx)} ${n(cy + r)} L${n(cx - k)} ${n(cy + k)} L${n(cx - r)} ${n(cy)} L${n(cx - k)} ${n(cy - k)} Z`;
  return path(d, fill, S2);
}

/** 五角星 */
export function star(cx: number, cy: number, r: number, fill = '#FFD84D'): string {
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.45;
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  return poly(pts, fill, S2);
}

export function group(content: string, transform?: string): string {
  return transform ? `<g transform="${transform}">${content}</g>` : `<g>${content}</g>`;
}
