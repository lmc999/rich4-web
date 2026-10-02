// 原版道具欄右下角的「收起交通工具」（STOW_VEHICLE）× 真实引擎：机车 / 汽车开局时第 15 格画 Panel#11 图15 / 16
// （欄内 (325,117)），悬停在消息框写说明，点一下直接提交并收起回合菜单，引擎接受后改回步行、车进背包；
// 步行、工程车、卡片欄、旧存档（options 没有 vehicle）都不出现这一格。
import { fixtureRegistry } from '@rich4/shared/data';
import type { PlayerIntent, SeatIndex, TurnMenuOptions } from '@rich4/shared/engine';
import { decisionForSeat, type Scenario, scenario } from '@rich4/shared/engine-testing';
import { type DecisionForYou, projectState } from '@rich4/shared/view';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'motion/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSkinStoreForTest } from '../../../skin/skinStore';
import { useGameStore } from '../../../store/gameStore';
import { installResizeObserver, intents } from '../../decisions/testing';
import { TurnMenuSheetContext, type TurnMenuSheetControl } from '../../decisions/turnMenuSheet';
import { resetClassicAssetsForTest } from '../assets';
import { installSceneAssets } from '../common/testing';
import { ClassicDecisionHost } from '../decisions/ClassicDecisionHost';
import { gridCellRect, STOW_CELL } from './parts';
import { a11FakeSheets, a11PackClient } from './testing';

installResizeObserver();

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});
afterAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});
beforeEach(() => {
  installSceneAssets({ sprites: a11FakeSheets() });
});
afterEach(() => {
  cleanup();
  useGameStore.getState().clear();
  resetClassicAssetsForTest();
  resetSkinStoreForTest();
});

function setup(vehicle: 'walk' | 'moto' | 'car'): Scenario {
  return scenario({ players: ['human', 'human'], map: 'test', config: { vehicle } }).untilMenu(0);
}

interface Mounted {
  submit: ReturnType<typeof vi.fn<(intent: PlayerIntent) => unknown>>;
  user: ReturnType<typeof userEvent.setup>;
  root: HTMLElement;
  sheet: TurnMenuSheetControl;
}

/** 渲染 seat 的 TURN_MENU（原版宿主），经工具列请求直接打开道具欄；patch 可以改 options（模拟旧存档） */
async function mountItems(
  sc: Scenario,
  seat: SeatIndex = 0,
  patch?: (o: TurnMenuOptions) => TurnMenuOptions,
): Promise<Mounted> {
  sc.expectAsk(seat, 'TURN_MENU');
  const d = { ...decisionForSeat(sc.pending(seat)), deadlineAt: null } as DecisionForYou<'TURN_MENU'>;
  const decision = patch ? { ...d, options: patch(d.options) } : d;
  const submit = vi.fn<(intent: PlayerIntent) => unknown>(() => undefined);
  const sheet: TurnMenuSheetControl = { request: 'items', consume: vi.fn(), collapse: vi.fn() };
  render(
    <TurnMenuSheetContext.Provider value={sheet}>
      <ClassicDecisionHost
        decision={decision as DecisionForYou}
        isMine
        view={projectState(sc.state, { kind: 'seat', seat }, { handVisibility: 'public' })}
        map={fixtureRegistry.getMap(sc.state.dataRef.mapId)}
        submit={submit}
        packId="test-pack"
        client={a11PackClient()}
      />
    </TurnMenuSheetContext.Provider>,
  );
  const root = await screen.findByTestId('decision-TURN_MENU', undefined, { timeout: 8000 });
  expect(root).toHaveAttribute('data-scene', 'classic');
  expect(root).toHaveAttribute('data-tab', 'items');
  return { submit, user: userEvent.setup(), root, sheet };
}

describe('原版道具欄：收起交通工具', { timeout: 30_000 }, () => {
  it.each([
    ['moto', 15, 5, '机车'],
    ['car', 16, 6, '汽车'],
  ] as const)(
    '%s 开局：右下角那一格画图 %i，悬停看说明，点一下 → STOW_VEHICLE，收起回合菜单；引擎接受后步行、车进背包',
    async (vehicle, frame, item, name) => {
      const sc = setup(vehicle);
      const m = await mountItems(sc);
      const cell = within(m.root).getByTestId('inv-stow-vehicle');
      const r = gridCellRect(STOW_CELL.at);
      expect(STOW_CELL.at).toBe(14);
      expect(cell).toHaveStyle({ left: `${r.x}px`, top: `${r.y}px` });
      expect(cell).toBeEnabled();
      expect(cell).toHaveAttribute('aria-label', `收起${name}`);
      expect(within(cell).getByTestId('stow-vehicle-icon')).toHaveAttribute('data-sprite', `ui.itemBar/${frame}`);
      // 开局道具（1/2/3/4/8/9）按顺序占前 6 格，第 14 格空着
      expect(within(m.root).getAllByTestId(/^inv-item-/)).toHaveLength(6);

      await m.user.hover(cell);
      const info = within(m.root).getByTestId('turn-info');
      expect(info).toHaveTextContent(`收起${name}`);
      expect(info).toHaveTextContent('改回步行，只掷 1 颗骰子');

      await m.user.click(cell);
      expect(intents(m.submit)).toEqual([{ type: 'STOW_VEHICLE' }]);
      expect(m.sheet.collapse).toHaveBeenCalled();
      sc.act(0, { type: 'STOW_VEHICLE' });
      expect(sc.player(0)).toMatchObject({ vehicle: 'walk', diceCount: 1 });
      expect(sc.player(0).items[item]).toBe(1);

      // 引擎重发的回合菜单：没有这一格了，收起的车出现在道具欄里（可以再装上）
      cleanup();
      const again = await mountItems(sc);
      expect(within(again.root).queryByTestId('inv-stow-vehicle')).toBeNull();
      expect(within(again.root).getByTestId(`inv-item-${item}`)).toBeEnabled();
    },
  );

  it('步行、工程车、卡片欄、旧存档（options 没有 vehicle）都没有这一格', async () => {
    const walk = await mountItems(setup('walk'));
    expect(within(walk.root).queryByTestId('inv-stow-vehicle')).toBeNull();
    cleanup();

    const eng = setup('moto');
    eng.give(0, { items: [{ item: 12, qty: 1 }] });
    eng.useItem(0, 12);
    const e = await mountItems(eng);
    expect(within(e.root).queryByTestId('inv-stow-vehicle')).toBeNull();
    cleanup();

    const car = await mountItems(setup('car'));
    await car.user.click(within(car.root).getByTestId('turn-cards'));
    expect(car.root).toHaveAttribute('data-tab', 'cards');
    expect(within(car.root).queryByTestId('inv-stow-vehicle')).toBeNull();
    cleanup();

    const old = await mountItems(setup('car'), 0, (o) => {
      const { vehicle: _drop, ...rest } = o;
      return rest;
    });
    expect(within(old.root).queryByTestId('inv-stow-vehicle')).toBeNull();
  });
});
