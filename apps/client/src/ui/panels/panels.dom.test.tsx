// 信息面板：InventoryPanel 置灰逻辑、StockPanel 金额与盈亏、PlayerInfoPanel 汇总（与 shared netWorth 一致）、
// PropertyListPanel 筛选与过路费、BankPanel、TileInfoPopover
import { CARD, calcToll, ITEM, netWorth } from '@rich4/shared/engine';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { formatInt, stockAmount } from '../components/format';
import { demoTurnMenu } from '../decisions/devFixtures';
import { fixture, installResizeObserver } from '../decisions/testing';
import { BankPanel } from './BankPanel';
import { InventoryPanel } from './InventoryPanel';
import { counterDays, PlayerInfoPanel, summarizePlayer } from './PlayerInfoPanel';
import { filterRows, PropertyListPanel, propertyRows } from './PropertyListPanel';
import { holdingValue, StockPanel, viewStockRows } from './StockPanel';
import { TileInfoPopover } from './TileInfoPopover';

installResizeObserver();

describe('InventoryPanel', () => {
  it('本人回合：不可用的卡置灰并显示引擎给的原因，可用的能点', async () => {
    const fx = fixture();
    const menu = demoTurnMenu(fx.view);
    menu.cards[1] = { ...menu.cards[1]!, usable: false, reason: 'investBlocked' };
    const onUseCard = vi.fn();
    render(<InventoryPanel view={fx.view} map={fx.map} seat={0} menu={menu} onUseCard={onUseCard} />);
    const angel = screen.getByTestId('inv-card-1');
    expect(angel).toBeDisabled();
    expect(angel).toHaveTextContent('神明作祟，禁止投资');
    expect(angel).toHaveAttribute('data-disabled', 'true');
    const free = screen.getByTestId('inv-card-4');
    expect(free).toBeDisabled();
    expect(free).toHaveTextContent('被动卡');
    expect(screen.getByRole('tab', { name: '卡片 5/7' })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByTestId('inv-card-5'));
    expect(onUseCard).toHaveBeenCalledWith(expect.objectContaining({ slot: 5, card: CARD.RED }));
  });

  it('整体禁用（已提交 / 超时）时连可用的也不能点', () => {
    const fx = fixture();
    render(
      <InventoryPanel view={fx.view} map={fx.map} seat={0} menu={demoTurnMenu(fx.view)} disabled onUseCard={vi.fn()} />,
    );
    expect(screen.getByTestId('inv-card-0')).toBeDisabled();
  });

  it('道具 Tab：数量徽标、不可用原因；查看模式列出持有道具与交通工具', async () => {
    const fx = fixture();
    const { unmount } = render(<InventoryPanel view={fx.view} map={fx.map} seat={0} menu={demoTurnMenu(fx.view)} />);
    await userEvent.setup().click(screen.getByRole('tab', { name: /道具/ }));
    expect(screen.getByTestId(`inv-item-${ITEM.ROADBLOCK}`)).toHaveTextContent('2');
    const tm = screen.getByTestId(`inv-item-${ITEM.TIME_MACHINE}`);
    expect(tm).toHaveAttribute('data-disabled', 'true');
    expect(tm).toHaveTextContent('还没有可以回去的时间点');
    unmount();
    render(<InventoryPanel view={fx.view} map={fx.map} seat={1} tab="items" />);
    expect(screen.getByTestId(`inv-item-${ITEM.MINE}`)).not.toHaveAttribute('disabled');
    expect(screen.getByTestId('inv-vehicle')).toHaveTextContent('汽车');
  });

  it('私密手牌：对手只显示张数', () => {
    const fx = fixture();
    const view = { ...fx.view, players: fx.view.players.map((p) => (p.seat === 1 ? { ...p, cards: null } : p)) };
    render(<InventoryPanel view={view} map={fx.map} seat={1} />);
    expect(screen.getByText('手牌不公开（3 张）')).toBeInTheDocument();
  });
});

describe('StockPanel', () => {
  it('金额 = trunc(价 × 股数 / 100)，交易后存款，买入 → onTrade', async () => {
    const fx = fixture();
    const menu = demoTurnMenu(fx.view);
    const onTrade = vi.fn();
    render(<StockPanel view={fx.view} map={fx.map} seat={0} market={menu.stock} onTrade={onTrade} />);
    const user = userEvent.setup();
    const row = menu.stock.rows[3]!;
    await user.click(screen.getByTestId('stock-pick-3'));
    const qty = screen.getByRole('spinbutton', { name: '股数' });
    await user.clear(qty);
    await user.type(qty, '123');
    const amount = stockAmount(row.priceCents, 123);
    expect(screen.getByTestId('stock-amount')).toHaveTextContent(formatInt(amount));
    expect(screen.getByTestId('stock-deposit-after')).toHaveTextContent(formatInt(menu.stock.deposit - amount));
    await user.click(screen.getByTestId('stock-submit'));
    expect(onTrade).toHaveBeenCalledWith({ type: 'STOCK_BUY', stock: row.idx, shares: 123 });
  });

  it('涨停不能买、跌停不能卖、停牌不能交易；休市时提示原因', async () => {
    const fx = fixture();
    const menu = demoTurnMenu(fx.view);
    const { unmount } = render(
      <StockPanel view={fx.view} map={fx.map} seat={0} market={menu.stock} onTrade={vi.fn()} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId('stock-pick-1'));
    expect(screen.getByText('涨停无法买进')).toBeInTheDocument();
    expect(screen.getByTestId('stock-submit')).toBeDisabled();
    await user.click(screen.getByTestId('stock-pick-5'));
    expect(within(screen.getByTestId('stock-trade')).getByText('停牌中')).toBeInTheDocument();
    unmount();
    render(
      <StockPanel
        view={fx.view}
        map={fx.map}
        seat={0}
        market={{ ...menu.stock, open: false, reason: 'sunday' }}
        onTrade={vi.fn()}
      />,
    );
    expect(screen.getByTestId('stock-market-state')).toHaveTextContent('星期日休市');
  });

  it('只读行情：盈亏 = 市值 − 成本，持股市值合计；Sparkline 取最近 30 天', () => {
    const fx = fixture();
    render(<StockPanel view={fx.view} map={fx.map} seat={0} />);
    const rows = viewStockRows(fx.view, 0);
    const held = rows.find((r) => r.shares > 0)!;
    const hv = holdingValue(held);
    expect(hv.value).toBe(stockAmount(held.priceCents, held.shares));
    expect(screen.getByTestId(`stock-pnl-${held.idx}`)).toHaveTextContent(formatInt(Math.abs(hv.pnl)));
    const total = rows.reduce((s, r) => s + stockAmount(r.priceCents, r.shares), 0);
    expect(screen.getByTestId('stock-total-value')).toHaveTextContent(formatInt(total));
    for (const sp of screen.getAllByTestId('sparkline')) expect(sp).toHaveAttribute('data-points', '30');
  });
});

