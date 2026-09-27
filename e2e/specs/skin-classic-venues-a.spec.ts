// 原版皮肤第一组场所屏（original-skin.md §4.2 场所屏、§5 A12；ui/classic/venues/a）：合成素材包 + fixture 地图（与
// skin-classic-venues-b 同一种供包方式：page.route 按 manifest 白名单提供 /pack/*，GET /api/access 模拟成「门禁开启且已通过」，
// 默认配置与原版皮肤配置下都能跑——CI 只跑默认配置），4 个真人用 debug:act 传送与强制骰子，全部操作点原版场景里的热区与按钮：
//   第 1 轮：P1 停在银行——ATM（银行底图上）按键输入存 30000、柜台选贷款填 50000；P2 路过银行——ATM 取 20000（停在卡片格）；
//           P3 进百货公司（点券 500）买货架上第一张买得起的卡，再离开；P4 停在乐透格，点 5 号 → YES 买下。
//   第 2 轮（开市日）：P2 从工具列「股票」打开原版股市（断言 data-scene="classic"），买 300 股、卖 100 股。
// 断言：各场景是原版场景（data-scene="classic"）、提交的数值生效；4 个页面 HUD 上的现金 / 存款 / 点券与地块归属完全一致
// 且等于服务器下发的 view，贷款、持股、手牌、乐透号码与操作一致。
// 第二个用例：手机横屏 844×390 下银行 ATM 与柜台的主要控件热区 ≥44px。
// 测试图（fixture test）：18 → 1（银行格）→ 2（新闻）→ 3（命运）→ 4（卡片）；9 → 10（百货）；7 → 8（乐透）；12 → 13（得 30 点）。
// 对局页是原版皮肤（繁体界面）：按可访问名找的控件一律用繁体名。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';
import type { PackManifestV1 } from '../../packages/shared/src/assets/pack';
import {
  acted,
  createRoom,
  currentSeq,
  debugAct,
  expect,
  hudSnapshot,
  joinRoom,
  newPlayer,
  type Player,
  pickCharacter,
  Q,
  roll,
  serverSnapshot,
  setReady,
  startGame,
  test,
  waitDecision,
  waitIdle,
  waitMyTurn,
  waitSeqAtLeast,
} from '../fixtures/room';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACK_DIR = join(repoRoot, '.cache', 'synthetic-pack');

const ACCESS_ON = {
  ok: true,
  data: {
    mode: 'passcode',
    granted: true,
    kind: 'p',
    expiresAt: Date.now() + 3_600_000,
    grants: false,
    canGrant: false,
  },
};

let manifest: PackManifestV1;
let servable: Map<string, string>;

test.beforeAll(() => {
  test.setTimeout(120_000);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['run', '--silent', 'extract', '--', 'assets', 'synth', '--out', '.cache/synthetic-pack'], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
  manifest = JSON.parse(readFileSync(join(PACK_DIR, 'manifest.json'), 'utf8')) as PackManifestV1;
  servable = new Map(Object.values(manifest.files).map((f) => [f.path, f.contentType]));
});

async function servePack(page: Page): Promise<void> {
  await page.route('**/pack/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/pack/manifest.json')
      return route.fulfill({ json: manifest, headers: { 'cache-control': 'no-cache' } });
    const rel = decodeURIComponent(path.slice('/pack/'.length));
    const type = servable.get(rel);
    if (!type) return route.fulfill({ status: 404, json: { ok: false, error: { code: 'BAD_REQUEST' } } });
    return route.fulfill({ status: 200, contentType: type, body: readFileSync(join(PACK_DIR, rel)) });
  });
  await page.route('**/api/access', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: ACCESS_ON }) : route.fallback(),
  );
}

async function classicPlayer(
  browser: Parameters<typeof newPlayer>[0],
  nick: string,
  viewport = { width: 1920, height: 1080 },
): Promise<Player> {
  return newPlayer(browser, nick, Q, {
    setup: async (pg) => {
      await pg.setViewportSize(viewport);
      await servePack(pg);
    },
  });
}

/** 传送到 (node, prev)、强制下一次骰子，然后按 GO */
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

/** 等本人出现某个决策，且它画的是原版场景 */
async function classicScene(page: Page, kind: string): Promise<ReturnType<Page['getByTestId']>> {
  await waitDecision(page, [kind]);
  const scene = page.getByTestId(`decision-${kind}`);
  await expect(scene).toBeVisible();
  await expect(scene).toHaveAttribute('data-scene', 'classic');
  return scene;
}

