// 原版舞台的 FLIC 选择与时长（original-skin.md §3 修正 1、§5 A8；design-draft §3.5）。纯函数，不引入 Pixi。
// - eventFlicOf：事件 → 要播的原版 FLIC（与 shared/view/pacing 的 flicReserveOf 同一张对应表，再按地图节日表、
//   角色号细分：没有 FLIC 的节日不播、棋盘伞按本人的角色）；
// - flicAvailMs：handler 里 FLIC 的可用时长 = 当前节奏的事件预算 − FLIC 之外的等待（fx/timings 的 ORIG_FLIC_WAITS）− 余量；
//   original 节奏下 ≥ FLIC 原长（原速完整播放），compact 节奏下 playFit 加速或截取（skin/flic/fit.ts）。
import { GOD_KEYS, type MapDef } from '@rich4/shared/data';
import type { GameEvent, GodKind, SeatIndex, StrikeKind } from '@rich4/shared/engine';
import { type FlicTiming, GOD_ARRIVAL_FLICS, ORIGINAL_FLICS, PARACHUTE_FLICS } from '@rich4/shared/view';
import { type FitPlan, planFit } from '../../../skin/flic/fit';
import { ORIG_FLIC_SLACK_MS, ORIG_FLIC_WAITS } from '../../fx/timings';

/** 播原版 FLIC 的事件类型 */
export type OrigFlicEvent = keyof typeof ORIG_FLIC_WAITS;
export const ORIG_FLIC_EVENTS: readonly OrigFlicEvent[] = Object.freeze(
  Object.keys(ORIG_FLIC_WAITS) as OrigFlicEvent[],
);

export function isOrigFlicEvent(t: string): t is OrigFlicEvent {
  return Object.hasOwn(ORIG_FLIC_WAITS, t);
}

/** 神明降临 FLIC 的用途键（素材包 flic-map：god.arrive.<神明键>）；恶犬等没有降临动画的为 null */
export function godArrivalUse(kind: GodKind): string | null {
  return GOD_ARRIVAL_FLICS[kind] ? `god.arrive.${GOD_KEYS[kind]}` : null;
}

/** 棋盘伞 FLIC 的用途键（char.parachuteBoard.<角色号>） */
export function parachuteUse(character: number): string {
  return `char.parachuteBoard.${character}`;
}

/** 飞弹 / 核弹 / 外星人 / 台风；手动引爆的 3×3 炸弹没有原版动画 */
export function strikeFlic(kind: StrikeKind): FlicTiming | null {
  switch (kind) {
    case 'missile':
      return ORIGINAL_FLICS.missile;
    case 'nuke':
      return ORIGINAL_FLICS.nuke;
    case 'alien':
      return ORIGINAL_FLICS.alienAttack;
    case 'typhoon':
      return ORIGINAL_FLICS.typhoon;
    default:
      return null;
  }
}

/** 节日表的事件位（flagsRaw 8..15 位）bit0 = 播 FLIC（audio_video.md「节日表」；VERIFY V-E5） */
export const HOLIDAY_FLIC_BIT = 0x100;

/**
 * 节日的 FLIC：送卡的节日（圣诞）为 513；其余只有节日表标了「播 FLIC」的（元旦、台湾图双十）放烟火 482，
 * 其他节日没有 FLIC。地图不在手边时按 pacing 的预留口径（送卡 → 圣诞，否则烟火）。
 */
export function holidayFlic(def: Pick<MapDef, 'holidays'> | null, key: string, giveCard: boolean): FlicTiming | null {
  if (giveCard) return ORIGINAL_FLICS.christmas;
  if (!def) return ORIGINAL_FLICS.fireworks;
  const h = def.holidays.find((x) => `h${x.slot}` === key);
  return h && (h.flagsRaw & HOLIDAY_FLIC_BIT) !== 0 ? ORIGINAL_FLICS.fireworks : null;
}

