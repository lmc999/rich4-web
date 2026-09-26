// 身体部件：腿、躯干（按服装）、手臂。所有服装共用骨架（rig.ts），只换形状与颜色。
import type { CharacterConfig, OutfitStyle } from '../defs';
import { type Facing, FOOT_Y, INK, limbEnd, n, type PoseSpec, type Skeleton } from '../rig';
import { circle, ellipse, limb, path, poly, S, S2 } from './common';

const CX = 64;

/** 腿露肤色（短裤 / 裙子）的服装 */
const SKIN_LEGS: ReadonlySet<OutfitStyle> = new Set(['farmer', 'sailor', 'dress', 'newsboy']);
/** 短袖或无袖 */
const SHORT_SLEEVE: ReadonlySet<OutfitStyle> = new Set(['sailor', 'dress', 'newsboy', 'tunic']);
const SLEEVELESS: ReadonlySet<OutfitStyle> = new Set(['farmer']);

export interface Limbs {
  handL: { x: number; y: number };
  handR: { x: number; y: number };
  footL: { x: number; y: number };
  footR: { x: number; y: number };
}

export function limbPositions(sk: Skeleton, p: PoseSpec): Limbs {
  const handL = limbEnd(CX - sk.shoulderDx, sk.shoulderY, p.armL, sk.armLen);
  const handR = limbEnd(CX + sk.shoulderDx, sk.shoulderY, p.armR, sk.armLen);
  const fl = limbEnd(CX - sk.hipDx, sk.hipY, p.legL, sk.legLen);
  const fr = limbEnd(CX + sk.hipDx, sk.hipY, p.legR, sk.legLen);
  return {
    handL,
    handR,
    footL: { x: fl.x, y: Math.min(FOOT_Y, fl.y) - p.liftL },
    footR: { x: fr.x, y: Math.min(FOOT_Y, fr.y) - p.liftR },
  };
}

export function legsSvg(c: CharacterConfig, sk: Skeleton, L: Limbs): string {
  const style = c.outfit.style;
  const legColor = SKIN_LEGS.has(style) ? c.skin : c.outfit.legs;
  const w = c.build === 'baby' ? 9 : c.build === 'kid' ? 8 : 9;
  let out = '';
  out += limb(CX - sk.hipDx, sk.hipY - 4, L.footL.x, L.footL.y, legColor, w);
  out += limb(CX + sk.hipDx, sk.hipY - 4, L.footR.x, L.footR.y, legColor, w);
  // 鞋
  out += ellipse(L.footL.x - 2, L.footL.y + 1, 7, 4.5, c.outfit.shoes);
  out += ellipse(L.footR.x + 2, L.footR.y + 1, 7, 4.5, c.outfit.shoes);
  return out;
}

function torsoPath(sk: Skeleton, topHalf: number, bottomHalf: number, bottom = sk.torsoBottom): string {
  const top = sk.torsoTop;
  return `M${n(CX - topHalf)} ${n(top + 3)} Q${CX} ${n(top - 4)} ${n(CX + topHalf)} ${n(top + 3)} L${n(CX + bottomHalf)} ${n(bottom)} Q${CX} ${n(bottom + 5)} ${n(CX - bottomHalf)} ${n(bottom)} Z`;
}

