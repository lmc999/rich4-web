// 百货公司道具店按原版（回归：线上反馈「道具店购买道具时显示库存，并且同一道具可以一次买多个，例如一次买 9 颗遥控骰子」）。
// 原版（rich4.exe v2.06）：道具货架每行只写名称与价格（0x42e011..0x42e0a6，不画库存）；点一行买 1 个
// （0x42d869 call fcn.0042c64b(座位, 道具)，没有数量参数），买后这一行灰色重画、货架表清零（0x42d89c、0x42d9cf），
// 同一次进店不能再买这一种；卖道具也是一次 1 个（0x42d4e6 push 1）。
// 一个真人 + 一个电脑，fixture 地图 test：点券 500，传送到 9 号格、强制掷 1 点进 10 号百货公司：
// - 原版皮肤（合成素材包，page.route 按 manifest 白名单供包；默认配置与原版配置都能跑）：先持有 2 颗遥控骰子（道具 8），
//   翻到道具店 → 货架上没有库存字样、也没有持有数「×n」 → 选遥控骰子后没有数量钮 → 改过的客户端直接发 qty 2 → 服务器 INVALID_ACTION{OUT_OF_RANGE} →
//   点「買下」→ 交易记录只有 qty 1、这一行变灰不能再选 → 再发一次 → 服务器 INVALID_ACTION{NOT_ALLOWED}；
// - 程序化皮肤（设置里指定）：「买道具」页签同样没有库存与数量步进器，买一次后这一种置灰，服务器同样拒绝重复购买。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator, Page, Route } from '@playwright/test';
import type { PackManifestV1 } from '../../packages/shared/src/assets/pack';
import {
  acted,
  createRoom,
  debugAct,
  expect,
  expectNoErrors,
  expectOriginalSkin,
  newPlayer,
  type Player,
  startGame,
  test,
  waitDecision,
  waitIdle,
  waitMyTurn,
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

/** 遥控骰子：价格 30，属于百货公司卖的 1..8 号道具 */
const ITEM = 8;

interface ShopState {
  seat: number;
  points: number;
  own: number;
  row: { maxQty: number; bought: boolean; listed: boolean } | null;
  trades: { op: string; item: number | null; qty: number; points: number }[];
}

/** 本人的点券、道具 8 持有数、当前 SHOP options 里道具 8 这一行与本次进店的交易记录 */
async function shopState(page: Page): Promise<ShopState> {
  return page.evaluate((item) => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const h = (window as any).__rich4;
    const g = h.store.game.getState();
    const seat = h.store.room.getState().room.you.seat as number;
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const p = g.view.players.find((x: any) => x.seat === seat);
    const o = g.decision?.kind === 'SHOP' ? g.decision.options : null;
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const row = o?.items.find((r: any) => r.item === item) ?? null;
    return {
      seat,
      points: p.points as number,
      own: (p.items?.[item] ?? 0) as number,
      row: row ? { maxQty: row.maxQty, bought: row.bought, listed: row.listed } : null,
      trades: o ? o.visit.trades : [],
    };
  }, ITEM);
}

/** 改过的客户端：绕过界面直接对当前 SHOP 决策提交 intent，返回服务器的结果 */
async function rawAct(
  page: Page,
  intent: Record<string, unknown>,
): Promise<{ ok: boolean; code?: string; rule?: string }> {
  return page.evaluate(async (it) => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const h = (window as any).__rich4;
    const d = h.store.game.getState().decision;
    const r = await h.client.act(it, d.decisionId);
    return r.ok ? { ok: true } : { ok: false, code: r.error.code, rule: r.error.details?.rule };
  }, intent);
}

/** 点券 500，传送到 9 号格、强制 1 点，掷骰进 10 号百货公司；返回 SHOP 决策容器 */
async function enterShop(page: Page, seat: number): Promise<Locator> {
  await waitMyTurn(page);
  await acted(page, () => debugAct(page, { op: 'setPoints', seat, points: 500 }));
  await acted(page, () => debugAct(page, { op: 'teleport', seat, node: 9, prev: 8 }));
  await acted(page, () => debugAct(page, { op: 'forceNext', purpose: 'dice', values: [1] }));
  await waitMyTurn(page);
  await acted(page, () => page.getByTestId('action-roll').click());
  await waitDecision(page, ['SHOP']);
  const dlg = page.getByTestId('decision-SHOP');
  await expect(dlg).toBeVisible();
  return dlg;
}

async function mySeat(page: Page): Promise<number> {
  // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
  return page.evaluate(() => (window as any).__rich4.store.room.getState().room.you.seat as number);
}

/** 服务器侧校验：一次买 2 个、同一次进店重复买都被拒绝（INVALID_ACTION），点券与持有不变 */
async function expectServerRejects(page: Page, when: 'before' | 'after'): Promise<void> {
  const s0 = await shopState(page);
  if (when === 'before') {
    expect(await rawAct(page, { type: 'SHOP_BUY_ITEM', item: ITEM, qty: 2 })).toEqual({
      ok: false,
      code: 'INVALID_ACTION',
      rule: 'OUT_OF_RANGE',
    });
  } else {
    expect(await rawAct(page, { type: 'SHOP_BUY_ITEM', item: ITEM, qty: 1 })).toEqual({
      ok: false,
      code: 'INVALID_ACTION',
      rule: 'NOT_ALLOWED',
    });
  }
  const s1 = await shopState(page);
  expect({ points: s1.points, own: s1.own }).toEqual({ points: s0.points, own: s0.own });
}

