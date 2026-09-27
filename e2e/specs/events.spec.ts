// 事件格与拍卖（M7；任务「events」）：4 个真人，debug:act 预置牌堆（stackDeck）、传送、强制骰子，依次触发
//   新闻（所得税：全员按现金 5% 缴税）→ 命运（继承遗产：+10000 × 物价指数）→ 魔法屋（现金最多的人 → 现金全部存入，
//   效果在 MagicHouseDialog 的 DOM 里选）→ 拍卖卡（P4 在 L1 出卡；P1、P2、P3 在 AuctionDialog 里出价、放弃、加价、退出，
//   多人并发决策，P2 成交）。
// 每一步之后 4 个页面追上同一个 seq：HUD 与服务器下发的 view 一致、显示态一致、事件日志一致且没有坏文案。
// P4 的页面不带 ?anim=instant（走演出路径）：新闻、命运、魔法屋弹窗与公开竞价横幅必须出现，handler 不得出错。
// 测试图（fixture test）：1 银行 → 2 新闻 → 3 命运 → 4 卡片 → 5 L1 → … → 8 乐透 → 9 魔法屋；18 → 1。
import type { Page } from '@playwright/test';
import {
  acted,
  createRoom,
  currentSeq,
  debugAct,
  expect,
  expectNoErrors,
  hudSnapshot,
  joinRoom,
  newPlayer,
  type Player,
  pickReadyStart,
  Q_ANIM,
  roll,
  serverSnapshot,
  syncPages,
  test,
  waitDecision,
  waitIdle,
  waitMyTurn,
  waitSeqAtLeast,
  zh,
} from '../fixtures/room';

/** 显示态里与本用例相关的部分（HUD 同源） */
async function eventState(page: Page): Promise<{
  players: { seat: number; node: number; cash: number; deposit: number; cardCount: number }[];
  lots: { id: string; owner: number | null; level: number }[];
  log: string[];
}> {
  return page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const g = (window as any).__rich4.store.game.getState();
    const v = g.view;
    return {
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      players: v.players.map((p: any) => ({
        seat: p.seat,
        node: p.node,
        cash: p.cash,
        deposit: p.deposit,
        cardCount: p.cardCount,
      })),
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      lots: [...v.lands, ...v.facilities].map((l: any) => ({ id: l.id, owner: l.owner, level: l.level })),
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      log: g.log.map((l: any) => `${l.type}|${l.text}`),
    };
  });
}

