// 角色 SVG 合成（design/client.md §6.2）：characterSvg(cfg, pose, facing) → 128×160 的 SVG 字符串。
// 正面图朝 SE、背面图朝 NE；另外两个方向由 Pixi 精灵 scale.x=-1 镜像得到。
// 分层顺序（正面）：后层头发 → 腿 → 躯干 → 胸前配饰 → 手臂 → 手持道具 → 脖子 → 头 → 五官 → 前层头发 → 帽子 → 嘴上道具 → 特效。
import { type CharacterConfig, GOD_LOOKS, type GodLook } from './defs';
import { armsSvg, legsSvg, limbPositions, neckSvg, torsoSvg } from './parts/body';
import { circle, ellipse, group, path, S, S2 } from './parts/common';
import { fxSvg } from './parts/fx';
import { hairBackSvg, hairBackViewSvg, hairFrontSvg } from './parts/hair';
import { chestAccessoriesSvg, handPropsSvg, hatSvg, mouthPropsSvg } from './parts/hats';
import { faceSvg, headBaseSvg } from './parts/head';
import { type Expression, type Facing, INK, n, POSE_SPECS, type Pose, SKELETONS, VIEW_H, VIEW_W } from './rig';

function wrap(body: string, w = VIEW_W, h = VIEW_H): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`;
}

/** 角色全身 */
export function characterSvg(c: CharacterConfig, pose: Pose, facing: Facing): string {
  const sk = SKELETONS[c.build];
  const p = POSE_SPECS[pose];
  const L = limbPositions(sk, p);
  const front = facing === 'front';
  const headTf = p.headTilt !== 0 ? `rotate(${n(p.headTilt)} ${sk.headCx} ${sk.neckY})` : undefined;

  let head = '';
  if (front) {
    head += headBaseSvg(c, sk);
    head += faceSvg(c, sk, p.expression);
    head += hairFrontSvg(c, sk);
    head += hatSvg(c, sk, 'front', p.expression);
    head += mouthPropsSvg(c, sk);
  } else {
    head += headBaseSvg(c, sk);
    head += hairBackViewSvg(c, sk);
    head += hatSvg(c, sk, 'back');
  }

  let body = '';
  if (front) body += group(hairBackSvg(c, sk), headTf);
  body += legsSvg(c, sk, L);
  body += torsoSvg(c, sk, facing);
  body += chestAccessoriesSvg(c, sk, facing);
  body += armsSvg(c, sk, L);
  if (front) body += handPropsSvg(c, L);
  body += neckSvg(c, sk);
  body += group(head, headTf);
  body += fxSvg(front ? p.fx : p.fx === 'tear' ? 'none' : p.fx, sk, L);

  return wrap(group(body, p.bob !== 0 ? `translate(0 ${n(p.bob)})` : undefined));
}

/** 表情 → 头像用姿势（复用五官） */
const EXPR_POSE: Readonly<Record<Expression, Pose>> = {
  normal: 'idle0',
  happy: 'cheer',
  sad: 'sad',
  angry: 'cast',
  shock: 'hurt',
  sleep: 'sleep',
};

/** 256×256 胸像（HUD 头像用），背景为角色代表色的圆 */
export function portraitSvg(c: CharacterConfig, expr: Expression = 'normal'): string {
  const sk = SKELETONS[c.build];
  const p = { ...POSE_SPECS[EXPR_POSE[expr]], armL: 8, armR: -8, headTilt: 0, fx: 'none' as const };
  const L = limbPositions(sk, p);
  let inner = '';
  inner += hairBackSvg(c, sk);
  inner += torsoSvg(c, sk, 'front');
  inner += chestAccessoriesSvg(c, sk, 'front');
  inner += armsSvg(c, sk, L);
  inner += neckSvg(c, sk);
  inner += headBaseSvg(c, sk);
  inner += faceSvg(c, sk, p.expression);
  inner += hairFrontSvg(c, sk);
  inner += hatSvg(c, sk, 'front', p.expression);
  inner += mouthPropsSvg(c, sk);
  // 以头部为中心放大 2 倍
  const scale = 2.2;
  const tx = 128 - sk.headCx * scale;
  const ty = 118 - sk.headCy * scale;
  const bg = `<circle cx="128" cy="128" r="122" fill="${c.color}" opacity="0.35"/><circle cx="128" cy="128" r="122" fill="none" stroke="${INK}" stroke-width="6"/>`;
  const clip = `<clipPath id="pc"><circle cx="128" cy="128" r="119"/></clipPath>`;
  return wrap(
    `<defs>${clip}</defs>${bg}<g clip-path="url(#pc)"><g transform="translate(${n(tx)} ${n(ty)}) scale(${scale})">${inner}</g></g>`,
    256,
    256,
  );
}

/** 神明占位图：光环 + 云朵 + 长袍小人 + 字符 */
export function godPlaceholderSvg(g: GodLook): string {
  const k = g.big ? 1 : 0.78;
  const cx = 64;
  let s = '';
  s += `<ellipse cx="${cx}" cy="80" rx="${n(56 * k)}" ry="${n(62 * k)}" fill="${g.aura}" opacity="0.45"/>`;
  s += ellipse(cx, 140, 44 * k, 12 * k, '#FFFFFF', S2);
  s += ellipse(cx - 26 * k, 136, 16 * k, 10 * k, '#FFFFFF', S2);
  s += ellipse(cx + 26 * k, 136, 16 * k, 10 * k, '#FFFFFF', S2);
  s += path(
    `M${n(cx - 26 * k)} ${n(134)} Q${n(cx - 30 * k)} ${n(92)} ${n(cx)} ${n(84)} Q${n(cx + 30 * k)} ${n(92)} ${n(cx + 26 * k)} ${n(134)} Z`,
    g.robe,
  );
  s += circle(cx, 62, 26 * k, '#FFE0C2');
  s += `<path d="M${n(cx - 9)} 62 Q${cx - 5} 57 ${n(cx - 1)} 62 M${n(cx + 1)} 62 Q${cx + 5} 57 ${n(cx + 9)} 62" fill="none" ${S}/>`;
  s += `<path d="M${cx - 5} 72 Q${cx} 77 ${cx + 5} 72" fill="none" ${S}/>`;
  s += ellipse(cx, 62 - 26 * k - 4, 18 * k, 5 * k, 'none', `stroke="#FFD84D" stroke-width="4"`);
  s += `<text x="${cx}" y="${n(122 - 4 * (1 - k))}" font-size="${n(22 * k)}" font-weight="700" text-anchor="middle" fill="#FFFFFF" stroke="${INK}" stroke-width="3" paint-order="stroke" font-family="PingFang SC, Microsoft YaHei, sans-serif">${g.symbol}</text>`;
  return wrap(s);
}

export function allGodSvgs(): { key: string; svg: string }[] {
  return GOD_LOOKS.map((g) => ({ key: g.key, svg: godPlaceholderSvg(g) }));
}

/** SVG 字符串 → data URL（DOM 画廊、HUD 头像用） */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
