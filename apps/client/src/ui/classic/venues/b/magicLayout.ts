// 魔法屋（Panel#18 图集、Panel#19 命中掩膜、Panel#20 施法 FLC；ui.md §2.3）的布局常量与纯函数。
// 坐标来源（本机真实素材包，test/w3-venueb-*.mjs 统计；只有目视依据的标 visual）：
// - 12 个效果图标的画点：在底图（图0）上按梯度相关找暗图标的位置（效果 e 的图标是图 23+e，落在掩膜区 e+1）；
// - 掩膜 13 区：1–12 从正上方的星角起顺时针（奇数为星角、偶数为星角之间的外圈），13 为中心六边形（女巫）；
// - 女巫（图1）画点 (242,140)：与施法 FLC 首帧里施法女巫（图2，(182,142)，逐像素贴合）底边对齐、水晶球同一竖线（visual）；
// - 脸部小图：图3 眨眼 (+45,+48)、图5 张嘴 (+45,+77)（相对图1，逐像素贴合）；
// - 条件图标（图 11+条件）画在水晶球里（visual）。
import type { MagicConditionId, MagicEffectId } from '@rich4/shared/engine';
import type { Rect } from '../../layout';

export const MAGIC_SHEET = 'venue.magic.screen';
export const MAGIC_MASK = 'venue.magic.mask';
export const MAGIC_CAST_FLC = 'venue.magic.cast';

export const MAGIC_FRAME = {
  bg: 0,
  witch: 1,
  witchCast: 2,
  eyes: 3,
  mouth: 4,
  mouthOpen: 5,
  /** 提示框：尾巴在右下 / 左下 / 右上 / 左上 */
  hintBR: 6,
  hintBL: 7,
  card: 8,
  hintTR: 9,
  hintTL: 10,
  /** 条件图标 = 11 + 条件 */
  cond0: 11,
  /** 效果图标 = 23 + 效果 */
  effect0: 23,
} as const;

/** 效果 e 的图标画点（锚点落点） */
export const MAGIC_ICON_AT: readonly (readonly [number, number])[] = [
  [322, 91],
  [414, 82],
  [453, 157],
  [509, 242],
  [458, 314],
  [415, 387],
  [322, 394],
  [239, 393],
  [188, 316],
  [131, 222],
  [184, 161],
  [225, 83],
];

export const WITCH_AT = { x: 242, y: 140 } as const;
export const WITCH_FACE = {
  eyes: { x: 45, y: 48 },
  mouthOpen: { x: 45, y: 77 },
} as const;
/** 水晶球中心（条件图标的画点） */
export const BALL_AT = { x: 324, y: 306 } as const;

/** 提示框尺寸与尾巴尖（框内坐标） */
export const HINT = {
  w: 142,
  h: 120,
  /** 文字区（框内） */
  text: { x: 22, y: 22, w: 96, h: 76 },
  tips: {
    [MAGIC_FRAME.hintBR]: { x: 137, y: 118 },
    [MAGIC_FRAME.hintBL]: { x: 3, y: 118 },
    [MAGIC_FRAME.hintTR]: { x: 138, y: 2 },
    [MAGIC_FRAME.hintTL]: { x: 2, y: 2 },
  } as Readonly<Record<number, { x: number; y: number }>>,
} as const;

/** 效果按钮（键盘焦点框、无掩膜时的命中范围）：图标画点为中心的 56×56，互不重叠 */
export const EFFECT_BUTTON = 56;

/** 条件讲话框（ui.common 图3：尾巴在右下，锚点 = 尾巴尖）的画点：左上角，尾巴指向女巫 */
export const COND_BUBBLE_AT = { x: 150, y: 124 } as const;

/** 确认框（YES/NO 消息框）画点：中心六边形里、盖住女巫 */
export const CONFIRM_AT = { x: 320, y: 241 } as const;

export function effectRegion(e: MagicEffectId): number {
  return e + 1;
}

export function regionEffect(region: number): MagicEffectId | null {
  return region >= 1 && region <= 12 ? ((region - 1) as MagicEffectId) : null;
}

export function effectFrame(e: MagicEffectId): number {
  return MAGIC_FRAME.effect0 + e;
}

export function conditionFrame(c: MagicConditionId): number {
  return MAGIC_FRAME.cond0 + c;
}

export function effectButtonRect(e: MagicEffectId): Rect {
  const [x, y] = MAGIC_ICON_AT[e]!;
  const h = EFFECT_BUTTON / 2;
  return { x: x - h, y: y - h, w: EFFECT_BUTTON, h: EFFECT_BUTTON };
}

/**
 * 提示框的帧与左上角：图标在上半 → 框在下方（尾巴朝上），在下半 → 框在上方；在左半 → 框在右侧，右半 → 左侧。
 * 尾巴尖离图标中心 18px；框夹在场景里。
 */
export function hintPlacement(e: MagicEffectId): { frame: number; x: number; y: number } {
  const [ix, iy] = MAGIC_ICON_AT[e]!;
  const upper = iy < 240;
  const left = ix < 320;
  const frame = upper
    ? left
      ? MAGIC_FRAME.hintTL
      : MAGIC_FRAME.hintTR
    : left
      ? MAGIC_FRAME.hintBL
      : MAGIC_FRAME.hintBR;
  const tip = HINT.tips[frame]!;
  const tx = ix + (left ? 18 : -18);
  const ty = iy + (upper ? 18 : -18);
  const x = Math.max(0, Math.min(640 - HINT.w, tx - tip.x));
  const y = Math.max(0, Math.min(480 - HINT.h, ty - tip.y));
  return { frame, x, y };
}
