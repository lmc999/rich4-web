// 原版皮肤 A14：标题、开局设置、选人大厅、Loading、片头（original-skin.md §4.3）。合成素材包 + fixture 地图（与
// skin-classic-shell 同一种供包方式：page.route 按 manifest 白名单提供 /pack/*，GET /api/access 模拟成「门禁开启且已通过」）。
// 合成包带这几屏的条目（tools/extract 的 syntheticUi：标题 Data#1、开局部件 jump#4、背景 jump#0、Loading Data#560、
// 36 段侧视走动，自绘图形，帧数 / 帧尺寸 / 锚点同原版包），画面走原版精灵路径；原版美术只在本机用真实素材包目视。
// 1) 桌面 1920×1080、4 个真人：标题（悬停换放大帧；没有片头条目时不播片头）→ START 开局设置（竖栏 6 个下拉 + 联机设置）
//    → 建房 → 选人大厅（头像格、走动预览、邀请链接、座位牌）→ 3 人加入并选角 → 准备 → 房主 OK 开局 → 经典对局页；
// 2) 片头：manifest 带 video.start 时首次进入播放、可跳过、看过不再自动播放、设置里可重播（视频请求挂起，只测跳过）；
// 3) 手机横屏 844×390：标题、开局设置、选人大厅的交互控件热区 ≥44×44 CSS 像素；对局页工具列收成「更多」、每个钮与
//    菜单项 ≥44×44，太阳 / 月亮钮 ≥44×44；页面不横向滚动。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';
import { hashedPath } from '../../packages/shared/src/assets/common';
import { type PackManifestV1, withPackId } from '../../packages/shared/src/assets/pack';
import {
  createRoom,
  expect,
  expectNoErrors,
  joinRoom,
  newPlayer,
  type Player,
  pickCharacter,
  Q,
  Q_ANIM,
  setReady,
  startGame,
  test,
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

/** 按 manifest 白名单提供 /pack/*；hang 里的路径不回应（模拟加载很慢的视频） */
async function servePack(page: Page, body: () => PackManifestV1 = () => manifest, hang = new Set<string>()) {
  await page.route('**/pack/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/pack/manifest.json')
      return route.fulfill({ json: body(), headers: { 'cache-control': 'no-cache' } });
    const rel = decodeURIComponent(path.slice('/pack/'.length));
    if (hang.has(rel)) return;
    const type = servable.get(rel);
    if (!type) return route.fulfill({ status: 404, json: { ok: false, error: { code: 'BAD_REQUEST' } } });
    return route.fulfill({ status: 200, contentType: type, body: readFileSync(join(PACK_DIR, rel)) });
  });
  await page.route('**/api/access', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: ACCESS_ON }) : route.fallback(),
  );
}

async function classicPlayer(
  browser: Parameters<typeof newPlayer>[0],
  nick: string,
  viewport: { width: number; height: number },
  o: { query?: string; body?: () => PackManifestV1; hang?: Set<string> } = {},
): Promise<Player> {
  return newPlayer(browser, nick, o.query ?? Q, {
    setup: async (pg) => {
      await pg.setViewportSize(viewport);
      await servePack(pg, o.body, o.hang);
    },
  });
}

/** 原版标题画面（繁体） */
async function expectTitle(page: Page): Promise<void> {
  await expect(page.getByTestId('screen-home')).toHaveAttribute('data-screen', 'title', { timeout: 30_000 });
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-TW');
  await expect(page.getByTestId('title-bg')).toHaveAttribute('data-sprite', 'title.screen/0');
}

/**
 * 控件热区里最大的正方形边长（CSS 像素）：在控件周围 ±80 像素内逐像素 elementFromPoint，落在该控件（含透明热区、伪元素）
 * 上的点构成热区，求其中最大的全命中正方形
 */
async function hitSquare(page: Page, testId: string): Promise<number> {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) throw new Error(`没有 ${id}`);
    const r = el.getBoundingClientRect();
    const x0 = Math.floor(r.left - 80);
    const y0 = Math.floor(r.top - 80);
    const W = Math.ceil(r.width + 160);
    const H = Math.ceil(r.height + 160);
    let prev = new Int32Array(W + 1);
    let best = 0;
    for (let y = 0; y < H; y++) {
      const cur = new Int32Array(W + 1);
      for (let x = 0; x < W; x++) {
        const hit = document.elementFromPoint(x0 + x + 0.5, y0 + y + 0.5);
        if (hit !== null && (hit === el || el.contains(hit))) {
          cur[x + 1] = Math.min(prev[x + 1]!, cur[x]!, prev[x]!) + 1;
          if (cur[x + 1]! > best) best = cur[x + 1]!;
        }
      }
      prev = cur;
    }
    return best;
  }, testId);
}

