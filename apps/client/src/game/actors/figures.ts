// 神明（13 种）、四大恶人与 NPC（新闻主播、女巫、医生、警察）的致敬造型（design/client.md §6.2）。
// 全部复用 M3a 的 SVG 纸娃娃 rig（procedural/character）：身体由 characterSvg 生成，再叠加各自的标志物
// （乌纱帽、元宝、翅膀、犄角、镰刀、眼罩……），原创绘制、不参考原版素材。纯函数，node 下可测。
import { GOD_KEYS, type GodKind, VILLAIN_KINDS, type VillainKind } from '@rich4/shared/engine';
import type { CharacterConfig } from '../procedural/character/defs';
import { type Limbs, limbPositions } from '../procedural/character/parts/body';
import { circle, ellipse, limb, path, poly, S, S2, sparkle, star } from '../procedural/character/parts/common';
import {
  type Facing,
  INK,
  n,
  POSE_SPECS,
  type Pose,
  SKELETONS,
  type Skeleton,
  VIEW_H,
  VIEW_W,
} from '../procedural/character/rig';
import { characterSvg } from '../procedural/character/svg';
import { GOD_PALETTES } from './godPalettes';

export type NpcId = 'anchor' | 'witch' | 'doctor' | 'police';
export const NPC_IDS: readonly NpcId[] = ['anchor', 'witch', 'doctor', 'police'];

export type FigureId = `god:${GodKind}` | `villain:${VillainKind}` | `npc:${NpcId}`;

export { GOD_PALETTES, type GodPalette } from './godPalettes';

const SKIN = { light: '#FFE0C2', fair: '#FFE8D6', tan: '#F2C79A', pale: '#DCDDE6', grey: '#C9C4D6' } as const;

/** 生成一个只用于 rig 的角色配置（index 为 -1：不是可选角色） */
function cfg(key: string, o: Omit<CharacterConfig, 'key' | 'index' | 'babble'>): CharacterConfig {
  return { key, index: -1, babble: { basePitch: 200, wave: 'sine', speed: 1 }, ...o };
}

interface OverlayCtx {
  sk: Skeleton;
  L: Limbs;
  pose: Pose;
  facing: Facing;
  front: boolean;
}

interface FigureDef {
  id: FigureId;
  /** null：不是人形（恶犬），由 custom 画整幅 */
  base: CharacterConfig | null;
  /** 画在身体之后（翅膀、麻袋） */
  behind?: (c: OverlayCtx) => string;
  /** 画在身体之前（帽子、道具、面具） */
  front?: (c: OverlayCtx) => string;
  custom?: (pose: Pose, facing: Facing) => string;
}

const CX = 64;

// ───────────────────────── 标志物 ─────────────────────────

/** 乌纱帽（财神）：黑色圆顶 + 两侧帽翅 + 金色帽徽 */
function officialHat(sk: Skeleton, front: boolean): string {
  const { headCx: cx, headCy: cy, headR: r } = sk;
  const top = cy - r * 0.62;
  let s = '';
  s += ellipse(cx - r * 1.35, top - 2, r * 0.42, 5, '#1F1A17', S2);
  s += ellipse(cx + r * 1.35, top - 2, r * 0.42, 5, '#1F1A17', S2);
  s += path(
    `M${n(cx - r * 0.82)} ${n(top + 6)} Q${n(cx - r * 0.9)} ${n(top - r * 0.75)} ${n(cx)} ${n(top - r * 0.8)} Q${n(cx + r * 0.9)} ${n(top - r * 0.75)} ${n(cx + r * 0.82)} ${n(top + 6)} Z`,
    '#1F1A17',
  );
  if (front) s += circle(cx, top - r * 0.25, 5, '#FFD84D', S2);
  return s;
}

/** 元宝 */
function ingot(x: number, y: number, k = 1): string {
  return (
    path(
      `M${n(x - 13 * k)} ${n(y - 4 * k)} Q${n(x)} ${n(y + 12 * k)} ${n(x + 13 * k)} ${n(y - 4 * k)} L${n(x + 8 * k)} ${n(y + 6 * k)} L${n(x - 8 * k)} ${n(y + 6 * k)} Z`,
      '#FFC21A',
      S2,
    ) + ellipse(x, y - 3 * k, 6 * k, 5 * k, '#FFE066', S2)
  );
}

/** 福字卷轴（福神） */
function fortuneScroll(x: number, y: number): string {
  return (
    `<rect x="${n(x - 11)}" y="${n(y - 14)}" width="22" height="26" rx="3" fill="#E8453C" ${S2}/>` +
    `<text x="${n(x)}" y="${n(y + 6)}" font-size="17" font-weight="900" text-anchor="middle" fill="#FFD84D" font-family="PingFang SC, Microsoft YaHei, sans-serif">福</text>`
  );
}

