// 真人收起交通工具（VEHICLE{stowed}）的提示、日志与音效。原版收起（v2.06 道具函数表第 14 项 0x4467b1）只调 0x40b425
// 刷新外观、0x41cc56 重画，不调台词函数 0x44d870（机车道具 0x445a77 会调）：不弹「换乘」提示、不放 ding，
// 日志记「收起××，改为步行」，外观照样换回步行。其他来源的 VEHICLE（换乘、梦游卡、工程车到期）照旧。
import type { GameEvent, GameEventOf } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeSoundQuery } from '../../audio/cues';
import { sfxCueFor } from '../../audio/selectors';
import { AnimClock } from '../../game/anim/AnimClock';
import { initI18n } from '../../i18n';
import { tx } from '../../i18n/tx';
import { selfPlay } from '../../test/selfPlay';
import { formatEvent } from '../logFormat';
import { makeNames } from '../names';
import { NULL_BOARD, NULL_UI, type PresentationContext } from '../types';
import { HANDLERS } from '.';
import { recordingStage, type StageCall } from './testStage';

beforeAll(() => {
  initI18n('original');
});

const view: GameView = selfPlay({ seed: 3, steps: 2 }).initial.view;
const names = makeNames({ t: tx, view: () => view, map: () => null });
/** 座位 0 的角色名（i18n 在 beforeAll 里初始化，不能在模块顶层取） */
const who = (): string => names.seat(0);

async function play(e: GameEventOf<'VEHICLE'>): Promise<{ toasts: string[]; stage: StageCall[] }> {
  const toasts: string[] = [];
  const stage: StageCall[] = [];
  const clock = new AnimClock();
  clock.instant = true;
  const ctx: PresentationContext = {
    signal: new AbortController().signal,
    wait: (ms) => clock.wait(ms),
    board: { ...NULL_BOARD, ready: true, stage: recordingStage(stage) } as PresentationContext['board'],
    ui: { ...NULL_UI, toast: (text) => toasts.push(text) },
    audio: { play: () => {} },
    me: 0,
    role: 'player',
    view: () => view,
    map: null,
    names,
    t: tx,
  };
  await (HANDLERS.VEHICLE as unknown as (x: GameEvent, c: PresentationContext) => Promise<void>)(e, ctx);
  return { toasts, stage };
}

describe('收起交通工具（VEHICLE{stowed}）', () => {
  const stowCar: GameEventOf<'VEHICLE'> = { type: 'VEHICLE', seat: 0, vehicle: 'walk', dice: 1, stowed: 'car' };
  const stowMoto: GameEventOf<'VEHICLE'> = { type: 'VEHICLE', seat: 0, vehicle: 'walk', dice: 1, stowed: 'moto' };
  const ride: GameEventOf<'VEHICLE'> = { type: 'VEHICLE', seat: 0, vehicle: 'car', dice: 3 };
  const sleepwalk: GameEventOf<'VEHICLE'> = { type: 'VEHICLE', seat: 0, vehicle: 'walk', dice: 1 };

  it('日志写「收起××，改为步行」，不再写成换乘；其他 VEHICLE 的文案不变', () => {
    expect(formatEvent(stowCar, names)).toBe(`${who()} 收起汽车，改为步行`);
    expect(formatEvent(stowMoto, names)).toBe(`${who()} 收起机车，改为步行`);
    expect(formatEvent(ride, names)).toBe(`${who()} 换乘交通工具（3 颗骰子）`);
    expect(formatEvent(sleepwalk, names)).toBe(`${who()} 换乘交通工具（1 颗骰子）`);
  });

  it('演出：收起不弹提示，外观照样换回步行；换乘照旧弹提示', async () => {
    const s = await play(stowCar);
    expect(s.toasts).toEqual([]);
    expect(s.stage).toContainEqual(['vehicle', 0, 'walk']);
    const r = await play(ride);
    expect(r.toasts).toEqual([`${who()} 换乘交通工具（3 颗骰子）`]);
    expect(r.stage).toContainEqual(['vehicle', 0, 'car']);
  });

  it('音效：收起不放 ding；换乘、梦游卡改回步行照旧', () => {
    const q = makeSoundQuery(() => view, null);
    expect(sfxCueFor(stowCar, q)).toBeNull();
    expect(sfxCueFor(stowMoto, q)).toBeNull();
    expect(sfxCueFor(ride, q)).toMatchObject({ zzfx: 'ding' });
    expect(sfxCueFor(sleepwalk, q)).toMatchObject({ zzfx: 'ding' });
  });
});
