// 原版皮肤 A11：原版通用对话框与弹窗（original-skin.md §4.2 通用、§5 A11）。合成素材包（tools/extract 的 syntheticUi：
// 自绘图形，逻辑键、帧数、帧尺寸与锚点同原版包）经 page.route 提供，GET /api/access 模拟成「门禁开启且已通过」，
// 与 skin-classic-shell 同一种供包方式（默认配置与原版皮肤配置下都能跑）。两名真人 + 一名观战者（观战页不带
// anim=instant，走演出路径，看新闻、命运、轮盘、老虎机）：
// 1) 买地（BUY_LAND 原版 YES/NO + 讲话头像）→ 卡片欄用查税卡：原版目标面板（DOM 候选）选对手、棋盘视窗换成原版光标 →
//    升级（UPGRADE_LAND）→ 买设施地 → 兴建旅馆（设施类别选择 Data#476 图4）→ 对手住进旅馆：观战页弹出原版转盘
//    （旅馆盘，停在强制的 3 天）→ 新闻板（插图 + 所得税）→ 命运（继承遗产；命运插图未核实，整体回退程序化弹窗）→
//    资产表（工具列「查询」接管成原版资产表：
//    三页、数值与 HUD 一致）→ 托管设置（原版托管对话框）；每一步断言场景是原版（data-scene="classic"）、intent 被服务器接受；
// 2) 老虎机：保留开局摆在路上的神明，走到小财神上（强制老虎机 1 2 3），观战页的原版老虎机滚动后定格在 123。
// 3) 回合菜单（房主页带界面动画）：Esc 收起后在退场动画期间立即点工具列的股市 / SALE，原版股市 / 公佈欄照常打开
//    （回归：退场中的旧层取走了子页请求，新展开的菜单只剩卡片欄）；
// 4) 工具列 SAVE / LOAD：原版风格的存读档窗（Data#479）接真服务器存档，LOAD 窗列出刚存的档；
// 5) 15 日乐透开奖、1 日月结颁奖：观战页的原版开奖场景与颁奖画面。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';
import type { PackManifestV1 } from '../../packages/shared/src/assets/pack';
import {
  acted,
  createRoom,
  debugAct,
  expect,
  expectNoErrors,
  hudSnapshot,
  joinRoom,
  newPlayer,
  type Player,
  pickCharacter,
  playTurn,
  Q,
  Q_ANIM,
  serverSnapshot,
  setReady,
  startGame,
  syncPages,
  test,
  waitDecision,
  waitIdle,
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
  test.setTimeout(180_000);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['run', '--silent', 'extract', '--', 'assets', 'synth', '--out', '.cache/synthetic-pack'], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
  manifest = JSON.parse(readFileSync(join(PACK_DIR, 'manifest.json'), 'utf8')) as PackManifestV1;
  servable = new Map(Object.values(manifest.files).map((f) => [f.path, f.contentType]));
});

/** 整图条目在素材包里的 URL（manifest 的带哈希文件名） */
function imageUrlOf(key: string): string {
  const e = manifest.entries[key];
  if (e?.type !== 'image') throw new Error(`${key} 不是整图条目`);
  return `/pack/${manifest.files[e.file]!.path}`;
}

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

async function classicPlayer(browser: Parameters<typeof newPlayer>[0], nick: string, query = Q): Promise<Player> {
  return newPlayer(browser, nick, query, {
    setup: async (pg) => {
      await pg.setViewportSize({ width: 1920, height: 1080 });
      await servePack(pg);
    },
  });
}

async function expectClassic(page: Page): Promise<void> {
  await expect(page.getByTestId('classic-stage')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('screen-game')).toHaveAttribute('data-layout', 'classic');
}

/** 两名真人 + 观战者（演出页）开局 */
async function openRoom(
  browser: Parameters<typeof newPlayer>[0],
  o: { clearBoard?: boolean; hostQuery?: string } = {},
): Promise<{ a: Player; b: Player; w: Player }> {
  const a = await classicPlayer(browser, 'P1', o.hostQuery ?? Q);
  const b = await classicPlayer(browser, 'P2');
  const w = await classicPlayer(browser, 'W', Q_ANIM);
  const code = await createRoom(a.page, { map: 'test', timer: 'off' });
  await joinRoom(b.page, code);
  await w.page.goto(`/r/${code}?${Q_ANIM}&watch=1`);
  await pickCharacter(a.page, 9);
  await pickCharacter(b.page, 4);
  await setReady(b.page);
  await startGame(a.page, [a.page, b.page], o);
  for (const p of [a.page, b.page, w.page]) await expectClassic(p);
  return { a, b, w };
}

