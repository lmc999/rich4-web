// 第一组场所屏（client-dom）× 真实引擎：用引擎场景 DSL 走到真实决策，按座位视角投影出 view，渲染原版场景，
// 按场景里的原版热区 / 按钮操作得到 intent，再交给引擎执行，断言被接受且效果正确。
// 覆盖 BANK_ATM（路过 / 停下）、BANK_COUNTER（贷款、只读）、SHOP（买卡、买道具、离开）、LOTTERY（选号确认、机选、不买）、
// TURN_MENU 股票子页（工具列快捷入口打开股市场景、买入、重发后卖出、EXIT 收起）；注册表与宿主回退；乐透开奖演出。
import { fixtureRegistry, type MapIndex } from '@rich4/shared/data';
import type { DecisionKind, ItemId, PlayerIntent, SeatIndex } from '@rich4/shared/engine';
import { decisionForSeat, type Scenario, scenario } from '@rich4/shared/engine-testing';
import { type DecisionForYou, projectState } from '@rich4/shared/view';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MotionGlobalConfig } from 'motion/react';
import { type ComponentType, type ReactElement, type ReactNode, useMemo, useState } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import TurnMenuDialog from '../../../decisions/TurnMenuDialog';
import { installResizeObserver, intents } from '../../../decisions/testing';
import { TurnMenuSheetContext, type TurnMenuSheetControl } from '../../../decisions/turnMenuSheet';
import type { DecisionProps } from '../../../decisions/types';
import type { LotteryPopupSpec } from '../../../popups/popupStore';
import { resetClassicAssetsForTest } from '../../assets';
import { fakePackClient, installSceneAssets } from '../../common/testing';
import { ClassicDecisionHost, type SceneGateState } from '../../decisions/ClassicDecisionHost';
import { CLASSIC_REGISTRY_CONFLICTS, classicDecisionRegistry } from '../../decisions/registry';
import { resolveRequiredKeys, sceneLoader } from '../../decisions/scene';
import BankAtmScene from './BankAtm';
import BankCounterScene from './BankCounter';
import { classicVenuesA } from './index';
import LotteryBetScene from './LotteryBet';
import { ClassicLotteryDraw, LOTTERY_DRAW_KEYS, LotteryDrawScene } from './LotteryDraw';
import ShopScene from './Shop';
import { STOCK_KEYS } from './StockMarket';
import { ClassicStockSheet } from './TurnMenuStock';
import { fakeVenueSheets } from './testing';

installResizeObserver();

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});
afterAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});
beforeEach(() => {
  installSceneAssets({ sprites: fakeVenueSheets() });
});
afterEach(() => {
  resetClassicAssetsForTest();
});

type Submit = ReturnType<typeof vi.fn<(intent: PlayerIntent) => unknown>>;

interface Mounted {
  submit: Submit;
  user: ReturnType<typeof userEvent.setup>;
  root: HTMLElement;
  /** 以当前待决策重新渲染（新的 decisionId），返回场景根 */
  rerender(testId?: string): Promise<HTMLElement>;
}

function mapOf(sc: Scenario): MapIndex {
  return fixtureRegistry.getMap(sc.state.dataRef.mapId);
}

function youOf(sc: Scenario, seat: SeatIndex): DecisionForYou {
  return { ...decisionForSeat(sc.pending(seat)), deadlineAt: null } as DecisionForYou;
}

async function mount<K extends DecisionKind>(
  sc: Scenario,
  seat: SeatIndex,
  kind: K,
  Comp: ComponentType<DecisionProps<K>>,
  o: { isMine?: boolean; wrap?: (el: ReactElement) => ReactElement; testId?: string; extra?: object } = {},
): Promise<Mounted> {
  sc.expectAsk(seat, kind);
  const submit = vi.fn<(intent: PlayerIntent) => unknown>(() => undefined);
  const user = userEvent.setup();
  const map = mapOf(sc);
  const el = (): ReactElement => {
    const inner = (
      <Comp
        decision={youOf(sc, seat) as DecisionForYou<K>}
        isMine={o.isMine ?? true}
        view={projectState(sc.state, { kind: 'seat', seat }, { handVisibility: 'public' })}
        map={map}
        submit={submit}
        {...o.extra}
      />
    );
    return o.wrap ? o.wrap(inner) : inner;
  };
  const utils = render(el());
  const root = await screen.findByTestId(o.testId ?? `decision-${kind}`, undefined, { timeout: 8000 });
  return {
    submit,
    user,
    root,
    async rerender(testId) {
      utils.rerender(el());
      return screen.findByTestId(testId ?? `decision-${sc.pending(seat).kind}`, undefined, { timeout: 8000 });
    },
  };
}

/** 取场景提交的最后一个 intent 交给引擎（不合法时引擎抛错，测试失败） */
function commit(sc: Scenario, seat: SeatIndex, m: Mounted): PlayerIntent {
  const last = intents(m.submit).at(-1);
  if (!last) throw new Error('scene submitted nothing');
  sc.act(seat, last);
  return last;
}

