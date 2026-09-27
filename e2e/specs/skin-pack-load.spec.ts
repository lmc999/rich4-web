// 原版皮肤 A5：合成素材包 + fixture 地图（original-skin.md §3 修正 6）。
// 合成包由 `npm run extract -- assets synth` 现场生成到 .cache/synthetic-pack（内容全是自绘图形，不入库），
// 用 page.route 按 manifest 白名单提供 /pack/*，并把 GET /api/access 模拟成「门禁开启且已通过」（服务器启用素材包时的真实形态）。
// 1) 皮肤判定为 original：manifest、地图皮肤与图集请求成功；界面切到繁体（zh-TW）与原版主题；
//    原版棋盘渲染器（A6）尚未实现 → 棋盘回退程序化（renderer-unavailable），不报错，测试钩子同形，设置页显示原因；
// 2) 地图绑定不匹配 → auto 回退程序化（map-mismatch，设置页列出明细）；强制「原版」→ 界面原版、棋盘仍程序化。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';
import { type PackManifestV1, withPackId } from '../../packages/shared/src/assets/pack';
import { createRoom, expect, newPlayer, openMenu, Q, startGame, test, waitIdle, waitMyTurn } from '../fixtures/room';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACK_DIR = join(repoRoot, '.cache', 'synthetic-pack');

/** 门禁开启且已通过（本 spec 的服务器实际是 mode off，不能真的生成房间授权，所以 grants 关闭） */
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

/** 按 manifest 白名单提供 /pack/*（其余 404），manifest 可替换 */
async function servePack(page: Page, manifestBody: () => unknown): Promise<void> {
  await page.route('**/pack/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/pack/manifest.json')
      return route.fulfill({ json: manifestBody(), headers: { 'cache-control': 'no-cache' } });
    const rel = decodeURIComponent(path.slice('/pack/'.length));
    const type = servable.get(rel);
    if (!type) return route.fulfill({ status: 404, json: { ok: false, error: { code: 'BAD_REQUEST' } } });
    return route.fulfill({ status: 200, contentType: type, body: readFileSync(join(PACK_DIR, rel)) });
  });
  await page.route('**/api/access', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: ACCESS_ON }) : route.fallback(),
  );
}

interface SkinSnap {
  resolution: { skin: string; board: string; reason: string | null; boardReason: string | null; packId: string | null };
  pack: string;
  packId: string | null;
  failedGroups: string[];
  boardInUse: string | null;
  applied: string | null;
  lang: string;
}

async function skinOf(page: Page): Promise<SkinSnap | null> {
  // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
  return page.evaluate(() => ((window as any).__rich4?.skin ?? null) as SkinSnap | null);
}

async function boardHooks(page: Page): Promise<string> {
  return page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const r = (window as any).__rich4.renderer;
    return r ? `${r.kind}:${r.board.allActors().length}:${typeof r.board.roads.counts().objects}` : 'none';
  });
}

async function openSettings(page: Page): Promise<void> {
  await openMenu(page);
  await page.getByTestId('menu-settings').click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
}

