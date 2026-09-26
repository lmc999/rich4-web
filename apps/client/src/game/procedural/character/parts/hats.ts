// 帽子、头饰与随身道具（角色的标志物：牛仔帽、头巾、兜帽、斗笠、后冠、头带、棒球帽、蝴蝶结、羽毛……）
import type { CharacterConfig } from '../defs';
import { type Expression, type Facing, INK, n, type Skeleton } from '../rig';
import type { Limbs } from './body';
import { circle, ellipse, limb, path, poly, S, S2, star } from './common';
import { eyesSvg, faceAnchors } from './head';

const CX = 64;

/** 头顶帽子 / 头饰（正面与背面共用轮廓，背面省略正面细节） */
export function hatSvg(c: CharacterConfig, sk: Skeleton, facing: Facing, expr: Expression = 'normal'): string {
  const { headCx: cx, headCy: cy, headR: r } = sk;
  const { color, accent } = c.hat;
  const front = facing === 'front';
  switch (c.hat.style) {
    case 'none':
      return '';
    case 'cowboy': {
      const by = cy - r * 0.55;
      let s = path(
        `M${n(cx - r * 1.55)} ${n(by + 2)} Q${n(cx - r * 1.2)} ${n(by + 12)} ${n(cx)} ${n(by + 9)} Q${n(cx + r * 1.2)} ${n(by + 12)} ${n(cx + r * 1.55)} ${n(by + 2)} Q${n(cx + r * 1.1)} ${n(by - 4)} ${n(cx)} ${n(by - 2)} Q${n(cx - r * 1.1)} ${n(by - 4)} ${n(cx - r * 1.55)} ${n(by + 2)} Z`,
        color,
      );
      s += path(
        `M${n(cx - r * 0.72)} ${n(by + 1)} Q${n(cx - r * 0.8)} ${n(by - r * 0.9)} ${n(cx - r * 0.25)} ${n(by - r * 0.85)} Q${n(cx)} ${n(by - r * 0.6)} ${n(cx + r * 0.25)} ${n(by - r * 0.85)} Q${n(cx + r * 0.8)} ${n(by - r * 0.9)} ${n(cx + r * 0.72)} ${n(by + 1)} Z`,
        color,
      );
      s += `<path d="M${n(cx - r * 0.7)} ${n(by - 4)} Q${n(cx)} ${n(by)} ${n(cx + r * 0.7)} ${n(by - 4)}" fill="none" stroke="${accent}" stroke-width="5"/>`;
      return s;
    }
    case 'keffiyeh': {
      // 头巾垂到肩 + 金色头箍
      let s = path(
        `M${n(cx - r * 1.12)} ${n(cy + r * 1.05)} Q${n(cx - r * 1.3)} ${n(cy - r * 1.2)} ${n(cx)} ${n(cy - r * 1.15)} Q${n(cx + r * 1.3)} ${n(cy - r * 1.2)} ${n(cx + r * 1.12)} ${n(cy + r * 1.05)} L${n(cx + r * 0.78)} ${n(cy + r * 0.2)} Q${n(cx)} ${n(cy - r * 0.62)} ${n(cx - r * 0.78)} ${n(cy + r * 0.2)} Z`,
        color,
      );
      if (!front) s = ellipse(cx, cy, r * 1.12, r * 1.12, color) + s;
      s += `<path d="M${n(cx - r * 0.95)} ${n(cy - r * 0.55)} Q${n(cx)} ${n(cy - r * 0.95)} ${n(cx + r * 0.95)} ${n(cy - r * 0.55)}" fill="none" stroke="${INK}" stroke-width="7" stroke-linecap="round"/>`;
      s += `<path d="M${n(cx - r * 0.95)} ${n(cy - r * 0.55)} Q${n(cx)} ${n(cy - r * 0.95)} ${n(cx + r * 0.95)} ${n(cy - r * 0.55)}" fill="none" stroke="${accent}" stroke-width="3.5" stroke-linecap="round"/>`;
      return s;
    }
    case 'hood': {
      // 忍者兜帽：只露出眼部
      const a = faceAnchors(sk);
      let s = ellipse(cx, cy, r * 1.04, r * 1.0, color);
      if (front) {
        s += `<rect x="${n(cx - r * 0.78)}" y="${n(a.eyeY - 9)}" width="${n(r * 1.56)}" height="17" rx="8" fill="${c.skin}" ${S2}/>`;
        s += eyesSvg(c, sk, expr);
      }
      // 红色头带 + 飘带
      s += `<path d="M${n(cx - r)} ${n(cy - r * 0.45)} Q${n(cx)} ${n(cy - r * 0.62)} ${n(cx + r)} ${n(cy - r * 0.45)}" fill="none" stroke="${accent}" stroke-width="6"/>`;
      s += path(
        `M${n(cx + r * 0.9)} ${n(cy - r * 0.5)} Q${n(cx + r * 1.5)} ${n(cy - r * 0.6)} ${n(cx + r * 1.7)} ${n(cy - r * 0.2)} Q${n(cx + r * 1.3)} ${n(cy - r * 0.35)} ${n(cx + r * 0.95)} ${n(cy - r * 0.35)} Z`,
        accent,
        S2,
      );
      return s;
    }
    case 'straw': {
      // 斗笠
      const by = cy - r * 0.42;
      let s = path(
        `M${n(cx - r * 1.7)} ${n(by + 8)} Q${n(cx)} ${n(by + 18)} ${n(cx + r * 1.7)} ${n(by + 8)} L${n(cx + 3)} ${n(by - r * 0.95)} L${n(cx - 3)} ${n(by - r * 0.95)} Z`,
        color,
      );
      for (const k of [-0.9, -0.45, 0.45, 0.9]) {
        s += `<line x1="${n(cx + k * r * 1.6)}" y1="${n(by + 10)}" x2="${cx}" y2="${n(by - r * 0.9)}" stroke="${accent}" stroke-width="1.5"/>`;
      }
      return s;
    }
    case 'tiara': {
      const by = cy - r * 0.72;
      let s = poly(
        [
          [cx - 15, by + 6],
          [cx - 15, by - 4],
          [cx - 8, by + 1],
          [cx, by - 10],
          [cx + 8, by + 1],
          [cx + 15, by - 4],
          [cx + 15, by + 6],
        ],
        color,
        S2,
      );
      s += circle(cx, by, 3, accent, S2);
      return s;
    }
    case 'headband': {
      const y = cy - r * 0.48;
      let s = `<path d="M${n(cx - r * 1.0)} ${n(y + 3)} Q${n(cx)} ${n(y - 5)} ${n(cx + r * 1.0)} ${n(y + 3)}" fill="none" stroke="${INK}" stroke-width="10" stroke-linecap="round"/>`;
      s += `<path d="M${n(cx - r * 1.0)} ${n(y + 3)} Q${n(cx)} ${n(y - 5)} ${n(cx + r * 1.0)} ${n(y + 3)}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round"/>`;
      if (front) s += circle(cx, y - 1, 3.5, accent, 'stroke="none"');
      else
        s += path(
          `M${cx} ${n(y)} Q${cx - 10} ${n(y + 16)} ${cx - 16} ${n(y + 22)} L${cx - 10} ${n(y + 24)} Q${cx - 4} ${n(y + 14)} ${cx} ${n(y)} Z`,
          color,
          S2,
        );
      return s;
    }
    case 'cap': {
      const by = cy - r * 0.35;
      let s = path(
        `M${n(cx - r * 1.02)} ${n(by)} C${n(cx - r * 1.0)} ${n(cy - r * 1.35)} ${n(cx + r * 1.0)} ${n(cy - r * 1.35)} ${n(cx + r * 1.02)} ${n(by)} Z`,
        color,
      );
      if (front) s += ellipse(cx + r * 0.2, by + 1, r * 0.95, 5.5, color);
      s += circle(cx, cy - r * 1.02, 3, accent, S2);
      if (front) s += star(cx, by - 12, 5.5, accent);
      return s;
    }
    case 'ribbon': {
      const x = cx + r * 0.55;
      const y = cy - r * 0.9;
      let s = path(`M${x} ${y} L${x - 16} ${y - 10} L${x - 16} ${y + 10} Z`, color);
      s += path(`M${x} ${y} L${x + 16} ${y - 10} L${x + 16} ${y + 10} Z`, color);
      s += circle(x, y, 5, accent);
      return s;
    }
    case 'featherBand': {
      const y = cy - r * 0.5;
      let s = `<path d="M${n(cx - r * 1.0)} ${n(y + 3)} Q${n(cx)} ${n(y - 5)} ${n(cx + r * 1.0)} ${n(y + 3)}" fill="none" stroke="${INK}" stroke-width="9" stroke-linecap="round"/>`;
      s += `<path d="M${n(cx - r * 1.0)} ${n(y + 3)} Q${n(cx)} ${n(y - 5)} ${n(cx + r * 1.0)} ${n(y + 3)}" fill="none" stroke="${color}" stroke-width="5" stroke-dasharray="4 3" stroke-linecap="round"/>`;
      const fx = cx + r * 0.55;
      s += path(
        `M${n(fx)} ${n(y - 2)} Q${n(fx + 14)} ${n(y - 26)} ${n(fx + 6)} ${n(y - 44)} Q${n(fx - 6)} ${n(y - 24)} ${n(fx)} ${n(y - 2)} Z`,
        accent,
      );
      s += `<line x1="${n(fx)}" y1="${n(y - 2)}" x2="${n(fx + 6)}" y2="${n(y - 40)}" stroke="${INK}" stroke-width="1.5"/>`;
      return s;
    }
  }
}