/** 破碗（穷神） */
function brokenBowl(x: number, y: number): string {
  return (
    path(`M${n(x - 11)} ${n(y - 3)} Q${n(x)} ${n(y + 12)} ${n(x + 11)} ${n(y - 3)} Z`, '#9A8F80', S2) +
    `<path d="M${n(x + 2)} ${n(y - 3)} L${n(x - 1)} ${n(y + 2)} L${n(x + 3)} ${n(y + 5)}" fill="none" stroke="${INK}" stroke-width="1.5"/>`
  );
}

/** 补丁（穷神的衣服） */
function patches(sk: Skeleton): string {
  return (
    `<rect x="${CX - 12}" y="${sk.torsoTop + 12}" width="8" height="7" fill="#B59A74" ${S2} transform="rotate(-12 ${CX - 8} ${sk.torsoTop + 15})"/>` +
    `<rect x="${CX + 4}" y="${sk.torsoBottom - 12}" width="7" height="6" fill="#7E8AA0" ${S2} transform="rotate(10 ${CX + 7} ${sk.torsoBottom - 9})"/>`
  );
}

/** 乌云 + 雨滴（衰神头顶） */
function rainCloud(sk: Skeleton): string {
  const { headCx: cx, headCy: cy, headR: r } = sk;
  const y = cy - r * 1.45;
  let s = '';
  s += ellipse(cx - 12, y + 2, 13, 9, '#6E6A7E', S2);
  s += ellipse(cx + 10, y + 1, 14, 10, '#6E6A7E', S2);
  s += ellipse(cx, y - 5, 13, 10, '#7E7A90', S2);
  for (const dx of [-14, -3, 8, 18]) {
    s += `<path d="M${n(cx + dx)} ${n(y + 12)} l-2 6" stroke="#7FD3FF" stroke-width="2.5" stroke-linecap="round"/>`;
  }
  return s;
}

/** 天使光圈 */
function haloRing(sk: Skeleton): string {
  const { headCx: cx, headCy: cy, headR: r } = sk;
  return ellipse(cx, cy - r * 1.18, r * 0.62, r * 0.18, 'none', `stroke="#FFD84D" stroke-width="5"`);
}

/** 天使翅膀（身后） */
function angelWings(sk: Skeleton): string {
  const y = sk.torsoTop + 8;
  const wing = (dir: -1 | 1): string =>
    path(
      `M${CX + dir * 8} ${y} Q${CX + dir * 44} ${y - 30} ${CX + dir * 50} ${y - 6} Q${CX + dir * 46} ${y + 6} ${CX + dir * 36} ${y + 10} Q${CX + dir * 40} ${y + 20} ${CX + dir * 26} ${y + 24} Q${CX + dir * 18} ${y + 22} ${CX + dir * 8} ${y + 14} Z`,
      '#FFFFFF',
    );
  return wing(-1) + wing(1);
}

/** 恶魔蝙蝠翅（身后） */
function batWings(sk: Skeleton): string {
  const y = sk.torsoTop + 6;
  const wing = (d: -1 | 1): string =>
    path(
      `M${CX + d * 8} ${y} L${CX + d * 50} ${y - 22} L${CX + d * 44} ${y + 2} L${CX + d * 36} ${y - 4} L${CX + d * 32} ${y + 12} L${CX + d * 22} ${y + 6} L${CX + d * 10} ${y + 16} Z`,
      '#5A2230',
    );
  return wing(-1) + wing(1);
}

/** 恶魔犄角 */
function horns(sk: Skeleton): string {
  const { headCx: cx, headCy: cy, headR: r } = sk;
  const y = cy - r * 0.72;
  return (
    path(
      `M${n(cx - r * 0.55)} ${n(y + 4)} Q${n(cx - r * 0.95)} ${n(y - 10)} ${n(cx - r * 0.7)} ${n(y - 20)} Q${n(cx - r * 0.45)} ${n(y - 6)} ${n(cx - r * 0.25)} ${n(y + 2)} Z`,
      '#F5E6C8',
    ) +
    path(
      `M${n(cx + r * 0.55)} ${n(y + 4)} Q${n(cx + r * 0.95)} ${n(y - 10)} ${n(cx + r * 0.7)} ${n(y - 20)} Q${n(cx + r * 0.45)} ${n(y - 6)} ${n(cx + r * 0.25)} ${n(y + 2)} Z`,
      '#F5E6C8',
    )
  );
}

/** 三叉戟（恶魔）；握在右手 */
function trident(L: Limbs): string {
  const x = L.handR.x + 2;
  const y = L.handR.y;
  let s = limb(x, y + 14, x + 4, y - 34, '#8A8F99', 3);
  s += `<path d="M${n(x - 4)} ${n(y - 30)} L${n(x - 3)} ${n(y - 42)} M${n(x + 4)} ${n(y - 34)} L${n(x + 5)} ${n(y - 48)} M${n(x + 12)} ${n(y - 30)} L${n(x + 13)} ${n(y - 42)} M${n(x - 4)} ${n(y - 30)} Q${n(x + 4)} ${n(y - 24)} ${n(x + 12)} ${n(y - 30)}" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>`;
  return s;
}