describe('注册表', { timeout: 20_000 }, () => {
  it('第一组登记 BANK_ATM / BANK_COUNTER / SHOP / LOTTERY，与其他两处不冲突；股市随回合菜单接入', async () => {
    expect(Object.keys(classicVenuesA).sort()).toEqual(['BANK_ATM', 'BANK_COUNTER', 'LOTTERY', 'SHOP']);
    expect(CLASSIC_REGISTRY_CONFLICTS).toEqual([]);
    for (const k of Object.keys(classicVenuesA) as DecisionKind[]) {
      expect(classicDecisionRegistry[k]).toBe(classicVenuesA[k]);
    }
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    const props = {
      decision: youOf(sc, 0),
      isMine: true,
      view: projectState(sc.state, { kind: 'seat', seat: 0 }, { handVisibility: 'public' }),
      map: mapOf(sc),
      submit: () => undefined,
    } as unknown as DecisionProps;
    // 原版回合菜单（dialogs 登记）接入了原版股市：它的 requiredKeys 含股市的全部素材（缺任何一个整体回退）
    const menu = await sceneLoader(classicDecisionRegistry.TURN_MENU!)!.load();
    const keys = resolveRequiredKeys(menu, props);
    for (const k of STOCK_KEYS) expect(keys).toContain(k);
  });
});

describe('BANK_ATM', { timeout: 20_000 }, () => {
  it('路过：ATM 落在棋盘视窗上，按键 3 0 0 0 0 → ↵ 提交 ATM{deposit, 30000}，引擎继续走完剩余步数', async () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.stackDeck('fate', [3]);
    sc.teleport(0, 18, 17).force('dice', 3).roll(0);
    const m = await mount(sc, 0, 'BANK_ATM', BankAtmScene);
    expect(m.root).toHaveAttribute('data-scene', 'classic');
    expect(m.root).toHaveAttribute('data-mode', 'pass');
    expect(within(m.root).getByTestId('bank-cash')).toHaveTextContent('100,000');
    expect(within(m.root).getByTestId('bank-op-deposit')).toHaveAttribute('aria-pressed', 'true');
    // 路过不画银行底图
    expect(m.root.querySelector('[data-sprite="venue.bank.screen/0"]')).toBeNull();
    for (const k of ['3', '0', '0', '0', '0']) await m.user.click(within(m.root).getByTestId(`atm-key-${k}`));
    expect(within(m.root).getByTestId('atm-lcd')).toHaveAttribute('data-value', '30000');
    expect(within(m.root).getAllByRole('spinbutton', { name: '金额' })).toHaveLength(1);
    await m.user.click(within(m.root).getByTestId('bank-confirm'));
    expect(commit(sc, 0, m)).toEqual({ type: 'ATM', op: 'deposit', amount: 30000 });
    expect(sc.player(0)).toMatchObject({ node: 3, cash: 70000, deposit: 130000 });
  });

  it('停下：银行底图 + ATM；取款 MAX 夹到存款、数字框填 50000 → ATM{withdraw}；随后柜台计算器 MAX 贷满额度 → LOAN', async () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.teleport(0, 18, 17).force('dice', 1).roll(0);
    const atm = await mount(sc, 0, 'BANK_ATM', BankAtmScene);
    expect(atm.root).toHaveAttribute('data-mode', 'stop');
    expect(atm.root.querySelector('[data-sprite="venue.bank.screen/0"]')).not.toBeNull();
    await atm.user.click(within(atm.root).getByTestId('bank-op-withdraw'));
    await atm.user.click(within(atm.root).getByTestId('atm-key-max'));
    expect(within(atm.root).getByTestId('atm-lcd')).toHaveAttribute('data-value', '100000');
    const amount = within(atm.root).getByRole('spinbutton', { name: '金额' });
    await atm.user.clear(amount);
    await atm.user.type(amount, '50000');
    await atm.user.click(within(atm.root).getByTestId('bank-confirm'));
    expect(commit(sc, 0, atm)).toEqual({ type: 'ATM', op: 'withdraw', amount: 50000 });
    expect(sc.player(0)).toMatchObject({ cash: 150000, deposit: 50000 });
  });

  it('挤兑期间取款钮压禁止符号且不可选；Esc 提交 SKIP', async () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.teleport(0, 18, 17).force('dice', 1).roll(0);
    const m = await mount(sc, 0, 'BANK_ATM', BankAtmScene);
    // 用 options 模拟挤兑（引擎的 bankRun 由新闻触发，这里只测表现层）
    m.root.ownerDocument.body.innerHTML = '';
    const d = youOf(sc, 0) as DecisionForYou<'BANK_ATM'>;
    const submit = vi.fn<(intent: PlayerIntent) => unknown>(() => undefined);
    render(
      <BankAtmScene
        decision={{ ...d, options: { ...d.options, canWithdraw: false } }}
        isMine
        view={projectState(sc.state, { kind: 'seat', seat: 0 }, { handVisibility: 'public' })}
        map={mapOf(sc)}
        submit={submit}
      />,
    );
    const root = await screen.findByTestId('decision-BANK_ATM');
    expect(within(root).getByTestId('bank-op-withdraw')).toBeDisabled();
    expect(within(root).getByTestId('atm-ban-withdraw')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.keyboard('{Escape}');
    expect(intents(submit)).toEqual([{ type: 'SKIP' }]);
  });
});

