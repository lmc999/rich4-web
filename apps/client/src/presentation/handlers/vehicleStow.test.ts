// 座驾切换的提示、日志、音效与演出（architecture §34）。原版各条换车路径都只调 0x40b425 刷新外观、不出对话框、没有换车音效、
// 不移镜头：用机车 / 汽车 / 工程车道具换车另说道具台词（机车 0x445a77 调 0x44d870，随 ITEM_USED），真人收起（VEHICLE{stowed}，
// 0x4467b1）、中梦游卡（via sleepwalk，0x442fa8）、梦游结束装回（via wake，0x41c1aa）、工程车到期（via expire，0x41c4d3）、
// 魔法屋卖光（via sold，0x4446de）不说台词——都不弹提示、不放 ding、不闪光不跳动，外观直接换成 post 里的座驾，日志按来源写。
// 命运 10 / 11 失车（VEHICLE_DESTROYED{via:'fate'}，0x44b4eb / 0x44b5fc）不走毁车：不爆炸、不飘字，只说事件槽 3 / 4 的台词。
import type { GameEvent, GameEventOf } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeSoundQuery } from '../../audio/cues';
import { sfxCueFor, voiceCuesFor } from '../../audio/selectors';
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

async function play(
  e: GameEventOf<'VEHICLE'> | GameEventOf<'VEHICLE_DESTROYED'> | GameEventOf<'ITEM_USED'>,
): Promise<{ toasts: string[]; stage: StageCall[]; floats: number }> {
  const toasts: string[] = [];
  const stage: StageCall[] = [];
  let floats = 0;
  const clock = new AnimClock();
  clock.instant = true;
  const ctx: PresentationContext = {
    signal: new AbortController().signal,
    wait: (ms) => clock.wait(ms),
    board: {
      ...NULL_BOARD,
      ready: true,
      stage: recordingStage(stage),
      floatText: () => {
        floats++;
      },
    } as PresentationContext['board'],
    ui: { ...NULL_UI, toast: (text) => toasts.push(text) },
    audio: { play: () => {} },
    me: 0,
    role: 'player',
    view: () => view,
    map: null,
    names,
    t: tx,
  };
  const h = HANDLERS[e.type] as unknown as (x: GameEvent, c: PresentationContext) => Promise<void>;
  await h(e, ctx);
  return { toasts, stage, floats };
}

const V = (x: Omit<GameEventOf<'VEHICLE'>, 'type' | 'seat'>): GameEventOf<'VEHICLE'> => ({
  type: 'VEHICLE',
  seat: 0,
  ...x,
});

describe('座驾切换（VEHICLE）', () => {
  const stowCar = V({ vehicle: 'walk', dice: 1, stowed: 'car' });
  const stowMoto = V({ vehicle: 'walk', dice: 1, stowed: 'moto' });
  const ride = V({ vehicle: 'car', dice: 3 });
  const sleepCar = V({ vehicle: 'walk', dice: 1, via: 'sleepwalk', from: 'car' });
  const sleepEng = V({ vehicle: 'walk', dice: 1, via: 'sleepwalk', from: 'engineer' });
  const wakeMoto = V({ vehicle: 'moto', dice: 1, via: 'wake', from: 'walk' });
  const wakeEng = V({ vehicle: 'engineer', dice: 1, via: 'wake', from: 'walk' });
  const expireCar = V({ vehicle: 'car', dice: 3, via: 'expire', from: 'engineer' });
  const expireWalk = V({ vehicle: 'walk', dice: 1, via: 'expire', from: 'engineer' });
  const soldMoto = V({ vehicle: 'walk', dice: 1, via: 'sold', from: 'moto' });
  const soldEng = V({ vehicle: 'walk', dice: 1, via: 'sold', from: 'engineer' });
  const quiet = [stowCar, stowMoto, sleepCar, sleepEng, wakeMoto, wakeEng, expireCar, expireWalk, soldMoto, soldEng];

  it('日志：用道具换车写「换乘交通工具」（只进日志，不弹提示），其余按来源写', () => {
    expect(formatEvent(ride, names)).toBe(`${who()} 换乘交通工具（3 颗骰子）`);
    expect(formatEvent(stowCar, names)).toBe(`${who()} 收起汽车，改为步行`);
    expect(formatEvent(stowMoto, names)).toBe(`${who()} 收起机车，改为步行`);
    expect(formatEvent(sleepCar, names)).toBe(`${who()} 梦游，汽车收回道具栏，改为步行`);
    expect(formatEvent(sleepEng, names)).toBe(`${who()} 梦游，工程车停下，改为步行`);
    expect(formatEvent(wakeMoto, names)).toBe(`${who()} 梦游结束，换回机车`);
    expect(formatEvent(wakeEng, names)).toBe(`${who()} 梦游结束，换回工程车`);
    expect(formatEvent(expireCar, names)).toBe(`${who()} 的工程车到期，换回汽车`);
    expect(formatEvent(expireWalk, names)).toBe(`${who()} 的工程车到期，改为步行`);
    expect(formatEvent(soldMoto, names)).toBe(`${who()} 的机车一并卖掉，改为步行`);
    expect(formatEvent(soldEng, names)).toBe(`${who()} 的工程车一并卖掉，改为步行`);
    for (const e of quiet) expect(formatEvent(e, names), JSON.stringify(e)).not.toContain('换乘');
  });

  it('演出：各条路径都只刷新外观——不弹提示，舞台只调 vehicle（换姿态库 / 载具图，不闪光不跳），不移镜头', async () => {
    for (const e of [ride, ...quiet]) {
      const s = await play(e);
      expect(s.toasts, JSON.stringify(e)).toEqual([]);
      expect(
        s.stage.filter((c) => c[0] !== 'syncWorld'),
        JSON.stringify(e),
      ).toEqual([['vehicle', 0, e.vehicle]]);
    }
  });

  it('音效：换座驾不出声（原版 0x40b425 只换行进循环音）；道具台词随 ITEM_USED', () => {
    const q = makeSoundQuery(() => view, null);
    for (const e of [ride, ...quiet]) expect(sfxCueFor(e, q), JSON.stringify(e)).toBeNull();
  });
});