/** 土地公的拐杖（挂葫芦） */
function cane(L: Limbs): string {
  const x = L.handR.x + 1;
  const y = L.handR.y;
  let s = limb(x, y - 18, x + 3, y + 30, '#8A5A2B', 4);
  s += `<path d="M${n(x - 6)} ${n(y - 22)} Q${n(x)} ${n(y - 30)} ${n(x + 6)} ${n(y - 20)}" fill="none" stroke="${INK}" stroke-width="7" stroke-linecap="round"/>`;
  s += `<path d="M${n(x - 6)} ${n(y - 22)} Q${n(x)} ${n(y - 30)} ${n(x + 6)} ${n(y - 20)}" fill="none" stroke="#8A5A2B" stroke-width="4" stroke-linecap="round"/>`;
  s += circle(x - 7, y - 12, 4.5, '#E8A13C', S2) + circle(x - 7, y - 4, 6, '#E8A13C', S2);
  return s;
}

/** 土地公 / 医生的软帽 */
function softCap(sk: Skeleton, color: string): string {
  const { headCx: cx, headCy: cy, headR: r } = sk;
  const y = cy - r * 0.55;
  return path(
    `M${n(cx - r * 0.85)} ${n(y + 4)} Q${n(cx - r * 0.8)} ${n(y - r * 0.7)} ${n(cx)} ${n(y - r * 0.72)} Q${n(cx + r * 0.8)} ${n(y - r * 0.7)} ${n(cx + r * 0.85)} ${n(y + 4)} Q${n(cx)} ${n(y - 4)} ${n(cx - r * 0.85)} ${n(y + 4)} Z`,
    color,
  );
}

/** 死神镰刀 */
function scythe(L: Limbs): string {
  const x = L.handR.x + 2;
  const y = L.handR.y;
  let s = limb(x - 2, y + 30, x + 4, y - 40, '#5A4A3A', 3.5);
  s += path(
    `M${n(x + 4)} ${n(y - 40)} Q${n(x - 22)} ${n(y - 52)} ${n(x - 40)} ${n(y - 30)} Q${n(x - 18)} ${n(y - 40)} ${n(x + 4)} ${n(y - 32)} Z`,
    '#D8DCE6',
  );
  return s;
}

/** 眼罩（小偷） */
function eyeMask(sk: Skeleton): string {
  const y = sk.headCy + sk.headR * 0.18;
  const cx = sk.headCx;
  const r = sk.headR;
  return (
    `<rect x="${n(cx - r * 0.95)}" y="${n(y - 6)}" width="${n(r * 1.9)}" height="12" rx="6" fill="#1F1A17" ${S2}/>` +
    circle(cx - r * 0.36, y, 3.4, '#FFFFFF', 'stroke="none"') +
    circle(cx + r * 0.36, y, 3.4, '#FFFFFF', 'stroke="none"') +
    circle(cx - r * 0.36, y, 1.6, INK, 'stroke="none"') +
    circle(cx + r * 0.36, y, 1.6, INK, 'stroke="none"')
  );
}

/** 蒙面巾（强盗，遮住口鼻） */
function faceScarf(sk: Skeleton): string {
  const { headCx: cx, headCy: cy, headR: r } = sk;
  const y = cy + r * 0.32;
  return path(
    `M${n(cx - r * 0.92)} ${n(y)} Q${n(cx)} ${n(y - 5)} ${n(cx + r * 0.92)} ${n(y)} Q${n(cx + r * 0.7)} ${n(y + r * 0.62)} ${n(cx)} ${n(y + r * 0.8)} Q${n(cx - r * 0.7)} ${n(y + r * 0.62)} ${n(cx - r * 0.92)} ${n(y)} Z`,
    '#C0392B',
  );
}

/** 墨镜（流氓、间谍） */
function sunglasses(sk: Skeleton): string {
  const y = sk.headCy + sk.headR * 0.16;
  const cx = sk.headCx;
  const dx = sk.headR * 0.37;
  return (
    ellipse(cx - dx, y, 8.5, 6, '#1F1A17', S2) +
    ellipse(cx + dx, y, 8.5, 6, '#1F1A17', S2) +
    `<line x1="${n(cx - dx + 8)}" y1="${n(y - 1)}" x2="${n(cx + dx - 8)}" y2="${n(y - 1)}" stroke="${INK}" stroke-width="2.5"/>` +
    `<path d="M${n(cx - dx - 4)} ${n(y - 2)} l3 -2" stroke="#FFFFFF" stroke-width="1.6" stroke-linecap="round"/>`
  );
}