describe('BANK_COUNTER', { timeout: 20_000 }, () => {
  async function toCounter(): Promise<{ sc: Scenario }> {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.teleport(0, 18, 17).force('dice', 1).roll(0).expectAsk(0, 'BANK_ATM').act(0, { type: 'SKIP' });
    return { sc };
  }

  it('计算器 MAX → 确认钮提交 LOAN{loanLimit}；资料羊皮纸显示额度与贷款', async () => {
    const { sc } = await toCounter();
    const m = await mount(sc, 0, 'BANK_COUNTER', BankCounterScene);
    const limit = (sc.pending(0).options as { loanLimit: number }).loanLimit;
    expect(within(m.root).getByTestId('counter-limit')).toHaveAttribute('data-value', String(limit));
    expect(within(m.root).getByTestId('counter-loan')).toHaveTextContent('0');
    expect(within(m.root).getByTestId('bank-op-loan')).toHaveAttribute('aria-pressed', 'true');
    // 没有贷款：还款钮禁用并压禁止符号
    expect(within(m.root).getByTestId('bank-op-repay')).toBeDisabled();
    expect(within(m.root).getByTestId('counter-ban-repay')).toBeInTheDocument();
    expect(within(m.root).getByTestId('bank-confirm')).toBeDisabled();
    await m.user.click(within(m.root).getByTestId('bank-calc-key-max'));
    expect(within(m.root).getByTestId('counter-amount')).toHaveAttribute('data-value', String(limit));
    await m.user.click(within(m.root).getByTestId('bank-confirm'));
    expect(commit(sc, 0, m)).toEqual({ type: 'LOAN', amount: limit });
    expect(sc.player(0)).toMatchObject({ loan: limit, deposit: 100000 + limit });
  });

  it('数字框填金额、计算器 ↵ 同样提交；提交后锁定不再重复发送', async () => {
    const { sc } = await toCounter();
    const m = await mount(sc, 0, 'BANK_COUNTER', BankCounterScene);
    const amount = within(m.root).getByRole('spinbutton', { name: '金额' });
    await m.user.clear(amount);
    await m.user.type(amount, '20000');
    await m.user.click(within(m.root).getByTestId('bank-calc-key-enter'));
    await m.user.click(within(m.root).getByTestId('bank-confirm'));
    expect(intents(m.submit)).toEqual([{ type: 'LOAN', amount: 20000 }]);
    expect(m.root).toHaveAttribute('data-locked', 'true');
    sc.act(0, { type: 'LOAN', amount: 20000 });
    expect(sc.player(0).loan).toBe(20000);
  });

  it('非本人（托管 / 旁观）：只读，状态条显示等待，按钮全部不可用', async () => {
    const { sc } = await toCounter();
    const m = await mount(sc, 0, 'BANK_COUNTER', BankCounterScene, { isMine: false });
    expect(m.root).toHaveAttribute('data-readonly', 'true');
    expect(within(m.root).getByTestId('decision-BANK_COUNTER-status')).toHaveTextContent('等待');
    expect(within(m.root).getByTestId('bank-skip')).toBeDisabled();
    expect(within(m.root).getByTestId('bank-op-loan')).toBeDisabled();
  });
});

