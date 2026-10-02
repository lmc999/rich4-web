// 原版皮肤 A10：路线 A 外壳（original-skin.md §4.1、§5 A10）。合成素材包 + fixture 地图（与 skin-pack-load 同一种供包方式：
// page.route 按 manifest 白名单提供 /pack/*，GET /api/access 模拟成「门禁开启且已通过」）。合成包带经典外壳的 UI 条目
// （tools/extract 的 syntheticUi：自绘图形，帧数、帧尺寸、锚点与 GO 掩膜区号语义同原版包），经典画面走原版精灵路径：
// 断言 data-art、关键 data-sprite 帧号与 GO 掩膜命中。原版美术本身只在本机用真实素材包目视（截图只放 .cache/）。
// 1) 桌面 1920×1080、4 个真人：经典布局出现（舞台 2.25 倍、两侧整栏）；工具列、资料栏、日历、GO 钮画原版帧；工具列可用
//    （查询、说明、系统设定、托管、大地图）；点 GO 钮的透明四角不掷骰；用 GO 钮与空格键（先用鼠标点过工具钮）走完买地 /
//    过路费；4 个页面的座位数值、地块归属与服务器快照一致，资料栏 4 页数值在 4 个页面上一致；
// 2) 手机横屏 844×390：舞台 520×390、两侧收成抽屉按钮，抽屉可开关、可聊天；抽屉关着也能看到本人倒计时（叠在棋盘视窗）；
//    舞台钮与侧栏钮的实际命中尺寸（含透明热区）≥44px（工具列宽度受相邻钮所限）；GO 钮可掷骰，页面不横向滚动；
//    toast 排在左边距条（开左抽屉时换到右边距条），不碰舞台；视口变一次到 1920×1080 后棋盘画布与棋盘视窗等大，
//    toast 回到页面上部正中；
// 3) 观战者（经典布局）：没有掷骰 / 回合菜单 / 决策层 / 本人倒计时，托管、道具、卡片、股市、公佈欄、存读档钮禁用；
//    聊天双向可用，表情在座位条出现 DOM 气泡，托管标记同步。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';
import type { PackManifestV1 } from '../../packages/shared/src/assets/pack';
import {
  acted,
  answer,
  createRoom,
  currentSeq,
  debugAct,
  expect,
  expectNoErrors,
  hudSnapshot,
  joinRoom,
  newPlayer,
  type Player,
  pickCharacter,
  Q,
  sendChat,
  serverSnapshot,
  setReady,
  startGame,
  test,
  waitDecision,
  waitIdle,
  waitMyTurn,
  waitSeqAtLeast,
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

async function servePack(page: Page): Promise<void> {
  await page.route('**/pack/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/pack/manifest.json')
      return route.fulfill({ json: manifest, headers: { 'cache-control': 'no-cache' } });
    const rel = decodeURIComponent(path.slice('/pack/'.length));
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
): Promise<Player> {
  const p = await newPlayer(browser, nick, Q, {
    setup: async (pg) => {
      await pg.setViewportSize(viewport);
      await servePack(pg);
    },
  });
  return p;
}

/** 经典布局已就绪（原版皮肤 + 繁体） */
async function expectClassic(page: Page): Promise<void> {
  await expect(page.getByTestId('classic-stage')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('screen-game')).toHaveAttribute('data-layout', 'classic');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-TW');
  await expect(page.getByTestId('classic-board-slot').getByTestId('board-host')).toBeVisible();
}

/** 让 seat 从 (node, prev) 出发、强制掷出 1 点，按 GO（或空格键）前进 */
async function stepFrom(
  page: Page,
  seat: number,
  node: number,
  prev: number,
  via: 'go' | 'space' = 'go',
): Promise<void> {
  await waitMyTurn(page);
  await acted(page, () => debugAct(page, { op: 'teleport', seat, node, prev }));
  await acted(page, () => debugAct(page, { op: 'forceNext', purpose: 'dice', values: [1] }));
  await waitMyTurn(page);
  const go = page.getByTestId('action-roll');
  await expect(go).toHaveAttribute('data-state', 'normal');
  if (via === 'go') {
    await acted(page, () => go.click());
  } else {
    // 先用鼠标点过舞台上的工具钮（大地图开、关）：钮不留焦点，空格仍是「前进」
    const big = page.getByTestId('tool-bigmap');
    await big.click();
    await expect(big).toHaveAttribute('aria-pressed', 'true');
    await big.click();
    await expect(big).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null)).not.toBe(
      'tool-bigmap',
    );
    await acted(page, () => page.keyboard.press('Space'));
  }
}