/** 麻袋（小偷，背在身后） */
function sack(sk: Skeleton): string {
  const x = CX + 20;
  const y = sk.torsoTop + 10;
  return (
    path(
      `M${x - 12} ${y + 22} Q${x - 16} ${y - 2} ${x} ${y - 6} Q${x + 16} ${y - 2} ${x + 12} ${y + 22} Q${x} ${y + 28} ${x - 12} ${y + 22} Z`,
      '#C9A060',
    ) +
    `<text x="${x}" y="${y + 16}" font-size="12" font-weight="900" text-anchor="middle" fill="${INK}" font-family="Arial Black, Arial, sans-serif">$</text>`
  );
}

/** 木棒（强盗） */
function club(L: Limbs): string {
  const x = L.handR.x;
  const y = L.handR.y;
  return limb(x, y + 6, x + 10, y - 22, '#8A5A2B', 6) + circle(x + 11, y - 24, 6, '#8A5A2B', S2);
}

/** 牙签（流氓） */
function toothpick(sk: Skeleton): string {
  const y = sk.headCy + sk.headR * 0.55;
  return `<line x1="${n(sk.headCx + 4)}" y1="${n(y + 1)}" x2="${n(sk.headCx + 16)}" y2="${n(y - 3)}" stroke="#E8C872" stroke-width="2.5" stroke-linecap="round"/>`;
}

/** 麦克风（新闻主播） */
function microphone(L: Limbs): string {
  const x = L.handR.x;
  const y = L.handR.y;
  return limb(x, y + 2, x + 2, y - 14, '#2A2A2A', 3) + circle(x + 2, y - 18, 5.5, '#8A8F99', S2);
}

/** 领带 */
function tie(sk: Skeleton, color: string): string {
  return poly(
    [
      [CX - 3, sk.torsoTop + 1],
      [CX + 3, sk.torsoTop + 1],
      [CX + 4, sk.torsoTop + 18],
      [CX, sk.torsoTop + 23],
      [CX - 4, sk.torsoTop + 18],
    ],
    color,
    S2,
  );
}

/** 女巫尖帽 */
function witchHat(sk: Skeleton): string {
  const { headCx: cx, headCy: cy, headR: r } = sk;
  const by = cy - r * 0.5;
  return (
    ellipse(cx, by + 2, r * 1.45, 7, '#3C2360') +
    path(
      `M${n(cx - r * 0.75)} ${n(by)} L${n(cx + r * 0.45)} ${n(by - r * 1.7)} L${n(cx + r * 0.75)} ${n(by)} Z`,
      '#3C2360',
    ) +
    `<path d="M${n(cx - r * 0.62)} ${n(by - 5)} L${n(cx + r * 0.66)} ${n(by - 5)}" stroke="#FFD84D" stroke-width="4"/>`
  );
}

/** 魔杖（女巫），杖头星星 */
function wand(L: Limbs): string {
  const x = L.handR.x;
  const y = L.handR.y;
  return limb(x, y + 3, x + 8, y - 20, '#6B4423', 2.5) + star(x + 9, y - 25, 7, '#FFE066');
}

/** 额镜 + 听诊器（医生） */
function doctorKit(sk: Skeleton, front: boolean): string {
  const { headCx: cx, headCy: cy, headR: r } = sk;
  let s = `<path d="M${n(cx - r * 0.95)} ${n(cy - r * 0.35)} Q${n(cx)} ${n(cy - r * 0.62)} ${n(cx + r * 0.95)} ${n(cy - r * 0.35)}" fill="none" stroke="${INK}" stroke-width="3"/>`;
  if (front) {
    s +=
      circle(cx - r * 0.25, cy - r * 0.52, 7, '#DDF6FF', S2) + circle(cx - r * 0.25, cy - r * 0.52, 2.5, '#FFFFFF', S2);
    s += `<path d="M${CX - 8} ${sk.torsoTop + 2} Q${CX - 10} ${sk.torsoTop + 18} ${CX} ${sk.torsoTop + 22} Q${CX + 10} ${sk.torsoTop + 18} ${CX + 8} ${sk.torsoTop + 2}" fill="none" stroke="#2A2A2A" stroke-width="2.5"/>`;
    s += circle(CX, sk.torsoTop + 23, 3.5, '#BFC5CF', S2);
  }
  return s;
}

/** 警徽（警察帽） */
function policeBadge(sk: Skeleton): string {
  return star(sk.headCx, sk.headCy - sk.headR * 0.62, 5.5, '#FFD84D');
}

// ───────────────────────── 神明 ─────────────────────────

