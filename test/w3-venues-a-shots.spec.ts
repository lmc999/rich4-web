// 调试（A12 第一组场所屏）：银行 ATM / 柜台、百货、乐透投注、股市（W3_INTEGRATE=1 构建时是原版股市）、乐透开奖演出的截图，
// 桌面 1920×1080 与手机横屏 844×390。素材包由 page.route 提供：缺省合成包（.cache/w3-venues-a-pack）；
// W3_PACK_DIR=rich4-assets 时用本机真实素材包（界面强制原版，棋盘回退程序化）。截图只写 .cache/w3-shots（绝不入库）。
// 用法：CI=1 W3_INTEGRATE=1 [W3_PACK_DIR=rich4-assets W3_TAG=real] npx playwright test -c test/w3-venues-a.config.ts w3-venues-a-shots
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';
import {
  acted,
  createRoom,
  debugAct,
  decisionKind,
  expect,
  joinRoom,
  newPlayer,
  pickCharacter,
  Q_ANIM,
  setReady,
  startGame,
  test,
  waitDecision,
  waitIdle,
  waitMyTurn,
} from '../e2e/fixtures/room';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACK_DIR = process.env.W3_PACK_DIR
  ? resolve(repoRoot, process.env.W3_PACK_DIR)
  : join(repoRoot, '.cache', 'w3-venues-a-pack');
const TAG = process.env.W3_TAG ?? 'synth';
const OUT = join(repoRoot, '.cache', 'w3-shots');
const manifest = JSON.parse(readFileSync(join(PACK_DIR, 'manifest.json'), 'utf8'));
const servable = new Map(
  Object.values(manifest.files as Record<string, { path: string; contentType: string }>).map((f) => [
    f.path,
    f.contentType,
  ]),
);

async function servePack(page: Page): Promise<void> {
  await page.route('**/pack/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/pack/manifest.json')
      return route.fulfill({ json: manifest, headers: { 'cache-control': 'no-cache' } });
    const rel = decodeURIComponent(path.slice('/pack/'.length));
    const type = servable.get(rel);
    if (!type) return route.fulfill({ status: 404, json: { ok: false } });
    return route.fulfill({ status: 200, contentType: type, body: readFileSync(join(PACK_DIR, rel)) });
  });
  // 片头动画（真实素材包才有）只在首次进入时播：先记成看过
  await page.addInitScript(() => {
    try {
      localStorage.setItem('rich4.introSeen', '1');
    } catch {}
  });
  if (process.env.W3_PACK_DIR) {
    await page.addInitScript(() => {
      try {
        const raw = localStorage.getItem('rich4.settings');
        const cur = raw ? JSON.parse(raw) : { state: {}, version: 2 };
        cur.state = { ...(cur.state ?? {}), skin: 'original' };
        localStorage.setItem('rich4.settings', JSON.stringify(cur));
      } catch {}
    });
  }
}

/** 走完这一步：路上遇到的无关决策（买地 → 不买；拍卖 → Esc 放弃）顺手答掉 */
async function settle(pages: Page[]): Promise<void> {
  for (let i = 0; i < 12; i++) {
    let busy = false;
    for (const p of pages) {
      await waitIdle(p);
      const k = await decisionKind(p);
      if (k === 'BUY_LAND' || k === 'BUY_FACILITY') {
        await acted(p, () => p.getByTestId('buy-decline').click());
        busy = true;
      } else if (k === 'AUCTION_BID') {
        await acted(p, () => p.keyboard.press('Escape'));
        busy = true;
      }
    }
    if (!busy) return;
  }
}

async function stepFrom(page: Page, seat: number, node: number, prev: number, dice: number): Promise<void> {
  await waitMyTurn(page);
  await acted(page, () => debugAct(page, { op: 'teleport', seat, node, prev }));
  await acted(page, () => debugAct(page, { op: 'forceNext', purpose: 'dice', values: [dice] }));
  await waitMyTurn(page);
  await acted(page, () => page.getByTestId('action-roll').click());
}