/** 躯干与服装主体（在手臂之前绘制） */
export function torsoSvg(c: CharacterConfig, sk: Skeleton, facing: Facing): string {
  const o = c.outfit;
  const tw = sk.torsoW;
  const front = facing === 'front';
  let s = '';
  switch (o.style) {
    case 'cowboy': {
      s += path(torsoPath(sk, tw * 0.38, tw * 0.46), o.primary);
      if (front) {
        // 马甲两片 + 腰带扣
        s += path(
          `M${n(CX - tw * 0.38)} ${sk.torsoTop + 4} L${CX - 5} ${sk.torsoTop + 10} L${CX - 4} ${sk.torsoBottom - 6} L${n(CX - tw * 0.46)} ${sk.torsoBottom - 4} Z`,
          o.secondary,
        );
        s += path(
          `M${n(CX + tw * 0.38)} ${sk.torsoTop + 4} L${CX + 5} ${sk.torsoTop + 10} L${CX + 4} ${sk.torsoBottom - 6} L${n(CX + tw * 0.46)} ${sk.torsoBottom - 4} Z`,
          o.secondary,
        );
      } else {
        s += path(torsoPath(sk, tw * 0.38, tw * 0.46, sk.torsoBottom - 6), o.secondary);
      }
      s += `<rect x="${n(CX - tw * 0.47)}" y="${sk.torsoBottom - 7}" width="${n(tw * 0.94)}" height="6" fill="#5A3A1E" ${S2}/>`;
      if (front)
        s += `<rect x="${CX - 4}" y="${sk.torsoBottom - 8}" width="8" height="8" rx="1.5" fill="#FFD84D" ${S2}/>`;
      break;
    }
    case 'robe': {
      // 长袍到脚踝 + 金色镶边
      const hem = FOOT_Y - 5;
      s += path(
        `M${n(CX - tw * 0.4)} ${sk.torsoTop + 3} Q${CX} ${sk.torsoTop - 4} ${n(CX + tw * 0.4)} ${sk.torsoTop + 3} L${n(CX + tw * 0.62)} ${hem} Q${CX} ${hem + 5} ${n(CX - tw * 0.62)} ${hem} Z`,
        o.primary,
      );
      if (front)
        s += `<line x1="${CX}" y1="${sk.torsoTop + 4}" x2="${CX}" y2="${hem}" stroke="${o.secondary}" stroke-width="4"/>`;
      s += `<path d="M${n(CX - tw * 0.6)} ${hem - 4} Q${CX} ${hem + 2} ${n(CX + tw * 0.6)} ${hem - 4}" fill="none" stroke="${o.secondary}" stroke-width="3"/>`;
      break;
    }
    case 'ninja': {
      s += path(torsoPath(sk, tw * 0.38, tw * 0.44), o.primary);
      if (front) {
        s += `<path d="M${CX - 9} ${sk.torsoTop + 2} L${CX + 3} ${sk.torsoTop + 18} M${CX + 9} ${sk.torsoTop + 2} L${CX - 3} ${sk.torsoTop + 18}" stroke="#6B5B66" stroke-width="2.5" fill="none"/>`;
      }
      s += `<rect x="${n(CX - tw * 0.45)}" y="${sk.torsoBottom - 10}" width="${n(tw * 0.9)}" height="7" fill="${o.secondary}" ${S2}/>`;
      break;
    }
    case 'gown':
    case 'princess': {
      // 紧身上衣 + 大裙摆（公主裙更蓬）
      const waist = sk.torsoTop + (sk.torsoBottom - sk.torsoTop) * 0.55;
      const flare = o.style === 'princess' ? 0.95 : 0.78;
      const hem = FOOT_Y - 4;
      s += path(
        `M${n(CX - tw * 0.26)} ${n(waist)} Q${n(CX - tw * flare)} ${n((waist + hem) / 2)} ${n(CX - tw * flare)} ${hem} Q${CX} ${hem + 7} ${n(CX + tw * flare)} ${hem} Q${n(CX + tw * flare)} ${n((waist + hem) / 2)} ${n(CX + tw * 0.26)} ${n(waist)} Z`,
        o.primary,
      );
      s += `<path d="M${n(CX - tw * flare + 2)} ${hem - 3} Q${CX} ${hem + 5} ${n(CX + tw * flare - 2)} ${hem - 3}" fill="none" stroke="${o.secondary}" stroke-width="4" stroke-dasharray="5 3"/>`;
      s += path(torsoPath(sk, tw * 0.34, tw * 0.28, waist), o.primary);
      if (o.style === 'princess') {
        // 泡泡袖
        s += circle(CX - sk.shoulderDx - 1, sk.shoulderY - 1, 7, o.secondary);
        s += circle(CX + sk.shoulderDx + 1, sk.shoulderY - 1, 7, o.secondary);
      }
      break;
    }
    case 'farmer': {
      // 背心 + 短裤
      s += path(torsoPath(sk, tw * 0.3, tw * 0.42), o.primary);
      s += path(
        `M${n(CX - tw * 0.46)} ${sk.torsoBottom - 6} L${n(CX + tw * 0.46)} ${sk.torsoBottom - 6} L${n(CX + tw * 0.5)} ${sk.hipY + 10} L${CX + 2} ${sk.hipY + 10} L${CX} ${sk.hipY + 2} L${CX - 2} ${sk.hipY + 10} L${n(CX - tw * 0.5)} ${sk.hipY + 10} Z`,
        o.legs,
      );
      break;
    }
    case 'hakama': {
      // 宽裤（袴）+ 交领上衣
      const hem = FOOT_Y - 6;
      s += path(
        `M${n(CX - tw * 0.42)} ${sk.torsoBottom - 10} L${n(CX + tw * 0.42)} ${sk.torsoBottom - 10} L${n(CX + tw * 0.62)} ${hem} L${n(CX - tw * 0.62)} ${hem} Z`,
        o.secondary,
      );
      s += `<path d="M${CX - 6} ${sk.torsoBottom} L${CX - 8} ${hem - 2} M${CX + 6} ${sk.torsoBottom} L${CX + 8} ${hem - 2}" stroke="${INK}" stroke-width="1.5" opacity="0.5"/>`;
      s += path(torsoPath(sk, tw * 0.38, tw * 0.44, sk.torsoBottom - 8), o.primary);
      if (front) {
        s += `<path d="M${CX - 9} ${sk.torsoTop + 2} L${CX + 4} ${sk.torsoTop + 20} M${CX + 9} ${sk.torsoTop + 2} L${CX} ${sk.torsoTop + 14}" stroke="#FFFFFF" stroke-width="3" fill="none"/>`;
      }
      break;
    }
    case 'sailor': {
      // 水手服 + 百褶裙 + 红领巾
      s += path(
        `M${n(CX - tw * 0.42)} ${sk.torsoBottom - 8} L${n(CX + tw * 0.42)} ${sk.torsoBottom - 8} L${n(CX + tw * 0.62)} ${sk.hipY + 12} L${n(CX - tw * 0.62)} ${sk.hipY + 12} Z`,
        o.secondary,
      );
      for (const dx of [-8, 0, 8]) {
        s += `<line x1="${CX + dx * 0.6}" y1="${sk.torsoBottom - 6}" x2="${CX + dx}" y2="${sk.hipY + 11}" stroke="${INK}" stroke-width="1.5" opacity="0.45"/>`;
      }
      s += path(torsoPath(sk, tw * 0.36, tw * 0.42, sk.torsoBottom - 6), o.primary);
      if (front) {
        s += poly(
          [
            [CX - tw * 0.36, sk.torsoTop + 2],
            [CX, sk.torsoTop + 16],
            [CX + tw * 0.36, sk.torsoTop + 2],
            [CX + tw * 0.2, sk.torsoTop - 1],
            [CX, sk.torsoTop + 8],
            [CX - tw * 0.2, sk.torsoTop - 1],
          ],
          o.secondary,
          S2,
        );
        s += poly(
          [
            [CX - 6, sk.torsoTop + 13],
            [CX + 6, sk.torsoTop + 13],
            [CX, sk.torsoTop + 24],
          ],
          '#E8453C',
          S2,
        );
      } else {
        s += `<rect x="${n(CX - tw * 0.34)}" y="${sk.torsoTop}" width="${n(tw * 0.68)}" height="13" fill="${o.secondary}" ${S2}/>`;
      }
      break;
    }
    case 'tunic': {
      // 流苏短袍
      const hem = sk.hipY + 12;
      s += path(
        `M${n(CX - tw * 0.38)} ${sk.torsoTop + 3} Q${CX} ${sk.torsoTop - 4} ${n(CX + tw * 0.38)} ${sk.torsoTop + 3} L${n(CX + tw * 0.56)} ${hem} L${n(CX - tw * 0.56)} ${hem} Z`,
        o.primary,
      );
      let fringe = `M${n(CX - tw * 0.56)} ${hem}`;
      for (let i = 0; i <= 8; i++) {
        const x = CX - tw * 0.56 + (tw * 1.12 * i) / 8;
        fringe += ` L${n(x)} ${hem + (i % 2 ? 6 : 0)}`;
      }
      s += `<path d="${fringe}" fill="none" stroke="${o.secondary}" stroke-width="3"/>`;
      if (front)
        s += `<path d="M${CX - 10} ${sk.torsoTop + 16} Q${CX} ${sk.torsoTop + 22} ${CX + 10} ${sk.torsoTop + 16}" fill="none" stroke="${o.secondary}" stroke-width="3" stroke-dasharray="3 3"/>`;
      break;
    }
    case 'dress': {
      // 及膝连衣裙 + 黄色镶边
      const hem = sk.hipY + 13;
      s += path(
        `M${n(CX - tw * 0.36)} ${sk.torsoTop + 3} Q${CX} ${sk.torsoTop - 4} ${n(CX + tw * 0.36)} ${sk.torsoTop + 3} L${n(CX + tw * 0.62)} ${hem} Q${CX} ${hem + 5} ${n(CX - tw * 0.62)} ${hem} Z`,
        o.primary,
      );
      s += `<path d="M${n(CX - tw * 0.6)} ${hem - 3} Q${CX} ${hem + 2} ${n(CX + tw * 0.6)} ${hem - 3}" fill="none" stroke="${o.secondary}" stroke-width="3"/>`;
      if (front) {
        s += `<path d="M${CX - 8} ${sk.torsoTop + 1} Q${CX} ${sk.torsoTop + 8} ${CX + 8} ${sk.torsoTop + 1}" fill="none" stroke="${o.secondary}" stroke-width="3"/>`;
        s += circle(CX, sk.torsoTop + 14, 1.8, o.secondary, S2);
        s += circle(CX, sk.torsoTop + 22, 1.8, o.secondary, S2);
      }
      break;
    }
    case 'newsboy': {
      // 衬衫 + 马甲 + 短裤
      s += path(
        `M${n(CX - tw * 0.46)} ${sk.torsoBottom - 6} L${n(CX + tw * 0.46)} ${sk.torsoBottom - 6} L${n(CX + tw * 0.5)} ${sk.hipY + 9} L${CX + 2} ${sk.hipY + 9} L${CX} ${sk.hipY + 2} L${CX - 2} ${sk.hipY + 9} L${n(CX - tw * 0.5)} ${sk.hipY + 9} Z`,
        o.legs,
      );
      s += path(torsoPath(sk, tw * 0.38, tw * 0.44), o.primary);
      if (front) {
        s += path(
          `M${n(CX - tw * 0.38)} ${sk.torsoTop + 4} L${CX - 4} ${sk.torsoTop + 12} L${CX - 3} ${sk.torsoBottom - 2} L${n(CX - tw * 0.44)} ${sk.torsoBottom - 1} Z`,
          o.secondary,
        );
        s += path(
          `M${n(CX + tw * 0.38)} ${sk.torsoTop + 4} L${CX + 4} ${sk.torsoTop + 12} L${CX + 3} ${sk.torsoBottom - 2} L${n(CX + tw * 0.44)} ${sk.torsoBottom - 1} Z`,
          o.secondary,
        );
      }
      break;
    }
    case 'onesie': {
      // 圆滚滚连体衣 + 围兜
      s += ellipse(
        CX,
        (sk.torsoTop + sk.torsoBottom) / 2 + 2,
        tw * 0.52,
        (sk.torsoBottom - sk.torsoTop) / 2 + 3,
        o.primary,
      );
      if (front) {
        s += ellipse(CX, sk.torsoTop + 11, 11, 9, o.secondary, S2);
        s += circle(CX, sk.torsoBottom - 8, 2, '#FFFFFF', S2);
      }
      break;
    }
  }
  return s;
}