function wealthGod(big: boolean): Omit<FigureDef, 'id'> {
  return {
    base: cfg(big ? 'bigWealth' : 'smallWealth', {
      build: big ? 'adult' : 'kid',
      skin: SKIN.light,
      hair: { style: 'short', color: '#1F1A17' },
      eyes: 'narrow',
      hat: { style: 'none', color: '#000000', accent: '#000000' },
      outfit: { style: 'robe', primary: '#D8342C', secondary: '#F4C542', legs: '#D8342C', shoes: '#1F1A17' },
      accessories: big ? ['mustache', 'beard'] : [],
      color: '#D8342C',
    }),
    front: ({ sk, front, L }) => officialHat(sk, front) + (front ? ingot(CX, (L.handL.y + L.handR.y) / 2 - 2) : ''),
  };
}

function fortuneGod(big: boolean): Omit<FigureDef, 'id'> {
  return {
    base: cfg(big ? 'bigFortune' : 'smallFortune', {
      build: big ? 'adult' : 'kid',
      skin: SKIN.tan,
      hair: { style: big ? 'bald' : 'topknot', color: '#F5F5F5' },
      eyes: 'dot',
      hat: { style: 'none', color: '#000000', accent: '#000000' },
      outfit: { style: 'robe', primary: '#F29B21', secondary: '#D8342C', legs: '#F29B21', shoes: '#6B4423' },
      accessories: big ? ['beard'] : [],
      color: '#F29B21',
    }),
    front: ({ front, L }) => (front ? fortuneScroll(L.handL.x + 4, L.handL.y - 6) : ''),
  };
}

function poorGod(big: boolean): Omit<FigureDef, 'id'> {
  return {
    base: cfg(big ? 'bigPoor' : 'smallPoor', {
      build: big ? 'adult' : 'kid',
      skin: SKIN.grey,
      hair: { style: 'curly', color: '#8A8F99' },
      eyes: 'dot',
      hat: { style: 'none', color: '#000000', accent: '#000000' },
      outfit: { style: 'tunic', primary: '#8C8F99', secondary: '#6E6E6E', legs: '#6E6E6E', shoes: '#5A4A3A' },
      accessories: big ? ['beard'] : [],
      color: '#8C8F99',
    }),
    front: ({ sk, front, L }) => (front ? patches(sk) + brokenBowl(L.handL.x, L.handL.y + 2) : ''),
  };
}

function misfortuneGod(big: boolean): Omit<FigureDef, 'id'> {
  return {
    base: cfg(big ? 'bigMisfortune' : 'smallMisfortune', {
      build: big ? 'adult' : 'kid',
      skin: SKIN.pale,
      hair: { style: 'long', color: '#3A2F4A' },
      eyes: 'narrow',
      hat: { style: 'none', color: '#000000', accent: '#000000' },
      outfit: { style: 'robe', primary: '#6B5B8A', secondary: '#3A2F4A', legs: '#6B5B8A', shoes: '#2A2A2A' },
      accessories: [],
      color: '#6B5B8A',
    }),
    front: ({ sk }) => rainCloud(sk),
  };
}

const GOD_DEFS: Readonly<Record<GodKind, Omit<FigureDef, 'id'>>> = {
  1: wealthGod(false),
  2: wealthGod(true),
  3: fortuneGod(false),
  4: fortuneGod(true),
  5: poorGod(false),
  6: poorGod(true),
  7: misfortuneGod(false),
  8: misfortuneGod(true),
  9: {
    base: cfg('angel', {
      build: 'kid',
      skin: SKIN.fair,
      hair: { style: 'long', color: '#F4C95D' },
      eyes: 'lashes',
      hat: { style: 'none', color: '#000000', accent: '#000000' },
      outfit: { style: 'gown', primary: '#FFFFFF', secondary: '#BFE8FF', legs: '#FFFFFF', shoes: '#F4C95D' },
      accessories: [],
      color: '#BFE8FF',
    }),
    behind: ({ sk }) => angelWings(sk),
    front: ({ sk }) => haloRing(sk),
  },
  10: {
    base: cfg('devil', {
      build: 'adult',
      skin: '#F2A08A',
      hair: { style: 'spiky', color: '#2A1E26' },
      eyes: 'narrow',
      hat: { style: 'none', color: '#000000', accent: '#000000' },
      outfit: { style: 'ninja', primary: '#3A1A24', secondary: '#C0392B', legs: '#3A1A24', shoes: '#1F1A17' },
      accessories: [],
      color: '#C0392B',
    }),
    behind: ({ sk }) => batWings(sk),
    front: ({ sk, L, front }) => horns(sk) + (front ? trident(L) : ''),
  },
  11: { base: null, custom: (pose, facing) => dogSvg(pose, facing) },
  12: {
    base: cfg('earthGod', {
      build: 'adult',
      skin: SKIN.tan,
      hair: { style: 'bald', color: '#F5F5F5' },
      eyes: 'dot',
      hat: { style: 'none', color: '#000000', accent: '#000000' },
      outfit: { style: 'robe', primary: '#8A5A2B', secondary: '#E8C872', legs: '#8A5A2B', shoes: '#3A2A1A' },
      accessories: ['mustache', 'beard'],
      color: '#8A5A2B',
    }),
    front: ({ sk, L, front }) => softCap(sk, '#6B4423') + (front ? cane(L) : ''),
  },
  15: {
    base: cfg('death', {
      build: 'adult',
      skin: SKIN.pale,
      hair: { style: 'bald', color: '#000000' },
      eyes: 'dot',
      hat: { style: 'hood', color: '#1F1A24', accent: '#5A4A6A' },
      outfit: { style: 'ninja', primary: '#1F1A24', secondary: '#5A4A6A', legs: '#1F1A24', shoes: '#1F1A24' },
      accessories: [],
      color: '#1F1A24',
    }),
    front: ({ L, front }) => (front ? scythe(L) : ''),
  },
};

