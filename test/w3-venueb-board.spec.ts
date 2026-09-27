// 调试（venues/b）：公佈欄原版场景截图（回合菜单 → 工具列 SALE；dialogs/TurnMenuFull 已套上 ClassicBoardSheet）；其余同 w3-venueb-shot（桌面 1920×1080 或手机横屏 844×390，W3_VP=mobile）。
// 素材包由 page.route 提供：缺省合成包（.cache/synthetic-pack）；W3_PACK_DIR=rich4-assets 时用本机真实素材包
// （界面强制原版，棋盘回退程序化）。截图只写到 .cache/w3-shots（真实素材截图绝不入库）。
// 用法：W3_PACK_DIR=rich4-assets W3_TAG=real CI=1 npx playwright test -c test/w3-playwright.config.ts w3-venueb
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';
import {
  acted,
  createRoom,
  debugAct,
  expect,
  joinRoom,
  newPlayer,
  pickCharacter,
  Q,
  Q_ANIM,
  setReady,
  startGame,
  syncPages,
  test,
  waitDecision,
  waitMyTurn,
} from '../e2e/fixtures/room';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACK_DIR = process.env.W3_PACK_DIR
  ? resolve(repoRoot, process.env.W3_PACK_DIR)
  : join(repoRoot, '.cache', 'w3b', 'synth');
const TAG = process.env.W3_TAG ?? 'synth';
const VP = process.env.W3_VP === 'mobile' ? { name: 'mobile', width: 844, height: 390 } : { name: 'desktop', width: 1920, height: 1080 };
const OUT = join(repoRoot, '.cache', 'w3-shots');
const manifest = JSON.parse(readFileSync(join(PACK_DIR, 'manifest.json'), 'utf8'));
const servable = new Map(
  Object.values(manifest.files as Record<string, { path: string; contentType: string }>).map((f) => [f.path, f.contentType]),
);

async function servePack(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('rich4.introSeen', '1');
    } catch {}
  });
  await page.route('**/pack/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/pack/manifest.json') return route.fulfill({ json: manifest, headers: { 'cache-control': 'no-cache' } });
    const rel = decodeURIComponent(path.slice('/pack/'.length));
    const type = servable.get(rel);
    if (!type) return route.fulfill({ status: 404, json: { ok: false } });
    return route.fulfill({ status: 200, contentType: type, body: readFileSync(join(PACK_DIR, rel)) });
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

const shot = async (page: Page, name: string): Promise<void> => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(OUT, `venueb-${name}-${TAG}-${VP.name}.png`) });
};

async function stepOnto(page: Page, seat: number, node: number, prev: number): Promise<void> {
  await waitMyTurn(page);
  await acted(page, () => debugAct(page, { op: 'teleport', seat, node, prev }));
  await acted(page, () => debugAct(page, { op: 'forceNext', purpose: 'dice', values: [1] }));
  await waitMyTurn(page);
  await acted(page, () => page.getByTestId('action-roll').click());
}

test(`venues/b 公佈欄截图（${VP.name}）`, async ({ browser }) => {
  test.setTimeout(300_000);
  mkdirSync(OUT, { recursive: true });
  const mk = (n: string, q = Q) =>
    newPlayer(browser, n, q, {
      setup: async (pg) => {
        await pg.setViewportSize({ width: VP.width, height: VP.height });
        await servePack(pg);
      },
    });
  const players = [await mk('P1'), await mk('P2')];
  const pages = players.map((p) => p.page);
  const [a, b] = pages as [Page, Page];
  try {
    const code = await createRoom(a, { map: 'test', timer: 'off' });
    await joinRoom(b, code);
    await pickCharacter(a, 9);
    await pickCharacter(b, 4);
    await setReady(b);
    await startGame(a, pages);
    await waitMyTurn(a);
    await acted(a, () => debugAct(a, { op: 'give', seat: 0, cards: [9, 12], items: [{ item: 3, qty: 2 }] }));
    await waitMyTurn(a);
    await a.getByTestId('action-board').click();
    await expect(a.locator('[data-testid="decision-TURN_MENU"][data-venue="bulletin"]')).toBeVisible();
    await shot(a, 'board-empty');
    await a.getByTestId('board-sell').click();
    await shot(a, 'board-kinds');
    await a.getByTestId('board-kind-item').click();
    await shot(a, 'board-table-item');
    await a.getByTestId('board-pick-item-3').click();
    await shot(a, 'board-form-item');
    await a.getByTestId('board-edit-price').click();
    await a.getByTestId('board-calc-input').fill('1200');
    await acted(a, () => a.getByTestId('board-list').click());
    await a.getByTestId('board-sell').click();
    await a.getByTestId('board-kind-card').click();
    await a.getByTestId('board-pick-card-12').click();
    await a.getByTestId('board-calc-input').fill('800');
    await acted(a, () => a.getByTestId('board-list').click());
    await shot(a, 'board');
    const mine = a.locator('[data-testid^="listing-"][data-mine="true"]').first();
    await mine.click();
    await shot(a, 'board-detail-mine');
    await a.getByTestId('listing-close').click();
    await a.getByTestId('board-exit').click();
    await stepOnto(a, 0, 17, 16);
    await waitDecision(a, ['BUY_LAND']);
    await acted(a, () => a.getByTestId('buy-decline').click());
    await waitMyTurn(b);
    await b.getByTestId('action-board').click();
    await expect(b.locator('[data-testid="decision-TURN_MENU"][data-venue="bulletin"]')).toBeVisible();
    await shot(b, 'board-p2');
    await b.locator('[data-testid^="listing-"][data-mine="false"]').first().click();
    await shot(b, 'board-detail-other');
  } finally {
    for (const p of players) await p.context.close();
  }
});
