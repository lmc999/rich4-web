// 原版舞台的 FLIC 选择与可用时长（original-skin.md §3 修正 1）：
// - 事件 → FLIC 与 shared/view/pacing 的 flicReserveOf 同一张对应表（节日按地图节日表、棋盘伞按角色细分）；
// - handler 里 FLIC 之外的等待（fx/timings 的 ORIG_FLIC_WAITS）不超过 pacing 为它预留的 extraMs：
//   original 节奏下可用时长 ≥ FLIC 原长（原速完整播放），compact 节奏下 playFit 的计划落在可用时长内。
import { buildTestMap } from '@rich4/shared/data';
import type { GameEvent, GodKind, StrikeKind } from '@rich4/shared/engine';
import {
  eventBudgetMs,
  FLIC_EVENT_TYPES,
  flicMs,
  flicReserveOf,
  GOD_ARRIVAL_FLICS,
  ORIGINAL_FLICS,
  PACING_PROFILES,
  PARACHUTE_FLICS,
} from '@rich4/shared/view';
import { describe, expect, it } from 'vitest';
import { ORIG_FLIC_SLACK_MS, ORIG_FLIC_WAITS } from '../../fx/timings';
import {
  eventFlicOf,
  flicAvailMs,
  flicOtherMs,
  HOLIDAY_FLIC_BIT,
  holidayFlic,
  ORIG_FLIC_EVENTS,
  planFlic,
} from './flicPlan';

const GODS: GodKind[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15];
const STRIKES: StrikeKind[] = ['missile', 'nuke', 'alien', 'typhoon', 'bomb3x3'];
const cause = { k: 'card', ref: 17, by: 0 } as const;

/** 每种有 FLIC 的事件的样本（覆盖全部神明、打击、关押去处、节日、角色） */
function samples(): { e: GameEvent; character: number }[] {
  const out: { e: GameEvent; character: number }[] = [];
  const add = (e: unknown, character = 0): void => void out.push({ e: e as GameEvent, character });
  for (let c = 0; c < 12; c++) add({ type: 'PARACHUTE', seat: 1, node: 5, prev: 4 }, c);
  for (const kind of GODS) add({ type: 'GOD_ATTACHED', seat: 0, kind, displaced: null });
  add({ type: 'GOD_LEFT', seat: 0, kind: 2, reason: 'expired' });
  add({ type: 'GOD_LEFT', seat: null, kind: 7, reason: 'swept' });
  for (const where of ['jail', 'hospital', 'away']) {
    add({ type: 'CONFINED', actor: { t: 'seat', seat: 1 }, where, days: 3, total: 3, cause });
  }
  add({ type: 'CONFINED', actor: { t: 'villain', kind: 'thief' }, where: 'jail', days: 3, total: 3, cause });
  add({ type: 'BOMB_EXPLODED', seat: 2, node: 6, lot: 'L2' });
  for (const kind of STRIKES) add({ type: 'STRIKE', kind, center: 6, half: 100, lots: [], actors: [] });
  for (const kind of ['mine', 'bomb', 'roadblock']) {
    add({
      type: 'OBJECT_REMOVED',
      obj: { id: 1, kind, node: 6, placedBy: 0 },
      cause: { k: 'object', ref: null, by: null },
    });
  }
  add({ type: 'OBJECT_REMOVED', obj: { id: 1, kind: 'mine', node: 6, placedBy: 0 }, cause });
  for (const source of ['square', 'shop', 'god']) add({ type: 'CARD_GAINED', seat: 0, card: 3, source });
  for (const source of ['square', 'chest']) add({ type: 'POINTS_GAINED', seat: 0, amount: 30, source });
  add({ type: 'HOLIDAY', key: 'h0', giveCard: false });
  add({ type: 'HOLIDAY', key: 'h1', giveCard: false });
  add({ type: 'HOLIDAY', key: 'h9', giveCard: true });
  add({ type: 'BANKRUPT', seat: 2, cause, creditor: null });
  add({ type: 'TOLL_EXEMPT', seat: 1, lot: 'L1', reason: 'jail' });
  return out;
}

/** 地图节日表：h0 标了播 FLIC（元旦），h1 没标 */
const HOLIDAYS = {
  holidays: [
    { slot: 0, flagsRaw: 0x301 },
    { slot: 1, flagsRaw: 0x001 },
  ],
} as never;