// ───────────────────────── 四大恶人 ─────────────────────────

const VILLAIN_DEFS: Readonly<Record<VillainKind, Omit<FigureDef, 'id'>>> = {
  thief: {
    base: cfg('thief', {
      build: 'adult',
      skin: SKIN.light,
      hair: { style: 'short', color: '#2A1E26' },
      eyes: 'round',
      hat: { style: 'cap', color: '#2A2A2A', accent: '#2A2A2A' },
      outfit: { style: 'ninja', primary: '#3E4450', secondary: '#E8E8E8', legs: '#2A2A2A', shoes: '#1F1A17' },
      accessories: [],
      color: '#3E4450',
    }),
    behind: ({ sk }) => sack(sk),
    front: ({ sk, front }) => (front ? eyeMask(sk) : ''),
  },
  robber: {
    base: cfg('robber', {
      build: 'adult',
      skin: SKIN.tan,
      hair: { style: 'short', color: '#3A2A1A' },
      eyes: 'narrow',
      hat: { style: 'cowboy', color: '#2A2A2A', accent: '#C0392B' },
      outfit: { style: 'cowboy', primary: '#6B4423', secondary: '#3A2A1A', legs: '#3A3A4A', shoes: '#2A2A2A' },
      accessories: ['beard'],
      color: '#6B4423',
    }),
    front: ({ sk, L, front }) => (front ? faceScarf(sk) + club(L) : ''),
  },
  thug: {
    base: cfg('thug', {
      build: 'adult',
      skin: SKIN.tan,
      hair: { style: 'spiky', color: '#1F1A17' },
      eyes: 'narrow',
      hat: { style: 'none', color: '#000000', accent: '#000000' },
      outfit: { style: 'farmer', primary: '#F5F5F5', secondary: '#2A2A2A', legs: '#2A2A2A', shoes: '#F5F5F5' },
      accessories: ['goldChain'],
      color: '#2A2A2A',
    }),
    front: ({ sk, front }) => (front ? sunglasses(sk) + toothpick(sk) : ''),
  },
  spy: {
    base: cfg('spy', {
      build: 'adult',
      skin: SKIN.light,
      hair: { style: 'short', color: '#2A1E26' },
      eyes: 'narrow',
      hat: { style: 'cowboy', color: '#4A4A52', accent: '#1F1A17' },
      outfit: { style: 'robe', primary: '#C8A870', secondary: '#6B5842', legs: '#4A4A52', shoes: '#1F1A17' },
      accessories: [],
      color: '#C8A870',
    }),
    front: ({ sk, front }) => (front ? sunglasses(sk) : ''),
  },
};

// ───────────────────────── NPC ─────────────────────────