interface Econ {
  loan: number;
  shares: number[];
  cards: number;
  lottery: (number | null)[];
}

/** 本页收到的最新权威 view：P1 的贷款、每人持股合计、P3 的手牌张数、乐透号码的持有者 */
async function econOf(page: Page): Promise<Econ> {
  return page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const v = (window as any).__rich4.store.game.getState().latest;
    return {
      loan: v.players[0].loan,
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      shares: v.players.map((pl: any) =>
        Object.values(pl.holdings as Record<string, { shares: number } | null>).reduce(
          (sum, h) => sum + (h ? h.shares : 0),
          0,
        ),
      ),
      cards: v.players[2].cardCount,
      lottery: v.lottery.owners,
    };
  });
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

/** 股市：选股票、买 / 卖、填股数、成交（非终结操作，服务器以新 decisionId 重发回合菜单） */
async function trade(page: Page, stock: number, side: 'buy' | 'sell', shares: number): Promise<void> {
  const sheet = page.getByTestId('turn-stock-sheet');
  if (!(await sheet.isVisible())) await page.getByTestId('action-stock').click();
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveAttribute('data-scene', 'classic');
  await sheet.getByTestId(`stock-pick-${stock}`).click();
  await sheet.getByTestId(`stock-side-${side}`).click();
  await sheet.getByRole('spinbutton', { name: '股數' }).fill(String(shares));
  await acted(page, () => sheet.getByTestId('stock-submit').click());
  await waitMyTurn(page);
}

test('原版场所屏：银行存取款贷款、百货买卡、乐透投注、股市买卖，四个页面数值一致', async ({ browser }) => {
  test.setTimeout(300_000);
  const fourPlayers: Player[] = [];
  for (let i = 1; i <= 4; i++) fourPlayers.push(await classicPlayer(browser, `P${i}`));
  try {
    await venuesRound(fourPlayers);
  } finally {
    for (const p of fourPlayers) await p.context.close();
  }
});

