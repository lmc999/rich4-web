// 事件演出（design/client.md §4.5）：用假棋盘 / 假 UI 端口检查 M1/M4 事件的演出调用
import type { GameEvent, GameEventOf, GameEventType } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { beforeAll, describe, expect, it } from 'vitest';
import { AnimClock } from '../../game/anim/AnimClock';
import { initI18n } from '../../i18n';
import { tx } from '../../i18n/tx';
import { useUiStore } from '../../store/uiStore';
import { selfPlay } from '../../test/selfPlay';
import { usePopupStore } from '../../ui/popups/popupStore';
import { makeNames } from '../names';
import type { BoardPort, PresentationContext, UiPort } from '../types';
import { createUiPresenter } from '../UiPresenter';
import { HANDLERS } from '.';

beforeAll(() => {
  initI18n('original');
});

type Call = [string, ...unknown[]];

function fakeBoard(calls: Call[]): BoardPort {
  const rec =
    (name: string, ret?: unknown) =>
    (...a: unknown[]) => {
      calls.push([name, ...a.filter((x) => !(x instanceof AbortSignal))]);
      return ret;
    };
  return {
    ready: true,
    syncView: rec('syncView'),
    walk: rec('walk', Promise.resolve()) as BoardPort['walk'],
    placeActor: rec('placeActor'),
    hop: rec('hop', Promise.resolve()) as BoardPort['hop'],
    setActorPose: rec('setActorPose'),
    setLot: rec('setLot'),
    focus: rec('focus', Promise.resolve()) as BoardPort['focus'],
    follow: rec('follow'),
    floatText: rec('floatText'),
    coinFlight: rec('coinFlight', Promise.resolve()) as BoardPort['coinFlight'],
    plantFlag: rec('plantFlag', Promise.resolve()) as BoardPort['plantFlag'],
    popBuilding: rec('popBuilding', Promise.resolve()) as BoardPort['popBuilding'],
    pulseTile: rec('pulseTile'),
    shake: rec('shake'),
    clearFx: rec('clearFx'),
  };
}

function ctxFor(view: GameView, calls: Call[], me: 0 | 1 | 2 | 3 | null = 0): PresentationContext {
  const clock = new AnimClock();
  clock.instant = true;
  const ui: UiPort = createUiPresenter({ wait: (ms, s) => clock.wait(ms, s) });
  return {
    signal: new AbortController().signal,
    wait: (ms) => clock.wait(ms),
    board: fakeBoard(calls),
    ui,
    audio: { play: () => {} },
    me,
    role: me === null ? 'spectator' : 'player',
    view: () => view,
    map: null,
    names: makeNames({ t: tx, view: () => view, map: () => null }),
    t: tx,
  };
}

async function run<T extends GameEventType>(e: GameEventOf<T>, view: GameView, me: 0 | 1 | 2 | 3 | null = 0) {
  const calls: Call[] = [];
  const h = HANDLERS[e.type] as unknown as (x: GameEvent, c: PresentationContext) => Promise<void>;
  await h(e as GameEvent, ctxFor(view, calls, me));
  return calls;
}

const sp = selfPlay({ seed: 11, steps: 80 });
const view = sp.initial.view;
const find = <T extends GameEventType>(t: T): GameEventOf<T> | undefined =>
  sp.batches.flatMap((b) => b.events).find((e) => e.type === t) as GameEventOf<T> | undefined;