const BAD_TEXT = /undefined|NaN|\{\{|\[object|\b(?:events|news|fate|magic|hud|ui):[A-Za-z0-9]/;

/** 4 页面追上同一 seq；HUD 与服务器快照一致；显示态与日志一致且没有坏文案 */
async function consistent(pages: Page[]) {
  await syncPages(pages);
  const huds = await Promise.all(pages.map((p) => hudSnapshot(p)));
  const server = await serverSnapshot(pages[0]!);
  for (const h of huds) expect(h).toEqual(server);
  const states = await Promise.all(pages.map((p) => eventState(p)));
  for (const s of states) {
    expect({ ...s, log: s.log.slice(-40) }).toEqual({ ...states[0]!, log: states[0]!.log.slice(-40) });
    for (const line of s.log) expect(line).not.toMatch(BAD_TEXT);
  }
  return states[0]!;
}

const cashOf = (s: Awaited<ReturnType<typeof eventState>>, seat: number) => s.players.find((p) => p.seat === seat)!;

/** 本人回合：传送到 (node, prev)，强制掷出 1 点并掷骰（落到下一格） */
async function stepOnto(page: Page, seat: number, node: number, prev: number): Promise<void> {
  await waitMyTurn(page);
  await acted(page, () => debugAct(page, { op: 'teleport', seat, node, prev }));
  await acted(page, () => debugAct(page, { op: 'forceNext', purpose: 'dice', values: [1] }));
  await waitMyTurn(page);
  await acted(page, () => roll(page));
}

/** 等本页出现 AUCTION_BID 并点 testId；之后 4 页面对齐到这一批（下一个出价者看到的一定是最新一问） */
async function bid(pages: Page[], page: Page, testId: string): Promise<void> {
  await waitDecision(page, ['AUCTION_BID']);
  const btn = page.getByTestId(testId);
  await expect(btn).toBeEnabled();
  await acted(page, () => btn.click());
  await syncPages(pages, page);
}

test('新闻、命运、魔法屋、拍卖卡四人竞价：4 个页面结果一致，演出页弹窗与竞价横幅出现', async ({ browser }) => {
  test.setTimeout(240_000);
  const players: Player[] = [];
  for (let i = 1; i <= 3; i++) players.push(await newPlayer(browser, `P${i}`));
  // P4 走演出路径（不带 anim=instant）
  players.push(await newPlayer(browser, 'P4', Q_ANIM));
  const pages = players.map((p) => p.page);
  const [a, b, c, d] = pages as [Page, Page, Page, Page];
  try {
    const code = await createRoom(a, { map: 'test', timer: 'off' });
    for (const p of [b, c]) await joinRoom(p, code);
    await d.goto(`/r/${code}?${Q_ANIM}`);
    await expect(d.getByTestId('screen-room')).toBeVisible();
    await pickReadyStart(pages);
    const s0 = await consistent(pages);

    // ── 新闻：P1 从 1 号格走到 2 号新闻格，预置「所得税」（全员缴现金的 5%，进公库） ──
    await waitMyTurn(a);
    await acted(a, () => debugAct(a, { op: 'stackDeck', deck: 'news', ids: [11] }));
    await stepOnto(a, 0, 1, 18);
    await expect(d.getByTestId('news-popup')).toHaveAttribute('data-news', '11');
    const s1 = await consistent(pages);
    for (const seat of [0, 1, 2, 3]) {
      const before = cashOf(s0, seat).cash;
      expect(cashOf(s1, seat).cash, `seat ${seat}`).toBe(before - Math.trunc(before * 0.05));
    }
    expect(s1.log.some((l) => l.startsWith('NEWS|') && l.includes(zh('所得税', '所得稅')))).toBe(true);

    // ── 命运：P2 从 2 号格走到 3 号命运格，预置「继承遗产」（+10000 × 物价指数，无神明加持） ──
    await waitMyTurn(b);
    await acted(b, () => debugAct(b, { op: 'stackDeck', deck: 'fate', ids: [25] }));
    const pi = await b.evaluate(
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      () => (window as any).__rich4.store.game.getState().latest.econ.priceIndex as number,
    );
    await stepOnto(b, 1, 2, 1);
    await expect(d.getByTestId('fate-popup')).toHaveAttribute('data-fate', '25');
    const s2 = await consistent(pages);
    expect(cashOf(s2, 1).cash).toBe(cashOf(s1, 1).cash + 10000 * pi);
    expect(s2.log.some((l) => l.startsWith('FATE|') && l.includes(zh('继承遗产', '繼承遺產')))).toBe(true);

    // ── 魔法屋：P3 从 8 号格走到 9 号魔法屋，条件预置为 3「现金最多的人」（刚继承遗产的 P2）→ DOM 选「现金全部存入」 ──
    await waitMyTurn(c);
    await acted(c, () => debugAct(c, { op: 'forceNext', purpose: 'magicCond', values: [3] }));
    await stepOnto(c, 2, 8, 7);
    await waitDecision(c, ['MAGIC_CAST']);
    await expect(c.getByTestId('magic-targets')).toBeVisible();
    await c.getByTestId('magic-effect-4').click();
    await acted(c, () => c.getByTestId('magic-confirm').click());
    // 演出页：女巫施法弹窗（魔法：现金全部存入）
    await expect(d.locator('[data-testid="popup"][data-kind="magic"]')).toContainText(
      zh('现金全部存入', '現金全部存入'),
    );
    await waitIdle(c);
    const s3 = await consistent(pages);
    expect(cashOf(s3, 1).cash).toBe(0);
    expect(cashOf(s3, 1).deposit).toBe(cashOf(s2, 1).deposit + cashOf(s2, 1).cash);
    expect(s3.log.some((l) => l.startsWith('MAGIC_CAST|') && l.includes(zh('现金全部存入', '現金全部存入')))).toBe(
      true,
    );

    // ── 拍卖卡：P2 先取回现金（debug）；P4 站在无主的 L1，出拍卖卡（回合菜单 → 卡片 → 目标面板 → 确认） ──
    await waitMyTurn(d);
    await acted(d, () => debugAct(d, { op: 'setCash', seat: 1, cash: 50000, deposit: null }));
    await acted(d, () => debugAct(d, { op: 'teleport', seat: 3, node: 5, prev: 4 }));
    await acted(d, () => debugAct(d, { op: 'give', seat: 3, cards: [8], items: [] }));
    await waitMyTurn(d);
    await syncPages(pages);
    const slot = await d.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      const dd = (window as any).__rich4.store.game.getState().decision;
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      return dd.options.cards.find((r: any) => r.card === 8).slot as number;
    });
    await d.getByTestId('action-cards').click();
    const card = d.getByTestId(`inv-card-${slot}`);
    await expect(card).toBeEnabled();
    await card.click();
    await expect(d.getByTestId('target-picker')).toBeVisible();
    const seqBefore = await currentSeq(d);
    await d.getByTestId('target-confirm').click();
    for (const p of pages) await waitSeqAtLeast(p, seqBefore + 1);
    // 三名竞拍者同时被问；演出页（卖方）顶部出现公开竞价横幅
    for (const p of [a, b, c]) await waitDecision(p, ['AUCTION_BID']);
    await expect(d.getByTestId('auction-banner')).toBeVisible();
    await expect(d.getByTestId('auction-banner')).toHaveAttribute('data-lot', 'L1');
    const start = await a.evaluate(
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      () => (window as any).__rich4.store.game.getState().decision.options.start as number,
    );
    // P1 按起拍价 → P2 这轮不加价 → P3 +1000（P2 恢复可出价）→ P1 退出 → P2 +500 → P3 不加价 → P2 成交
    await bid(pages, a, 'auction-bid-0');
    await bid(pages, b, 'auction-pass');
    await bid(pages, c, 'auction-bid-1000');
    await bid(pages, a, 'auction-quit');
    await bid(pages, b, 'auction-bid-500');
    await bid(pages, c, 'auction-pass');
    await waitMyTurn(d);
    const s4 = await consistent(pages);
    const price = start + 1500;
    expect(s4.lots.find((l) => l.id === 'L1')?.owner).toBe(1);
    expect(cashOf(s4, 1).cash).toBe(50000 - price);
    // 拍卖卡：成交款进卖方（出卡者）的存款
    expect(cashOf(s4, 3).deposit).toBe(cashOf(s3, 3).deposit + price);
    expect(s4.log.some((l) => l.startsWith('AUCTION_ENDED|') && l.includes(price.toLocaleString('en-US')))).toBe(true);
    // 横幅在成交后收起
    await expect(d.getByTestId('auction-banner')).toHaveCount(0);

    // P4 掷骰结束回合，4 页面仍一致
    await acted(d, () => roll(d));
    await waitIdle(d);
    await consistent(pages);

    expectNoErrors(players);
  } finally {
    for (const p of players) await p.context.close();
  }
});
