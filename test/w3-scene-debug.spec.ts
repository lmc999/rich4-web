// 调试：临时把 BUY_LAND 登记成 W3Debug（源码存放在 .cache/w3-debug/W3Debug.tsx.txt，用时拷回 ui/classic/dialogs 并改 index.ts，用完还原），
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';
import { acted, createRoom, debugAct, expect, joinRoom, newPlayer, pickCharacter, Q, setReady, startGame, test, waitDecision, waitMyTurn } from '../e2e/fixtures/room';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACK_DIR = process.env.W3_PACK_DIR ? resolve(repoRoot, process.env.W3_PACK_DIR) : join(repoRoot, '.cache', 'synthetic-pack');
const TAG = process.env.W3_TAG ?? 'synth';
const OUT = join(repoRoot, '.cache', 'w3-shots');
const manifest = JSON.parse(readFileSync(join(PACK_DIR, 'manifest.json'), 'utf8'));
const servable = new Map(Object.values(manifest.files as Record<string, { path: string; contentType: string }>).map((f) => [f.path, f.contentType]));

async function servePack(page: Page): Promise<void> {
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

test('W3Debug 截图', async ({ browser }) => {
  test.setTimeout(180_000);
  mkdirSync(OUT, { recursive: true });
  const mk = (n: string) => newPlayer(browser, n, Q, { setup: async (pg) => { await pg.setViewportSize({ width: 1920, height: 1080 }); await servePack(pg); } });
  const a = await mk('P1');
  const b = await mk('P2');
  try {
    const code = await createRoom(a.page, { map: 'test', timer: 'off' });
    await joinRoom(b.page, code);
    await pickCharacter(a.page, 9);
    await pickCharacter(b.page, 4);
    await setReady(b.page);
    await startGame(a.page, [a.page, b.page]);
    await waitMyTurn(a.page);
    await acted(a.page, () => debugAct(a.page, { op: 'teleport', seat: 0, node: 4, prev: 3 }));
    await acted(a.page, () => debugAct(a.page, { op: 'forceNext', purpose: 'dice', values: [1] }));
    await waitMyTurn(a.page);
    await acted(a.page, () => a.page.getByTestId('action-roll').click());
    await waitDecision(a.page, ['BUY_LAND']);
    await expect(a.page.getByTestId('decision-BUY_LAND')).toHaveAttribute('data-scene', 'classic');
    await a.page.waitForTimeout(800);
    await a.page.getByTestId('calc-key-7').hover();
    await a.page.mouse.down();
    await a.page.waitForTimeout(100);
    await a.page.screenshot({ path: join(OUT, `debug-${TAG}.png`) });
    await a.page.mouse.up();
    await a.page.screenshot({ path: join(OUT, `debug-${TAG}-zoom.png`), clip: { x: 250, y: 100, width: 200, height: 150 } });
    await a.page.screenshot({ path: join(OUT, `debug-${TAG}-zoom2.png`), clip: { x: 250, y: 400, width: 200, height: 150 } });
    await a.page.screenshot({ path: join(OUT, `debug-${TAG}-bank.png`), clip: { x: 240, y: 720, width: 520, height: 280 } });
    console.log('slices', JSON.stringify(await a.page.evaluate(() => [...document.querySelectorAll('[data-slice]')].map((e) => `${e.getAttribute('data-frame')}:${e.getAttribute('data-slice')}`))));
    console.log('calc', await a.page.getByTestId('calc').getAttribute('data-value'), await a.page.getByTestId('calc-keys').getAttribute('data-mask'));
  } finally {
    await a.context.close();
    await b.context.close();
  }
});
