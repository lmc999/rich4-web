// 银行与股市（M4；任务「bank-stock」）：4 个真人，用 debug:act 传送与强制骰子，全部操作点对话框的 DOM 按钮：
//   第 1 轮：P1 停在银行，ATM 存款 30000，柜台贷款 50000；P2 路过银行，ATM 取款 20000 后继续走；P3、P4 走到点券格。
//   第 2 轮（debug:setDate 保证是开市日）：P2 从行动区「股票」直接打开股市，买 300 股、再卖 100 股；
//   P4 买 200 股；P1、P3 走到点券格。股票取当天可交易（未停牌、未涨跌停）的第一支，行情随房间种子变化。
// 断言 4 个页面 HUD 上的现金 / 存款 / 点券与地块归属完全一致且等于服务器下发的 view，贷款与持股与操作一致。
// 测试图（fixture test）：18 → 1（银行格）→ 2 → 3；12 → 13（得 30 点）。
import type { Page } from '@playwright/test';
import {
  createRoom,
  currentSeq,
  debugAct,
  expect,
  hudSnapshot,
  joinRoom,
  pickCharacter,
  roll,
  serverSnapshot,
  setReady,
  startGame,
  test,
  waitDecision,
  waitIdle,
  waitMyTurn,
  waitSeqAtLeast,
  zh,
} from '../fixtures/room';

/** 执行一个会产生新批次的操作，并等本页收到这一批 */
async function acted(page: Page, fn: () => Promise<unknown>): Promise<void> {
  const s0 = await currentSeq(page);
  await fn();
  await waitSeqAtLeast(page, s0 + 1);
}

/** 传送到 (node, prev)、强制下一次骰子，然后点行动区的掷骰按钮 */
async function stepFrom(page: Page, seat: number, node: number, prev: number, dice: number): Promise<void> {
  await waitMyTurn(page);
  await acted(page, () => debugAct(page, { op: 'teleport', seat, node, prev }));
  await acted(page, () => debugAct(page, { op: 'forceNext', purpose: 'dice', values: [dice] }));
  await waitMyTurn(page);
  await acted(page, () => roll(page));
}

/** 走到 13 号点券格（没有决策），本回合结束 */
async function toPoints(page: Page, seat: number): Promise<void> {
  await stepFrom(page, seat, 12, 11, 1);
  await waitIdle(page);
}

/** 银行对话框：选存 / 取（或贷 / 还），填金额，确认 */
async function bank(page: Page, kind: 'BANK_ATM' | 'BANK_COUNTER', op: string, amount: number): Promise<void> {
  await waitDecision(page, [kind]);
  const dlg = page.getByTestId(`decision-${kind}`);
  await dlg.getByTestId(`bank-op-${op}`).click();
  await dlg.getByRole('spinbutton', { name: zh('金额', '金額') }).fill(String(amount));
  await acted(page, () => dlg.getByTestId('bank-confirm').click());
}

/** 行动区「股票」→ 股市子页：选股票、买 / 卖、填股数、提交（非终结操作，服务器以新 decisionId 重发回合菜单） */
async function trade(page: Page, stock: number, side: 'buy' | 'sell', shares: number): Promise<void> {
  const sheet = page.getByTestId('turn-stock-sheet');
  if (!(await sheet.isVisible())) await page.getByTestId('action-stock').click();
  await expect(sheet).toBeVisible();
  await sheet.getByTestId(`stock-pick-${stock}`).click();
  await sheet.getByTestId(`stock-side-${side}`).click();
  await sheet.getByRole('spinbutton', { name: zh('股数', '股數') }).fill(String(shares));
  await acted(page, () => sheet.getByTestId('stock-submit').click());
  await waitMyTurn(page);
}

/** 当前回合菜单里能买能卖（未停牌、未涨停跌停、可买量足够）的第一支股票；行情随房间种子变化，不能写死 */
async function tradableStock(page: Page, shares: number): Promise<number> {
  const idx = await page.evaluate((n) => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const d = (window as any).__rich4.store.game.getState().decision;
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const row = d?.options?.stock?.rows?.find((r: any) => !r.suspended && !r.limitUp && !r.limitDown && r.maxBuy >= n);
    return row ? (row.idx as number) : -1;
  }, shares);
  expect(idx, 'no tradable stock today').toBeGreaterThanOrEqual(0);
  return idx;
}

