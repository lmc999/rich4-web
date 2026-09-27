// 调试：BUY_LAND 原版场景截图（桌面 1920×1080 与手机横屏 844×390）。素材包由 page.route 提供：
// 缺省合成包（.cache/synthetic-pack）；W3_PACK_DIR=rich4-assets 时用本机真实素材包（界面强制原版，棋盘回退程序化）。
// 截图只写到 .cache/w3-shots（真实素材截图绝不入库）。
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
  setReady,
  startGame,
  test,
  waitDecision,
  waitMyTurn,
} from '../e2e/fixtures/room';

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

for (const vp of [
  { name: 'desktop', width: 1920, height: 1080 },
  { name: 'mobile', width: 844, height: 390 },
]) {
  test(`BUY_LAND 原版场景截图（${vp.name}）`, async ({ browser }) => {
    test.setTimeout(180_000);
    mkdirSync(OUT, { recursive: true });
    const mk = (n: string) =>
      newPlayer(browser, n, Q, { setup: async (pg) => { await pg.setViewportSize({ width: vp.width, height: vp.height }); await servePack(pg); } });
    const a = await mk('P1');
    const b = await mk('P2');
    try {
      const code = await createRoom(a.page, { map: 'test', timer: (process.env.W3_TIMER as 'off' | 'slow' | undefined) ?? 'off' });
      await joinRoom(b.page, code);
      await pickCharacter(a.page, 9);
      await pickCharacter(b.page, 4);
      await setReady(b.page);
      await startGame(a.page, [a.page, b.page]);
      await expect(a.page.getByTestId('classic-stage')).toBeVisible({ timeout: 30_000 });
      await waitMyTurn(a.page);
      await acted(a.page, () => debugAct(a.page, { op: 'teleport', seat: 0, node: 4, prev: 3 }));
      await acted(a.page, () => debugAct(a.page, { op: 'forceNext', purpose: 'dice', values: [1] }));
      await waitMyTurn(a.page);
      await acted(a.page, () => a.page.getByTestId('action-roll').click());
      await waitDecision(a.page, ['BUY_LAND']);
      const scene = a.page.getByTestId('decision-BUY_LAND');
      await expect(scene).toBeVisible();
      console.log('data-scene =', await scene.getAttribute('data-scene'));
      await a.page.waitForTimeout(400);
      await a.page.screenshot({ path: join(OUT, `buyland-${TAG}-${vp.name}.png`) });
      await a.page.getByTestId('buy-confirm').hover();
      await a.page.waitForTimeout(100);
      await a.page.screenshot({ path: join(OUT, `buyland-${TAG}-${vp.name}-hover.png`) });
      for (const id of ['buy-confirm', 'buy-decline']) {
        const bb = (await a.page.getByTestId(id).boundingBox())!;
        console.log(id, JSON.stringify(bb));
      }
      // 实际命中区（含 ::before 扩展）：在按钮外侧 4px 处取元素
      const hit = await a.page.evaluate(() => {
        const y = document.querySelector('[data-testid="buy-confirm"]')!.getBoundingClientRect();
        const n = document.querySelector('[data-testid="buy-decline"]')!.getBoundingClientRect();
        const at = (x: number, yy: number) => document.elementFromPoint(x, yy)?.getAttribute('data-testid') ?? null;
        return { yesLeft: at(y.left - 4, y.top + y.height / 2), noRight: at(n.right + 4, n.top + n.height / 2), yesTop: at(y.left + 4, y.top - 3) };
      });
      console.log('hit', JSON.stringify(hit));
      await acted(a.page, () => a.page.getByTestId('buy-confirm').click());
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });
}