const NPC_DEFS: Readonly<Record<NpcId, Omit<FigureDef, 'id'>>> = {
  anchor: {
    base: cfg('anchor', {
      build: 'adult',
      skin: SKIN.fair,
      hair: { style: 'bob', color: '#4A2E22' },
      eyes: 'lashes',
      hat: { style: 'none', color: '#000000', accent: '#000000' },
      outfit: { style: 'robe', primary: '#2C3E7A', secondary: '#FFFFFF', legs: '#2C3E7A', shoes: '#1F1A17' },
      accessories: [],
      color: '#2C3E7A',
    }),
    front: ({ sk, L, front }) => (front ? tie(sk, '#E8453C') + microphone(L) : ''),
  },
  witch: {
    base: cfg('witch', {
      build: 'adult',
      skin: '#E8F0D0',
      hair: { style: 'long', color: '#C9CCD6' },
      eyes: 'lashes',
      hat: { style: 'none', color: '#000000', accent: '#000000' },
      outfit: { style: 'gown', primary: '#6A3FA0', secondary: '#2A1E36', legs: '#6A3FA0', shoes: '#2A1E36' },
      accessories: [],
      color: '#6A3FA0',
    }),
    front: ({ sk, L, front }) => witchHat(sk) + (front ? wand(L) : ''),
  },
  doctor: {
    base: cfg('doctor', {
      build: 'adult',
      skin: SKIN.light,
      hair: { style: 'short', color: '#4A3A2A' },
      eyes: 'round',
      hat: { style: 'none', color: '#000000', accent: '#000000' },
      outfit: { style: 'robe', primary: '#FFFFFF', secondary: '#BFE8FF', legs: '#9DB8D8', shoes: '#FFFFFF' },
      accessories: [],
      color: '#FFFFFF',
    }),
    front: ({ sk, front }) => doctorKit(sk, front),
  },
  police: {
    base: cfg('police', {
      build: 'adult',
      skin: SKIN.light,
      hair: { style: 'short', color: '#1F1A17' },
      eyes: 'narrow',
      hat: { style: 'cap', color: '#1F3A6E', accent: '#1F3A6E' },
      outfit: { style: 'tunic', primary: '#2F5DA8', secondary: '#FFD84D', legs: '#1F3A6E', shoes: '#1F1A17' },
      accessories: [],
      color: '#2F5DA8',
    }),
    front: ({ sk, front }) => (front ? policeBadge(sk) + tie(sk, '#1F3A6E') : ''),
  },
};

// ───────────────────────── 恶犬（非人形） ─────────────────────────

function dogSvg(pose: Pose, facing: Facing): string {
  const walk = pose.startsWith('walk');
  const bob = pose === 'walk0' || pose === 'walk2' ? -2 : pose === 'hurt' ? 2 : 0;
  const legA = walk && (pose === 'walk0' || pose === 'walk2') ? 5 : 0;
  const y0 = 150;
  let s = '';
  s += ellipse(64, y0 - 1, 34, 6, 'rgba(0,0,0,0.18)', 'stroke="none"');
  // 腿
  const leg = (x: number, d: number): string =>
    limb(x, y0 - 30, x + d, y0 - 4, '#A0643C', 7) + ellipse(x + d, y0 - 3, 6, 4, '#7A4A2A');
  s += leg(42, legA) + leg(52, -legA) + leg(78, legA) + leg(88, -legA);
  // 尾巴
  s += `<path d="M96 ${y0 - 42} Q112 ${y0 - 58} 106 ${y0 - 70}" fill="none" stroke="${INK}" stroke-width="9" stroke-linecap="round"/><path d="M96 ${y0 - 42} Q112 ${y0 - 58} 106 ${y0 - 70}" fill="none" stroke="#A0643C" stroke-width="5" stroke-linecap="round"/>`;
  // 身体
  s += ellipse(66, y0 - 40, 32, 18, '#A0643C');
  s += ellipse(66, y0 - 34, 20, 9, '#E8C8A0', 'stroke="none"');
  if (facing === 'front') {
    // 头 + 耳朵 + 口鼻
    s += path(`M24 ${y0 - 78} L18 ${y0 - 96} L34 ${y0 - 84} Z`, '#7A4A2A');
    s += path(`M50 ${y0 - 84} L56 ${y0 - 100} L60 ${y0 - 80} Z`, '#7A4A2A');
    s += circle(38, y0 - 66, 20, '#A0643C');
    s += ellipse(30, y0 - 56, 13, 9, '#E8C8A0');
    s += circle(22, y0 - 60, 4, INK, 'stroke="none"');
    // 凶眉 + 眼
    s += `<path d="M30 ${y0 - 76} L40 ${y0 - 72} M44 ${y0 - 72} L52 ${y0 - 77}" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>`;
    s += circle(36, y0 - 68, 3, INK, 'stroke="none"') + circle(48, y0 - 68, 3, INK, 'stroke="none"');
    // 獠牙嘴
    s += `<path d="M22 ${y0 - 50} Q30 ${y0 - 44} 38 ${y0 - 50}" fill="#C0392B" ${S2}/>`;
    s += poly(
      [
        [26, y0 - 49],
        [28, y0 - 45],
        [30, y0 - 49],
      ],
      '#FFFFFF',
      'stroke="none"',
    );
  } else {
    s += circle(40, y0 - 66, 20, '#8A5432');
    s += path(`M26 ${y0 - 80} L22 ${y0 - 98} L38 ${y0 - 84} Z`, '#7A4A2A');
    s += path(`M48 ${y0 - 84} L56 ${y0 - 100} L58 ${y0 - 80} Z`, '#7A4A2A');
  }
  // 刺项圈
  s += `<path d="M24 ${y0 - 50} Q40 ${y0 - 40} 56 ${y0 - 52}" fill="none" stroke="#C0392B" stroke-width="6" stroke-linecap="round"/>`;
  for (const x of [30, 40, 50]) {
    s += poly(
      [
        [x - 3, y0 - 46],
        [x, y0 - 38],
        [x + 3, y0 - 46],
      ],
      '#D8DCE6',
      S2,
    );
  }
  if (pose === 'cast' || pose === 'hurt') {
    s += `<text x="8" y="${y0 - 90}" font-size="16" font-weight="900" fill="#FFFFFF" stroke="${INK}" stroke-width="3" paint-order="stroke" font-family="Arial Black, Arial, sans-serif">!!</text>`;
  }
  return `<g transform="translate(0 ${bob})">${s}</g>`;
}