/**
 * 骰子数竖槽第 i 个小骰子的帧（exe fcn.004169f6：图6–11 两两成对，第 i 个选中画亮图 2i+7、未选中或停留画灰图 2i+6）
 */
function diceIconFrame(i: number, on: boolean): number {
  return 2 * i + (on ? 7 : 6);
}

/** 棋盘视窗（classic-board-slot）与棋盘画布的 CSS 尺寸（取整） */
async function boardCanvasSize(page: Page): Promise<{ slot: number[]; canvas: number[] }> {
  return page.evaluate(() => {
    const wh = (e: Element | null): number[] => {
      const b = e?.getBoundingClientRect();
      return b ? [Math.round(b.width), Math.round(b.height)] : [];
    };
    const slot = document.querySelector('[data-testid="classic-board-slot"]');
    return { slot: wh(slot), canvas: wh(slot?.querySelector('[data-testid="board-host"] canvas') ?? null) };
  });
}

/** 注入几条 toast（ttl 足够长，量完自己关掉）；返回 id */
async function injectToasts(page: Page, texts: string[]): Promise<number[]> {
  return page.evaluate((list) => {
    type UiHook = { toast(text: string, kind: string, ttl: number): number };
    const ui = (window as unknown as { __rich4: { store: { ui: { getState(): UiHook } } } }).__rich4.store.ui;
    return list.map((x) => ui.getState().toast(x, 'info', 60_000));
  }, texts);
}

async function dismissToasts(page: Page, ids: number[]): Promise<void> {
  await page.evaluate((list) => {
    type UiHook = { dismissToast(id: number): void };
    const ui = (window as unknown as { __rich4: { store: { ui: { getState(): UiHook } } } }).__rich4.store.ui;
    for (const id of list) ui.getState().dismissToast(id);
  }, ids);
}

type Box = { x: number; y: number; width: number; height: number };
function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * 控件的实际命中尺寸（CSS 像素）：过控件中心的横线与竖线上逐像素 elementFromPoint，量出落在该控件（含透明热区）
 * 上的连续长度
 */
async function hitSize(page: Page, testId: string): Promise<{ w: number; h: number }> {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) throw new Error(`没有 ${id}`);
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const on = (x: number, y: number): boolean => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && (hit === el || el.contains(hit));
    };
    const span = (dx: number, dy: number): number => {
      let n = 0;
      for (let k = 1; k < 200; k++) {
        if (!on(cx + dx * k, cy + dy * k)) break;
        n++;
      }
      return n;
    };
    if (!on(cx, cy)) return { w: 0, h: 0 };
    return { w: span(-1, 0) + span(1, 0) + 1, h: span(0, -1) + span(0, 1) + 1 };
  }, testId);
}

async function finishTurn(page: Page, choice: 'confirm' | 'decline', expectKind?: string): Promise<void> {
  if (expectKind) {
    await waitDecision(page, [expectKind]);
    await acted(page, () => answer(page, choice));
  }
  await waitIdle(page);
}

/** 本页资料栏查看 seat 时 4 页的全部数值 */
async function profileValues(page: Page, seat: number): Promise<Record<string, string | null>> {
  const profile = page.getByTestId('classic-profile');
  if ((await profile.getAttribute('data-seat')) !== String(seat)) {
    await page.getByTestId(`chip-${seat}`).click();
    await expect(profile).toHaveAttribute('data-seat', String(seat));
  }
  const out: Record<string, string | null> = {};
  for (const tab of ['funds', 'estate', 'stocks', 'other']) {
    await page.getByTestId(`classic-tab-${tab}`).click();
    await expect(profile).toHaveAttribute('data-page', tab);
    for (const el of await page.locator(`[data-testid^="classic-val-${tab}-"]`).all()) {
      out[(await el.getAttribute('data-testid')) ?? '?'] = await el.getAttribute('data-value');
    }
  }
  return out;
}