/** 躯干之上、手臂之前的配饰（领巾、项链、背带） */
export function chestAccessoriesSvg(c: CharacterConfig, sk: Skeleton, facing: Facing): string {
  const front = facing === 'front';
  let s = '';
  for (const a of c.accessories) {
    switch (a) {
      case 'bandana':
        if (front)
          s += poly(
            [
              [CX - 12, sk.torsoTop - 1],
              [CX + 12, sk.torsoTop - 1],
              [CX, sk.torsoTop + 14],
            ],
            '#E8453C',
            S2,
          );
        break;
      case 'goldChain':
        if (front)
          s += `<path d="M${CX - 11} ${sk.torsoTop + 2} Q${CX} ${sk.torsoTop + 16} ${CX + 11} ${sk.torsoTop + 2}" fill="none" stroke="#E0B83C" stroke-width="3.5"/>`;
        break;
      case 'pearls':
        if (front) {
          for (let i = 0; i < 7; i++) {
            const t = i / 6;
            const x = CX - 12 + 24 * t;
            const y = sk.torsoTop + 2 + Math.sin(Math.PI * t) * 9;
            s += circle(x, y, 2.3, '#FFFFFF', 'stroke="#3A2A1A" stroke-width="1"');
          }
          s += poly(
            [
              [CX, sk.torsoTop + 12],
              [CX + 4, sk.torsoTop + 16],
              [CX, sk.torsoTop + 21],
              [CX - 4, sk.torsoTop + 16],
            ],
            '#DDF6FF',
            S2,
          );
        }
        break;
      case 'towel':
        s += path(
          `M${CX + 6} ${sk.torsoTop - 2} Q${CX + 16} ${sk.torsoTop - 4} ${CX + 19} ${sk.torsoTop + 6} L${CX + 17} ${sk.torsoTop + 22} L${CX + 11} ${sk.torsoTop + 22} L${CX + 11} ${sk.torsoTop + 6} Z`,
          '#FFFFFF',
          S2,
        );
        break;
      case 'newsBag':
        s += `<line x1="${CX - 12}" y1="${sk.torsoTop}" x2="${CX + 12}" y2="${sk.torsoBottom - 4}" stroke="${INK}" stroke-width="6"/>`;
        s += `<line x1="${CX - 12}" y1="${sk.torsoTop}" x2="${CX + 12}" y2="${sk.torsoBottom - 4}" stroke="#A0643C" stroke-width="3"/>`;
        if (front) {
          s += `<rect x="${CX + 6}" y="${sk.torsoBottom - 10}" width="20" height="15" rx="3" fill="#A0643C" ${S2}/>`;
          s += `<rect x="${CX + 9}" y="${sk.torsoBottom - 15}" width="14" height="7" fill="#FFFFFF" ${S2}/>`;
        }
        break;
      case 'shuriken':
        if (front) s += star(CX - 9, sk.torsoBottom - 7, 6, '#BFC5CF');
        break;
      case 'katana':
        if (front) {
          s += `<line x1="${CX - 22}" y1="${sk.torsoBottom + 6}" x2="${CX + 4}" y2="${sk.torsoBottom - 16}" stroke="${INK}" stroke-width="7" stroke-linecap="round"/>`;
          s += `<line x1="${CX - 22}" y1="${sk.torsoBottom + 6}" x2="${CX + 4}" y2="${sk.torsoBottom - 16}" stroke="#2A2A2A" stroke-width="4" stroke-linecap="round"/>`;
        } else {
          s += `<line x1="${CX - 16}" y1="${sk.torsoTop - 4}" x2="${CX + 16}" y2="${sk.torsoBottom}" stroke="${INK}" stroke-width="7" stroke-linecap="round"/>`;
          s += `<line x1="${CX - 16}" y1="${sk.torsoTop - 4}" x2="${CX + 16}" y2="${sk.torsoBottom}" stroke="#2A2A2A" stroke-width="4" stroke-linecap="round"/>`;
        }
        break;
      default:
        break;
    }
  }
  return s;
}