/** 关掉股市子页：经快捷入口打开的回合菜单随之收起 */
async function closeStock(page: Page): Promise<void> {
  const sheet = page.getByTestId('turn-stock-sheet');
  await sheet.getByRole('button', { name: zh('关闭', '關閉') }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId('decision-layer')).toHaveCount(0);
}

interface Econ {
  loan: number;
  holdings: Record<string, number>;
}

/** 本页收到的最新权威 view 里每位玩家的贷款与持股 */
async function econOf(page: Page): Promise<Econ[]> {
  return page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const v = (window as any).__rich4.store.game.getState().latest;
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    return v.players.map((p: any) => ({
      loan: p.loan,
      holdings: Object.fromEntries(
        Object.entries(p.holdings as Record<string, { shares: number } | null>)
          .filter(([, h]) => h && h.shares > 0)
          .map(([k, h]) => [k, (h as { shares: number }).shares]),
      ),
    }));
  });
}

test('银行存取款、贷款与股票买卖：四个页面的 HUD 与服务器快照一致', async ({ fourPlayers }) => {
  const pages = fourPlayers.map((p) => p.page);
  const [a, b, c, d] = pages as [Page, Page, Page, Page];
  const code = await createRoom(a, { map: 'test', timer: 'off' });
  for (const p of [b, c, d]) await joinRoom(p, code);
  await pickCharacter(a, 9);
  await pickCharacter(b, 4);
  await pickCharacter(c, 0);
  await pickCharacter(d, 3);
  for (const p of [b, c, d]) await setReady(p);
  await startGame(a, pages);

  // 第 1 轮。先把日期调到 2010-01-04（星期一），第 2 轮（1-05，星期二）股市开市
  await waitMyTurn(a);
  await acted(a, () => debugAct(a, { op: 'setDate', date: 20100104 }));
  // P1 停在银行：ATM 存 30000，柜台贷款 50000
  await stepFrom(a, 0, 18, 17, 1);
  await bank(a, 'BANK_ATM', 'deposit', 30_000);
  await bank(a, 'BANK_COUNTER', 'loan', 50_000);
  await waitIdle(a);
  // P2 路过银行：ATM 取 20000，然后走到 2 号格
  await stepFrom(b, 1, 18, 17, 2);
  await bank(b, 'BANK_ATM', 'withdraw', 20_000);
  await waitIdle(b);
  await toPoints(c, 2);
  await toPoints(d, 3);

  // 第 2 轮：股票
  await toPoints(a, 0);
  await waitMyTurn(b);
  const sb = await tradableStock(b, 300);
  await trade(b, sb, 'buy', 300);
  await trade(b, sb, 'sell', 100);
  await closeStock(b);
  await toPoints(b, 1);
  await toPoints(c, 2);
  await waitMyTurn(d);
  const sd = await tradableStock(d, 200);
  await trade(d, sd, 'buy', 200);
  await closeStock(d);
  await toPoints(d, 3);

  // 所有页面追上同一个 seq 后比较
  const seq = await currentSeq(a);
  for (const p of pages) await waitSeqAtLeast(p, seq);
  const snaps = await Promise.all(pages.map((p) => hudSnapshot(p)));
  const server = await serverSnapshot(a);
  expect(Object.keys(snaps[0]!.players)).toHaveLength(4);
  for (const s of snaps) expect(s).toEqual(snaps[0]);
  expect(snaps[0]).toEqual(server);
  // P1：存 30000 → 现金 70000；贷款 50000 进存款 → 存款 180000
  expect(snaps[0]!.players['0']).toMatchObject({ cash: '70000', deposit: '180000' });
  // P2：路过银行取 20000 → 现金 120000；买卖股票从存款结算
  expect(snaps[0]!.players['1']!.cash).toBe('120000');
  expect(Number(snaps[0]!.players['1']!.deposit)).toBeLessThan(80_000);

  const econ = await Promise.all(pages.map((p) => econOf(p)));
  for (const e of econ) expect(e).toEqual(econ[0]);
  expect(econ[0]![0]).toMatchObject({ loan: 50_000 });
  expect(econ[0]![1]!.holdings).toEqual({ [String(sb)]: 200 });
  expect(econ[0]![3]!.holdings).toEqual({ [String(sd)]: 200 });

  for (const p of fourPlayers) {
    expect(
      p.errors.filter((e) => !e.includes('WebGL') && !e.includes('favicon')),
      p.nickname,
    ).toEqual([]);
  }
});