/** 本人回合：传送到 (node, prev)，强制掷出 1 点，按 GO 前进 */
async function stepOnto(page: Page, seat: number, node: number, prev: number): Promise<void> {
  await waitMyTurn(page);
  await acted(page, () => debugAct(page, { op: 'teleport', seat, node, prev }));
  await acted(page, () => debugAct(page, { op: 'forceNext', purpose: 'dice', values: [1] }));
  await waitMyTurn(page);
  await acted(page, () => page.getByTestId('action-roll').click());
}

/**
 * 观战页（演出页）先把积压播完，再做它要看的那一步。两名真人页是 instant，几乎同时连发一串批次；演出页积压超过 5 批
 * （或落后 15 秒）会自动 skipAll 追帧（EventPlayer AUTO_SKIP_QUEUE / AUTO_SKIP_BACKLOG_MS），后面那一批的弹窗就被跳过。
 * 掷骰按原版时序演出（持骰动作 + 骰子 FLC 36 帧 + 停留，original 节奏每次约 2.3 s）之后，这里不同步就会积压到阈值
 */
async function watcherCaughtUp(page: Page): Promise<void> {
  await waitIdle(page);
}

/** 原版场景（决策 kind）出现在本页 */
function classicScene(page: Page, kind: string) {
  return page.locator(`[data-testid="decision-${kind}"][data-scene="classic"]`);
}

async function lotOf(page: Page, id: string): Promise<{ owner: number | null; level: number; type: string | null }> {
  return page.evaluate((lot) => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const v = (window as any).__rich4.store.game.getState().view;
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const l = [...v.lands, ...v.facilities].find((x: any) => x.id === lot);
    return { owner: l.owner, level: l.level, type: l.type ?? null };
  }, id);
}

