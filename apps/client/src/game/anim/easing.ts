// 缓动函数：输入 t∈[0,1]，输出进度（可越界，如 backOut）
export type Ease = (t: number) => number;

export const linear: Ease = (t) => t;
export const quadIn: Ease = (t) => t * t;
export const quadOut: Ease = (t) => t * (2 - t);
export const quadInOut: Ease = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);
export const cubicOut: Ease = (t) => {
  const u = t - 1;
  return u * u * u + 1;
};
export const cubicInOut: Ease = (t) => (t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1);
export const sineInOut: Ease = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
/** 略微冲过终点再回弹（按钮、建筑升级的 scaleY 弹跳） */
export const backOut: Ease = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
};
export const elasticOut: Ease = (t) => {
  if (t === 0 || t === 1) return t;
  return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
};
/** 抛物线：0→1→0，用于跳步的高度 */
export const hopArc: Ease = (t) => 4 * t * (1 - t);

export const EASINGS = {
  linear,
  quadIn,
  quadOut,
  quadInOut,
  cubicOut,
  cubicInOut,
  sineInOut,
  backOut,
  elasticOut,
} as const;