describe('SHOP', { timeout: 20_000 }, () => {
  it('买货架上的卡 → 翻到道具店买道具 8 → 离开；每笔交易后以新 decisionId 重发，场景保持打开', async () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.apply({ type: 'SYS_DEBUG', op: { op: 'setPoints', seat: 0, points: 500 } });
    sc.force('shelf', 3).teleport(0, 9, 8).force('dice', 1).roll(0);
    const m = await mount(sc, 0, 'SHOP', ShopScene);
    expect(m.root).toHaveAttribute('data-page', 'card');
    expect(within(m.root).getByTestId('shop-points')).toHaveAttribute('data-value', '500');
    const shelf = (sc.pending(0).options as { shelf: { idx: number; card: number; price: number }[] }).shelf;
    const first = shelf[0]!;
    await m.user.click(within(m.root).getByTestId(`shop-shelf-${first.idx}`));
    expect(within(m.root).getByTestId('shop-price')).toHaveAttribute('data-value', String(first.price));
    await m.user.click(within(m.root).getByTestId('shop-buy-card'));
    expect(commit(sc, 0, m)).toEqual({ type: 'SHOP_BUY_CARD', shelfIdx: first.idx });
    expect(sc.player(0)).toMatchObject({ points: 500 - first.price, cards: [first.card] });
    const left = 500 - first.price;

    const again = await m.rerender();
    expect(again).toBe(m.root);
    expect(within(again).getByTestId('shop-points')).toHaveAttribute('data-value', String(left));
    await m.user.click(within(again).getByTestId('shop-page-item'));
    expect(again).toHaveAttribute('data-page', 'item');
    // 按原版：货架只写名称与价格，不显示库存；没有数量钮
    expect(within(again).getByTestId('shop-shelf')).not.toHaveTextContent(/库存|庫存/);
    await m.user.click(within(again).getByTestId('shop-item-8'));
    expect(within(again).queryByTestId('shop-qty')).toBeNull();
    expect(within(again).queryByTestId('shop-qty-inc')).toBeNull();
    expect(within(again).queryByRole('spinbutton')).toBeNull();
    expect(within(again).getByTestId('shop-price')).toHaveAttribute('data-value', '30');
    await m.user.click(within(again).getByTestId('shop-buy-item'));
    expect(commit(sc, 0, m)).toEqual({ type: 'SHOP_BUY_ITEM', item: 8, qty: 1 });
    expect(sc.player(0).points).toBe(left - 30);

    const third = await m.rerender();
    // 买过的这一行变灰、不能再选，详情区收起（原版 0x42d89c 灰色重画、0x42d9cf 货架行清零）；下拉框里也禁用
    const row8 = within(third).getByTestId('shop-item-8');
    expect(row8).toBeDisabled();
    expect(row8).toHaveAttribute('title', '这次进店已经买过了');
    expect(within(third).queryByTestId('shop-detail')).toBeNull();
    expect(within(third).queryByTestId('shop-buy-item')).toBeNull();
    const picker = within(third).getByTestId('shop-picker') as HTMLSelectElement;
    expect((picker.querySelector('option[value="item-8"]') as HTMLOptionElement).disabled).toBe(true);
    // 服务器（引擎）同样拒绝：再买一次、一次买 2 个
    expect(() => sc.act(0, { type: 'SHOP_BUY_ITEM', item: 8, qty: 1 })).toThrow(/NOT_ALLOWED/);
    expect(() => sc.act(0, { type: 'SHOP_BUY_ITEM', item: 2, qty: 2 })).toThrow(/OUT_OF_RANGE/);
    // 别的道具照常能买
    await m.user.click(within(third).getByTestId('shop-item-2'));
    expect(within(third).getByTestId('shop-buy-item')).toBeEnabled();
    // 卖道具页签：刚买的道具 8 在列表里，卖回价按公式
    await m.user.click(within(third).getByRole('tab', { name: '卖道具' }));
    expect(within(third).getByTestId('shop-sell-item-8')).toBeInTheDocument();
    await m.user.click(within(third).getByTestId('shop-leave'));
    expect(commit(sc, 0, m)).toEqual({ type: 'LEAVE' });
    sc.expectNoAsk(0, 'SHOP');
  });

  it('卖卡：卖卡页签列出手牌，卖出 → SHOP_SELL_CARD{slot}', async () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.give(0, { cards: [5] });
    sc.teleport(0, 9, 8).force('dice', 1).roll(0);
    const m = await mount(sc, 0, 'SHOP', ShopScene);
    await m.user.click(within(m.root).getByRole('tab', { name: '卖卡片' }));
    const row = within(m.root).getByTestId('shop-sell-card-0');
    await m.user.click(row);
    await m.user.click(within(m.root).getByTestId('shop-sell-card'));
    expect(commit(sc, 0, m)).toEqual({ type: 'SHOP_SELL_CARD', slot: 0 });
    expect(sc.player(0).cards).toEqual([]);
  });

  it('回归：卖道具持有 13 种（一页 8 行）→ 货架分页、下拉框列出全部；第 9 种起也能卖', async () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    const all = Array.from({ length: 13 }, (_, i) => ({ item: (i + 1) as ItemId, qty: 1 }));
    sc.give(0, { items: all });
    sc.teleport(0, 9, 8).force('dice', 1).roll(0);
    const m = await mount(sc, 0, 'SHOP', ShopScene);
    await m.user.click(within(m.root).getByTestId('shop-page-item'));
    await m.user.click(within(m.root).getByRole('tab', { name: '卖道具' }));
    const sell = (sc.pending(0).options as { sell: { items: { item: number }[] } }).sell.items;
    expect(sell).toHaveLength(13);
    // 第一页 8 行；翻页钮显示 1/2
    expect(within(m.root).getByTestId('shop-sell-item-8')).toBeInTheDocument();
    expect(within(m.root).queryByTestId('shop-sell-item-9')).toBeNull();
    const pager = within(m.root).getByTestId('shop-rows-page');
    expect(pager).toHaveAccessibleName('翻页（1/2）');
    // 下拉框列出全部 13 种；选第 12 种，货架翻到第二页并选中
    const picker = within(m.root).getByTestId('shop-picker') as HTMLSelectElement;
    expect(picker.querySelectorAll('option[value^="selli-"]')).toHaveLength(13);
    await m.user.selectOptions(picker, 'selli-12');
    expect(within(m.root).getByTestId('shop-sell-item-12')).toHaveAttribute('aria-pressed', 'true');
    expect(within(m.root).getByTestId('shop-rows-page')).toHaveAccessibleName('翻页（2/2）');
    // 翻回第一页再翻到第二页，点第 13 种卖出
    await m.user.click(within(m.root).getByTestId('shop-rows-page'));
    expect(within(m.root).queryByTestId('shop-sell-item-13')).toBeNull();
    await m.user.click(within(m.root).getByTestId('shop-rows-page'));
    await m.user.click(within(m.root).getByTestId('shop-sell-item-13'));
    await m.user.click(within(m.root).getByTestId('shop-sell-item'));
    expect(commit(sc, 0, m)).toEqual({ type: 'SHOP_SELL_ITEM', item: 13, qty: 1 });
  });

  it('道具店按原版：进店时卖完的道具不上架（行压紧）；卖道具一次 1 个、可以连着卖', async () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.apply({ type: 'SYS_DEBUG', op: { op: 'setPoints', seat: 0, points: 500 } });
    // 地雷（3）的库存全部发到两人手上；座位 0 另有 2 个路障（2）
    const left = sc.state.pools.items[3]!;
    sc.give(0, { items: [{ item: 3 as ItemId, qty: 1 }] }).give(1, { items: [{ item: 3 as ItemId, qty: left - 1 }] });
    sc.give(0, { items: [{ item: 2 as ItemId, qty: 2 }] });
    sc.teleport(0, 9, 8).force('dice', 1).roll(0);
    const m = await mount(sc, 0, 'SHOP', ShopScene);
    await m.user.click(within(m.root).getByTestId('shop-page-item'));
    expect(within(m.root).queryByTestId('shop-item-3')).toBeNull();
    // 行压紧：地雷不占行，道具 4 紧接在道具 2 之后
    const ids = within(m.root)
      .getAllByTestId(/^shop-item-\d+$/)
      .map((el) => el.getAttribute('data-testid'));
    expect(ids).toEqual([
      'shop-item-1',
      'shop-item-2',
      'shop-item-4',
      'shop-item-5',
      'shop-item-6',
      'shop-item-7',
      'shop-item-8',
    ]);
    // 货架行只写名称与价格（@source v2.06 0x42e030..0x42e0a6 每行两次 0x44e2e3：名称、"$%d"）：
    // 不显示库存，也不显示持有数（座位 0 持有 ≥ 2 个路障；货架上的「×n」容易被看成「剩 n 个」）
    expect(sc.player(0).items[2]).toBeGreaterThanOrEqual(2);
    expect(within(m.root).getByTestId('shop-shelf')).not.toHaveTextContent('×');
    expect(within(m.root).getByTestId('shop-shelf')).not.toHaveTextContent(/库存|庫存/);

    // 卖路障：一次 1 个，卖回价 trunc(30 × 0.9) = 27；卖完 1 个后还能接着卖
    await m.user.click(within(m.root).getByRole('tab', { name: '卖道具' }));
    // 卖道具页写持有数
    expect(within(m.root).getByTestId('shop-shelf')).toHaveTextContent(`×${sc.player(0).items[2]}`);
    await m.user.click(within(m.root).getByTestId('shop-sell-item-2'));
    expect(within(m.root).queryByRole('spinbutton')).toBeNull();
    expect(within(m.root).getByTestId('shop-price')).toHaveAttribute('data-value', '27');
    const own2 = sc.player(0).items[2]!;
    await m.user.click(within(m.root).getByTestId('shop-sell-item'));
    expect(commit(sc, 0, m)).toEqual({ type: 'SHOP_SELL_ITEM', item: 2, qty: 1 });
    const again = await m.rerender();
    await m.user.click(within(again).getByTestId('shop-sell-item'));
    expect(commit(sc, 0, m)).toEqual({ type: 'SHOP_SELL_ITEM', item: 2, qty: 1 });
    expect(sc.player(0).items[2]).toBe(own2 - 2);
    // 卖回 1 个地雷：库存有了，但原版货架只在进店时填写，不补上架
    const third = await m.rerender();
    await m.user.click(within(third).getByTestId('shop-sell-item-3'));
    await m.user.click(within(third).getByTestId('shop-sell-item'));
    expect(commit(sc, 0, m)).toEqual({ type: 'SHOP_SELL_ITEM', item: 3, qty: 1 });
    expect(sc.state.pools.items[3]).toBe(1);
    const fourth = await m.rerender();
    await m.user.click(within(fourth).getByRole('tab', { name: '买道具' }));
    expect(within(fourth).getByTestId('shop-item-2')).toBeInTheDocument();
    expect(within(fourth).queryByTestId('shop-item-3')).toBeNull();
  });
});

