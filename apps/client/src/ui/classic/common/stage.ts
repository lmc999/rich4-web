// 原版场景层的几何（design-draft §4.3 Stage4x3）：640×480 逻辑坐标，与经典舞台同一缩放（scale = min(W/640, H/480)，
// 整数倍最近邻、否则平滑），落在舞台矩形上；各层按原坐标、原锚点绝对定位（落点 = 画点 − 锚点）。纯函数，不碰 DOM。
import type { ClassicLayoutBox, Rect } from '../layout';

export const SCENE_W = 640;
export const SCENE_H = 480;

/** 场景层的 z-index：高于棋盘叠层（40，内含弹窗与横幅）与抽屉状态条（39），低于侧栏抽屉（70） */
export const SCENE_Z = 48;

/** 手机与粗指针设备的最小触控热区（CSS 像素；44 再留 2px 余量，与经典外壳一致） */
export const HIT_MIN_CSS = 46;

export interface ScenePlacement {
  /** 相对经典舞台容器（ClassicStage 的 .frame）的左上角（CSS 像素） */
  left: number;
  top: number;
  scale: number;
  pixelated: boolean;
}

/** 场景层的摆放：有经典舞台布局时贴在舞台矩形上；否则（测试、预览）左上角、给定缩放 */
export function scenePlacement(
  box: Pick<ClassicLayoutBox, 'stage' | 'scale' | 'pixelated'> | null,
  scale = 1,
): ScenePlacement {
  if (box) return { left: box.stage.x, top: box.stage.y, scale: box.scale, pixelated: box.pixelated };
  return { left: 0, top: 0, scale, pixelated: scale >= 1 && Math.abs(scale - Math.round(scale)) < 1e-3 };
}

/** 舞台缩小（手机横屏）或粗指针设备时补 ≥44px 透明热区 */
export function wantsWideHit(scale: number, coarse: boolean): boolean {
  return scale < 1 || coarse;
}

/** 44px 热区折成场景逻辑像素 */
export function hitMinLogical(scale: number): number {
  return HIT_MIN_CSS / Math.max(0.1, scale);
}

/** 按锚点落点：画点 (x, y) − 锚点 (ax, ay) */
export function anchored(x: number, y: number, ax: number, ay: number): { left: number; top: number } {
  return { left: x - ax, top: y - ay };
}

export function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

/** 粗指针（触摸屏）设备 */
export function coarsePointer(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)').matches
      : false;
  } catch {
    return false;
  }
}