describe('handlers', () => {
  it('TURN_STARTED：镜头跟随并飞向该玩家、跳一下、弹回合横幅', async () => {
    useUiStore.getState().clear();
    const calls = await run({ type: 'TURN_STARTED', actor: { t: 'seat', seat: 1 }, turnNo: 5 }, view, 0);
    expect(calls.map((c) => c[0])).toEqual(['follow', 'focus', 'hop']);
    expect(calls[0]).toEqual(['follow', 1]);
  });

  it('DICE_ROLLED：DOM 骰子滚动后落定', async () => {
    useUiStore.getState().clear();
    await run({ type: 'DICE_ROLLED', seat: 0, dice: [2, 5], steps: 7, forced: false, diceCount: 2 }, view);
    expect(useUiStore.getState().dice).toMatchObject({ seat: 0, faces: [2, 5], rolling: false });
  });

  it('MOVE_SEGMENT：从当前格出发逐格行走', async () => {
    const p0 = view.players.find((p) => p.seat === 0)!;
    const calls = await run(
      { type: 'MOVE_SEGMENT', actor: { t: 'seat', seat: 0 }, path: [5, 6, 7], remaining: 0 },
      view,
    );
    expect(calls).toContainEqual(['walk', 0, [p0.node, 5, 6, 7]]);
  });

  it('LAND_BOUGHT：镜头移到地块、插旗、改归属、飘字扣钱', async () => {
    const e: GameEventOf<'LAND_BOUGHT'> = {
      type: 'LAND_BOUGHT',
      seat: 0,
      lot: 'L1',
      price: 2000,
      post: {
        players: [{ seat: 0, set: { cash: view.players[0]!.cash - 2000 } }],
        lands: [{ id: 'L1', set: { owner: 0 } }],
      },
    };
    const calls = await run(e, view);
    const names = calls.map((c) => c[0]);
    expect(names).toContain('plantFlag');
    expect(calls).toContainEqual(['setLot', 'L1', { owner: 0, level: 0 }]);
    expect(calls.find((c) => c[0] === 'floatText')).toEqual(['floatText', { seat: 0 }, '-2,000', 'loss']);
    expect(useUiStore.getState().flashes.at(-1)).toMatchObject({ seat: 0, field: 'cash', delta: -2000 });
  });

  it('TOLL_PAID：金币从付款人飞向地主，双方飘字', async () => {
    const e: GameEventOf<'TOLL_PAID'> = {
      type: 'TOLL_PAID',
      payer: 1,
      owner: 0,
      ally: null,
      amount: 400,
      allyAmount: 0,
      lots: ['L1'],
      mods: [],
      post: {
        players: [
          { seat: 1, set: { cash: view.players[1]!.cash - 400 } },
          { seat: 0, set: { cash: view.players[0]!.cash + 400 } },
        ],
      },
    };
    const calls = await run(e, view);
    expect(calls).toContainEqual(['coinFlight', { seat: 1 }, { seat: 0 }]);
    const floats = calls.filter((c) => c[0] === 'floatText');
    expect(floats).toContainEqual(['floatText', { seat: 1 }, '-400', 'loss']);
    expect(floats).toContainEqual(['floatText', { seat: 0 }, '+400', 'gain']);
  });

  it('LOT_LEVEL：升级弹跳 + Lv 飘字', async () => {
    const calls = await run(
      {
        type: 'LOT_LEVEL',
        lot: 'L1',
        from: 0,
        to: 1,
        cause: { k: 'system', ref: null, by: 0 },
        post: { lands: [{ id: 'L1', set: { level: 1, owner: 0 } }] },
      },
      view,
    );
    expect(calls.map((c) => c[0])).toContain('popBuilding');
    expect(calls).toContainEqual(['floatText', { lot: 'L1' }, 'Lv.1', 'info']);
  });

  it('BANKRUPT：角色沮丧、震屏、横幅', async () => {
    useUiStore.getState().clear();
    const calls = await run(
      { type: 'BANKRUPT', seat: 2, cause: { k: 'toll', ref: null, by: 0 }, creditor: null },
      view,
    );
    expect(calls).toContainEqual(['setActorPose', 2, 'sad']);
    expect(calls.map((c) => c[0])).toContain('shake');
  });

  it('NEWS：演出期间打开新闻弹窗（标题按编号取自 i18n），结束后关闭', async () => {
    const seen: string[] = [];
    const off = usePopupStore.subscribe((st) => {
      if (st.current?.kind === 'news') seen.push(st.current.headline);
    });
    await run({ type: 'NEWS', id: 3, params: {}, affected: [] }, view);
    off();
    expect(seen[0]).toBe('流感疫情升温');
    expect(usePopupStore.getState().current).toBeNull();
  });

  it('自对弈里出现的全部事件都能演出（instant 时钟）', async () => {
    let v = sp.initial.view;
    for (const b of sp.batches) {
      for (const e of b.events) {
        const calls: Call[] = [];
        const h = HANDLERS[e.type] as unknown as (x: GameEvent, c: PresentationContext) => Promise<void>;
        await expect(h(e, ctxFor(v, calls))).resolves.toBeUndefined();
      }
      v = b.view;
    }
    expect(find('DICE_ROLLED')).toBeDefined();
  });
});