describe('LOTTERY', { timeout: 20_000 }, () => {
  it('点 5 号 → 选号圈套上并弹 YES/NO → 是：LOTTERY_BUY{number:4}（下标），只扣现金 1000', async () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.teleport(0, 7, 6).force('dice', 1).roll(0);
    const m = await mount(sc, 0, 'LOTTERY', LotteryBetScene);
    expect(within(m.root).getByTestId('lottery-pool')).toHaveAttribute(
      'data-value',
      String((sc.pending(0).options as { pool: number }).pool),
    );
    expect(within(m.root).queryByTestId('lottery-buy')).toBeNull();
    await m.user.click(within(m.root).getByTestId('lottery-ball-5'));
    expect(within(m.root).getByTestId('lottery-ring')).toBeInTheDocument();
    expect(m.root).toHaveAttribute('data-pick', '5');
    await m.user.click(within(m.root).getByTestId('lottery-buy'));
    expect(commit(sc, 0, m)).toEqual({ type: 'LOTTERY_BUY', number: 4 });
    expect(sc.event('LOTTERY_TICKET')).toMatchObject({ seat: 0, number: 4 });
    expect(sc.player(0).cash).toBe(99000);
  });

  it('已售号码压暗、画买主小头且不可选；机选只挑未售号码；NO 取消、不买 → SKIP', async () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.teleport(0, 7, 6).force('dice', 1).roll(0);
    const d = youOf(sc, 0) as DecisionForYou<'LOTTERY'>;
    const sold = d.options.sold.map((_, i) => (i === 0 ? (1 as SeatIndex) : null));
    const submit = vi.fn<(intent: PlayerIntent) => unknown>(() => undefined);
    render(
      <LotteryBetScene
        decision={{ ...d, options: { ...d.options, sold } }}
        isMine
        view={projectState(sc.state, { kind: 'seat', seat: 0 }, { handVisibility: 'public' })}
        map={mapOf(sc)}
        submit={submit}
        random={() => 0}
      />,
    );
    const root = await screen.findByTestId('decision-LOTTERY');
    const user = userEvent.setup();
    expect(within(root).getByTestId('lottery-ball-1')).toBeDisabled();
    expect(within(root).getByTestId('lottery-sold-1')).toHaveAttribute('data-owner', '1');
    await user.click(within(root).getByTestId('lottery-quick'));
    // random() = 0 → 第一个未售号码（2 号）
    expect(root).toHaveAttribute('data-pick', '2');
    await user.click(within(root).getByTestId('lottery-cancel'));
    expect(root).toHaveAttribute('data-pick', '');
    await user.click(within(root).getByTestId('lottery-skip'));
    expect(intents(submit)).toEqual([{ type: 'SKIP' }]);
  });
});

