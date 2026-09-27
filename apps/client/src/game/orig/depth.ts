// 原版深度排序（render.md §2.5；design-draft §3.3「深度排序」）：键 = 锚点在棋盘坐标里的 y（取整）× 16 + layer，
// 升序绘制。装饰圆盘与地面不参与排序（单独一层）；飞行物固定最后画（原版键 0x7FF0）。
// 与原版的差别：原版只取 (sy & 0xfff)（屏幕内 0..480），这里用整张棋盘的 y，按 JS 数值比较，没有回绕。

export const OrigLayer = {
  /** 建筑、地块标记、路面物件、附身物件 */
  Building: 0,
  Object: 0,
  /** 非当前 NPC（恶人、机器娃娃） */
  Npc: 8,
  /** 非当前玩家 */
  Player: 0xc,
  /** 当前玩家或当前 NPC */
  Current: 0xd,
  /** 梦游 / 冬眠 ZZZ */
  Zzz: 0xe,
} as const;
export type OrigLayer = (typeof OrigLayer)[keyof typeof OrigLayer];

/** 飞行中的物件：固定最后画 */
export const ORIG_FLYING_Z = 1e12;

/** 深度键：sy 为锚点的棋盘 y（按源像素取整） */
export function origDepth(sy: number, layer: number): number {
  return Math.round(sy) * 16 + layer;
}

/** 按深度键排好的绘制顺序（稳定：同键保持输入顺序；测试与调试用） */
export function sortByDepth<T extends { z: number }>(items: readonly T[]): T[] {
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => a.it.z - b.it.z || a.i - b.i)
    .map((x) => x.it);
}