test('原版对话框与弹窗：买地、升级、设施、轮盘、新闻板（命运回退程序化）、用卡选目标、资产表、托管', async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const { a, b, w } = await openRoom(browser);
  const [A, B, W] = [a.page, b.page, w.page];
  try {
    // ── 买地：原版 YES/NO + 讲话头像 ──
    await stepOnto(A, 0, 4, 3);
    await waitDecision(A, ['BUY_LAND']);
    const buy = classicScene(A, 'BUY_LAND');
    await expect(buy).toBeVisible();
    await expect(buy.getByTestId('classic-buy-speaker')).toBeAttached();
    await acted(A, () => buy.getByTestId('buy-confirm').click());
    await waitIdle(A);
    expect((await lotOf(A, 'L1')).owner).toBe(0);
    await playTurn(B, 1, { node: 12, prev: 11 });

    // ── 用卡选目标：卡片欄 → 查税卡 → 原版目标面板选对手 → 使用 ──
    await waitMyTurn(A);
    await acted(A, () => debugAct(A, { op: 'give', seat: 0, cards: [26], items: [] }));
    await waitMyTurn(A);
    const slot = await A.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      const d = (window as any).__rich4.store.game.getState().decision;
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      return d.options.cards.find((r: any) => r.card === 26).slot as number;
    });
    const cashB = Number((await hudSnapshot(A)).players['1']!.cash);
    await A.getByTestId('action-cards').click();
    const menu = classicScene(A, 'TURN_MENU');
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute('data-tab', 'cards');
    // 回合菜单不挡棋盘：卡片欄上方的棋盘视窗空白处点得到棋盘（场景根与背板不接收指针）
    const passThrough = await A.evaluate(() => {
      const stage = document.querySelector('[data-testid="classic-stage"]')!;
      const [sx, sy] = (stage.getAttribute('data-stage') ?? '0,0').split(',').map(Number);
      const k = Number(stage.getAttribute('data-scale'));
      const r = stage.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + sx! + 60 * k, r.top + sy! + 120 * k);
      return { inScene: !!el?.closest('[data-scene]'), inBoard: !!el?.closest('[data-testid="classic-board-slot"]') };
    });
    expect(passThrough).toEqual({ inScene: false, inBoard: true });
    await watcherCaughtUp(W);
    const cell = menu.getByTestId(`inv-card-${slot}`);
    await expect(cell).toBeEnabled();
    await cell.click();
    const picker = menu.getByTestId('target-picker');
    await expect(picker).toBeVisible();
    await expect(picker).toHaveAttribute('data-target-kind', 'seat');
    // 目标选择期间棋盘视窗的鼠标光标换成原版手形
    await expect(A.getByTestId('classic-board-slot')).toHaveAttribute('data-classic-cursor', 'hand');
    await picker.getByTestId('target-seat-1').click();
    await acted(A, () => A.getByTestId('target-confirm').click());
    // 出卡演出（观战页走演出路径）：原版卡片插画 + 消息框
    const cast = W.locator('[data-scene="classic"] [data-testid="card-cast-popup"]');
    await expect(cast).toBeVisible({ timeout: 30_000 });
    await expect(cast).toHaveAttribute('data-card', '26');
    // 插画是素材包里 card.26 那一张（卡号 k → card.<k> → Data#529+k；合成包按键画的假图）
    const castArt = cast.getByTestId('card-cast-art');
    await expect(castArt).toHaveAttribute('data-asset-key', 'card.26');
    await expect(castArt).toHaveAttribute('data-src', imageUrlOf('card.26'));
    await waitIdle(A);
    await syncPages([A, B]);
    expect(Number((await hudSnapshot(A)).players['1']!.cash)).toBeLessThan(cashB);
    await expect(A.getByTestId('classic-board-slot')).not.toHaveAttribute('data-classic-cursor', 'hand');

    // ── 升级：再停 L1 ──
    await stepOnto(A, 0, 4, 3);
    await waitDecision(A, ['UPGRADE_LAND']);
    const up = classicScene(A, 'UPGRADE_LAND');
    await expect(up).toBeVisible();
    const to = Number(await up.getByTestId('upgrade-levels').getAttribute('data-to'));
    await acted(A, () => up.getByTestId('upgrade-confirm').click());
    await waitIdle(A);
    expect((await lotOf(A, 'L1')).level).toBe(to);
    await playTurn(B, 1, { node: 12, prev: 11 });

    // ── 买设施地 → 兴建旅馆（设施类别选择） ──
    await stepOnto(A, 0, 16, 15);
    await waitDecision(A, ['BUY_FACILITY']);
    await acted(A, () => classicScene(A, 'BUY_FACILITY').getByTestId('buy-confirm').click());
    await waitIdle(A);
    await playTurn(B, 1, { node: 12, prev: 11 });
    await stepOnto(A, 0, 16, 15);
    await waitDecision(A, ['BUILD_FACILITY']);
    const build = classicScene(A, 'BUILD_FACILITY');
    await expect(build.getByTestId('facility-confirm')).toBeDisabled();
    await build.getByTestId('facility-type-hotel').click();
    await expect(build).toHaveAttribute('data-pick', 'hotel');
    await acted(A, () => build.getByTestId('facility-confirm').click());
    await waitIdle(A);
    expect(await lotOf(A, 'F1')).toMatchObject({ owner: 0, level: 1, type: 'hotel' });

    // ── 轮盘：对手住进旅馆（转盘强制停在 3 天），观战页弹出原版旅馆转盘 ──
    await waitMyTurn(B);
    await watcherCaughtUp(W);
    await acted(B, () => debugAct(B, { op: 'forceNext', purpose: 'wheel', values: [7] }));
    await stepOnto(B, 1, 16, 15);
    const wheel = W.locator('[data-scene="classic"] [data-testid="roulette-popup"]');
    await expect(wheel).toBeVisible({ timeout: 30_000 });
    await expect(wheel).toHaveAttribute('data-wheel', 'hotel');
    await expect(wheel).toHaveAttribute('data-value', '3');
    await expect(wheel).toHaveAttribute('data-done', 'true', { timeout: 5000 });
    await waitIdle(B);

    // ── 新闻板：所得税（观战页：原版新闻板 + 插图） ──
    await waitMyTurn(A);
    await watcherCaughtUp(W);
    await acted(A, () => debugAct(A, { op: 'stackDeck', deck: 'news', ids: [11] }));
    await stepOnto(A, 0, 1, 18);
    const news = W.locator('[data-scene="classic"] [data-testid="news-popup"]');
    await expect(news).toBeVisible({ timeout: 30_000 });
    await expect(news).toHaveAttribute('data-news', '11');
    await expect(news.getByTestId('news-art')).toBeVisible();
    await waitIdle(A);

    // ── 命运：继承遗产（命运插图未核实，guess 整体回退 → 程序化命运弹窗，不在原版紫板上拼） ──
    await waitMyTurn(A);
    await watcherCaughtUp(W);
    await acted(A, () => debugAct(A, { op: 'stackDeck', deck: 'fate', ids: [25] }));
    await stepOnto(A, 0, 2, 1);
    const fate = W.getByTestId('fate-popup');
    await expect(fate).toBeVisible({ timeout: 30_000 });
    await expect(fate).toHaveAttribute('data-fate', '25');
    await expect(fate.getByTestId('fate-amount')).toBeVisible();
    await expect(W.locator('[data-scene="classic"] [data-testid="fate-popup"]')).toHaveCount(0);
    await waitIdle(A);

    // ── 资产表：工具列「查询」接管成原版资产表 ──
    await A.getByTestId('action-info').click();
    const sheet = A.getByTestId('classic-assets');
    await expect(sheet).toBeVisible();
    await expect(A.getByTestId('panel-info')).toHaveCount(0);
    const hud = await hudSnapshot(A);
    const seat = await sheet.getAttribute('data-seat');
    await expect(sheet.getByTestId('assets-cash')).toHaveAttribute('data-value', hud.players[seat ?? '0']?.cash ?? '');
    await sheet.getByTestId('assets-page-1').click();
    await expect(sheet).toHaveAttribute('data-page', '1');
    await expect(sheet.getByTestId('assets-estate-L1')).toBeAttached();
    await expect(sheet.getByTestId('assets-estate-F1')).toBeAttached();
    await sheet.getByTestId('assets-page-2').click();
    await expect(sheet.getByTestId('assets-stock-head')).toBeAttached();
    await sheet.getByTestId('assets-exit').click();
    await expect(sheet).toHaveCount(0);

    // ── 托管设置：原版托管对话框（只看不改） ──
    await A.getByTestId('action-autopilot').click({ button: 'right' });
    const trustee = A.getByTestId('trustee-dialog');
    await expect(trustee).toHaveAttribute('data-classic', 'true');
    await expect(trustee.getByTestId('trustee-status')).toBeVisible();
    await A.keyboard.press('Escape');
    await expect(trustee).toHaveCount(0);

    // 4 个页面（含服务器）一致
    await syncPages([A, B, W]);
    const server = await serverSnapshot(A);
    for (const p of [A, B, W]) expect(await hudSnapshot(p)).toEqual(server);
    expectNoErrors([a, b, w]);
  } finally {
    for (const p of [a, b, w]) await p.context.close();
  }
});