describe('TURN_MENU 股票子页 → 原版股市', { timeout: 20_000 }, () => {
  function sheetCtl(request: TurnMenuSheetControl['request']) {
    return { request, consume: vi.fn<() => void>(), collapse: vi.fn<() => void>() };
  }

  /** 股市外壳包住程序化回合菜单（原版回合菜单由 dialogs 组测；外壳与菜单本体无关） */
  const WithProgrammatic = (p: DecisionProps<'TURN_MENU'>): ReactNode => (
    <ClassicStockSheet {...p}>
      <TurnMenuDialog {...p} />
    </ClassicStockSheet>
  );

  /** 与决策层相同：consume 之后请求清空（有状态的子页请求） */
  function SheetHost({
    initial,
    onConsume,
    onCollapse,
    children,
  }: {
    initial: TurnMenuSheetControl['request'];
    onConsume: () => void;
    onCollapse: () => void;
    children: ReactNode;
  }): ReactNode {
    const [request, setRequest] = useState(initial);
    const ctl = useMemo<TurnMenuSheetControl>(
      () => ({
        request,
        consume: () => {
          onConsume();
          setRequest(null);
        },
        collapse: onCollapse,
      }),
      [request, onConsume, onCollapse],
    );
    return <TurnMenuSheetContext.Provider value={ctl}>{children}</TurnMenuSheetContext.Provider>;
  }

  it('工具列「股票」直接打开股市：买 300 股 → STOCK_BUY（存款扣款）；重发后卖 100 股；EXIT 收起回合菜单', async () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    const ctl = sheetCtl('stock');
    const m = await mount(sc, 0, 'TURN_MENU', WithProgrammatic, {
      testId: 'turn-stock-sheet',
      wrap: (el) => (
        <SheetHost initial="stock" onConsume={ctl.consume} onCollapse={ctl.collapse}>
          {el}
        </SheetHost>
      ),
    });
    expect(ctl.consume).toHaveBeenCalled();
    expect(m.root).toHaveAttribute('data-scene', 'classic');
    // 程序化回合菜单不在
    expect(screen.queryByTestId('decision-TURN_MENU')).toBeNull();
    expect(within(m.root).getByTestId('stock-deposit')).toHaveAttribute('data-value', '100000');
    await m.user.click(within(m.root).getByTestId('stock-pick-0'));
    const trade = within(m.root).getByTestId('stock-trade');
    // 行业图按所属企业的行业码（exe 表 0x4733b7）：test 图股票 0 = C1 测试银行（行业 7）→ 帧 3
    expect(within(trade).getByTestId('stock-industry')).toHaveAttribute('data-sprite', 'venue.stock.screen/3');
    await m.user.click(within(trade).getByTestId('stock-side-buy'));
    const qty = within(trade).getByRole('spinbutton', { name: '股数' });
    await m.user.clear(qty);
    await m.user.type(qty, '300');
    const price = sc.state.stocks[0]!.priceCents;
    const amount = Math.trunc((price * 300) / 100);
    expect(within(trade).getByTestId('stock-amount')).toHaveAttribute('data-value', String(amount));
    await m.user.click(within(trade).getByTestId('stock-submit'));
    expect(commit(sc, 0, m)).toEqual({ type: 'STOCK_BUY', stock: 0, shares: 300 });
    expect(sc.player(0).holdings[0]?.shares).toBe(300);
    expect(sc.player(0).deposit).toBe(100000 - amount);
    // 成交后回到行情表
    expect(within(m.root).queryByTestId('stock-trade')).toBeNull();

    const again = await m.rerender('turn-stock-sheet');
    expect(within(again).getByTestId('stock-row-0')).toHaveAttribute('data-shares', '300');
    await m.user.click(within(again).getByTestId('stock-pick-0'));
    const trade2 = within(again).getByTestId('stock-trade');
    await m.user.click(within(trade2).getByTestId('stock-side-sell'));
    await m.user.click(within(trade2).getByTestId('stock-calc-key-max'));
    const qty2 = within(trade2).getByRole('spinbutton', { name: '股数' });
    await m.user.clear(qty2);
    await m.user.type(qty2, '100');
    await m.user.click(within(trade2).getByTestId('stock-submit'));
    expect(commit(sc, 0, m)).toEqual({ type: 'STOCK_SELL', stock: 0, shares: 100 });
    expect(sc.player(0).holdings[0]?.shares).toBe(200);

    await m.rerender('turn-stock-sheet');
    await m.user.click(screen.getByTestId('stock-exit'));
    expect(ctl.collapse).toHaveBeenCalled();
    expect(screen.queryByTestId('turn-stock-sheet')).toBeNull();
  });

  it('公司详情的行业图：有企业的股票按行业码取帧（股票 2 = C2 测试百货，行业 10 → 帧 4）；没有企业的股票不画', async () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    const ctl = sheetCtl('stock');
    const m = await mount(sc, 0, 'TURN_MENU', WithProgrammatic, {
      testId: 'turn-stock-sheet',
      wrap: (el) => (
        <SheetHost initial="stock" onConsume={ctl.consume} onCollapse={ctl.collapse}>
          {el}
        </SheetHost>
      ),
    });
    await m.user.click(within(m.root).getByTestId('stock-pick-2'));
    const dept = within(m.root).getByTestId('stock-trade');
    expect(within(dept).getByTestId('stock-industry')).toHaveAttribute('data-sprite', 'venue.stock.screen/4');
    await m.user.click(within(dept).getByTestId('stock-back'));
    await m.user.click(within(m.root).getByTestId('stock-pick-1'));
    const none = within(m.root).getByTestId('stock-trade');
    expect(within(none).queryByTestId('stock-industry')).toBeNull();
  });

  it('回合菜单里的「股票」钮也打开原版股市；EXIT 回到回合菜单（不收起）；其他子页请求照常转给程序化菜单', async () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    const ctl = sheetCtl(null);
    const m = await mount(sc, 0, 'TURN_MENU', WithProgrammatic, {
      wrap: (el) => <TurnMenuSheetContext.Provider value={ctl}>{el}</TurnMenuSheetContext.Provider>,
    });
    expect(m.root).not.toHaveAttribute('data-scene');
    await m.user.click(within(m.root).getByTestId('turn-stock'));
    expect(screen.queryByTestId('turn-stock-sheet')).toHaveAttribute('data-scene', 'classic');
    await m.user.keyboard('{Escape}');
    expect(screen.queryByTestId('turn-stock-sheet')).toBeNull();
    expect(ctl.collapse).not.toHaveBeenCalled();
    expect(await screen.findByTestId('decision-TURN_MENU')).toBeInTheDocument();
  });
});