describe('事件 → 原版 FLIC', () => {
  it('与 pacing 的 flicReserveOf 同一张对应表（节日按节日表、棋盘伞按角色细分）', () => {
    for (const { e, character } of samples()) {
      const f = eventFlicOf(e, { map: HOLIDAYS, characterOf: () => character });
      const r = flicReserveOf(e);
      const tag = JSON.stringify(e);
      if (e.type === 'HOLIDAY' && e.key === 'h1') {
        // 节日表没标「播 FLIC」：pacing 按烟火预留，原版舞台不播
        expect(f, tag).toBeNull();
        expect(r?.flic, tag).toBe(ORIGINAL_FLICS.fireworks);
        continue;
      }
      if (e.type === 'PARACHUTE') {
        expect(f?.timing, tag).toBe(PARACHUTE_FLICS[character]);
        expect(f?.use).toBe(`char.parachuteBoard.${character}`);
        // pacing 按最长的一段预留
        expect(flicMs(f!.timing)).toBeLessThanOrEqual(flicMs(r!.flic));
        continue;
      }
      expect(f?.timing ?? null, tag).toBe(r?.flic ?? null);
      if (f) expect(f.use, tag).toBe(f.timing.use === 'god.arrive' ? f.use : f.timing.use);
    }
  });

  it('神明降临按神明键取用途；恶犬没有降临动画', () => {
    for (const kind of GODS) {
      const f = eventFlicOf({ type: 'GOD_ATTACHED', seat: 0, kind, displaced: null } as GameEvent, {
        map: null,
        characterOf: () => 0,
      });
      if (GOD_ARRIVAL_FLICS[kind]) expect(f?.use).toMatch(/^god\.arrive\.[a-zA-Z]+$/);
      else expect(f).toBeNull();
    }
  });

  it('节日：送卡为圣诞；其余按节日表的「播 FLIC」位；没有地图时按 pacing 口径', () => {
    const def = buildTestMap();
    expect(holidayFlic(def, 'h0', true)).toBe(ORIGINAL_FLICS.christmas);
    expect(holidayFlic(null, 'h0', false)).toBe(ORIGINAL_FLICS.fireworks);
    expect(holidayFlic({ holidays: [{ slot: 3, flagsRaw: HOLIDAY_FLIC_BIT }] } as never, 'h3', false)).toBe(
      ORIGINAL_FLICS.fireworks,
    );
    expect(holidayFlic({ holidays: [{ slot: 3, flagsRaw: 0x400 }] } as never, 'h3', false)).toBeNull();
    expect(holidayFlic({ holidays: [] } as never, 'h3', false)).toBeNull();
  });
});

describe('FLIC 的可用时长 = 事件预算 − handler 内其他等待 − 余量', () => {
  it('每种有 FLIC 预留的事件都登记了等待；等待不超过 pacing 预留的 extraMs', () => {
    expect(new Set(ORIG_FLIC_EVENTS)).toEqual(new Set(FLIC_EVENT_TYPES.filter((t) => isBoardFlic(t))));
    for (const { e } of samples()) {
      const r = flicReserveOf(e);
      if (!r || !isBoardFlic(e.type)) continue;
      const t = e.type as keyof typeof ORIG_FLIC_WAITS;
      expect(flicOtherMs(t), e.type).toBeLessThanOrEqual(r.extraMs);
      expect(ORIG_FLIC_SLACK_MS).toBeLessThanOrEqual(100);
    }
  });

  it.each(PACING_PROFILES)('%s：可用时长非负，playFit 的计划落在可用时长内；original 原速完整播放', (profile) => {
    for (const { e, character } of samples()) {
      const f = eventFlicOf(e, { map: HOLIDAYS, characterOf: () => character });
      if (!f) continue;
      const budget = eventBudgetMs(e, profile);
      const avail = flicAvailMs(f.type, budget);
      const w = ORIG_FLIC_WAITS[f.type];
      expect(avail + w.before + w.after, JSON.stringify(e)).toBeLessThanOrEqual(budget);
      const plan = planFlic(f.timing, avail);
      expect(plan.durationMs, JSON.stringify(e)).toBeLessThanOrEqual(avail + 1e-6);
      if (profile === 'original') {
        expect(avail, `${e.type} ${f.use}`).toBeGreaterThanOrEqual(flicMs(f.timing));
        expect(plan.speed).toBe(1);
        expect(plan.skipped).toBe(false);
        expect(plan.frames).toHaveLength(f.timing.frames);
      }
    }
  });

  it('compact 节奏下长 FLIC 加速或跳帧（救护车 6.2 s、警车 2.5 s）', () => {
    const hospital = {
      type: 'CONFINED',
      actor: { t: 'seat', seat: 1 },
      where: 'hospital',
      days: 3,
      total: 3,
      cause,
    } as GameEvent;
    const avail = flicAvailMs('CONFINED', eventBudgetMs(hospital, 'compact'));
    const plan = planFlic(ORIGINAL_FLICS.ambulance, avail);
    expect(plan.skipped).toBe(true);
    expect(plan.durationMs).toBeLessThanOrEqual(avail + 1e-6);
    const police = planFlic(ORIGINAL_FLICS.policeCar, avail);
    expect(police.speed).toBeGreaterThan(1);
    expect(police.durationMs).toBeLessThanOrEqual(avail + 1e-6);
    // 神明离身的烟雾在 compact 预算里仍可原速播完
    const leave = planFlic(ORIGINAL_FLICS.godLeave, flicAvailMs('GOD_LEFT', 900));
    expect(leave.skipped).toBe(false);
    expect(leave.speed).toBeGreaterThan(1);
  });
});

/** 由棋盘舞台播放的 FLIC 事件（骰子、乐透、魔法屋属于外壳与场所屏） */
function isBoardFlic(t: string): boolean {
  return !['DICE_ROLLED', 'LOTTERY_DRAW', 'MAGIC_CAST'].includes(t);
}