async function expectHit(page: Page, ids: readonly string[], min = 44): Promise<void> {
  for (const id of ids) expect(await hitSquare(page, id), id).toBeGreaterThanOrEqual(min);
}

test('桌面 1920×1080：标题 → 开局设置 → 选人大厅 → 邀请 → 4 人准备 → 开局', async ({ browser }) => {
  test.setTimeout(240_000);
  const players: Player[] = [];
  try {
    for (const n of ['P1', 'P2', 'P3', 'P4'])
      players.push(await classicPlayer(browser, n, { width: 1920, height: 1080 }));
    const pages = players.map((p) => p.page);
    const [a, b, c, d] = pages as [Page, Page, Page, Page];

    // 标题：Data#1 底图；START 悬停换放大帧（图2），移开恢复（底图已烘焙常态图标）；没有片头条目 → 不播片头
    await expectTitle(a);
    await expect(a.getByTestId('intro')).toHaveCount(0);
    const stage = a.getByTestId('classic-stage');
    await expect(stage).toHaveAttribute('data-scale', '2.2500');
    const start = a.getByTestId('home-create');
    await start.hover();
    await expect(start.locator('[data-sprite]')).toHaveAttribute('data-sprite', 'title.screen/2');
    await a.mouse.move(5, 5);
    await expect(start.locator('[data-sprite]')).toHaveCount(0);

    // START → 开局设置：竖栏（jump#4 图1）、背景（jump#0）、6 个下拉叠在白框上、联机设置面板；EXIT 回标题再进来
    await start.click();
    const setup = a.getByTestId('screen-setup');
    await expect(setup).toBeVisible();
    await expect(setup.getByTestId('setup-column')).toHaveAttribute('data-sprite', 'title.setup.ui/1');
    await expect(setup.getByTestId('setup-bg')).toHaveAttribute('data-image', 'title.setup.bg');
    await a.getByTestId('create-cancel').click();
    await expectTitle(a);
    await a.getByTestId('home-create').click();
    await expect(a.locator('[data-testid="set-map"] option[value="test"]')).toHaveCount(1);
    await a.getByTestId('set-map').selectOption('test');
    await expect(a.getByTestId('setup-banner')).toHaveCount(0);
    await a.getByTestId('set-timer').selectOption('off');
    await a.getByTestId('set-fund').selectOption('100000');
    await a.getByTestId('set-vehicle').selectOption('moto');
    await a.getByTestId('create-submit').click();
    await a.waitForURL(/\/r\/\d{6}/);
    const code = /\/r\/(\d{6})/.exec(a.url())![1]!;

    // 选人大厅：原版画面（竖栏显示当前设置、头像格、座位牌）；邀请链接在左栏
    const room = a.getByTestId('screen-room');
    await expect(room).toHaveAttribute('data-screen', 'select');
    await expect(a.getByTestId('setup-grid')).toHaveAttribute('data-sprite', 'title.setup.ui/0');
    await expect(a.getByTestId('setup-value-vehicle')).toHaveText('機車');
    await expect(a.getByTestId('setup-value-initialFund')).toHaveText('10 萬');
    await expect(a.getByTestId('classic-rail-left').getByTestId('room-code')).toHaveText(code);
    await expect(a.getByTestId('invite-url')).toHaveValue(new RegExp(`/r/${code}$`));
    await expect(a.getByTestId('char-walker')).toHaveAttribute('data-sheet', 'title.sidewalk.0.moto');
    for (const p of [b, c, d]) await joinRoom(p, code);
    await expect(a.getByTestId('classic-seat-3')).toContainText('P4');

    await pickCharacter(a, 9);
    await expect(a.getByTestId('char-9')).toHaveAttribute('data-mine', 'true');
    await expect(a.getByTestId('char-walker')).toHaveAttribute('data-sheet', 'title.sidewalk.9.moto');
    await expect(b.getByTestId('char-9')).toHaveAttribute('data-taken', 'true');
    await b.getByTestId('char-9').hover();
    await expect(b.getByTestId('char-tip')).toHaveText('孫小美');
    await pickCharacter(b, 4);
    await pickCharacter(c, 0);
    await pickCharacter(d, 3);
    await expect(a.getByTestId('room-start')).toBeDisabled();
    for (const p of [b, c, d]) await setReady(p);
    await expect(b.getByTestId('room-ready-mark')).toBeVisible();

    await startGame(a, pages, { clearBoard: false });
    for (const p of pages) {
      await expect(p.getByTestId('screen-game')).toHaveAttribute('data-layout', 'classic');
      await expect(p.getByTestId('classic-loading')).toHaveCount(0, { timeout: 20_000 });
    }
    await expect(a.locator('html')).toHaveAttribute('lang', 'zh-TW');
    expectNoErrors(players);
  } finally {
    for (const p of players) await p.context.close();
  }
});