async function venuesRound(fourPlayers: Player[]): Promise<void> {
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

  // 第 1 轮。日期调到 2010-01-04（星期一），第 2 轮（1-05，星期二）股市开市
  await waitMyTurn(a);
  await acted(a, () => debugAct(a, { op: 'setDate', date: 20100104 }));

  // P1 停在银行：ATM（叠在银行底图上）按键 3 0 0 0 0 → ↵ 存款
  await stepFrom(a, 0, 18, 17, 1);
  const atm = await classicScene(a, 'BANK_ATM');
  await expect(atm).toHaveAttribute('data-mode', 'stop');
  await expect(atm.getByTestId('bank-op-deposit')).toHaveAttribute('aria-pressed', 'true');
  for (const k of ['3', '0', '0', '0', '0']) await atm.getByTestId(`atm-key-${k}`).click();
  await expect(atm.getByTestId('atm-lcd')).toHaveAttribute('data-value', '30000');
  await acted(a, () => atm.getByTestId('bank-confirm').click());
  // 柜台：贷款 50000（数字框填数，确认钮提交）
  const counter = await classicScene(a, 'BANK_COUNTER');
  await counter.getByTestId('bank-op-loan').click();
  await counter.getByRole('spinbutton', { name: '金額' }).fill('50000');
  await expect(counter.getByTestId('counter-amount')).toHaveAttribute('data-value', '50000');
  await acted(a, () => counter.getByTestId('bank-confirm').click());
  await waitIdle(a);

  // P2 路过银行：ATM 落在棋盘视窗上，取 20000，然后走到 4 号卡片格（2 号新闻、3 号命运是随机事件，不停在那里）
  await stepFrom(b, 1, 18, 17, 4);
  const atm2 = await classicScene(b, 'BANK_ATM');
  await expect(atm2).toHaveAttribute('data-mode', 'pass');
  await atm2.getByTestId('bank-op-withdraw').click();
  await atm2.getByRole('spinbutton', { name: '金額' }).fill('20000');
  await acted(b, () => atm2.getByTestId('bank-confirm').click());
  await waitIdle(b);

  // P3 百货：点券 500，买货架上第一张买得起的卡，离开
  await waitMyTurn(c);
  await acted(c, () => debugAct(c, { op: 'setPoints', seat: 2, points: 500 }));
  await stepFrom(c, 2, 9, 8, 1);
  const shop = await classicScene(c, 'SHOP');
  await expect(shop.getByTestId('shop-points')).toHaveAttribute('data-value', '500');
  const pick = await c.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const o = (window as any).__rich4.store.game.getState().decision.options;
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const r = o.shelf.find((x: any) => x.buyable);
    return r ? { idx: r.idx as number, card: r.card as number, price: r.price as number } : null;
  });
  expect(pick, 'no buyable card on the shelf').not.toBeNull();
  await shop.getByTestId(`shop-shelf-${pick!.idx}`).click();
  await expect(shop.getByTestId('shop-price')).toHaveAttribute('data-value', String(pick!.price));
  await acted(c, () => shop.getByTestId('shop-buy-card').click());
  // 非终结交易：场景保持打开，点数刷新
  await waitDecision(c, ['SHOP']);
  await expect(shop.getByTestId('shop-points')).toHaveAttribute('data-value', String(500 - pick!.price));
  await acted(c, () => shop.getByTestId('shop-leave').click());
  await waitIdle(c);

  // P4 乐透：点 5 号 → 选号圈 → YES 买下
  await stepFrom(d, 3, 7, 6, 1);
  const lottery = await classicScene(d, 'LOTTERY');
  await lottery.getByTestId('lottery-ball-5').click();
  await expect(lottery).toHaveAttribute('data-pick', '5');
  await acted(d, () => lottery.getByTestId('lottery-buy').click());
  await waitIdle(d);

  // 第 2 轮：股票
  await toPoints(a, 0);
  await waitMyTurn(b);
  const sb = await tradableStock(b, 300);
  await trade(b, sb, 'buy', 300);
  await trade(b, sb, 'sell', 100);
  const sheet = b.getByTestId('turn-stock-sheet');
  // 回合菜单的股市是原版股市场景（回退到程序化子页时 testid 相同，必须看 data-scene）
  await expect(sheet).toHaveAttribute('data-scene', 'classic');
  await sheet.getByTestId('stock-exit').click();
  await expect(sheet).toHaveCount(0);
  await expect(b.getByTestId('decision-layer')).toHaveCount(0);
  await toPoints(b, 1);

  // 所有页面追上同一个 seq 后比较
  const seq = await currentSeq(a);
  for (const p of pages) await waitSeqAtLeast(p, seq);
  const snaps = await Promise.all(pages.map((p) => hudSnapshot(p)));
  const server = await serverSnapshot(a);
  expect(Object.keys(snaps[0]!.players)).toHaveLength(4);
  for (const s of snaps) expect(s).toEqual(snaps[0]);
  expect(snaps[0]).toEqual(server);
  // P1：存 30000 → 现金 70000（第 2 轮点券格不动现金）；贷款 50000 进存款 → 存款 180000
  expect(snaps[0]!.players['0']).toMatchObject({ cash: '70000', deposit: '180000' });
  // P2：路过银行取 20000 → 现金 120000；买卖股票从存款结算
  expect(snaps[0]!.players['1']!.cash).toBe('120000');
  expect(Number(snaps[0]!.players['1']!.deposit)).toBeLessThan(80_000);
  // P3：点券 500 − 卡价（第 2 轮未行动）
  expect(snaps[0]!.players['2']!.points).toBe(String(500 - pick!.price));
  // P4：乐透 1000 只扣现金
  expect(snaps[0]!.players['3']!.cash).toBe('99000');

  const econ = await Promise.all(pages.map((p) => econOf(p)));
  for (const e of econ) expect(e).toEqual(econ[0]);
  expect(econ[0]!.loan).toBe(50_000);
  expect(econ[0]!.shares).toEqual([0, 200, 0, 0]);
  expect(econ[0]!.cards).toBe(1);
  expect(econ[0]!.lottery[4]).toBe(3);

  for (const p of fourPlayers) {
    expect(
      p.errors.filter((e) => !e.includes('WebGL') && !e.includes('favicon')),
      p.nickname,
    ).toEqual([]);
  }
}