/** 手持道具（画在手臂之后）与嘴上的奶嘴（画在五官之后） */
export function handPropsSvg(c: CharacterConfig, L: Limbs): string {
  let s = '';
  if (c.accessories.includes('rose')) {
    s += limb(L.handL.x, L.handL.y + 2, L.handL.x - 3, L.handL.y - 14, '#3F9A4A', 2);
    s += circle(L.handL.x - 3, L.handL.y - 17, 5.5, '#E8453C');
    s += `<path d="M${n(L.handL.x - 6)} ${n(L.handL.y - 17)} Q${n(L.handL.x - 3)} ${n(L.handL.y - 21)} ${n(L.handL.x)} ${n(L.handL.y - 17)}" fill="none" stroke="${INK}" stroke-width="1.5"/>`;
  }
  if (c.accessories.includes('baseball')) {
    s += circle(L.handR.x + 3, L.handR.y - 3, 5.5, '#FFFFFF');
    s += `<path d="M${n(L.handR.x)} ${n(L.handR.y - 7)} Q${n(L.handR.x + 4)} ${n(L.handR.y - 3)} ${n(L.handR.x)} ${n(L.handR.y + 1)}" fill="none" stroke="#E8453C" stroke-width="1.2"/>`;
  }
  return s;
}

export function mouthPropsSvg(c: CharacterConfig, sk: Skeleton): string {
  if (!c.accessories.includes('pacifier')) return '';
  const a = faceAnchors(sk);
  return ellipse(sk.headCx, a.mouthY + 1, 8, 5, '#FF8FB1', S) + circle(sk.headCx, a.mouthY + 1, 3, '#FFFFFF', S2);
}