test('桌面 1920×1080：经典布局、工具列可用、GO 钮与空格键走棋、4 个页面数值一致', async ({ browser }) => {
  test.setTimeout(240_000);
  const players: Player[] = [];
  try {
    for (const n of ['P1', 'P2', 'P3', 'P4'])
      players.push(await classicPlayer(browser, n, { width: 1920, height: 1080 }));
    const pages = players.map((p) => p.page);
    const [a, b, c, d] = pages as [Page, Page, Page, Page];
    const code = await createRoom(a, { map: 'test', timer: 'off' });
    for (const p of [b, c, d]) await joinRoom(p, code);
    await pickCharacter(a, 9);
    await pickCharacter(b, 4);
    await pickCharacter(c, 0);
    await pickCharacter(d, 3);
    for (const p of [b, c, d]) await setReady(p);
    await startGame(a, pages);
    for (const p of pages) await expectClassic(p);

    // 舞台：1080 高 → 2.25 倍、平滑；左右各 240 的整栏侧栏；棋盘视窗 990×990
    const stage = a.getByTestId('classic-stage');
    await expect(stage).toHaveAttribute('data-scale', '2.2500');
    await expect(stage).toHaveAttribute('data-rails', 'full');
    await expect(stage).toHaveAttribute('data-stage', '240,0,1440,1080');
    const slot = await a.getByTestId('classic-board-slot').boundingBox();
    expect(slot).toEqual({ x: 240, y: 90, width: 990, height: 990 });
    const tb = await a.getByTestId('classic-toolbar').boundingBox();
    expect(tb).toEqual({ x: 240, y: 0, width: 990, height: 90 });
    const prof = await a.getByTestId('classic-profile').boundingBox();
    expect(prof).toEqual({ x: 1230, y: 0, width: 450, height: 630 });
    const cal = await a.getByTestId('classic-calendar').boundingBox();
    expect(cal).toEqual({ x: 1230, y: 630, width: 450, height: 450 });
    await expect(a.getByTestId('classic-toolbar').getByRole('button')).toHaveCount(11);
    await expect(a.getByTestId('classic-rail-left')).toBeVisible();
    await expect(a.getByTestId('classic-rail-right').getByTestId('chat-panel')).toBeVisible();

    // 合成包的经典外壳 UI 条目：各区域画原版帧（不是 CSS 回退）
    await expect(a.getByTestId('classic-toolbar')).toHaveAttribute('data-art', 'true');
    await expect(a.getByTestId('tool-help').locator('[data-sprite="ui.toolbar/1"]')).toHaveCount(1);
    await expect(a.getByTestId('action-stock').locator('[data-sprite="ui.toolbar/11"]')).toHaveCount(1);
    await expect(a.getByTestId('classic-profile')).toHaveAttribute('data-art', 'true');
    await expect(a.getByTestId('classic-avatar').locator('[data-sprite="portrait.face72/9"]')).toHaveCount(1);
    // 开局是元旦（节日：日历页换成节日画面）；点月亮切回月历
    await a.getByTestId('classic-cal-moon').click();
    await expect(a.getByTestId('classic-calendar')).toHaveAttribute('data-mode', 'month');
    await expect(a.getByTestId('classic-cal-bg')).toHaveAttribute('data-bg', /^ui\.calendar\/[4-7]$/);
    // 月历模式：太阳 / 月亮钮的帧与页图烘焙的相同（未选中太阳图9、选中月亮图10），位置与烘焙图标重合
    await expect(a.getByTestId('classic-cal-sun').locator('[data-sprite]')).toHaveAttribute(
      'data-sprite',
      'ui.calendar/9',
    );
    await expect(a.getByTestId('classic-cal-moon').locator('[data-sprite]')).toHaveAttribute(
      'data-sprite',
      'ui.calendar/10',
    );
    const calBox = (await a.getByTestId('classic-calendar').boundingBox())!;
    const sunBox = (await a.getByTestId('classic-cal-sun').boundingBox())!;
    expect([sunBox.x - calBox.x, sunBox.y - calBox.y]).toEqual([10 * 2.25, 9 * 2.25]);
    await expect(a.getByTestId('action-roll').locator('[data-sprite]')).toHaveAttribute(
      'data-sprite',
      /^ui\.goButton\/[0-5]$/,
    );
    for (const p of pages) {
      // 小骰子个数 = 交通工具的上限（开局交通工具随机：步行 1、机车 2、汽车 3），前「骰子数」个亮
      const dc = p.getByTestId('action-dice-count');
      const n = Number(await dc.getAttribute('data-value'));
      const slots = Number(await dc.getAttribute('data-slots'));
      expect(slots).toBeGreaterThanOrEqual(1);
      expect(slots).toBeLessThanOrEqual(3);
      const dies = p.getByTestId('dice-count-die');
      await expect(dies).toHaveCount(slots);
      for (let i = 0; i < slots; i++) {
        const on = (await dies.nth(i).getAttribute('data-on')) === 'true';
        expect(on).toBe(i < n);
        await expect(dies.nth(i).locator('[data-sprite]')).toHaveAttribute(
          'data-sprite',
          `ui.goButton/${diceIconFrame(i, on)}`,
        );
      }
    }
    // 骰子数竖槽在 GO 钮里（掩膜区 1）：钮内 (7,9) 16×48
    const goBox = (await a.getByTestId('action-roll').boundingBox())!;
    const dcBox = (await a.getByTestId('action-dice-count').boundingBox())!;
    expect([dcBox.x - goBox.x, dcBox.y - goBox.y, dcBox.width, dcBox.height]).toEqual([
      7 * 2.25,
      9 * 2.25,
      16 * 2.25,
      48 * 2.25,
    ]);

    // 工具列：查询 → 原版资产表 classic-assets（开局后精灵可能还没预取完：先收起程序化面板、等精灵就绪再开，
    // 程序化面板 panel-info 不出现）；说明；系统设定 → 系统菜单
    await a.getByTestId('action-info').click();
    const assets = a.getByTestId('classic-assets');
    await expect(assets).toBeVisible();
    await expect(a.getByTestId('panel-info')).toHaveCount(0);
    await a.keyboard.press('Escape');
    await expect(assets).toBeHidden();
    await a.getByTestId('tool-help').click();
    await expect(a.getByTestId('classic-help')).toBeVisible();
    await a.keyboard.press('Escape');
    await a.getByTestId('top-menu').click();
    await expect(a.getByTestId('system-menu')).toBeVisible();
    await a.keyboard.press('Escape');
    await expect(a.getByTestId('system-menu')).toBeHidden();
    // 大地图：俯瞰全图（镜头缩小），再按一次回到原来的缩放
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const zoom = () => a.evaluate(() => (window as any).__rich4.renderer.camera.zoom as number);
    const z0 = await zoom();
    await a.getByTestId('tool-bigmap').click();
    await expect.poll(zoom).toBeLessThan(z0);
    await a.getByTestId('tool-bigmap').click();
    await expect.poll(zoom).toBeCloseTo(z0, 2);
    // 托管：P4 在别人回合打开再关掉，其他页面的座位条随之显示 / 收起托管标记
    await d.getByTestId('action-autopilot').click();
    await expect(a.getByTestId('chip-3-autopilot')).toBeVisible();
    await d.getByTestId('action-autopilot').click();
    await expect(a.getByTestId('chip-3-autopilot')).toBeHidden();

    // GO 钮命中掩膜：点透明四角（区 4）不掷骰
    await waitMyTurn(a);
    const seqBefore = await currentSeq(a);
    await a.getByTestId('action-roll').click({ position: { x: 1, y: 1 } });
    await a.waitForTimeout(300);
    expect(await currentSeq(a)).toBe(seqBefore);
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    expect(await a.evaluate(() => (window as any).__rich4.store.game.getState().submitting)).toBeNull();

    // 走棋：P1 按 GO 买 L1；P2 用空格键前进付过路费
    await stepFrom(a, 0, 4, 3, 'go');
    await finishTurn(a, 'confirm', 'BUY_LAND');
    await stepFrom(b, 1, 4, 3, 'space');
    await finishTurn(b, 'decline');

    // 4 个页面：座位数值、地块归属与服务器快照一致
    const seq = await currentSeq(a);
    for (const p of pages) await waitSeqAtLeast(p, seq);
    const snaps = await Promise.all(pages.map((p) => hudSnapshot(p)));
    const server = await serverSnapshot(a);
    expect(Object.keys(snaps[0]!.players)).toHaveLength(4);
    expect(snaps[0]!.lots.L1).toEqual({ owner: '0', level: '0' });
    for (const s of snaps) expect(s).toEqual(snaps[0]);
    expect(snaps[0]).toEqual(server);

    // 资料栏 4 页（查看 P1）：4 个页面数值一致，资金页现金 / 存款与服务器一致
    const profiles = [];
    for (const p of pages) profiles.push(await profileValues(p, 0));
    for (const v of profiles) expect(v).toEqual(profiles[0]);
    expect(profiles[0]!['classic-val-funds-cash']).toBe(server.players['0']!.cash);
    expect(profiles[0]!['classic-val-funds-deposit']).toBe(server.players['0']!.deposit);
    expect(profiles[0]!['classic-val-other-points']).toBe(server.players['0']!.points);
    expect(Number(profiles[0]!['classic-val-estate-lots'])).toBe(1);

    // 两种布局共用系统菜单：设置页里改皮肤时布局即时切换，设置页保持打开
    await a.getByTestId('top-menu').click();
    await a.getByTestId('menu-settings').click();
    await expect(a.getByTestId('settings-dialog')).toBeVisible();
    await a.getByTestId('settings-skin-procedural').check();
    await expect(a.getByTestId('top-bar')).toBeAttached();
    await expect(a.getByTestId('screen-game')).not.toHaveAttribute('data-layout', 'classic');
    await expect(a.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(a.getByTestId('settings-dialog')).toBeVisible();
    await a.getByTestId('settings-skin-auto').check();
    await expect(a.getByTestId('screen-game')).toHaveAttribute('data-layout', 'classic');
    await expect(a.getByTestId('settings-dialog')).toBeVisible();
    await a.keyboard.press('Escape');
    await expect(a.getByTestId('settings-dialog')).toBeHidden();
    expect(await hudSnapshot(a)).toEqual(server);

    expectNoErrors(players);
  } finally {
    for (const p of players) await p.context.close();
  }
});

test('手机横屏 844×390：舞台 520×390，两侧收成抽屉；抽屉可开关与聊天；GO 钮可掷骰', async ({ browser }) => {
  test.setTimeout(180_000);
  const p = await classicPlayer(browser, '手机', { width: 844, height: 390 });
  try {
    const page = p.page;
    await createRoom(page, { map: 'test', timer: 'off', aiCount: 1 });
    await startGame(page, [page]);
    await expectClassic(page);
    const stage = page.getByTestId('classic-stage');
    await expect(stage).toHaveAttribute('data-rails', 'drawer');
    await expect(stage).toHaveAttribute('data-stage', '162,0,520,390');
    await expect(stage).toHaveAttribute('data-scale', '0.8125');
    // 不横向滚动
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(844);

    // 左抽屉：座位（隐藏时数值也在 DOM 里）
    const left = page.getByTestId('classic-rail-left');
    await expect(left).toBeHidden();
    const leftBtn = page.getByTestId('classic-drawer-left-btn');
    await expect(leftBtn).toBeVisible();
    const lb = await leftBtn.boundingBox();
    expect(lb!.width).toBeGreaterThanOrEqual(44);
    expect(lb!.height).toBeGreaterThanOrEqual(44);
    await leftBtn.click();
    await expect(left).toBeVisible();
    await expect(left.getByTestId('chip-0')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(left).toBeHidden();

    // 右抽屉：聊天
    await page.getByTestId('classic-drawer-right-btn').click();
    const right = page.getByTestId('classic-rail-right');
    await expect(right).toBeVisible();
    await expect(right.getByTestId('chat-panel')).toBeVisible();
    await right.getByTestId('chat-input').fill('經典畫面你好');
    await right.getByTestId('chat-send').click();
    await expect(right.getByTestId('chat-list')).toContainText('經典畫面你好');
    await page.getByTestId('classic-drawer-right-close').click();
    await expect(right).toBeHidden();

    // toast：缺省的页面上部正中在这个尺寸下正好叠在棋盘视窗上部（原版亮卡、神明弹窗的消息框），改排在左边距条
    // （抽屉按钮以下），整列不碰舞台；开左抽屉时换到右边距条
    const ids = await injectToasts(page, [
      '忍太郎 付給 糖糖 過路費 800 元',
      '忍太郎 與 孫小美 的同盟破裂',
      '忍太郎：夢遊 5 回合',
    ]);
    const toasts = page.getByTestId('toasts');
    await expect(toasts).toHaveAttribute('data-place', 'gutter-left');
    const stageBox = (await page.getByTestId('classic-stage-inner').boundingBox())!;
    const leftBtnBox = (await leftBtn.boundingBox())!;
    const tl = (await toasts.boundingBox())!;
    expect(tl.x).toBeGreaterThanOrEqual(0);
    expect(tl.x + tl.width).toBeLessThanOrEqual(stageBox.x);
    expect(tl.y).toBeGreaterThanOrEqual(leftBtnBox.y + leftBtnBox.height);
    expect(tl.y + tl.height).toBeLessThanOrEqual(390);
    await expect(toasts.getByTestId('toast')).toHaveCount(3);
    for (const el of await toasts.getByTestId('toast').all()) {
      const b = (await el.boundingBox())!;
      expect(intersects(b, stageBox)).toBe(false);
    }
    await leftBtn.click();
    await expect(toasts).toHaveAttribute('data-place', 'gutter-right');
    const tr = (await toasts.boundingBox())!;
    expect(tr.x).toBeGreaterThanOrEqual(stageBox.x + stageBox.width);
    expect(tr.x + tr.width).toBeLessThanOrEqual(844);
    await page.getByTestId('classic-drawer-left-close').click();
    await expect(toasts).toHaveAttribute('data-place', 'gutter-left');
    await dismissToasts(page, ids);

    // 抽屉关着：本人倒计时叠在棋盘视窗左上角（不在隐藏的抽屉里）
    await waitMyTurn(page);
    const status = page.getByTestId('classic-stage-status');
    await expect(status.getByTestId('classic-my-countdown')).toBeVisible();
    await expect(page.getByTestId('classic-my-countdown')).toHaveCount(1);

    // 触控目标：舞台钮按 44px 补透明热区（工具列 40 宽的钮左右相接，宽度只有 32.5）
    await expect(stage).toHaveAttribute('data-hit', 'wide');
    for (const id of ['tool-help', 'action-autopilot', 'tool-bigmap', 'action-info', 'action-stock']) {
      const hs = await hitSize(page, id);
      expect(hs.h, id).toBeGreaterThanOrEqual(44);
      expect(hs.w, id).toBeGreaterThanOrEqual(32);
    }
    for (const id of [
      'action-dice-count',
      'classic-cal-moon',
      'classic-cal-toggle',
      'classic-tab-funds',
      'classic-tab-estate',
      'classic-tab-stocks',
      'classic-tab-other',
    ]) {
      const hs = await hitSize(page, id);
      expect(hs.w, id).toBeGreaterThanOrEqual(44);
      expect(hs.h, id).toBeGreaterThanOrEqual(44);
    }
    // 太阳钮左边是日历左缘、右边紧挨月亮：宽只有 42 逻辑像素（约 34px），高补到 44
    const sun = await hitSize(page, 'classic-cal-sun');
    expect(sun.h).toBeGreaterThanOrEqual(44);
    expect(sun.w).toBeGreaterThanOrEqual(32);
    await page.getByTestId('classic-cal-toggle').click();
    await expect(page.getByTestId('classic-minimap')).toBeVisible();
    for (const id of ['rotate-left', 'rotate-right']) {
      const hs = await hitSize(page, id);
      expect(hs.w, id).toBeGreaterThanOrEqual(44);
      expect(hs.h, id).toBeGreaterThanOrEqual(44);
    }
    await page.getByTestId('classic-cal-toggle').click();
    await expect(page.getByTestId('classic-calendar')).toHaveAttribute('data-mode', 'month');
    // 侧栏（不随舞台缩放）的按钮
    await page.getByTestId('classic-drawer-left-btn').click();
    for (const id of ['action-speed', 'action-focus', 'action-menu', 'classic-drawer-left-close']) {
      const bb = (await page.getByTestId(id).boundingBox())!;
      expect(bb.width, id).toBeGreaterThanOrEqual(44);
      expect(bb.height, id).toBeGreaterThanOrEqual(44);
    }
    await page.getByTestId('classic-drawer-left-close').click();
    await page.getByTestId('classic-drawer-right-btn').click();
    for (const id of ['top-chat', 'top-log']) {
      const bb = (await page.getByTestId(id).boundingBox())!;
      expect(bb.height, id).toBeGreaterThanOrEqual(44);
    }
    await page.getByTestId('classic-drawer-right-close').click();

    // GO 钮：棋盘视窗右下，可按
    const go = page.getByTestId('action-roll');
    const gb = await go.boundingBox();
    const slot = await page.getByTestId('classic-board-slot').boundingBox();
    expect(gb!.x + gb!.width).toBeLessThanOrEqual(slot!.x + slot!.width + 1);
    expect(gb!.y + gb!.height).toBeLessThanOrEqual(slot!.y + slot!.height + 1);
    await acted(page, () => go.click());
    await waitIdle(page);

    // 单次视口变大（转屏、窗口最大化）：棋盘画布跟着棋盘视窗变大（Pixi resizeTo 只跟 window resize，棋盘视窗的尺寸
    // 由经典舞台的 React 状态决定、提交晚于 Pixi 读尺寸那一帧，画布曾停在 844×390 时的 358×357）
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect(stage).toHaveAttribute('data-scale', '2.2500');
    await expect.poll(() => boardCanvasSize(page)).toEqual({ slot: [990, 990], canvas: [990, 990] });
    // 桌面：toast 照旧在页面上部正中（顶栏高缺省 50 + 16）
    const ids2 = await injectToasts(page, ['忍太郎：夢遊 5 回合']);
    await expect(page.getByTestId('toasts')).toHaveAttribute('data-place', 'page');
    const td = (await page.getByTestId('toasts').boundingBox())!;
    expect(Math.abs(td.x + td.width / 2 - 960)).toBeLessThanOrEqual(1);
    expect(Math.round(td.y)).toBe(66);
    await dismissToasts(page, ids2);
    expect(p.errors.filter((e) => !e.includes('WebGL') && !e.includes('favicon'))).toEqual([]);
  } finally {
    await p.context.close();
  }
});

test('观战者（经典布局）：没有操作，工具列相关钮禁用；聊天双向可用，表情气泡与托管标记同步', async ({ browser }) => {
  test.setTimeout(180_000);
  const players: Player[] = [];
  try {
    for (const n of ['P1', 'P2', '观众']) players.push(await classicPlayer(browser, n, { width: 1920, height: 1080 }));
    const [a, b, w] = players.map((p) => p.page) as [Page, Page, Page];
    const code = await createRoom(a, { map: 'test', timer: 'off' });
    await joinRoom(b, code);
    await joinRoom(w, code, true);
    await expect(a.getByTestId('spectator-count')).toHaveAttribute('data-value', '1');
    await pickCharacter(a, 9);
    await pickCharacter(b, 4);
    await setReady(b);
    await startGame(a, [a, b, w]);
    for (const p of [a, b, w]) await expectClassic(p);

    // 观战者：左栏标「觀戰中」；没有掷骰、回合菜单、决策层与本人倒计时
    await expect(w.getByTestId('classic-rail-left')).toContainText('觀戰中');
    for (const id of ['action-roll', 'action-dice-count', 'action-menu', 'decision-layer', 'classic-my-countdown']) {
      await expect(w.getByTestId(id), id).toHaveCount(0);
    }
    for (const id of [
      'action-autopilot',
      'action-items',
      'action-cards',
      'action-stock',
      'action-board',
      'tool-save',
      'tool-load',
    ]) {
      await expect(w.getByTestId(id), id).toBeDisabled();
    }
    for (const id of ['tool-help', 'top-menu', 'tool-bigmap', 'action-info'])
      await expect(w.getByTestId(id)).toBeEnabled();
    // 等别人决策：观战者看到等待条
    await expect(w.getByTestId('waiting-banner')).toBeVisible();
    await expect(a.getByTestId('action-roll')).toBeVisible();

    // 聊天双向
    await sendChat(w, '觀眾路過');
    for (const p of [a, b, w]) await expect(p.getByTestId('chat-msg').filter({ hasText: '觀眾路過' })).toBeVisible();
    await sendChat(a, '歡迎觀戰');
    await expect(w.getByTestId('chat-msg').filter({ hasText: '歡迎觀戰' })).toBeVisible();

    // 表情：观战者页面的 2P 座位条出现 DOM 气泡（2 秒）
    const bubble = w.getByTestId('bubble-1').waitFor({ state: 'visible', timeout: 20_000 });
    await b.getByTestId('emote-open').click();
    await b.getByTestId('emote-laugh').click();
    await bubble;

    // 托管标记同步到观战者页面
    await b.getByTestId('action-autopilot').click();
    await expect(w.getByTestId('chip-1-autopilot')).toBeVisible();
    await b.getByTestId('action-autopilot').click();
    await expect(w.getByTestId('chip-1-autopilot')).toBeHidden();
    expectNoErrors(players);
  } finally {
    for (const p of players) await p.context.close();
  }
});