test('原版老虎机：走到小财神上，观战页的老虎机滚动后定格在强制的 123', async ({ browser }) => {
  test.setTimeout(240_000);
  const { a, b, w } = await openRoom(browser, { clearBoard: false });
  const [A, W] = [a.page, w.page];
  try {
    await waitMyTurn(A);
    // 小财神所在格与它的一个非岔路邻格（从那里前进 1 步正好停到神明上）
    const route = await A.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      const h = (window as any).__rich4;
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      const god = h.store.game.getState().view.gods.find((g: any) => g.kind === 1 && g.where.t === 'road');
      if (!god) return null;
      const n = god.where.node as number;
      const tiles = h.client.currentMap.def.tiles as { id: number; links: { to: number; blocked: boolean }[] }[];
      const nb = (id: number): number[] =>
        (tiles.find((t) => t.id === id)?.links ?? []).filter((l) => !l.blocked).map((l) => l.to);
      const p = nb(n).find((x) => nb(x).length === 2);
      if (p === undefined) return null;
      return { node: p, prev: nb(p).find((x) => x !== n)!, god: n };
    });
    expect(route, '小财神不在路上或没有合适的邻格').not.toBeNull();
    await acted(A, () => debugAct(A, { op: 'forceNext', purpose: 'slot', values: [1, 2, 3] }));
    await stepOnto(A, 0, route!.node, route!.prev);
    const slot = W.locator('[data-scene="classic"] [data-testid="god-slot"]');
    await expect(slot).toBeVisible({ timeout: 30_000 });
    await expect(slot).toHaveAttribute('data-value', '123');
    await expect(slot).toHaveAttribute('data-digits', '3');
    await expect(slot).toHaveAttribute('data-rolling', 'false', { timeout: 5000 });
    expectNoErrors([a, b, w]);
  } finally {
    for (const p of [a, b, w]) await p.context.close();
  }
});