test('片头：首次进入播放、可跳过；看过不再自动播放；设置里可以重播', async ({ browser }) => {
  test.setTimeout(120_000);
  const lp = 'video/start.mp4';
  const sha = createHash('sha256').update('rich4-e2e-intro').digest('hex');
  const real = hashedPath(lp, sha);
  const { packId: _omit, ...rest } = manifest;
  const withVideo = withPackId({
    ...rest,
    features: { ...rest.features, video: true },
    files: { ...rest.files, [lp]: { path: real, bytes: 1024, sha256: sha, kind: 'video', contentType: 'video/mp4' } },
    groups: {
      ...rest.groups,
      video: { category: 'video', provenance: rest.groups.title!.provenance, files: [lp], bytes: 1024 },
    },
    entries: {
      ...rest.entries,
      'video.start': {
        type: 'video',
        group: 'video',
        confidence: 'exe',
        src: ['synthetic'],
        files: { mp4: lp },
        w: 640,
        h: 480,
        durationMs: 33867,
      },
    },
  } as Omit<PackManifestV1, 'packId'>);
  const p = await classicPlayer(
    browser,
    '片头',
    { width: 1280, height: 800 },
    {
      query: Q_ANIM,
      body: () => withVideo,
      hang: new Set([real]),
    },
  );
  try {
    const page = p.page;
    const intro = page.getByTestId('intro');
    await expect(intro).toBeVisible();
    await expect(intro.getByTestId('intro-video')).toHaveAttribute('src', `/pack/${real}`);
    await intro.getByTestId('intro-skip').click();
    await expect(intro).toHaveCount(0);
    await expectTitle(page);
    expect(await page.evaluate(() => localStorage.getItem('rich4.introSeen'))).toBe('1');

    // 看过：刷新后直接是标题画面；设置 → 重播片头，Esc 跳过
    await page.reload();
    await expectTitle(page);
    await expect(intro).toHaveCount(0);
    await page.getByTestId('title-option').click();
    await page.getByTestId('intro-replay').click();
    await expect(intro).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(intro).toHaveCount(0);
    await expect(page.getByTestId('home-create')).toBeVisible();
    expect(p.errors.filter((e) => !e.includes('favicon'))).toEqual([]);
  } finally {
    await p.context.close();
  }
});