test('合成素材包 + fixture 地图：判定为原版，请求成功，棋盘回退程序化且不报错；绑定不匹配时回退', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const responses: { path: string; status: number }[] = [];
  const failed: string[] = [];
  let body: unknown = manifest;
  // 路由在打开首页之前装好：前端启动时（bootstrapAccess）就读门禁状态
  const p = await newPlayer(browser, '原版', Q, {
    setup: async (pg) => {
      pg.on('response', (r) => {
        const u = new URL(r.url());
        if (u.pathname.startsWith('/pack/')) responses.push({ path: u.pathname, status: r.status() });
        if (r.status() >= 400) failed.push(`${r.status()} ${u.pathname}`);
      });
      await servePack(pg, () => body);
    },
  });
  const page = p.page;
  try {
    const code = await createRoom(page, { map: 'test', timer: 'off', aiCount: 1 });
    await startGame(page, [page]);
    await waitMyTurn(page);

    // 1) 原版判定
    await expect.poll(async () => (await skinOf(page))?.applied, { timeout: 20_000 }).toBe('original');
    const s = (await skinOf(page))!;
    expect(s).toMatchObject({
      pack: 'ready',
      packId: manifest.packId,
      resolution: { skin: 'original', board: 'procedural', reason: null, boardReason: 'renderer-unavailable' },
      boardInUse: 'procedural',
      lang: 'zh-TW',
    });
    await expect(page.locator('html')).toHaveAttribute('data-skin', 'original');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-TW');
    await expect(page.getByTestId('action-roll')).toContainText('擲骰');

    // manifest、地图皮肤与图集（地图组预取）都成功
    const skinPath = `/pack/${manifest.files[manifest.maps.test!.skin]!.path}`;
    await expect
      .poll(() => responses.filter((r) => r.path.startsWith('/pack/sprites/') && r.path.endsWith('.json')).length)
      .toBeGreaterThan(0);
    expect(responses.find((r) => r.path === '/pack/manifest.json')?.status).toBe(200);
    expect(responses.find((r) => r.path === skinPath)?.status).toBe(200);
    expect(responses.filter((r) => r.status !== 200)).toEqual([]);
    expect((await skinOf(page))?.failedGroups).toEqual([]);

    // 棋盘：程序化，测试钩子同形
    await expect.poll(() => boardHooks(page)).toBe('procedural:2:number');
    await expect(page.getByTestId('board-host')).toHaveAttribute('data-skin', 'procedural');

    // 设置页：当前判定与原因（繁体）
    await openSettings(page);
    const status = page.getByTestId('settings-skin-status');
    await expect(status).toHaveAttribute('data-skin', 'original');
    await expect(status).toHaveAttribute('data-board', 'procedural');
    await expect(page.getByTestId('settings-skin-reason')).toHaveAttribute('data-reason', 'renderer-unavailable');
    await expect(page.getByTestId('settings-skin-reason')).toContainText('原版棋盤尚未完成');
    await expect(status).toContainText(manifest.packId);
    await page.keyboard.press('Escape');

    // 2) 地图绑定不匹配：auto → 程序化（map-mismatch）
    const draft = structuredClone(manifest) as Omit<PackManifestV1, 'packId'> & { packId?: string };
    delete draft.packId;
    draft.maps.test!.binding.geometry = '0'.repeat(64);
    body = withPackId(draft);
    await page.goto(`/r/${code}?${Q}`);
    await expect(page.getByTestId('screen-game')).toBeVisible();
    await waitIdle(page);
    await expect.poll(async () => (await skinOf(page))?.resolution.reason, { timeout: 20_000 }).toBe('map-mismatch');
    expect((await skinOf(page))?.resolution).toMatchObject({ skin: 'procedural', board: 'procedural' });
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await openSettings(page);
    await expect(page.getByTestId('settings-skin-reason')).toHaveAttribute('data-reason', 'map-mismatch');
    await expect(page.getByTestId('settings-skin-mismatch')).toContainText('坐标 / 朝向有变化');

    //    强制「原版」：界面原版（繁体），棋盘仍程序化（map-mismatch）
    await page.getByTestId('settings-skin-original').check();
    await expect.poll(async () => (await skinOf(page))?.lang).toBe('zh-TW');
    expect((await skinOf(page))?.resolution).toMatchObject({
      skin: 'original',
      board: 'procedural',
      boardReason: 'map-mismatch',
    });
    await expect(page.getByTestId('settings-skin-reason')).toHaveAttribute('data-reason', 'map-mismatch');
    await page.getByTestId('settings-skin-auto').check();
    await expect.poll(async () => (await skinOf(page))?.lang).toBe('zh-CN');
    await page.keyboard.press('Escape');
    await expect.poll(() => boardHooks(page)).toBe('procedural:2:number');

    expect(failed).toEqual([]);
    expect(p.errors.filter((e) => !e.includes('WebGL') && !e.includes('favicon'))).toEqual([]);
  } finally {
    await p.context.close();
  }
});
