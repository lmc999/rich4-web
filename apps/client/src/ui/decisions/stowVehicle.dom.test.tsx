// 程序化回合菜单的「收起交通工具」（STOW_VEHICLE）× 真实引擎：机车 / 汽车开局时道具页顶部「正在使用」旁有
// 「收起X，改为步行」，点下去提交 STOW_VEHICLE 并关上背包；引擎接受后改回步行、骰子只剩 1 颗、车进背包。
// 步行、旧存档（options 没有 vehicle）不显示按钮。
import { fixtureRegistry } from '@rich4/shared/data';
import type { PlayerIntent, SeatIndex, TurnMenuOptions } from '@rich4/shared/engine';
import { decisionForSeat, type Scenario, scenario } from '@rich4/shared/engine-testing';
import { type DecisionForYou, projectState } from '@rich4/shared/view';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DecisionHost } from './DecisionHost';
import { installResizeObserver, intents } from './testing';

installResizeObserver();
afterEach(() => cleanup());

function setup(vehicle: 'walk' | 'moto' | 'car'): Scenario {
  return scenario({ players: ['human', 'human'], config: { vehicle } }).untilMenu(0);
}

async function mount(sc: Scenario, patch?: (o: TurnMenuOptions) => TurnMenuOptions, seat: SeatIndex = 0) {
  const d = { ...decisionForSeat(sc.pending(seat)), deadlineAt: null } as DecisionForYou<'TURN_MENU'>;
  const decision = patch ? { ...d, options: patch(d.options) } : d;
  const submit = vi.fn<(intent: PlayerIntent) => unknown>(() => undefined);
  const user = userEvent.setup();
  render(
    <DecisionHost
      decision={decision as DecisionForYou}
      isMine
      view={projectState(sc.state, { kind: 'seat', seat }, { handVisibility: 'public' })}
      map={fixtureRegistry.getMap(sc.state.dataRef.mapId)}
      submit={submit}
    />,
  );
  await screen.findByTestId('decision-TURN_MENU');
  await user.click(screen.getByTestId('turn-items'));
  const sheet = await screen.findByTestId('turn-inventory');
  return { submit, user, sheet };
}

describe('程序化回合菜单：收起交通工具', () => {
  it.each([
    ['car', '汽车', 6],
    ['moto', '机车', 5],
  ] as const)(
    '%s 开局：道具页「收起%s，改为步行」→ STOW_VEHICLE，关上背包；引擎接受后 1 颗骰子',
    async (vehicle, name, item) => {
      const sc = setup(vehicle);
      const m = await mount(sc);
      expect(within(m.sheet).getByTestId('inv-vehicle')).toHaveTextContent(name);
      const btn = within(m.sheet).getByTestId('inv-stow-vehicle');
      expect(btn).toHaveTextContent(`收起${name}，改为步行`);
      expect(btn).toBeEnabled();
      await m.user.click(btn);
      expect(intents(m.submit)).toEqual([{ type: 'STOW_VEHICLE' }]);
      expect(screen.queryByTestId('turn-inventory')).toBeNull();

      sc.act(0, { type: 'STOW_VEHICLE' });
      expect(sc.player(0)).toMatchObject({ vehicle: 'walk', diceCount: 1 });
      cleanup();
      const again = await mount(sc);
      expect(within(again.sheet).queryByTestId('inv-vehicle')).toBeNull();
      expect(within(again.sheet).queryByTestId('inv-stow-vehicle')).toBeNull();
      expect(within(again.sheet).getByTestId(`inv-item-${item}`)).toBeEnabled();
      // 骰子数只剩 1 颗
      expect(screen.getByTestId('dice-1')).toBeEnabled();
      expect(screen.getByTestId('dice-2')).toBeDisabled();
      expect(screen.getByTestId('dice-3')).toBeDisabled();
    },
  );

  it('步行、旧存档（options 没有 vehicle）不显示按钮', async () => {
    const walk = await mount(setup('walk'));
    expect(within(walk.sheet).queryByTestId('inv-stow-vehicle')).toBeNull();
    cleanup();
    const old = await mount(setup('car'), (o) => {
      const { vehicle: _drop, ...rest } = o;
      return rest;
    });
    expect(within(old.sheet).getByTestId('inv-vehicle')).toHaveTextContent('汽车');
    expect(within(old.sheet).queryByTestId('inv-stow-vehicle')).toBeNull();
  });
});
