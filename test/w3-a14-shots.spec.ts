// 调试（A14）：标题 / 开局设置 / 选人大厅 / 对局工具列的截图（桌面与手机横屏），素材包由 page.route 从 W3_PACK_DIR 提供
// （缺省合成素材包；W3_PACK_DIR=rich4-assets 时用本机真实素材包，截图含原版素材，只写 .cache/w3-shots，不入库）。
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';
import { createRoom, expect, joinRoom, newPlayer, pickCharacter, Q, setReady, startGame, test } from '../e2e/fixtures/room';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACK = resolve(root, process.env.W3_PACK_DIR ?? '.cache/synthetic-pack');
const TAG = process.env.W3_TAG ?? (process.env.W3_PACK_DIR ? 'real' : 'synth');
const OUT = join(root, '.cache', 'w3-shots');
mkdirSync(OUT, { recursive: true });
const manifest = JSON.parse(readFileSync(join(PACK, 'manifest.json'), 'utf8')) as {
  files: Record<string, { path: string; contentType: string }>;
};
const servable = new Map(Object.values(manifest.files).map((f) => [f.path, f.contentType]));
const ACCESS_ON = { ok: true, data: { mode: 'passcode', granted: true, kind: 'p', expiresAt: Date.now() + 3_600_000, grants: false, canGrant: false } };

async function serve(page: Page): Promise<void> {
  await page.route('**/pack/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/pack/manifest.json') return route.fulfill({ json: manifest, headers: { 'cache-control': 'no-cache' } });
    const rel = decodeURIComponent(path.slice('/pack/'.length));
    const type = servable.get(rel);
    if (!type) return route.fulfill({ status: 404, json: { ok: false } });
    return route.fulfill({ status: 200, contentType: type, body: readFileSync(join(PACK, rel)) });
  });
  await page.route('**/api/access', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: ACCESS_ON }) : r.fallback()));
}

const shot = (page: Page, name: string) => page.screenshot({ path: join(OUT, `a14-${TAG}-${name}.png`) });

for (const vp of [
  { name: 'desk', width: 1280, height: 960 },
  { name: 'phone', width: 844, height: 390 },
]) {
  test(`A14 截图 ${vp.name}`, async ({ browser }) => {
    test.setTimeout(180_000);
    const a = await newPlayer(browser, '阿土', Q, { setup: async (p) => { await p.setViewportSize(vp); await serve(p); } });
    const b = await newPlayer(browser, '小美', Q, { setup: async (p) => { await p.setViewportSize(vp); await serve(p); } });
    try {
      const pg = a.page;
      await expect(pg.getByTestId('screen-home')).toHaveAttribute('data-screen', 'title');
      await pg.waitForTimeout(600);
      await shot(pg, `${vp.name}-title`);
      await pg.getByTestId('home-create').hover();
      await pg.waitForTimeout(200);
      await shot(pg, `${vp.name}-title-hover`);
      await pg.getByTestId('home-join-open').click();
      await shot(pg, `${vp.name}-title-join`);
      await pg.getByTestId('title-panel-close').click();
      await pg.getByTestId('home-create').click();
      await expect(pg.getByTestId('screen-setup')).toBeVisible();
      await pg.waitForTimeout(600);
      await shot(pg, `${vp.name}-setup`);
      await pg.getByTestId('create-cancel').click();
      const code = await createRoom(pg, { map: 'test', timer: 'off' });
      await joinRoom(b.page, code);
      await pickCharacter(pg, 9);
      await pickCharacter(b.page, 4);
      await setReady(b.page);
      await pg.getByTestId('char-6').hover();
      await pg.waitForTimeout(800);
      await shot(pg, `${vp.name}-lobby`);
      await shot(b.page, `${vp.name}-lobby-guest`);
      await pg.getByTestId('room-start').click();
      await pg.waitForTimeout(150);
      await shot(pg, `${vp.name}-loading`);
      await startGame(pg, [pg, b.page], { clearBoard: false }).catch(() => undefined);
      await expect(pg.getByTestId('screen-game')).toBeVisible();
      await pg.waitForTimeout(1500);
      if (vp.name === 'phone') {
        await pg.getByTestId('tool-more').click();
        await pg.waitForTimeout(200);
      }
      await shot(pg, `${vp.name}-game`);
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });
}

test('A14 标题音乐（素材包 music-map 的 title / setup 场景曲）', async ({ browser }) => {
  test.skip(!process.env.W3_PACK_DIR, '合成包没有音乐');
  const p = await newPlayer(browser, '音乐', 'test=1', { setup: async (pg) => serve(pg) });
  try {
    const pg = p.page;
    await expect(pg.getByTestId('screen-home')).toHaveAttribute('data-screen', 'title');
    // 真实素材包带片头：先看到片头（截图），再跳过
    await expect(pg.getByTestId('intro')).toBeVisible();
    await pg.waitForTimeout(3000);
    await shot(pg, 'intro');
    await pg.getByTestId('intro-skip').click();
    await pg.getByTestId('home-join-open').click();
    await pg.getByTestId('title-panel-close').click();
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const music = () => pg.evaluate(() => JSON.stringify((window as any).__rich4?.audio?.music?.() ?? null));
    await expect.poll(music, { timeout: 15_000 }).toContain('music.track10');
    console.log('title music', await music());
  } finally {
    await p.context.close();
  }
});
