// 热区命中的纯函数（design-draft §4.3「热区有两种：矩形，以及掩膜」）：坐标一律是热区容器坐标（= 掩膜像素）。
import { type MaskAsset, maskRegion } from '../assets';
import type { Rect } from '../layout';
import { inRect } from './stage';

export interface HotspotShape {
  id: string;
  /** 热区矩形（容器坐标）；有掩膜时是该区号的包围盒（键盘焦点框、无掩膜时的命中范围） */
  rect: Rect;
  /** 掩膜区号（给出且掩膜可用时按像素判定） */
  region?: number;
  disabled?: boolean;
}

/**
 * 点 (x, y) 落在哪个热区：
 * - 掩膜可用且热区带区号 → 按像素区号找（区号没有对应热区 → null）；
 * - 否则按矩形，后面的热区在上层（与 DOM 叠放一致）。
 */
export function spotAt<T extends HotspotShape>(
  spots: readonly T[],
  mask: MaskAsset | null,
  x: number,
  y: number,
): T | null {
  if (mask && spots.some((s) => s.region !== undefined)) {
    const r = maskRegion(mask, x, y);
    if (r !== 0) {
      const hit = spots.find((s) => s.region === r);
      if (hit) return hit;
    }
    // 掩膜外、或区号没登记：只看不带区号的矩形热区
    for (let i = spots.length - 1; i >= 0; i--) {
      const s = spots[i]!;
      if (s.region === undefined && inRect(s.rect, x, y)) return s;
    }
    return null;
  }
  for (let i = spots.length - 1; i >= 0; i--) {
    const s = spots[i]!;
    if (inRect(s.rect, x, y)) return s;
  }
  return null;
}

/** 屏幕坐标 → 容器坐标（容器随舞台 transform 缩放：按实际像素尺寸与逻辑尺寸之比换算）；量不到尺寸时为 null */
export function localPoint(
  box: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
  w: number,
  h: number,
): { x: number; y: number } | null {
  if (!(box.width > 0) || !(box.height > 0)) return null;
  return { x: ((clientX - box.left) * w) / box.width, y: ((clientY - box.top) * h) / box.height };
}

/**
 * 点了热区 own 的按钮之后，真正要触发哪个热区：
 * - 没有指针坐标（键盘触发）→ own；
 * - 掩膜命中某个热区 → 它（包围盒相互重叠的不规则区域，以像素为准）；
 * - 掩膜判定为空白：落在 own 自己的矩形里 → 不触发（精确命中）；落在矩形外（手机的扩展热区）→ own。
 * 被禁用的热区不触发。
 */
export function resolveActivation<T extends HotspotShape>(
  spots: readonly T[],
  mask: MaskAsset | null,
  own: T,
  local: { x: number; y: number } | null,
): T | null {
  const ok = (s: T | null): T | null => (s && !s.disabled ? s : null);
  if (!local) return ok(own);
  if (!mask || own.region === undefined) return ok(own);
  const hit = spotAt(spots, mask, local.x, local.y);
  if (hit) return ok(hit);
  return inRect(own.rect, local.x, local.y) ? null : ok(own);
}

/** 掩膜里每个区号的包围盒（诊断、测试；区号 0 不计） */
export function regionBoxes(mask: MaskAsset): Map<number, Rect> {
  const acc = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      const v = mask.data[y * mask.w + x]!;
      if (v === 0) continue;
      const b = acc.get(v);
      if (!b) acc.set(v, { x0: x, y0: y, x1: x, y1: y });
      else {
        if (x < b.x0) b.x0 = x;
        if (x > b.x1) b.x1 = x;
        if (y < b.y0) b.y0 = y;
        if (y > b.y1) b.y1 = y;
      }
    }
  }
  const out = new Map<number, Rect>();
  for (const [v, b] of [...acc].sort((a, c) => a[0] - c[0])) {
    out.set(v, { x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 });
  }
  return out;
}