describe('宿主：原版场所屏的回退判定', { timeout: 20_000 }, () => {
  function hostOf(sc: Scenario, keys: Iterable<string>, gates: [SceneGateState, string | null][]): ReactElement {
    return (
      <ClassicDecisionHost
        decision={youOf(sc, 0)}
        isMine
        view={projectState(sc.state, { kind: 'seat', seat: 0 }, { handVisibility: 'public' })}
        map={mapOf(sc)}
        submit={() => undefined}
        packId="test-pack"
        client={fakePackClient(keys)}
        onGate={(s, r) => gates.push([s, r])}
      />
    );
  }

  it('素材齐全 → 原版 SHOP；缺 venue.shop.screen → 整体回退程序化对话框', async () => {
    const sc = scenario({ players: ['human', 'human'] }).untilMenu(0);
    sc.teleport(0, 9, 8).force('dice', 1).roll(0).expectAsk(0, 'SHOP');
    const gates: [SceneGateState, string | null][] = [];
    const r = render(hostOf(sc, ['venue.shop.screen'], gates));
    expect(await screen.findByTestId('decision-SHOP', undefined, { timeout: 8000 })).toHaveAttribute(
      'data-scene',
      'classic',
    );
    r.unmount();
    installSceneAssets({ sprites: fakeVenueSheets() });
    const gates2: [SceneGateState, string | null][] = [];
    render(hostOf(sc, [], gates2));
    expect(await screen.findByTestId('decision-SHOP', undefined, { timeout: 8000 })).not.toHaveAttribute('data-scene');
    expect(gates2.at(-1)).toEqual(['fallback', 'keys']);
  });
});