/** 事件要播的原版 FLIC */
export interface EventFlic {
  type: OrigFlicEvent;
  /** flic-map 用途键 */
  use: string;
  /** 原版时长参数（shared/view/pacing） */
  timing: FlicTiming;
}

export interface EventFlicContext {
  /** 地图（节日表）；没有时按 pacing 的预留口径 */
  map: Pick<MapDef, 'holidays'> | null;
  /** 座位 → 角色号（棋盘伞按角色） */
  characterOf(seat: SeatIndex): number | null;
}

const flicOf = (type: OrigFlicEvent, timing: FlicTiming | null | undefined, use = timing?.use): EventFlic | null =>
  timing && use ? { type, use, timing } : null;

/** 事件 → 原版 FLIC；没有为 null（与 pacing 的 flicReserveOf 同一张对应表，见 flicPlan.test） */
export function eventFlicOf(e: GameEvent, c: EventFlicContext): EventFlic | null {
  switch (e.type) {
    case 'PARACHUTE': {
      const ch = c.characterOf(e.seat);
      const t = ch === null ? undefined : PARACHUTE_FLICS[ch];
      return ch === null ? null : flicOf('PARACHUTE', t, parachuteUse(ch));
    }
    case 'GOD_ATTACHED':
      return flicOf('GOD_ATTACHED', GOD_ARRIVAL_FLICS[e.kind], godArrivalUse(e.kind) ?? undefined);
    case 'GOD_LEFT':
      return flicOf('GOD_LEFT', ORIGINAL_FLICS.godLeave);
    case 'CONFINED':
      if (e.actor.t !== 'seat') return null;
      return e.where === 'hospital'
        ? flicOf('CONFINED', ORIGINAL_FLICS.ambulance)
        : e.where === 'jail'
          ? flicOf('CONFINED', ORIGINAL_FLICS.policeCar)
          : null;
    case 'BOMB_EXPLODED':
      return flicOf('BOMB_EXPLODED', ORIGINAL_FLICS.explosionBig);
    case 'STRIKE':
      return flicOf('STRIKE', strikeFlic(e.kind));
    case 'OBJECT_REMOVED':
      return e.cause.k === 'object' && (e.obj.kind === 'mine' || e.obj.kind === 'bomb')
        ? flicOf('OBJECT_REMOVED', ORIGINAL_FLICS.explosionSmall)
        : null;
    case 'CARD_GAINED':
      return e.source === 'square' ? flicOf('CARD_GAINED', ORIGINAL_FLICS.cardGain) : null;
    case 'POINTS_GAINED':
      return e.source === 'square' ? flicOf('POINTS_GAINED', ORIGINAL_FLICS.pointsGain) : null;
    case 'HOLIDAY':
      return flicOf('HOLIDAY', holidayFlic(c.map, e.key, e.giveCard));
    case 'BANKRUPT':
      return flicOf('BANKRUPT', ORIGINAL_FLICS.bankrupt);
    default:
      return null;
  }
}

/** handler 里 FLIC 之外的等待（1x ms） */
export function flicOtherMs(type: OrigFlicEvent): number {
  const w = ORIG_FLIC_WAITS[type];
  return w.before + w.after;
}

/** FLIC 的可用时长：事件预算 − FLIC 之外的等待 − 余量（不小于 0） */
export function flicAvailMs(type: OrigFlicEvent, budgetMs: number): number {
  return Math.max(0, Math.trunc(budgetMs) - flicOtherMs(type) - ORIG_FLIC_SLACK_MS);
}

/** 按可用时长规划 FLIC 播放（原速 → 加速 ≤2× → trim → 均匀跳帧） */
export function planFlic(
  timing: Pick<FlicTiming, 'frames' | 'frameMs'>,
  availMs: number,
  trim: { startFrame: number; endFrame: number } | null = null,
): FitPlan {
  return planFit({ frames: timing.frames, frameMs: timing.frameMs, trim }, availMs);
}