test('手机横屏 844×390：标题、开局设置、选人大厅与对局工具列的触控热区 ≥44px', async ({ browser }) => {
  test.setTimeout(180_000);
  const p = await classicPlayer(browser, '手机', { width: 844, height: 390 });
  try {
    const page = p.page;
    await expectTitle(page);
    await expect(page.getByTestId('classic-stage')).toHaveAttribute('data-hit', 'wide');
    await expectHit(page, ['home-create', 'home-load-open', 'title-option', 'home-join-open', 'home-solo']);
    await expectHit(page, ['title-public-open', 'home-nickname']);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(844);

    // 开局设置：全部设置排进两列 56 高的行；竖栏白框只显示数值；OK / EXIT ≥44
    await page.getByTestId('home-create').click();
    await expect(page.getByTestId('screen-setup')).toBeVisible();
    await expect(page.getByTestId('set-map').locator('xpath=ancestor::fieldset')).toHaveAttribute('data-wide', 'true');
    await expectHit(page, [
      'create-submit',
      'create-cancel',
      'create-quick',
      'set-map',
      'set-fund',
      'set-ai-count',
      'set-spectators',
    ]);
    await page.getByTestId('create-cancel').click();
    await expectTitle(page);

    await createRoom(page, { map: 'test', timer: 'off', aiCount: 1 });
    await expect(page.getByTestId('screen-room')).toHaveAttribute('data-screen', 'select');
    await expectHit(page, ['char-0', 'char-11', 'char-prev', 'char-next', 'char-select', 'room-start', 'room-leave']);
    // 左抽屉：座位与房间设置（抽屉里的控件同样 ≥44）
    await page.getByTestId('classic-drawer-left-btn').click();
    const left = page.getByTestId('classic-rail-left');
    await expect(left.getByTestId('seat-grid')).toBeVisible();
    for (const id of ['seat-2-add-ai', 'set-timer', 'room-dissolve']) {
      const bb = (await left.getByTestId(id).boundingBox())!;
      expect(bb.height, id).toBeGreaterThanOrEqual(44);
    }
    // 「允许观战」勾选框（透明 input 铺满整个框）：实际命中 ≥44（抽屉内容较长，先滚到它）
    await left.getByTestId('set-spectators').scrollIntoViewIfNeeded();
    await expectHit(page, ['set-spectators']);
    await page.getByTestId('classic-drawer-left-close').click();
    // 右抽屉：聊天
    await page.getByTestId('classic-drawer-right-btn').click();
    const right = page.getByTestId('classic-rail-right');
    await right.getByTestId('chat-input').fill('選人畫面你好');
    await right.getByTestId('chat-send').click();
    await expect(right.getByTestId('chat-list')).toContainText('選人畫面你好');
    for (const id of ['chat-input', 'chat-send']) {
      const bb = (await right.getByTestId(id).boundingBox())!;
      expect(bb.height, id).toBeGreaterThanOrEqual(44);
    }
    await page.getByTestId('classic-drawer-right-close').click();
    await pickCharacter(page, 9);
    await startGame(page, [page]);

    // 对局页：工具列收成 7 钮 + 更多，每个 ≥44×44；更多菜单的 4 项 ≥44×44，点「系统设定」打开系统菜单
    const bar = page.getByTestId('classic-toolbar');
    await expect(bar).toHaveAttribute('data-compact', 'true');
    await expect(bar.getByRole('button')).toHaveCount(8);
    await expectHit(page, [
      'tool-help',
      'action-autopilot',
      'tool-bigmap',
      'action-info',
      'action-items',
      'action-cards',
      'action-stock',
      'tool-more',
    ]);
    await page.getByTestId('tool-more').click();
    await expect(page.getByTestId('tool-more-menu')).toBeVisible();
    await expectHit(page, ['top-menu', 'tool-load', 'tool-save', 'action-board']);
    // 存读档窗（原版风格 Data#479）：触屏上唯一的关闭控件是右上角的关闭钮，补到 ≥44（从场景顶边往下补）
    await page.getByTestId('tool-save').click();
    await expect(page.getByTestId('classic-saves')).toHaveAttribute('data-hit', 'wide');
    await expectHit(page, ['classic-saves-close']);
    await page.getByTestId('classic-saves-close').click();
    await expect(page.getByTestId('classic-saves')).toHaveCount(0);
    await page.getByTestId('tool-more').click();
    await page.getByTestId('top-menu').click();
    await expect(page.getByTestId('system-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('system-menu')).toBeHidden();
    await expect(page.getByTestId('tool-more-menu')).toHaveCount(0);
    // 托管设置（原版托管对话框）：不改设置直接离开只能点关闭钮，≥44
    await page.getByTestId('action-autopilot').click({ button: 'right' });
    const trustee = page.getByTestId('trustee-dialog');
    await expect(trustee).toHaveAttribute('data-classic', 'true');
    await expectHit(page, ['trustee-dialog-close', 'trustee-save']);
    await page.getByTestId('trustee-dialog-close').click();
    await expect(trustee).toHaveCount(0);
    // 回合菜单（工具列「卡片」）：一排文字钮只往上补（正下方是卡片欄），实际命中 ≥44
    await waitMyTurn(page);
    await page.getByTestId('action-cards').click();
    const menu = page.locator('[data-testid="decision-TURN_MENU"][data-scene="classic"]');
    await expect(menu).toHaveAttribute('data-tab', 'cards');
    await expectHit(page, ['turn-cards', 'turn-items', 'turn-stock', 'turn-board', 'turn-close']);
    await page.getByTestId('turn-items').click();
    await expect(menu).toHaveAttribute('data-tab', 'items');
    await page.getByTestId('turn-close').click();
    await expect(page.locator('[data-testid="decision-TURN_MENU"][data-scene="classic"]')).toHaveCount(0);
    // 日历的太阳 / 月亮钮
    await page.getByTestId('classic-cal-moon').click();
    await expect(page.getByTestId('classic-calendar')).toHaveAttribute('data-mode', 'month');
    await expectHit(page, ['classic-cal-sun', 'classic-cal-moon']);
    await page.getByTestId('classic-cal-sun').click();
    await expect(page.getByTestId('classic-calendar')).not.toHaveAttribute('data-mode', 'month');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(844);
    expect(p.errors.filter((e) => !e.includes('WebGL') && !e.includes('favicon'))).toEqual([]);
  } finally {
    await p.context.close();
  }
});
