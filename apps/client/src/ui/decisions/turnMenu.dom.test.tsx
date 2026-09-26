// TURN_MENU 行动面板：掷骰与骰子数、背包（不可用置灰 + 原因）→ 选目标 → USE_CARD / USE_ITEM、股票买卖、公布栏、投降
import { CARD, ITEM } from '@rich4/shared/engine';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TurnMenuDialog from './TurnMenuDialog';
import { expectSingleIntent, installResizeObserver, intents, renderDialog } from './testing';

installResizeObserver();

describe('TurnMenuDialog', () => {
  it('默认按当前骰子数掷骰 → ROLL{dice:2}；改成 1 颗 → ROLL{dice:1}', async () => {
    const r = renderDialog(TurnMenuDialog, 'TURN_MENU');
    expect(screen.getByTestId('dice-2')).toHaveAttribute('data-state', 'on');
    expect(screen.getByTestId('dice-3')).toBeDisabled(); // 机车最多 2 颗
    await r.user.click(screen.getByTestId('dice-1'));
    await r.user.dblClick(screen.getByTestId('turn-roll'));
    expectSingleIntent(r.submit, { type: 'ROLL', dice: 1 });
  });

  it('停留中：骰子数锁定，出发 → ROLL（不带 dice）', async () => {
    const r = renderDialog(TurnMenuDialog, 'TURN_MENU', {
      options: { dice: { allowed: [1, 2], current: 2, locked: 'stay' } },
    });
    expect(screen.getByTestId('dice-locked')).toHaveTextContent('停留中');
    expect(screen.getByTestId('dice-1')).toBeDisabled();
    await r.user.click(screen.getByTestId('turn-roll'));
    expectSingleIntent(r.submit, { type: 'ROLL' });
  });

  it('背包：被动卡置灰并显示原因；用均贫卡选对手 → USE_CARD{slot, card, target:seat}', async () => {
    const r = renderDialog(TurnMenuDialog, 'TURN_MENU');
    expect(screen.getByTestId('turn-cards')).toHaveTextContent('可用 6/7');
    await r.user.click(screen.getByTestId('turn-cards'));
    const sheet = await screen.findByTestId('turn-inventory');
    const free = within(sheet).getByTestId('inv-card-4');
    expect(free).toBeDisabled();
    expect(free).toHaveTextContent('被动卡');
    await r.user.click(within(sheet).getByTestId('inv-card-0'));
    const picker = within(sheet).getByTestId('target-picker');
    expect(picker).toHaveAttribute('data-target-kind', 'seat');
    expect(within(picker).getByTestId('target-confirm')).toBeDisabled();
    await r.user.click(within(picker).getByTestId('target-seat-3'));
    await r.user.click(within(picker).getByTestId('target-confirm'));
    expectSingleIntent(r.submit, {
      type: 'USE_CARD',
      slot: 0,
      card: CARD.EQUAL_POVERTY,
      target: { t: 'seat', seat: 3 },
    });
    expect(screen.queryByTestId('turn-inventory')).toBeNull(); // 用完关闭
  });

  it('道具：遥控骰子选点数 → USE_ITEM{dice}；返回可回到背包', async () => {
    const r = renderDialog(TurnMenuDialog, 'TURN_MENU');
    await r.user.click(screen.getByTestId('turn-items'));
    const sheet = await screen.findByTestId('turn-inventory');
    expect(within(sheet).getByTestId(`inv-item-${ITEM.TIME_MACHINE}`)).toHaveTextContent('还没有可以回去的时间点');
    await r.user.click(within(sheet).getByTestId(`inv-item-${ITEM.ROADBLOCK}`));
    await r.user.click(within(sheet).getByTestId('target-cancel'));
    await r.user.click(within(sheet).getByTestId(`inv-item-${ITEM.REMOTE_DICE}`));
    await r.user.click(within(sheet).getByTestId('target-dice-4'));
    await r.user.click(within(sheet).getByTestId('target-confirm'));
    expectSingleIntent(r.submit, { type: 'USE_ITEM', item: ITEM.REMOTE_DICE, target: { t: 'dice', value: 4 } });
  });

  it('股市：选股票、调股数、买入 → STOCK_BUY；非终结操作后新 decisionId 可继续卖出', async () => {
    const r = renderDialog(TurnMenuDialog, 'TURN_MENU');
    await r.user.click(screen.getByTestId('turn-stock'));
    const sheet = await screen.findByTestId('turn-stock-sheet');
    await r.user.click(within(sheet).getByTestId('stock-pick-0'));
    const qty = within(sheet).getByRole('spinbutton', { name: '股数' });
    await r.user.clear(qty);
    await r.user.type(qty, '300');
    await r.user.click(within(sheet).getByTestId('stock-submit'));
    r.rerenderWith({ decision: { ...r.decision, decisionId: 'd-menu-2' } });
    await r.user.click(within(sheet).getByTestId('stock-side-sell'));
    await r.user.click(within(sheet).getByTestId('stock-submit'));
    const all = intents(r.submit);
    expect(all[0]).toEqual({ type: 'STOCK_BUY', stock: 0, shares: 300 });
    expect(all[1]?.type).toBe('STOCK_SELL');
    expect(all).toHaveLength(2);
  });

  it('公布栏：买别人的挂牌 → BOARD_BUY；买不起的禁用', async () => {
    const r = renderDialog(TurnMenuDialog, 'TURN_MENU');
    await r.user.click(screen.getByTestId('turn-board'));
    const sheet = await screen.findByTestId('turn-board-sheet');
    expect(within(sheet).getByTestId('listing-buy-3')).toBeDisabled();
    expect(within(sheet).getByTestId('listing-delist-2')).toBeEnabled();
    await r.user.click(within(sheet).getByTestId('listing-buy-1'));
    expectSingleIntent(r.submit, { type: 'BOARD_BUY', listingId: 1 });
  });

  it('公布栏挂牌：选地产、填价格 → BOARD_LIST；超过估值上限不能挂', async () => {
    const r = renderDialog(TurnMenuDialog, 'TURN_MENU');
    await r.user.click(screen.getByTestId('turn-board'));
    const sheet = await screen.findByTestId('turn-board-sheet');
    await r.user.selectOptions(within(sheet).getByRole('combobox', { name: '地产' }), 'L1');
    const price = within(sheet).getByRole('spinbutton');
    await r.user.clear(price);
    await r.user.type(price, '9500');
    expect(within(sheet).getByTestId('board-list')).toBeDisabled(); // 上限 9000
    await r.user.clear(price);
    await r.user.type(price, '8800');
    await r.user.click(within(sheet).getByTestId('board-list'));
    expectSingleIntent(r.submit, { type: 'BOARD_LIST', asset: { t: 'lot', lot: 'L1' }, price: 8800 });
  });

  it('投降需要二次确认 → SURRENDER', async () => {
    const r = renderDialog(TurnMenuDialog, 'TURN_MENU');
    await r.user.click(screen.getByTestId('turn-surrender'));
    await r.user.click(await screen.findByTestId('surrender-confirm'));
    expectSingleIntent(r.submit, { type: 'SURRENDER' });
  });

  it('不能投降时没有投降按钮；本回合操作次数用完时提示', () => {
    renderDialog(TurnMenuDialog, 'TURN_MENU', {
      options: { canSurrender: false, menuActions: { used: 40, limit: 40 } },
    });
    expect(screen.queryByTestId('turn-surrender')).toBeNull();
    expect(screen.getByText('本回合操作次数已达上限')).toBeInTheDocument();
  });
});
