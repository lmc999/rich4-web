/**
 * 原版 8 视角下的帧选择规则（render.md §2.3、§2.6；v2.06 地址见注释）。纯整数运算，客户端渲染与测试共用。
 * view 为视角 0..7（view+1 画面顺时针转 45°）；方向槽 dir 为 0 南（+y）、2 东（+x）、4 北、6 西。
 */

/** 建筑（住宅、设施、企业）帧号：(8 − (facing + view)) & 7（0x408dd1、0x408ff4、0x409255、0x40939d） */
export function buildingFrame(facing: number, view: number): number {
  return (8 - (facing + view)) & 7;
}

/**
 * 棋子帧号：((8 − view + dir) & 7) · perDir + anim（0x408433–0x40846e）。
 * perDir = 姿态库帧数 / 8（走姿 9、站姿 1）；anim 按 perDir 取模。
 */
export function actorFrame(dir: number, view: number, perDir: number, anim: number): number {
  const a = ((anim % perDir) + perDir) % perDir;
  return ((8 - view + dir) & 7) * perDir + a;
}

/** 路面物件与路上神明帧号：(8 − view + facing) & 7 */
export function roadObjectFrame(facing: number, view: number): number {
  return (8 - view + facing) & 7;
}

/** 附身物件（画在主人位置）帧号：(dirIdx + 4) & 7 */
export function attachedObjectFrame(dirIdx: number): number {
  return (dirIdx + 4) & 7;
}

/** 装饰圆盘帧号：原版节点 decor 值（1 起）减 1 */
export function decorFrame(decor: number): number {
  return decor - 1;
}

const DIR_BY_OCTANT = [2, 3, 4, 5, 6, 7, 0, 1] as const;
/** tan(22.5°) = √2 − 1 */
const TAN_22_5 = 0.41421356237309503;

/**
 * 移动方向槽：原版 fcn.00453614 为 [2,3,4,5,6,7,0,1][round(atan2(−dy, dx) / 45°) & 7]。
 * 这里用与 tan(22.5°) 的比较代替 atan2 与 round（确定、无超越函数）；整数输入不会落在扇区边界上。
 * (0, 0) 与原版一致返回 2。
 */
export function directionFromDelta(dx: number, dy: number): number {
  const x = dx;
  const y = -dy;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  let octant: number;
  if (ay <= ax * TAN_22_5) octant = x < 0 ? 4 : 0;
  else if (ax <= ay * TAN_22_5) octant = y > 0 ? 2 : 6;
  else if (x > 0) octant = y > 0 ? 1 : 7;
  else octant = y > 0 ? 3 : 5;
  return DIR_BY_OCTANT[octant]!;
}

/** 视角旋转 ±45°：(view + step) & 7 */
export function rotateView(view: number, step: number): number {
  return (view + step) & 7;
}
