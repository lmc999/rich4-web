// 原版皮肤 A5：没有可用素材包时一律回退程序化（original-skin.md §3 修正 4；design-draft §3.1 判定矩阵）。
// 1) 默认服务器（ACCESS_MODE=off、没有素材包）：前端只问 GET /api/access，不请求任何 /pack/*；程序化棋盘、简体、无报错；
// 2) 门禁开启（page.route 模拟 /api/access）但 manifest 404 / 非 JSON / 校验失败 → 程序化，原因各自正确；
// 3) manifest 401（ACCESS_REQUIRED）→ 对局页弹出门禁页，输入口令后收起并重新发现素材包。
// 每种情况刷新页面（重新进入同一局）让前端重新发现；刷新前后 BoardSurface 测试钩子与 HUD 照常工作。
import type { Page, Route } from '@playwright/test';
import { createRoom, expect, newPlayer, Q, startGame, test, waitIdle, waitMyTurn } from '../fixtures/room';

const ACCESS_ON = {
  ok: true,
  data: { mode: 'passcode', granted: true, kind: 'p', expiresAt: Date.now() + 3_600_000, grants: true, canGrant: true },
};

interface SkinSnap {
  resolution: { skin: string; board: string; reason: string | null; boardReason: string | null };
  pack: string;
  applied: string | null;
  lang: string;
}

async function skinOf(page: Page): Promise<SkinSnap | null> {
  // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
  return page.evaluate(() => ((window as any).__rich4?.skin ?? null) as SkinSnap | null);
}

/** 素材包判定结束（不再是 loading / idle） */
async function waitSkinSettled(page: Page): Promise<SkinSnap> {
  await expect
    .poll(async () => (await skinOf(page))?.pack ?? 'none', { timeout: 20_000 })
    .not.toMatch(/^(none|idle|loading)$/);
  return (await skinOf(page))!;
}

/** 棋盘表面是程序化、测试钩子同形可读 */
async function expectProceduralBoard(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
        const r = (window as any).__rich4.renderer;
        return r ? `${r.kind}:${r.board.allActors().length}:${typeof r.board.roads.counts().objects}` : 'none';
      }),
    )
    .toBe('procedural:2:number');
  await expect(page.getByTestId('board-host')).toHaveAttribute('data-skin', 'procedural');
  await expect(page.locator('html')).not.toHaveAttribute('data-skin', 'original');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
}

/** 重新打开房间页（带测试开关；凭 token 回到原座位）并等回到对局页 */
async function reenter(page: Page, code: string): Promise<void> {
  await page.goto(`/r/${code}?${Q}`);
  await expect(page.getByTestId('screen-game')).toBeVisible();
  await waitIdle(page);
}

test('没有素材包：程序化棋盘与简体；门禁开启但 manifest 不可用时同样回退；manifest 401 弹门禁页', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const p = await newPlayer(browser, '回退');
  const page = p.page;
  const packRequests: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/pack/')) packRequests.push(`${r.method()} ${u.pathname}`);
  });
  try {
    const code = await createRoom(page, { map: 'test', timer: 'off', aiCount: 1 });
    await startGame(page, [page]);
    await waitMyTurn(page);

    // 1) 默认服务器：mode off → 不请求 /pack/*（生产构建），程序化
    let s = await waitSkinSettled(page);
    expect(s).toMatchObject({
      pack: 'absent',
      resolution: { skin: 'procedural', board: 'procedural', reason: 'pack-absent' },
      applied: 'procedural',
      lang: 'zh-CN',
    });
    expect(packRequests).toEqual([]);
    await expectProceduralBoard(page);
    await expect(page.getByTestId('action-roll')).toContainText('掷骰');

    // 2) 门禁开启、manifest 各种不可用
    await page.route('**/api/access', (route: Route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: ACCESS_ON }) : route.fallback(),
    );
    const cases: [string, (r: Route) => Promise<void>, string][] = [
      [
        '404 JSON',
        (r) =>
          r.fulfill({
            status: 404,
            json: { ok: false, error: { code: 'BAD_REQUEST', details: { reason: 'packDisabled' } } },
          }),
        'pack-absent',
      ],
      [
        'SPA 页面',
        (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><p>app</p>' }),
        'pack-absent',
      ],
      ['校验失败', (r) => r.fulfill({ json: { schema: 'rich4.assets/1', packId: 'x' } }), 'pack-invalid'],
    ];
    for (const [name, handler, reason] of cases) {
      await page.unroute('**/pack/manifest.json');
      await page.route('**/pack/manifest.json', handler);
      packRequests.length = 0;
      await reenter(page, code);
      s = await waitSkinSettled(page);
      expect(s.resolution, name).toMatchObject({ skin: 'procedural', board: 'procedural', reason });
      expect(packRequests, name).toEqual(['GET /pack/manifest.json']);
      await expectProceduralBoard(page);
    }

    // 3) manifest 401 → 门禁页；口令通过后收起、重新发现（这次 manifest 404）
    let granted = false;
    await page.unroute('**/pack/manifest.json');
    await page.route('**/pack/manifest.json', (r) =>
      granted
        ? r.fulfill({ status: 404, json: { ok: false } })
        : r.fulfill({
            status: 401,
            json: { ok: false, error: { code: 'ACCESS_REQUIRED', details: { reason: 'missing' } } },
          }),
    );
    await page.unroute('**/api/access');
    const posted: unknown[] = [];
    await page.route('**/api/access', async (route) => {
      if (route.request().method() === 'POST') {
        posted.push(route.request().postDataJSON());
        granted = true;
        return route.fulfill({ json: ACCESS_ON });
      }
      return route.fulfill({ json: ACCESS_ON });
    });
    await reenter(page, code);
    const gate = page.getByTestId('access-gate');
    await expect(gate).toBeVisible();
    await expect(gate).toHaveAttribute('data-reason', 'pack');
    expect((await skinOf(page))?.resolution.reason).toBe('access-required');
    await page.getByTestId('access-passcode').fill('e2e-pass');
    await page.getByTestId('access-submit').click();
    await expect(gate).toBeHidden();
    expect(posted).toEqual([{ passcode: 'e2e-pass' }]);
    await expect.poll(async () => (await skinOf(page))?.resolution.reason).toBe('pack-absent');
    await expectProceduralBoard(page);

    // 素材包 404 / 401 在 Chrome 里记成「Failed to load resource」，属于本用例刻意制造的响应
    expect(
      p.errors.filter(
        (e) => !e.includes('WebGL') && !e.includes('favicon') && !/Failed to load resource.*(404|401)/.test(e),
      ),
    ).toEqual([]);
  } finally {
    await p.context.close();
  }
});