test('回合菜单 Esc 收起后（退场动画中）立即从工具列打开股市、公佈欄：原版子页照常打开', async ({ browser }) => {
  test.setTimeout(180_000);
  // 房主页播放演出与界面动画（不带 anim=instant），才会出现「退场动画中又展开」的时机
  const { a, b, w } = await openRoom(browser, { hostQuery: Q_ANIM });
  const A = a.page;
  try {
    await waitMyTurn(A);
    // 星期一：股市开市
    await acted(A, () => debugAct(A, { op: 'setDate', date: 20100104 }));
    await waitMyTurn(A);
    await A.getByTestId('action-cards').click();
    await expect(classicScene(A, 'TURN_MENU')).toHaveAttribute('data-tab', 'cards');
    await A.keyboard.press('Escape');
    await A.getByTestId('action-stock').click();
    // 原版股市场景（回退到程序化子页时 testid 相同，必须看 data-scene）
    await expect(A.getByTestId('turn-stock-sheet')).toHaveAttribute('data-scene', 'classic');
    await A.getByTestId('stock-exit').click();
    await expect(A.getByTestId('turn-stock-sheet')).toHaveCount(0);
    await A.getByTestId('action-items').click();
    await expect(classicScene(A, 'TURN_MENU')).toHaveAttribute('data-tab', 'items');
    await A.keyboard.press('Escape');
    await A.getByTestId('action-board').click();
    await expect(A.locator('[data-testid="decision-TURN_MENU"][data-venue="bulletin"]')).toBeVisible();
    expectNoErrors([a, b, w]);
  } finally {
    for (const p of [a, b, w]) await p.context.close();
  }
});

test('工具列 SAVE / LOAD：原版风格的存读档窗真的存档（服务器存档列表），LOAD 窗列出这个存档', async ({ browser }) => {
  test.setTimeout(180_000);
  const p = await classicPlayer(browser, '房主');
  const name = `經典存檔-${Date.now()}`;
  try {
    const page = p.page;
    await createRoom(page, { map: 'test', timer: 'off', aiCount: 1 });
    await startGame(page, [page]);
    await expectClassic(page);
    await waitMyTurn(page);
    // SAVE：原版 SAVE 窗（经典外壳自己的程序化存读档窗不出现），存档后列表里有它
    await page.getByTestId('tool-save').click();
    const saves = page.getByTestId('classic-saves');
    await expect(saves).toHaveAttribute('data-scene', 'classic');
    await expect(saves).toHaveAttribute('data-mode', 'save');
    await saves.getByTestId('save-name').fill(name);
    await saves.getByTestId('save-submit').click();
    await expect(saves.locator(`[data-testid="save-list"] > li[data-name="${name}"]`)).toHaveCount(1);
    await saves.getByTestId('classic-saves-close').click();
    await expect(saves).toHaveCount(0);
    // LOAD：对局中只列出存档（不能读），刚存的档在列表里
    await page.getByTestId('tool-load').click();
    await expect(saves).toHaveAttribute('data-mode', 'load');
    await expect(saves.getByTestId('classic-load-note')).toBeVisible();
    await expect(saves.locator(`[data-testid="save-list"] > li[data-name="${name}"]`)).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(saves).toHaveCount(0);
    expectNoErrors([p]);
  } finally {
    await p.context.close();
  }
});

test('15 日乐透开奖与 1 日月结颁奖：观战页弹出原版开奖（摇奖机）与原版颁奖画面', async ({ browser }) => {
  test.setTimeout(240_000);
  const { a, b, w } = await openRoom(browser);
  const [A, B, W] = [a.page, b.page, w.page];
  try {
    // 1 月 14 日：P1 停在乐透格买 5 号（无人购票不开奖），开奖强制开出 5 号；这一轮走完进入 15 日 → 分红、乐透开奖
    await waitMyTurn(A);
    await acted(A, () => debugAct(A, { op: 'setDate', date: 20100114 }));
    await stepOnto(A, 0, 7, 6);
    await waitDecision(A, ['LOTTERY']);
    const bet = classicScene(A, 'LOTTERY');
    await bet.getByTestId('lottery-ball-5').click();
    await acted(A, () => bet.getByTestId('lottery-buy').click());
    await waitIdle(A);
    await acted(A, () => debugAct(A, { op: 'forceNext', purpose: 'lottery', values: [4] }));
    await playTurn(B, 1, { node: 12, prev: 11 });
    const draw = W.getByTestId('lottery-draw-scene');
    await expect(draw).toBeVisible({ timeout: 30_000 });
    await expect(draw).toHaveAttribute('data-scene', 'classic');
    await expect(draw).toHaveAttribute('data-number', '5');
    // 1 月 31 日：这一轮走完进入 2 月 1 日 → 月结颁奖
    await waitMyTurn(A);
    await acted(A, () => debugAct(A, { op: 'setDate', date: 20100131 }));
    await playTurn(A, 0, { node: 12, prev: 11 });
    await playTurn(B, 1, { node: 12, prev: 11 });
    const monthly = W.locator('[data-scene="classic"] [data-testid="monthly-popup"]');
    await expect(monthly).toBeVisible({ timeout: 30_000 });
    await expect(monthly.getByTestId('monthly-rank-1')).toBeAttached();
    expectNoErrors([a, b, w]);
  } finally {
    for (const p of [a, b, w]) await p.context.close();
  }
});