test('原版皮肤：道具店不显示库存、没有数量钮；买一件后这一行变灰，服务器拒绝多买与重复购买', async ({ browser }) => {
  test.setTimeout(240_000);
  const p: Player = await newPlayer(browser, '道具店', undefined, {
    setup: async (pg) => {
      await pg.setViewportSize({ width: 1920, height: 1080 });
      await servePack(pg);
    },
  });
  const page = p.page;
  try {
    await createRoom(page, { map: 'test', timer: 'off', aiCount: 1 });
    await startGame(page, [page]);
    await expectOriginalSkin(page);
    const seat = await mySeat(page);
    // 先持有 2 颗遥控骰子：货架上也不能出现持有数「×2」（容易被看成库存）
    await waitMyTurn(page);
    await acted(page, () => debugAct(page, { op: 'give', seat, cards: [], items: [{ item: ITEM, qty: 2 }] }));
    const shop = await enterShop(page, seat);
    await expect(shop).toHaveAttribute('data-scene', 'classic');

    // 翻到道具店：货架只写名称与价格，没有库存、没有持有数
    await shop.getByTestId('shop-page-item').click();
    await expect(shop).toHaveAttribute('data-page', 'item');
    const shelf = shop.getByTestId('shop-shelf');
    await expect(shelf.getByTestId(`shop-item-${ITEM}`)).toBeVisible();
    await expect(shelf).not.toContainText('庫存');
    await expect(shelf).not.toContainText('库存');
    await expect(shelf).not.toContainText('×');
    const s0 = await shopState(page);
    expect(s0.own).toBeGreaterThanOrEqual(2);
    expect(s0.row).toEqual({ maxQty: 1, bought: false, listed: true });

    // 选遥控骰子：详情区只有「買下」，没有数量钮
    await shop.getByTestId(`shop-item-${ITEM}`).click();
    await expect(shop.getByTestId('shop-price')).toHaveAttribute('data-value', '30');
    await expect(shop.getByTestId('shop-qty')).toHaveCount(0);
    await expect(shop.getByTestId('shop-qty-inc')).toHaveCount(0);
    await expect(shop.getByRole('spinbutton')).toHaveCount(0);
    await expectServerRejects(page, 'before');

    // 买下：只买 1 个，场景保持打开，这一行变灰、不能再选
    await acted(page, () => shop.getByTestId('shop-buy-item').click());
    await waitDecision(page, ['SHOP']);
    const s1 = await shopState(page);
    expect(s1.trades).toEqual([{ op: 'buyItem', card: null, item: ITEM, qty: 1, points: 30 }]);
    expect(s1).toMatchObject({ points: 470, own: s0.own + 1, row: { maxQty: 0, bought: true, listed: true } });
    const row = shop.getByTestId(`shop-item-${ITEM}`);
    await expect(row).toBeDisabled();
    await expect(shop.getByTestId('shop-buy-item')).toHaveCount(0);
    await expect(shelf).not.toContainText('庫存');
    await expect(shelf).not.toContainText('×');
    await expectServerRejects(page, 'after');

    await acted(page, () => shop.getByTestId('shop-leave').click());
    await waitIdle(page);
    expectNoErrors([p]);
  } finally {
    await p.context.close();
  }
});

test('程序化皮肤：「买道具」不显示库存、没有数量步进器；买一件后置灰，服务器拒绝多买与重复购买', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const p: Player = await newPlayer(browser, '道具店程式', undefined, {
    setup: async (pg) => {
      await pg.addInitScript(() => {
        try {
          localStorage.setItem('rich4.settings', JSON.stringify({ state: { skin: 'procedural' }, version: 2 }));
        } catch {}
      });
    },
  });
  const page = p.page;
  try {
    await createRoom(page, { map: 'test', timer: 'off', aiCount: 1 });
    // 不用 startGame：原版配置下它会断言原版皮肤，这里设置里指定了程序化皮肤
    await page.getByTestId('room-start').click();
    await expect(page.getByTestId('screen-game')).toBeVisible();
    await waitIdle(page);
    await acted(page, () => debugAct(page, { op: 'clearBoard' }));
    await expect(page.getByTestId('screen-game')).not.toHaveAttribute('data-layout', 'classic');
    const seat = await mySeat(page);
    const shop = await enterShop(page, seat);
    await expect(shop).not.toHaveAttribute('data-scene', 'classic');

    await shop.getByRole('tab', { name: '买道具' }).click();
    const panel = shop.getByRole('tabpanel');
    await expect(panel.getByTestId(`shop-item-${ITEM}`)).toBeEnabled();
    await expect(panel).not.toContainText('库存');
    await panel.getByTestId(`shop-item-${ITEM}`).click();
    await expect(shop.getByRole('spinbutton')).toHaveCount(0);
    await expect(shop.getByTestId('shop-buy-item')).toContainText('30');
    await expectServerRejects(page, 'before');
    const s0 = await shopState(page);

    await acted(page, () => shop.getByTestId('shop-buy-item').click());
    await waitDecision(page, ['SHOP']);
    const s1 = await shopState(page);
    expect(s1.trades).toEqual([{ op: 'buyItem', card: null, item: ITEM, qty: 1, points: 30 }]);
    expect(s1).toMatchObject({ points: 470, own: s0.own + 1, row: { maxQty: 0, bought: true } });
    await expect(panel.getByTestId(`shop-item-${ITEM}`)).toBeDisabled();
    await expect(panel.getByTestId(`shop-item-${ITEM}`)).toContainText('这次进店已经买过了');
    await expect(shop.getByTestId('shop-buy-item')).toHaveCount(0);
    await expectServerRejects(page, 'after');

    await acted(page, () => shop.getByTestId('shop-leave').click());
    await waitIdle(page);
    expectNoErrors([p]);
  } finally {
    await p.context.close();
  }
});