/** 按钮中心点起，横竖方向上仍命中该元素（含 ::before 扩展热区）的连续像素数 */
async function hitSize(page: Page, scope: string, testId: string): Promise<{ w: number; h: number }> {
  return page.evaluate(
    ([root, id]) => {
      const el = document.querySelector(`[data-testid="${root}"] [data-testid="${id}"]`);
      if (!el) throw new Error(`没有 ${id}`);
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const on = (x: number, y: number): boolean => {
        const hit = document.elementFromPoint(x, y);
        return hit !== null && (hit === el || el.contains(hit));
      };
      const span = (dx: number, dy: number): number => {
        let n = 0;
        for (let k = 1; k < 200; k++) {
          if (!on(cx + dx * k, cy + dy * k)) break;
          n++;
        }
        return n;
      };
      if (!on(cx, cy)) return { w: 0, h: 0 };
      return { w: span(-1, 0) + span(1, 0) + 1, h: span(0, -1) + span(0, 1) + 1 };
    },
    [scope, testId] as const,
  );
}

async function expectHit44(page: Page, scope: string, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    const hs = await hitSize(page, scope, id);
    expect(hs.w, id).toBeGreaterThanOrEqual(44);
    expect(hs.h, id).toBeGreaterThanOrEqual(44);
  }
}

test('手机横屏 844×390：银行 ATM 与柜台、股市（行情表与详情、计算器 MAX / ↵）的主要控件热区 ≥44px', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const p = await classicPlayer(browser, '手机', { width: 844, height: 390 });
  try {
    const page = p.page;
    await createRoom(page, { map: 'test', timer: 'off', aiCount: 1 });
    await startGame(page, [page]);
    // 星期一：下一轮开市（股市详情的买卖钮可用）
    await waitMyTurn(page);
    await acted(page, () => debugAct(page, { op: 'setDate', date: 20100104 }));
    await stepFrom(page, 0, 18, 17, 1);
    const atm = await classicScene(page, 'BANK_ATM');
    await expect(atm).toHaveAttribute('data-hit', 'wide');
    for (const id of [
      'bank-op-deposit',
      'bank-op-withdraw',
      'bank-skip',
      'bank-confirm',
      'atm-key-max',
      'bank-amount-input',
    ]) {
      const hs = await hitSize(page, 'decision-BANK_ATM', id);
      expect(hs.w, id).toBeGreaterThanOrEqual(44);
      expect(hs.h, id).toBeGreaterThanOrEqual(44);
    }
    await acted(page, () => atm.getByTestId('bank-skip').click());
    const counter = await classicScene(page, 'BANK_COUNTER');
    // ATM 的退场动画播完（退场中的层还在 DOM 里、不可操作）
    await expect(page.getByTestId('decision-BANK_ATM-exit')).toHaveCount(0);
    for (const id of ['bank-op-loan', 'bank-op-repay', 'bank-confirm', 'bank-skip']) {
      const hs = await hitSize(page, 'decision-BANK_COUNTER', id);
      expect(hs.w, id).toBeGreaterThanOrEqual(44);
      expect(hs.h, id).toBeGreaterThanOrEqual(44);
    }
    // 不横向滚动
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(844);
    await acted(page, () => counter.getByTestId('bank-skip').click());
    await waitIdle(page);

    // 股市（回归）：EXIT 顶栏贴屏幕上缘只往下补；「卖出」被计算器压住上半截只往下补；计算器 MAX / ↵ 往上补过计量条
    await waitMyTurn(page);
    const stock = await tradableStock(page, 100);
    await page.getByTestId('action-stock').click();
    const sheet = page.getByTestId('turn-stock-sheet');
    await expect(sheet).toHaveAttribute('data-scene', 'classic');
    await expect(sheet).toHaveAttribute('data-hit', 'wide');
    await expectHit44(page, 'turn-stock-sheet', ['stock-exit']);
    await sheet.getByTestId(`stock-pick-${stock}`).click();
    await expect(sheet).toHaveAttribute('data-selected', String(stock));
    await expectHit44(page, 'turn-stock-sheet', [
      'stock-side-buy',
      'stock-side-sell',
      'stock-calc-key-max',
      'stock-calc-key-enter',
      'stock-calc-input',
      'stock-submit',
      'stock-back',
    ]);
    // 计算器 MAX 在手机上照常可点（计量条只显示）
    await sheet.getByTestId('stock-calc-key-max').click();
    await expect(sheet.getByTestId('stock-calc')).not.toHaveAttribute('data-value', '0');
    await sheet.getByTestId('stock-back').click();
    await sheet.getByTestId('stock-exit').click();
    await expect(sheet).toHaveCount(0);
  } finally {
    await p.context.close();
  }
});