function cleanupAll(): void {
  document.body.innerHTML = '';
}

describe('乐透开奖演出', { timeout: 20_000 }, () => {
  const spec: LotteryPopupSpec = {
    kind: 'lottery',
    title: '乐透开奖',
    number: 12,
    winner: { seat: 1, character: 4, name: '孙小美' },
    subtitle: '开出 12 号：孙小美 独得 36,000 元',
  };

  it('揭晓：两颗号码球（1、2）、中奖人小头、一句话；开场与摇奖阶段有气泡', async () => {
    render(<LotteryDrawScene spec={spec} ms={2800} phase="reveal" />);
    const root = screen.getByTestId('lottery-draw-scene');
    expect(root).toHaveAttribute('data-phase', 'reveal');
    expect(root).toHaveAttribute('data-readonly', 'true');
    expect(root.querySelector('[data-sprite="venue.lottery.draw/38"]')).not.toBeNull();
    expect(root.querySelector('[data-sprite="venue.lottery.draw/39"]')).not.toBeNull();
    expect(screen.getByTestId('lottery-draw-winner')).toHaveAttribute('data-sprite', 'venue.lottery.draw/29');
    expect(screen.getByTestId('lottery-subtitle')).toHaveTextContent('孙小美');
    expect(screen.getByTestId('lottery-number')).toHaveAttribute('data-value', '12');
  });

  it('阶段按弹窗寿命推进：开场 → 摇奖 → 揭晓；没人买票直接举牌', async () => {
    vi.useFakeTimers();
    try {
      render(<LotteryDrawScene spec={spec} ms={1000} />);
      const root = screen.getByTestId('lottery-draw-scene');
      expect(root).toHaveAttribute('data-phase', 'intro');
      await act(async () => {
        vi.advanceTimersByTime(250);
      });
      expect(root).toHaveAttribute('data-phase', 'spin');
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      expect(root).toHaveAttribute('data-phase', 'reveal');
      cleanupAll();
    } finally {
      vi.useRealTimers();
    }
    const r = render(
      <LotteryDrawScene spec={{ ...spec, number: null, winner: null, subtitle: '本月不开奖' }} ms={1000} />,
    );
    const roots = screen.getAllByTestId('lottery-draw-scene');
    expect(roots.at(-1)).toHaveAttribute('data-phase', 'reveal');
    expect(screen.getByTestId('lottery-draw-host')).toBeInTheDocument();
    r.unmount();
  });

  it('给了 onSkip：最短展示时间过后出现「跳过」钮（只读场景里唯一可按的钮），点它调用 onSkip', async () => {
    const onSkip = vi.fn<() => void>();
    render(<LotteryDrawScene spec={spec} ms={2800} minMs={50} onSkip={onSkip} phase="spin" />);
    expect(screen.queryByTestId('lottery-draw-skip')).toBeNull();
    const btn = await screen.findByTestId('lottery-draw-skip');
    expect(screen.getByTestId('lottery-draw-scene')).toHaveAttribute('data-state', 'closed');
    await userEvent.setup().click(btn);
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('不在经典舞台之内（或素材不可用）→ 画 fallback（程序化 LotteryDrawPopup）', () => {
    expect(LOTTERY_DRAW_KEYS).toEqual(['venue.lottery.draw', 'venue.lottery.machine']);
    render(<ClassicLotteryDraw spec={spec} ms={2800} fallback={<p data-testid="fallback-draw">x</p>} />);
    expect(screen.getByTestId('fallback-draw')).toBeInTheDocument();
    expect(screen.queryByTestId('lottery-draw-scene')).toBeNull();
  });
});