/** 手臂 + 手（在躯干之后绘制） */
export function armsSvg(c: CharacterConfig, sk: Skeleton, L: Limbs): string {
  const style = c.outfit.style;
  const sleeve = SLEEVELESS.has(style) ? c.skin : c.outfit.primary;
  const shortS = SHORT_SLEEVE.has(style);
  const w = c.build === 'baby' ? 8 : 8.5;
  let s = '';
  for (const side of [-1, 1] as const) {
    const sx = CX + side * sk.shoulderDx;
    const sy = sk.shoulderY;
    const h = side < 0 ? L.handL : L.handR;
    if (shortS) {
      const mx = sx + (h.x - sx) * 0.45;
      const my = sy + (h.y - sy) * 0.45;
      s += limb(mx, my, h.x, h.y, c.skin, w - 1);
      s += limb(sx, sy, mx, my, sleeve, w + 1);
    } else {
      s += limb(sx, sy, h.x, h.y, sleeve, w);
    }
    s += circle(h.x, h.y, 5.5, c.skin);
  }
  return s;
}

/** 脖子 */
export function neckSvg(c: CharacterConfig, sk: Skeleton): string {
  return `<rect x="${CX - 6}" y="${sk.neckY - 6}" width="12" height="${sk.torsoTop - sk.neckY + 9}" rx="4" fill="${c.skin}" ${S}/>`;
}