describe('PlayerInfoPanel', () => {
  it('汇总与 shared netWorth 一致；显示神明、状态与地产', () => {
    const fx = fixture();
    render(<PlayerInfoPanel view={fx.view} map={fx.map} seat={0} />);
    const sum = summarizePlayer(fx.view, fx.map, 0)!;
    expect(sum.netWorth).toBe(netWorth(fx.view, fx.map, 0));
    expect(screen.getByTestId('info-net-worth')).toHaveTextContent(formatInt(sum.netWorth));
    expect(screen.getByTestId('info-cash')).toHaveTextContent('48,800');
    expect(screen.getByTestId('player-info')).toHaveTextContent('大财神');
    expect(screen.getByTestId('info-lots')).toHaveTextContent('Lv5');
    expect(sum.lands).toBe(2);
    expect(sum.houses).toBe(7);
  });

  it('状态天数按两段式编码显示 (c & 0x7f) + 1（与引擎 displayRemaining 一致）', () => {
    const fx = fixture();
    render(<PlayerInfoPanel view={fx.view} map={fx.map} seat={2} />);
    expect(screen.getByTestId('player-info')).toHaveTextContent('坐牢 · 4 天');
    expect(counterDays(0)).toBe(0);
    expect(counterDays(3)).toBe(4);
    expect(counterDays(0x80)).toBe(1);
  });
});

describe('PropertyListPanel', () => {
  it('按地主筛选；对观察者显示过路费（shared calcToll）', async () => {
    const fx = fixture();
    const rows = propertyRows(fx.view);
    expect(rows).toHaveLength(8); // 5 住宅 + 1 设施 + 2 企业
    expect(filterRows(rows, 'none').map((r) => r.id)).toEqual(['L3']);
    render(<PropertyListPanel view={fx.view} map={fx.map} viewer={0} />);
    expect(screen.getByTestId('property-toll-L2')).toHaveTextContent(formatInt(calcToll(fx.view, fx.map, 'L2', 0)));
    expect(screen.getByTestId('property-toll-L1')).toHaveTextContent('—'); // 自己的地
    expect(screen.getByTestId('property-L2')).toHaveTextContent('涨价');
    await userEvent.setup().selectOptions(screen.getByLabelText('地主'), '0');
    expect(screen.queryByTestId('property-L2')).toBeNull();
    expect(screen.getByTestId('property-L5')).toBeInTheDocument();
  });
});

describe('BankPanel', () => {
  it('显示存款、贷款与到期日', () => {
    const fx = fixture();
    render(<BankPanel view={fx.view} seat={2} />);
    expect(screen.getByTestId('bank-loan')).toHaveTextContent('30,000');
    expect(screen.getByText(/贷款 1998\/6\/10 到期/)).toBeInTheDocument();
  });

  it('无贷款时显示下次计息日', () => {
    const fx = fixture();
    render(<BankPanel view={fx.view} seat={0} />);
    expect(screen.getByText(/下次 1998\/4\/1/)).toBeInTheDocument();
  });
});

describe('TileInfoPopover', () => {
  it('地产格：地主、等级、对观察者的过路费；格上的物件', () => {
    const fx = fixture();
    const onClose = vi.fn();
    const { rerender } = render(
      <TileInfoPopover view={fx.view} map={fx.map} tile={6} at={{ x: 100, y: 100 }} viewer={0} onClose={onClose} />,
    );
    const info = screen.getByTestId('tile-info');
    expect(info).toHaveTextContent('阿土伯');
    expect(screen.getByTestId('tile-toll')).toHaveTextContent(formatInt(calcToll(fx.view, fx.map, 'L2', 0)));
    rerender(
      <TileInfoPopover view={fx.view} map={fx.map} tile={12} at={{ x: 10, y: 10 }} viewer={0} onClose={onClose} />,
    );
    expect(screen.getByTestId('tile-things')).toHaveTextContent('路障');
  });

  it('无主地显示标价；tile=null 时关闭', () => {
    const fx = fixture();
    const { rerender } = render(
      <TileInfoPopover view={fx.view} map={fx.map} tile={7} at={{ x: 1, y: 1 }} viewer={0} onClose={vi.fn()} />,
    );
    expect(screen.getByTestId('tile-buy-price')).toHaveTextContent('2,000');
    rerender(<TileInfoPopover view={fx.view} map={fx.map} tile={null} at={null} viewer={0} onClose={vi.fn()} />);
    expect(screen.queryByTestId('tile-info')).toBeNull();
  });
});
