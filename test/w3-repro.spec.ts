// 调试：回合菜单开过一次（卡片欄 → Esc 收起）之后，工具列的股票 / SALE 还能打开原版股市 / 公佈欄吗（合成素材包）
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';
import type { PackManifestV1 } from '../packages/shared/src/assets/pack';
import {
  acted,
  createRoom,
  debugAct,
  expect,
  joinRoom,
  newPlayer,
  pickCharacter,
  Q_ANIM,
  setReady,
  startGame,
  test,
  waitMyTurn,
} from '../e2e/fixtures/room';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACK_DIR = join(repoRoot, '.cache', 'synthetic-pack');
const ACCESS_ON = { ok: true, data: { mode: 'passcode', granted: true, kind: 'p', expiresAt: Date.now() + 3_600_000, grants: false, canGrant: false } };
let manifest: PackManifestV1;
let servable: Map<string, string>;

test.beforeAll(() => {
  test.setTimeout(120_000);
  execFileSync('npm', ['run', '--silent', 'extract', '--', 'assets', 'synth', '--out', '.cache/synthetic-pack'], { cwd: repoRoot, stdio: 'pipe' });
  manifest = JSON.parse(readFileSync(join(PACK_DIR, 'manifest.json'), 'utf8')) as PackManifestV1;
  servable = new Map(Object.values(manifest.files).map((f) => [f.path, f.contentType]));
});

async function servePack(page: Page): Promise<void> {
  await page.route('**/pack/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/pack/manifest.json') return route.fulfill({ json: manifest, headers: { 'cache-control': 'no-cache' } });
    const rel = decodeURIComponent(path.slice('/pack/'.length));
    const type = servable.get(rel);
    if (!type) return route.fulfill({ status: 404, json: { ok: false } });
    return route.fulfill({ status: 200, contentType: type, body: readFileSync(join(PACK_DIR, rel)) });
  });
  await page.route('**/api/access', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: ACCESS_ON }) : route.fallback()));
}

test('卡片欄 Esc 收起后，工具列股票 / SALE 打开原版子页', async ({ browser }) => {
  test.setTimeout(180_000);
  const mk = (nick: string) => newPlayer(browser, nick, Q_ANIM, { setup: async (pg) => { await pg.setViewportSize({ width: 1920, height: 1080 }); await servePack(pg); } });
  const a = await mk('P1');
  const b = await mk('P2');
  const A = a.page;
  const code = await createRoom(A, { map: 'test', timer: 'off' });
  await joinRoom(b.page, code);
  await pickCharacter(A, 9);
  await pickCharacter(b.page, 4);
  await setReady(b.page);
  await startGame(A, [A, b.page]);
  await waitMyTurn(A);
  await acted(A, () => debugAct(A, { op: 'setDate', date: 20100104 }));
  await waitMyTurn(A);
  const layers = async () => A.evaluate(() => [...document.querySelectorAll('[data-testid^="decision-layer"]')].map((e) => `${e.getAttribute('data-testid')}:${e.getAttribute('data-kind')}`));
  await A.getByTestId('action-cards').click();
  await expect(A.getByTestId('decision-TURN_MENU')).toHaveAttribute('data-tab', 'cards');
  await A.getByTestId('action-items').click();
  console.log('open', await layers());
  await A.keyboard.press('Escape');
  console.log('after esc', await layers(), await A.evaluate(() => (window as any).__rich4.store.ui.getState().panel));
  await A.getByTestId('action-stock').click();
  await A.waitForTimeout(1500);
  console.log('after stock', await layers(), await A.evaluate(() => (window as any).__rich4.store.ui.getState().panel));
  await A.screenshot({ path: join(repoRoot, '.cache/w3/repro-stock.png') });
  await expect(A.getByTestId('turn-stock-sheet')).toBeVisible();
  await A.getByTestId('stock-exit').click();
  await A.getByTestId('action-cards').click();
  await expect(A.getByTestId('decision-TURN_MENU')).toHaveAttribute('data-tab', 'cards');
  await A.keyboard.press('Escape');
  await A.getByTestId('action-board').click();
  await expect(A.getByTestId('board-panel')).toBeVisible();
});
