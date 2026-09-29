// 原版角色姿态库的选择（original-skin.md §5 A7；design-draft §3.3「棋子」；sprites.md §10）。纯函数，不引入 Pixi。
//
// 素材包逻辑键 char.<c>.<pose>（原版 Data#87 + 21c + k）：
//   stand / walk / dice（k 0–2）、moto.* / car.*（3–8）、engineer.*（9–11，置信度 guess → 走程序化回退）、
//   boat.*（13–15，快艇节点段）、sleepwalk.stand / walk（16–17）、beggar（18）、hospital（19）、jail（20）。
// 恶人：npc.villain.<kind>.{stand, walk, boat}；机器娃娃：npc.doll.{stand, walk}。
// 帧号 = ((8 − view + dir) & 7) · perDir + anim（shared/assets/frames.ts）；dirs = 1 的库按 anim 取模。
import { actorFrame, directionFromDelta } from '@rich4/shared/assets';
import type { Vehicle, VillainKind } from '@rich4/shared/engine';
import type { Pt } from '../iso/projection';

export type PoseMode = 'stand' | 'walk' | 'dice';

export interface PoseState {
  vehicle: Vehicle;
  /** 当前（或下一）节点是快艇节点 */
  boat: boolean;
  sleepwalk: boolean;
  confined: 'jail' | 'hospital' | null;
  beggar: boolean;
}

export const PLAIN_POSE: PoseState = Object.freeze({
  vehicle: 'walk',
  boat: false,
  sleepwalk: false,
  confined: null,
  beggar: false,
}) as PoseState;

export interface PoseChoice {
  /** 候选逻辑键（按优先级；第一项可用就用它） */
  keys: string[];
  /**
   * 第一候选不可用、回退到后面的键时需要叠加的程序化载具（工程车 k=9–11 置信度 guess，用 exe 0x40b425 核实前走程序化回退；
   * 机车 / 汽车条目缺失时同样叠加）
   */
  overlay: Exclude<Vehicle, 'walk'> | null;
}

/** 玩家角色的姿态候选 */
export function characterPose(character: number, mode: PoseMode, s: PoseState): PoseChoice {
  const c = `char.${character}`;
  const base = `${c}.${mode}`;
  const stand = `${c}.stand`;
  if (s.confined) return { keys: [`${c}.${s.confined}`, stand], overlay: null };
  if (s.beggar) return { keys: [`${c}.beggar`, stand], overlay: null };
  if (s.boat) return { keys: [`${c}.boat.${mode}`, `${c}.boat.stand`, base, stand], overlay: null };
  if (s.sleepwalk) {
    const k = mode === 'walk' ? `${c}.sleepwalk.walk` : `${c}.sleepwalk.stand`;
    return { keys: [k, `${c}.sleepwalk.stand`, mode === 'walk' ? base : stand, stand], overlay: null };
  }
  if (s.vehicle !== 'walk') {
    return { keys: [`${c}.${s.vehicle}.${mode}`, `${c}.${s.vehicle}.stand`, base, stand], overlay: s.vehicle };
  }
  return { keys: mode === 'stand' ? [stand] : [base, stand], overlay: null };
}

/** 恶人的姿态候选（原版 Data 339–354：站、走、pose3、快艇） */
export function villainPose(kind: VillainKind, mode: PoseMode, boat: boolean): PoseChoice {
  const v = `npc.villain.${kind}`;
  if (boat) return { keys: [`${v}.boat`, `${v}.stand`], overlay: null };
  return { keys: mode === 'walk' ? [`${v}.walk`, `${v}.stand`] : [`${v}.stand`], overlay: null };
}

/** 机器娃娃的姿态候选（原版 Data#480 站、#481 走） */
export function dollPose(mode: PoseMode): PoseChoice {
  return { keys: mode === 'walk' ? ['npc.doll.walk', 'npc.doll.stand'] : ['npc.doll.stand'], overlay: null };
}

/** 选中的库是否就是第一候选（否则按 overlay 叠加程序化载具） */
export function needsOverlay(choice: PoseChoice, usedKey: string | null): Exclude<Vehicle, 'walk'> | null {
  if (!choice.overlay) return null;
  return usedKey === choice.keys[0] || usedKey === choice.keys[1] ? null : choice.overlay;
}

/** 精灵库的帧：dirs=8 为方向主序（帧 = 屏幕方向槽 × perDir + anim），dirs=1 按 anim 取模 */
export function sheetFrame(sheet: { dirs: 1 | 8; count: number }, dir: number, view: number, anim: number): number {
  if (sheet.dirs === 8) return actorFrame(dir, view, Math.max(1, Math.trunc(sheet.count / 8)), anim);
  const n = Math.max(1, sheet.count);
  return ((Math.trunc(anim) % n) + n) % n;
}

/** 世界位移 → 方向槽（0 南 +y、2 东 +x、4 北、6 西）；零位移返回 null（保持原朝向） */
export function dirOfWorldStep(from: Pt, to: Pt): number | null {
  const dx = Math.round(to.x - from.x);
  const dy = Math.round(to.y - from.y);
  if (dx === 0 && dy === 0) return null;
  return directionFromDelta(dx, dy);
}

/**
 * reset / 快照之后的朝向：优先按来路（prevNode → node）的世界位移；缺失时用确定性默认（按座位哈希取 0..7 的偶数槽，
 * 所有客户端一致；critique §2 第 5 条）
 */
export function defaultFacing(seat: number, prev: Pt | null, cur: Pt | null): number {
  if (prev && cur) {
    const d = dirOfWorldStep(prev, cur);
    if (d !== null) return d;
  }
  return ((Math.imul(seat + 1, 0x9e3779b1) >>> 29) & 3) * 2;
}

/** 行走动画帧间隔（原版分频 2 档 ≈ 40 ms 一帧，按动画时钟计） */
export const WALK_FRAME_MS = 40;
/** ZZZ 动画帧间隔 */
export const ZZZ_FRAME_MS = 160;