describe('用换车道具（ITEM_USED 5 / 6 / 12）', () => {
  const use = (item: 5 | 6 | 12 | 7): GameEventOf<'ITEM_USED'> => ({
    type: 'ITEM_USED',
    seat: 0,
    item,
    target: { t: 'none' },
  });

  it('换车道具：没有道具名气泡与施放演出、没有施放音效，只说道具台词；其他道具照旧', async () => {
    const q = makeSoundQuery(() => view, null);
    for (const item of [5, 6, 12] as const) {
      const r = await play(use(item));
      expect(
        r.stage.some((c) => c[0] === 'cast' || c[0] === 'bubble'),
        String(item),
      ).toBe(false);
      expect(r.toasts).toHaveLength(1);
      expect(sfxCueFor(use(item), q)).toBeNull();
      expect(voiceCuesFor(use(item), q)).toEqual([{ k: 'item', seat: 0, item }]);
    }
    const missile = await play({ type: 'ITEM_USED', seat: 0, item: 7, target: { t: 'node', node: 3 } });
    expect(missile.stage.map((c) => c[0])).toEqual(expect.arrayContaining(['bubble', 'cast']));
    expect(sfxCueFor(use(7), q)).toMatchObject({ zzfx: 'magic' });
  });
});

describe('车没了（VEHICLE_DESTROYED）', () => {
  const mine: GameEventOf<'VEHICLE_DESTROYED'> = { type: 'VEHICLE_DESTROYED', seat: 0, vehicle: 'moto' };
  const fateMoto: GameEventOf<'VEHICLE_DESTROYED'> = {
    type: 'VEHICLE_DESTROYED',
    seat: 0,
    vehicle: 'moto',
    via: 'fate',
  };
  const fateCar: GameEventOf<'VEHICLE_DESTROYED'> = { type: 'VEHICLE_DESTROYED', seat: 0, vehicle: 'car', via: 'fate' };

  it('地雷炸弹：提示、飘字、车毁、爆炸声；命运 10 / 11：不提示、不飘字、不播车毁、不爆炸，说事件槽 3 / 4 的台词', async () => {
    const m = await play(mine);
    expect(m.toasts).toEqual([`${who()} 的交通工具被毁`]);
    expect(m.floats).toBe(1);
    expect(m.stage).toContainEqual(['wreck', 0, 'moto']);
    for (const e of [fateMoto, fateCar]) {
      const f = await play(e);
      expect(f.toasts).toEqual([]);
      expect(f.floats).toBe(0);
      expect(f.stage.some((c) => c[0] === 'wreck')).toBe(false);
    }
    const q = makeSoundQuery(() => view, null);
    expect(sfxCueFor(mine, q)).toMatchObject({ zzfx: 'boom' });
    expect(sfxCueFor(fateMoto, q)).toBeNull();
    expect(voiceCuesFor(mine, q)).toEqual([]);
    expect(voiceCuesFor(fateMoto, q)).toEqual([{ k: 'slot', seat: 0, slot: 'spendSmall0', alt: ['spendSmall1'] }]);
    expect(voiceCuesFor(fateCar, q)).toEqual([{ k: 'slot', seat: 0, slot: 'spendSmall0' }]);
  });

  it('日志：命运失车写「失去××，改为步行」', () => {
    expect(formatEvent(mine, names)).toBe(`${who()} 的交通工具被毁`);
    expect(formatEvent(fateMoto, names)).toBe(`${who()} 失去机车，改为步行`);
    expect(formatEvent(fateCar, names)).toBe(`${who()} 失去汽车，改为步行`);
  });
});