// ───────────────────────── 合成 ─────────────────────────

function wrap(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" width="${VIEW_W}" height="${VIEW_H}">${body}</svg>`;
}

/** 去掉 characterSvg 的 <svg> 外壳，得到可嵌入的内容 */
export function innerSvg(svg: string): string {
  return svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
}

function defOf(id: FigureId): FigureDef {
  const [group, key] = id.split(':') as [string, string];
  if (group === 'god') {
    const kind = Number(key) as GodKind;
    const d = GOD_DEFS[kind];
    if (!d) throw new Error(`unknown god ${key}`);
    return { id, ...d };
  }
  if (group === 'villain') {
    const d = VILLAIN_DEFS[key as VillainKind];
    if (!d) throw new Error(`unknown villain ${key}`);
    return { id, ...d };
  }
  const d = NPC_DEFS[key as NpcId];
  if (!d) throw new Error(`unknown figure ${id}`);
  return { id, ...d };
}

/** 人形造型的 rig 配置（恶犬为 null） */
export function figureConfig(id: FigureId): CharacterConfig | null {
  return defOf(id).base;
}

/** 身体内容（不含外壳）：身后标志物 + rig 身体 + 身前标志物 */
function bodyInner(d: FigureDef, pose: Pose, facing: Facing): string {
  if (!d.base) return d.custom?.(pose, facing) ?? '';
  const sk = SKELETONS[d.base.build];
  const spec = POSE_SPECS[pose];
  const L = limbPositions(sk, spec);
  const ctx: OverlayCtx = { sk, L, pose, facing, front: facing === 'front' };
  const bob = spec.bob !== 0 ? `translate(0 ${n(spec.bob)})` : undefined;
  const g = (s: string): string => (bob ? `<g transform="${bob}">${s}</g>` : s);
  return g(d.behind?.(ctx) ?? '') + innerSvg(characterSvg(d.base, pose, facing)) + g(d.front?.(ctx) ?? '');
}

/** 行走 / 站立造型（恶人、NPC 与恶犬；神明也可用，但路上神明请用 godSvg） */
export function figureSvg(id: FigureId, pose: Pose = 'idle0', facing: Facing = 'front'): string {
  return wrap(bodyInner(defOf(id), pose, facing));
}

/** 神明：柔光 + 云朵 + 缩小的身体（大神比小神大）；恶犬没有云 */
export function godSvg(kind: GodKind, pose: Pose = 'idle0'): string {
  const d = defOf(`god:${kind}`);
  const pal = GOD_PALETTES[kind];
  if (kind === 11) return wrap(bodyInner(d, pose, 'front'));
  const k = pal.big ? 0.86 : 0.72;
  let s = '';
  s += `<ellipse cx="64" cy="84" rx="${n(58 * k)}" ry="${n(70 * k)}" fill="${pal.auraCss}" opacity="0.4"/>`;
  s += `<g transform="translate(64 138) scale(${k}) translate(-64 -150)">${bodyInner(d, pose, 'front')}</g>`;
  // 云朵
  s += ellipse(64, 146, 40 * k + 6, 9, '#FFFFFF', S2);
  s += ellipse(64 - 26 * k, 143, 14 * k + 3, 8, '#FFFFFF', S2);
  s += ellipse(64 + 26 * k, 143, 14 * k + 3, 8, '#FFFFFF', S2);
  if (pose === 'cheer' || pose === 'cast') s += sparkle(104, 40, 8) + sparkle(24, 56, 6);
  return wrap(s);
}

/** 画廊与弹窗用的全部造型键 */
export function allFigureIds(): FigureId[] {
  const gods = (Object.keys(GOD_KEYS).map(Number) as GodKind[]).map((k) => `god:${k}` as const);
  const villains = VILLAIN_KINDS.map((k) => `villain:${k}` as const);
  const npcs = NPC_IDS.map((k) => `npc:${k}` as const);
  return [...gods, ...villains, ...npcs];
}

/** 造型的 SVG（神明用 godSvg，其余用 figureSvg） */
export function anyFigureSvg(id: FigureId, pose: Pose = 'idle0'): string {
  if (id.startsWith('god:')) return godSvg(Number(id.slice(4)) as GodKind, pose);
  return figureSvg(id, pose);
}

/** 统一描边常量（外部少量自绘时对齐风格） */
export const FIGURE_STROKE = S;
