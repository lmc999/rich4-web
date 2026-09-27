// 对话框 × 真实引擎联调（M4 经济决策）：用引擎场景 DSL 走到真实的决策，按座位视角投影出 view，
// 经 DecisionHost（注册表懒加载）渲染对应对话框，按界面操作得到 intent，再交给引擎执行，断言被接受且效果正确。
// 覆盖 BANK_ATM（路过 / 停下）、BANK_COUNTER、SHOP、LOTTERY、BUY_FACILITY / BUILD_FACILITY / UPGRADE_FACILITY、
// RESEARCH、SUBSCRIBE_SHARES、TURN_MENU 股票买卖；数值语义（金额单位、股价分、下标）以引擎的 options 为准。
import { fixtureRegistry, type MapIndex } from '@rich4/shared/data';
import type { DecisionKind, PlayerIntent, SeatIndex } from '@rich4/shared/engine';
import { decisionForSeat, type Scenario, scenario } from '@rich4/shared/engine-testing';
import { type DecisionForYou, projectState } from '@rich4/shared/view';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DecisionHost } from './DecisionHost';
import { installResizeObserver, intents } from './testing';

installResizeObserver();

interface Mounted {
  submit: ReturnType<typeof vi.fn<(intent: PlayerIntent) => unknown>>;
  user: ReturnType<typeof userEvent.setup>;
  root: HTMLElement;
  rerender(): Promise<HTMLElement>;
}

function mapOf(sc: Scenario): MapIndex {
  return fixtureRegistry.getMap(sc.state.dataRef.mapId);
}

function youOf(sc: Scenario, seat: SeatIndex): DecisionForYou {
  return { ...decisionForSeat(sc.pending(seat)), deadlineAt: null } as DecisionForYou;
}

/** 渲染 seat 当前的真实决策，等懒加载的对话框出现 */
async function mount(sc: Scenario, seat: SeatIndex, kind: DecisionKind): Promise<Mounted> {
  sc.expectAsk(seat, kind);
  const submit = vi.fn<(intent: PlayerIntent) => unknown>(() => undefined);
  const user = userEvent.setup();
  const map = mapOf(sc);
  const el = () => (
    <DecisionHost
      decision={youOf(sc, seat)}
      isMine
      view={projectState(sc.state, { kind: 'seat', seat }, { handVisibility: 'public' })}
      map={map}
      submit={submit}
    />
  );
  const utils = render(el());
  const root = await screen.findByTestId(`decision-${kind}`);
  return {
    submit,
    user,
    root,
    async rerender() {
      utils.rerender(el());
      return screen.findByTestId(`decision-${sc.pending(seat).kind}`);
    },
  };
}

/** 取对话框提交的最后一个 intent 交给引擎（不合法时引擎会抛错，测试失败） */
function commit(sc: Scenario, seat: SeatIndex, m: Mounted): PlayerIntent {
  const all = intents(m.submit);
  const last = all.at(-1);
  if (!last) throw new Error('dialog submitted nothing');
  sc.act(seat, last);
  return last;
}

