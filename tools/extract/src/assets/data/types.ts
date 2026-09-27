/**
 * 音视频映射表的公共类型（原版皮肤 A3；docs/design/original-skin.md §5）。
 * data/** 只含资源编号、exe 地址与我们自己写的用途描述，不含任何原版文案。
 */

/**
 * 置信度：
 * - exe：exe 里的表或调用点直接给出（表结构、switch 分支、调用点所在处理函数）
 * - visual：看样张、读台词文本或对照调研文档得出的语义
 * - guess：只凭位置或上下文推断，前端应准备回退
 */
export type Confidence = 'exe' | 'visual' | 'guess';

export const CONFIDENCES: readonly Confidence[] = ['exe', 'visual', 'guess'];

/** 12 名角色（原版编号 0..11，与 @rich4/shared/data 的 CharacterId 一致） */
export const CHARACTER_COUNT = 12;

/** 生成 [lo, hi] 闭区间整数数组 */
export function span(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}