for (const vp of [
  { name: 'desktop', width: 1920, height: 1080 },
  { name: 'mobile', width: 844, height: 390 },
]) {
  test(`第一组场所屏截图（${vp.name}）`, async ({ browser }) => {
    test.setTimeout(300_000);
    mkdirSync(OUT, { recursive: true });
    const shot = async (page: Page, name: string): Promise<void> => {
      await page.waitForTimeout(350);
      await page.screenshot({ path: join(OUT, `venues-a-${TAG}-${vp.name}-${name}.png`) });
    };
    const mk = (n: string) =>
      newPlayer(browser, n, Q_ANIM, {
        setup: async (pg) => {
          await pg.setViewportSize({ width: vp.width, height: vp.height });
          await servePack(pg);
        },
      });
    const a = await mk('P1');
    const b = await mk('P2');
    try {
      const code = await createRoom(a.page, { map: 'test', timer: 'off', pacing: 'compact' });
      await joinRoom(b.page, code);
      await pickCharacter(a.page, 9);
      await pickCharacter(b.page, 4);
      await setReady(b.page);
      await startGame(a.page, [a.page, b.page]);
      const A = a.page;
      const B = b.page;
      await expect(A.getByTestId('classic-stage')).toBeVisible({ timeout: 30_000 });
      await waitMyTurn(A);
      await acted(A, () => debugAct(A, { op: 'setDate', date: 20100112 }));

      // P1 停在银行：ATM（银行底图上）
      await stepFrom(A, 0, 18, 17, 1);
      await waitDecision(A, ['BANK_ATM']);
      const atm = A.getByTestId('decision-BANK_ATM');
      await expect(atm).toHaveAttribute('data-scene', 'classic');
      await shot(A, 'atm-stop');
      for (const k of ['3', '0', '0', '0', '0']) await atm.getByTestId(`atm-key-${k}`).click();
      await atm.getByTestId('atm-key-5').hover();
      await shot(A, 'atm-typed');
      await acted(A, () => atm.getByTestId('bank-confirm').click());
      await waitDecision(A, ['BANK_COUNTER']);
      const counter = A.getByTestId('decision-BANK_COUNTER');
      await expect(counter).toHaveAttribute('data-scene', 'classic');
      await shot(A, 'counter');
      await counter.getByTestId('bank-calc-key-max').click();
      await shot(A, 'counter-max');
      await acted(A, () => counter.getByTestId('bank-skip').click());
      await waitIdle(A);

      // P2 路过银行：ATM 在棋盘视窗上
      await stepFrom(B, 1, 18, 17, 4);
      await waitDecision(B, ['BANK_ATM']);
      await expect(B.getByTestId('decision-BANK_ATM')).toHaveAttribute('data-scene', 'classic');
      await shot(B, 'atm-pass');
      await acted(B, () => B.getByTestId('bank-skip').click());
      await settle([A, B]);

      // P1 百货
      await waitMyTurn(A);
      await acted(A, () => debugAct(A, { op: 'setPoints', seat: 0, points: 500 }));
      await stepFrom(A, 0, 9, 8, 1);
      await waitDecision(A, ['SHOP']);
      const shop = A.getByTestId('decision-SHOP');
      await expect(shop).toHaveAttribute('data-scene', 'classic');
      await shot(A, 'shop');
      await shop.locator('[data-testid^="shop-shelf-"]:not([disabled])').first().click();
      await shot(A, 'shop-card');
      await shop.getByTestId('shop-page-item').click();
      await shop.getByTestId('shop-item-8').click();
      await shot(A, 'shop-item');
      await acted(A, () => shop.getByTestId('shop-leave').click());
      await settle([A, B]);

      // P2 乐透
      await stepFrom(B, 1, 7, 6, 1);
      await waitDecision(B, ['LOTTERY']);
      const lot = B.getByTestId('decision-LOTTERY');
      await expect(lot).toHaveAttribute('data-scene', 'classic');
      await shot(B, 'lottery');
      await lot.getByTestId('lottery-ball-5').click();
      await shot(B, 'lottery-confirm');
      await acted(B, () => lot.getByTestId('lottery-buy').click());
      await settle([A, B]);

      // P1 股市（工具列「股票」）
      await waitMyTurn(A);
      await A.getByTestId('action-stock').click();
      const sheet = A.getByTestId('turn-stock-sheet');
      await expect(sheet).toBeVisible();
      console.log('stock data-scene =', await sheet.getAttribute('data-scene'));
      await shot(A, 'stock');
      await sheet.getByTestId('stock-pick-0').click();
      await shot(A, 'stock-trade');
      await sheet.getByRole('button', { name: '關閉' }).click();
      await expect(sheet).toHaveCount(0);

      // 开奖：日期调到 14 日，P1、P2 各走一步后到 15 日开奖（原版演出，W3_INTEGRATE=1 时）
      await acted(A, () => debugAct(A, { op: 'setDate', date: 20100114 }));
      await stepFrom(A, 0, 12, 11, 1);
      await waitIdle(A);
      await stepFrom(B, 1, 12, 11, 1);
      const draw = A.getByTestId('lottery-draw-scene').or(A.getByTestId('lottery-popup'));
      await expect(draw).toBeVisible({ timeout: 30_000 });
      console.log('draw =', await draw.getAttribute('data-testid'));
      await shot(A, 'draw-1');
      await A.waitForTimeout(900);
      await shot(A, 'draw-2');
      await A.waitForTimeout(900);
      await shot(A, 'draw-3');
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });
}
