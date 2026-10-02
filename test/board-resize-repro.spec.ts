// 调试：经典布局（合成素材包 + fixture 地图，page.route 供包）下，视口 1920×1080 → 844×390 → 1920×1080 各变一次，
// 每次等舞台缩放稳定后比较棋盘画布与宿主（classic-board-slot / board-host）的 getBoundingClientRect。
// 现象：变大回 1920×1080 后画布仍是 844×390 时的尺寸（只占视窗左上角），直到下一次 window resize。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';
import type { PackManifestV1 } from '../packages/shared/src/assets/pack';
import { createRoom, expect, newPlayer, Q, startGame, test } from '../e2e/fixtures/room';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACK_DIR = join(repoRoot, '.cache', 'synthetic-pack');
const ACCESS_ON = { ok: true, data: { mode: 'passcode', granted: true, kind: 'p', expiresAt: Date.now() + 3_600_000, grants: false, canGrant: false } };
let manifest: PackManifestV1;
let servable: Map<string, string>;

test.beforeAll(() => {
  test.setTimeout(120_000);
  if (!existsSync(join(PACK_DIR, 'manifest.json'))) {
    execFileSync('npm', ['run', '--silent', 'extract', '--', 'assets', 'synth', '--out', '.cache/synthetic-pack'], { cwd: repoRoot, stdio: 'pipe' });
  }
  manifest = JSON.parse(readFileSync(join(PACK_DIR, 'manifest.json'), 'utf8')) as PackManifestV1;
  servable = new Map(Object.values(manifest.files).map((f) => [f.path, f.contentType]));
});

async function servePack(page: Page): Promise<void> {
  await page.route('**/pack/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/pack/manifest.json') return route.fulfill({ json: manifest, headers: { 'cache-control': 'no-cache' } });
    const rel = decodeURIComponent(path.slice('/pack/'.length));
    const type = servable.get(rel);
    if (!type) return route.fulfill({ status: 404, json: { ok: false, error: { code: 'BAD_REQUEST' } } });
    return route.fulfill({ status: 200, contentType: type, body: readFileSync(join(PACK_DIR, rel)) });
  });
  await page.route('**/api/access', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: ACCESS_ON }) : route.fallback()));
}

interface Sizes {
  scale: string | null;
  slot: [number, number];
  host: [number, number];
  canvas: [number, number];
  style: [string, string];
  screen: [number, number] | null;
}

async function sizes(page: Page): Promise<Sizes> {
  return page.evaluate(() => {
    const wh = (e: Element): [number, number] => {
      const b = e.getBoundingClientRect();
      return [Math.round(b.width * 100) / 100, Math.round(b.height * 100) / 100];
    };
    const slot = document.querySelector('[data-testid="classic-board-slot"]')!;
    const host = slot.querySelector('[data-testid="board-host"]')!;
    const canvas = host.querySelector('canvas')!;
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const surface = (window as any).__rich4?.renderer;
    const app = surface?.app;
    return {
      scale: document.querySelector('[data-testid="classic-stage"]')?.getAttribute('data-scale') ?? null,
      slot: wh(slot),
      host: wh(host),
      canvas: wh(canvas),
      style: [canvas.style.width, canvas.style.height],
      screen: app ? [app.screen.width, app.screen.height] : null,
    };
  });
}

async function resizeTo(page: Page, w: number, h: number): Promise<Sizes> {
  const stage = page.getByTestId('classic-stage');
  const before = await stage.getAttribute('data-scale');
  await page.setViewportSize({ width: w, height: h });
  await expect(stage).not.toHaveAttribute('data-scale', before ?? '');
  // 给 Pixi 的 rAF / ResizeObserver 足够的时间（卡住的话再等多久也不会变）
  await page.waitForTimeout(1500);
  return sizes(page);
}

test('单次视口变化后棋盘画布跟随宿主尺寸', async ({ browser }) => {
  test.setTimeout(180_000);
  const p = await newPlayer(browser, '缩放', Q, {
    setup: async (pg) => {
      await pg.setViewportSize({ width: 1920, height: 1080 });
      await servePack(pg);
    },
  });
  try {
    const page = p.page;
    await createRoom(page, { map: 'test', timer: 'off', aiCount: 1 });
    await startGame(page, [page]);
    await expect(page.getByTestId('classic-stage')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('classic-board-slot').getByTestId('board-host')).toBeVisible();
    await page.waitForTimeout(1000);
    const steps: [string, Sizes][] = [['1920×1080 初始', await sizes(page)]];
    steps.push(['→ 844×390', await resizeTo(page, 844, 390)]);
    steps.push(['→ 1920×1080', await resizeTo(page, 1920, 1080)]);
    steps.push(['→ 1280×800', await resizeTo(page, 1280, 800)]);
    for (const [label, s] of steps) console.log(label, JSON.stringify(s));
    for (const [label, s] of steps) expect(s.canvas, label).toEqual(s.host);
  } finally {
    await p.context.close();
  }
});