describe('真实引擎 options → 对话框 → intent → 引擎', () => {
  it('BANK_ATM（路过）：存 30000 → ATM{deposit}，引擎继续走完剩余步数', async () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    // 终点 3 号格是命运格（M7 起生效）：预置一张不动现金、存款的命运（3 跳票：银行拒绝往来）
    sc.stackDeck('fate', [3]);
    sc.teleport(0, 18, 17).force('dice', 3).roll(0);
    const m = await mount(sc, 0, 'BANK_ATM');
    expect(within(m.root).getByTestId('bank-cash')).toHaveTextContent('100,000');
    const amount = within(m.root).getByRole('spinbutton', { name: '金额' });
    await m.user.clear(amount);
    await m.user.type(amount, '30000');
    await m.user.click(within(m.root).getByTestId('bank-confirm'));
    expect(commit(sc, 0, m)).toEqual({ type: 'ATM', op: 'deposit', amount: 30000 });
    expect(sc.player(0)).toMatchObject({ node: 3, cash: 70000, deposit: 130000 });
  });

  it('BANK_ATM（停下）取一半 → BANK_COUNTER 贷满额度 → LOAN{loanLimit}', async () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.teleport(0, 18, 17).force('dice', 1).roll(0);
    const atm = await mount(sc, 0, 'BANK_ATM');
    await atm.user.click(within(atm.root).getByTestId('bank-op-withdraw'));
    await atm.user.click(within(atm.root).getByRole('button', { name: '一半' }));
    await atm.user.click(within(atm.root).getByTestId('bank-confirm'));
    expect(commit(sc, 0, atm)).toEqual({ type: 'ATM', op: 'withdraw', amount: 50000 });
    expect(sc.player(0)).toMatchObject({ cash: 150000, deposit: 50000 });

    const counter = await atm.rerender();
    expect(counter).toHaveAttribute('data-testid', 'decision-BANK_COUNTER');
    const limit = (sc.pending(0).options as { loanLimit: number }).loanLimit;
    expect(within(counter).getByTestId('counter-limit')).toHaveTextContent(limit.toLocaleString('en-US'));
    await atm.user.click(within(counter).getByRole('button', { name: '全部' }));
    await atm.user.click(within(counter).getByTestId('bank-confirm'));
    expect(commit(sc, 0, atm)).toEqual({ type: 'LOAN', amount: limit });
    expect(sc.player(0)).toMatchObject({ loan: limit, deposit: 50000 + limit });
  });

  it('SHOP：买货架上的卡、买道具、离开；每笔交易后以新 decisionId 重发，界面随之刷新', async () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.apply({ type: 'SYS_DEBUG', op: { op: 'setPoints', seat: 0, points: 500 } });
    sc.force('shelf', 3).teleport(0, 9, 8).force('dice', 1).roll(0);
    const m = await mount(sc, 0, 'SHOP');
    expect(within(m.root).getByTestId('shop-points')).toHaveTextContent('500');
    const shelf = (sc.pending(0).options as { shelf: { idx: number; card: number; price: number }[] }).shelf;
    const first = shelf[0]!;
    await m.user.click(within(m.root).getByTestId(`shop-shelf-${first.idx}`));
    await m.user.click(within(m.root).getByTestId('shop-buy-card'));
    expect(commit(sc, 0, m)).toEqual({ type: 'SHOP_BUY_CARD', shelfIdx: first.idx });
    expect(sc.player(0)).toMatchObject({ points: 500 - first.price, cards: [first.card] });
    const left = 500 - first.price;

    // 道具 8（价格 30、已有 1 个）→ 默认数量 1
    const again = await m.rerender();
    expect(within(again).getByTestId('shop-points')).toHaveTextContent(String(left));
    await m.user.click(within(again).getByRole('tab', { name: '买道具' }));
    await m.user.click(within(again).getByTestId('shop-item-8'));
    await m.user.click(within(again).getByTestId('shop-buy-item'));
    const bought = commit(sc, 0, m) as { type: string; item: number; qty: number };
    expect(bought).toMatchObject({ type: 'SHOP_BUY_ITEM', item: 8 });
    expect(sc.player(0).points).toBe(left - 30 * bought.qty);
    const third = await m.rerender();
    expect(within(third).getByTestId('shop-points')).toHaveTextContent(String(left - 30 * bought.qty));
    await m.user.click(within(third).getByTestId('shop-leave'));
    expect(commit(sc, 0, m)).toEqual({ type: 'LEAVE' });
    sc.expectNoAsk(0, 'SHOP');
  });

  it('LOTTERY：选 5 号 → LOTTERY_BUY{number:4}（下标），只扣现金 1000', async () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.teleport(0, 7, 6).force('dice', 1).roll(0);
    const m = await mount(sc, 0, 'LOTTERY');
    await m.user.click(within(m.root).getByTestId('lottery-ball-5'));
    await m.user.click(within(m.root).getByTestId('lottery-buy'));
    expect(commit(sc, 0, m)).toEqual({ type: 'LOTTERY_BUY', number: 4 });
    expect(sc.event('LOTTERY_TICKET')).toMatchObject({ seat: 0, number: 4 });
    expect(sc.player(0).cash).toBe(99000);
  });

  it('BUY_FACILITY → BUILD_FACILITY（旅馆）→ UPGRADE_FACILITY：三次停在 F1', async () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.teleport(0, 16, 15).force('dice', 1).roll(0);
    const buy = await mount(sc, 0, 'BUY_FACILITY');
    expect(within(buy.root).getByTestId('buy-price')).toHaveTextContent('4,000');
    await buy.user.click(within(buy.root).getByTestId('buy-confirm'));
    expect(commit(sc, 0, buy)).toEqual({ type: 'CONFIRM' });
    buy.root.ownerDocument.body.innerHTML = '';

    sc.untilMenu(0).teleport(0, 16, 15).force('dice', 1).roll(0);
    const build = await mount(sc, 0, 'BUILD_FACILITY');
    expect(within(build.root).getByTestId('facility-cost')).toHaveTextContent('4,000');
    await build.user.click(within(build.root).getByTestId('facility-type-hotel'));
    await build.user.click(within(build.root).getByTestId('facility-confirm'));
    expect(commit(sc, 0, build)).toEqual({ type: 'BUILD_FACILITY', facility: 'hotel' });
    expect(sc.state.facilities[0]).toMatchObject({ level: 1, type: 'hotel', owner: 0 });
    build.root.ownerDocument.body.innerHTML = '';

    sc.untilMenu(0).teleport(0, 16, 15).force('dice', 1).roll(0);
    const up = await mount(sc, 0, 'UPGRADE_FACILITY');
    expect(within(up.root).getByTestId('upgrade-cost')).toHaveTextContent('800');
    await up.user.click(within(up.root).getByTestId('upgrade-confirm'));
    expect(commit(sc, 0, up)).toEqual({ type: 'CONFIRM' });
    expect(sc.state.facilities[0]!.level).toBe(2);
  });

  it('RESEARCH：自己的 2 级研究所，选项目 2 → RESEARCH{project:2}', async () => {
    const sc = scenario({ players: ['human', 'human'] })
      .untilMenu(0)
      .edit((s) => {
        Object.assign(s.facilities[0]!, { owner: 0, level: 2, type: 'lab' });
      });
    sc.teleport(0, 16, 15).force('dice', 1).roll(0).expectAsk(0, 'UPGRADE_FACILITY').decline(0);
    const m = await mount(sc, 0, 'RESEARCH');
    await m.user.click(within(m.root).getByTestId('research-2'));
    await m.user.click(within(m.root).getByTestId('research-confirm'));
    expect(commit(sc, 0, m)).toEqual({ type: 'RESEARCH', project: 2 });
    expect(sc.event('RESEARCH_STARTED')).toMatchObject({ seat: 0, project: 2 });
  });

  it('SUBSCRIBE_SHARES：企业地产格认购，合计 = 单价 × 股数，只用现金', async () => {
    const sc = scenario({ map: 'test-allkinds', players: ['human', 'human', 'human'] }).untilMenu(0);
    sc.teleport(0, 23, 22).force('dice', 1).roll(0);
    const m = await mount(sc, 0, 'SUBSCRIBE_SHARES');
    const o = sc.pending(0).options as { unitPrice: number; max: number };
    await m.user.click(within(m.root).getByTestId('subscribe-confirm'));
    const intent = commit(sc, 0, m) as { type: 'SUBSCRIBE'; shares: number };
    expect(intent.type).toBe('SUBSCRIBE');
    expect(intent.shares).toBeGreaterThan(0);
    expect(intent.shares).toBeLessThanOrEqual(o.max);
    expect(sc.player(0).cash).toBe(100000 - o.unitPrice * intent.shares);
    expect(sc.player(0).holdings[1]?.shares).toBe(intent.shares);
  });

  it('TURN_MENU 股市：买 300 股测试银行 → STOCK_BUY（存款扣款）；重发菜单后卖出', async () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    const m = await mount(sc, 0, 'TURN_MENU');
    await m.user.click(within(m.root).getByTestId('turn-stock'));
    const sheet = await screen.findByTestId('turn-stock-sheet');
    await m.user.click(within(sheet).getByTestId('stock-pick-0'));
    const qty = within(sheet).getByRole('spinbutton', { name: '股数' });
    await m.user.clear(qty);
    await m.user.type(qty, '300');
    const price = sc.state.stocks[0]!.priceCents;
    const amount = Math.trunc((price * 300) / 100);
    expect(within(sheet).getByTestId('stock-amount')).toHaveTextContent(amount.toLocaleString('en-US'));
    await m.user.click(within(sheet).getByTestId('stock-submit'));
    expect(commit(sc, 0, m)).toEqual({ type: 'STOCK_BUY', stock: 0, shares: 300 });
    expect(sc.player(0).holdings[0]?.shares).toBe(300);
    expect(sc.player(0).deposit).toBe(100000 - amount);

    await m.rerender();
    const sheet2 = await screen.findByTestId('turn-stock-sheet');
    await m.user.click(within(sheet2).getByTestId('stock-pick-0'));
    await m.user.click(within(sheet2).getByTestId('stock-side-sell'));
    const qty2 = within(sheet2).getByRole('spinbutton', { name: '股数' });
    await m.user.clear(qty2);
    await m.user.type(qty2, '100');
    await m.user.click(within(sheet2).getByTestId('stock-submit'));
    expect(commit(sc, 0, m)).toEqual({ type: 'STOCK_SELL', stock: 0, shares: 100 });
    expect(sc.player(0).holdings[0]?.shares).toBe(200);
  });
});
