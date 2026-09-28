// 调试（M11 验证 8）：部署形态（Caddy + 口令门禁 + 真实素材包，缺省 https://localhost:8443）上的原版皮肤巡检，
// 真实浏览器从门禁页一路走到对局，截图目视（配置见 test/m11-playwright.config.ts）。两种视口各走一遍：
// - desk（1920×1080）：门禁页 → 片头（跳过）→ 标题 → 開始遊戲 → 開局設定（台灣、3 電腦、不限時）→ 選人 → 開局 → Loading → 对局；
// - mobile（手机横屏 844×390）：门禁页 → 片头（跳过）→ 标题 → 單機對戰（一键开局：私密、不限时、3 电脑）→ Loading → 对局。
// 对局里正常掷骰（实例不开测试模式，不用 debug:act），至少打满 4 个本人回合且至少买下一块地；遇到的其他决策按 defaultIntent 提交。
// 断言：控制台 0 错误（pageerror / console.error）、/pack 请求没有 4xx/5xx（且确有素材请求）、皮肤判定为原版
// （skin.applied=original、pack=ready、没有加载失败的组、原版棋盘）、遇到的决策全部是原版场景（data-scene=classic）。
// 截图与 summary-<视口>.json 写到 .cache/m11/tour/（含原版素材，不入库）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, '.cache', 'm11', 'tour');
const PASS = readFileSync(join(root, '.cache/m11/passcode.txt'), 'utf8').trim();
// 带声音、原版节奏；?test=1 只暴露测试钩子（window.__rich4）并开批尾对账
const Q = 'test=1';
const MIN_TURNS = 4;
const MAX_TURNS = 14;

// biome-ignore lint/suspicious/noExplicitAny: 测试钩子
type Any = any;

interface Rec {
  viewport: string;
  flow: string;
  shots: string[];
  consoleErrors: string[];
  packRequests: number;
  packStatus: Record<string, number>;
  packBad: string[];
  otherBad: string[];
  decisions: Record<string, string[]>;
  turns: number;
  bought: string[];
  skin: unknown;
}

function tracker(page: Page, rec: Rec): void {
  page.on('pageerror', (e) => rec.consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') rec.consoleErrors.push(`console.error: ${m.text().slice(0, 300)}`);
  });
  page.on('response', (r) => {
    const u = new URL(r.url());
    const st = r.status();
    if (u.pathname.startsWith('/pack/')) {
      rec.packRequests++;
      rec.packStatus[st] = (rec.packStatus[st] ?? 0) + 1;
      if (st >= 400) rec.packBad.push(`${st} ${u.pathname}`);
    } else if (st >= 400) rec.otherBad.push(`${st} ${u.pathname}`);
  });
  page.on('requestfailed', (r) => {
    const u = new URL(r.url());
    // 媒体元素换源、离开页面时浏览器会主动取消请求（net::ERR_ABORTED），不算失败
    const why = r.failure()?.errorText ?? '';
    if (!/ERR_ABORTED/.test(why)) (u.pathname.startsWith('/pack/') ? rec.packBad : rec.otherBad).push(`${why} ${u.pathname}`);
  });
}

async function shot(page: Page, rec: Rec, name: string): Promise<void> {
  const file = join(OUT, `${rec.viewport}-${String(rec.shots.length + 1).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  rec.shots.push(file.slice(root.length + 1));
}

interface St {
  idle: boolean;
  kind: string | null;
  id: string | null;
  sub: unknown;
  over: boolean;
}

async function st(page: Page): Promise<St | null> {
  return page
    .evaluate(() => {
      const h = (window as Any).__rich4;
      const g = h?.store?.game?.getState();
      if (!g) return null;
      return {
        idle: !!h.eventPlayer?.idle,
        kind: g.decision?.kind ?? null,
        id: g.decision?.decisionId ?? null,
        sub: g.submitting,
        over: g.over !== null,
      };
    })
    .catch(() => null);
}

async function sceneOf(page: Page, kind: string): Promise<string> {
  const el = page.locator(`[data-testid="decision-${kind}"]`).first();
  await el.waitFor({ state: 'attached', timeout: 15_000 }).catch(() => undefined);
  return (await el.getAttribute('data-scene').catch(() => null)) ?? 'none';
}

function note(rec: Rec, kind: string, scene: string): void {
  const arr = (rec.decisions[kind] ??= []);
  if (!arr.includes(scene)) arr.push(scene);
}

/** 门禁页 → 片头 → 标题 */
async function gateIntroTitle(page: Page, rec: Rec): Promise<void> {
  await page.goto(`/?${Q}`);
  await expect(page.getByTestId('access-gate')).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, rec, 'access-gate');
  await page.getByTestId('access-passcode').fill(PASS);
  await page.getByTestId('access-submit').click();
  await page.waitForLoadState('load');

  await expect(page.getByTestId('intro')).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(3000);
  await shot(page, rec, 'intro');
  await page.getByTestId('intro-skip').click();
  await expect(page.getByTestId('intro')).toHaveCount(0);

  const home = page.getByTestId('screen-home');
  await expect(home).toHaveAttribute('data-screen', 'title', { timeout: 30_000 });
  await page.waitForTimeout(1000);
  await shot(page, rec, 'title');
  await page.getByTestId('home-nickname').fill(`巡检-${rec.viewport}`);
  await page.getByTestId('home-nickname').blur();
}

/** 等进入对局且皮肤判定为原版 */
async function enterGame(page: Page, rec: Rec): Promise<void> {
  await expect(page.getByTestId('screen-game')).toHaveAttribute('data-layout', 'classic', { timeout: 90_000 });
  await page.waitForFunction(() => (window as Any).__rich4?.skin?.boardInUse === 'original', undefined, {
    timeout: 60_000,
  });
  rec.skin = await page.evaluate(() => {
    const s = (window as Any).__rich4.skin;
    return {
      applied: s.applied,
      pack: s.pack,
      packId: s.packId,
      resolution: s.resolution,
      failedGroups: s.failedGroups,
      boardInUse: s.boardInUse,
      lang: s.lang,
      renderer: (window as Any).__rich4.renderer?.kind ?? null,
    };
  });
}

/** 正常对局：本人回合掷骰；买地决策点原版场景的「是」；其余决策按默认处理 */
async function play(page: Page, rec: Rec): Promise<void> {
  let lastId: string | null = null;
  const t0 = Date.now();
  while (rec.turns < MAX_TURNS && Date.now() - t0 < 600_000) {
    if (rec.turns >= MIN_TURNS && rec.bought.length > 0) break;
    const s = await st(page);
    if (s?.over) break;
    if (!s || !s.idle || s.sub !== null || !s.kind || s.id === lastId) {
      await page.waitForTimeout(250);
      continue;
    }
    lastId = s.id;
    if (s.kind === 'TURN_MENU') {
      rec.turns++;
      if (rec.turns === 1 || rec.turns === 3) await shot(page, rec, `turn${rec.turns}-menu`);
      await page.getByTestId('action-roll').click();
      continue;
    }
    const scene = await sceneOf(page, s.kind);
    note(rec, s.kind, scene);
    if (s.kind === 'BUY_LAND' && rec.bought.length < 2) {
      await page.waitForTimeout(900);
      await shot(page, rec, `buy-land-${rec.bought.length + 1}`);
      const buy = page.getByTestId('buy-confirm');
      if (await buy.isEnabled().catch(() => false)) {
        await buy.click();
        rec.bought.push(`turn ${rec.turns}`);
        await page.waitForTimeout(1500);
        await shot(page, rec, `bought-${rec.bought.length}`);
        continue;
      }
    } else if (Object.keys(rec.decisions).length <= 6 && rec.decisions[s.kind]?.length === 1) {
      // 其他决策第一次出现时截一张
      await page.waitForTimeout(700);
      await shot(page, rec, `decision-${s.kind}`);
    }
    await page.evaluate(() => {
      const h = (window as Any).__rich4;
      const d = h.store.game.getState().decision;
      return d ? h.client.act(d.defaultIntent, d.decisionId) : null;
    });
  }
}

/** 写 summary（无论成败） */
function save(rec: Rec): void {
  writeFileSync(join(OUT, `summary-${rec.viewport}.json`), `${JSON.stringify(rec, null, 2)}\n`);
  console.log(
    `[m11-tour ${rec.viewport}] 截图 ${rec.shots.length}，回合 ${rec.turns}，买地 ${rec.bought.length}，/pack 请求 ${rec.packRequests}` +
      ` ${JSON.stringify(rec.packStatus)}，决策 ${JSON.stringify(rec.decisions)}，控制台错误 ${rec.consoleErrors.length}`,
  );
}

/** 流程走完后的断言 */
function verify(rec: Rec): void {
  expect(rec.consoleErrors, '控制台错误').toEqual([]);
  expect(rec.packBad, '/pack 失败请求').toEqual([]);
  expect(rec.otherBad, '其他失败请求').toEqual([]);
  expect(rec.packRequests).toBeGreaterThan(50);
  expect(rec.skin).toMatchObject({
    applied: 'original',
    pack: 'ready',
    failedGroups: [],
    boardInUse: 'original',
    resolution: { skin: 'original', board: 'original' },
  });
  for (const [kind, scenes] of Object.entries(rec.decisions)) expect(scenes, `决策 ${kind}`).toEqual(['classic']);
  expect(rec.bought.length).toBeGreaterThan(0);
  expect(rec.turns).toBeGreaterThanOrEqual(MIN_TURNS);
}

function newRec(viewport: string, flow: string): Rec {
  return {
    viewport,
    flow,
    shots: [],
    consoleErrors: [],
    packRequests: 0,
    packStatus: {},
    packBad: [],
    otherBad: [],
    decisions: {},
    turns: 0,
    bought: [],
    skin: null,
  };
}

test.beforeAll(() => mkdirSync(OUT, { recursive: true }));

test('桌面 1920×1080：門禁 → 片頭 → 標題 → 開局設定 → 選人 → 對局', async ({ browser }) => {
  const rec = newRec('desk', '開始遊戲 → 開局設定 → 選人');
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  tracker(page, rec);
  try {
    await gateIntroTitle(page, rec);
    await page.getByTestId('home-create').click();
    await expect(page.getByTestId('screen-setup')).toBeVisible();
    await page.getByTestId('set-map').selectOption('taiwan');
    await page.getByTestId('set-timer').selectOption('off');
    await page.getByTestId('set-ai-count').selectOption('3');
    await page.waitForTimeout(800);
    await shot(page, rec, 'setup');
    await page.getByTestId('create-submit').click();
    await page.waitForURL(/\/r\/\d{6}/);

    await expect(page.getByTestId('screen-room')).toBeVisible();
    await page.getByTestId('char-9').click();
    await page.waitForTimeout(1000);
    await shot(page, rec, 'select-character');
    await page.getByTestId('char-select').click();
    await page.waitForTimeout(800);
    await shot(page, rec, 'lobby');
    await expect(page.getByTestId('room-start')).toBeEnabled();
    await page.getByTestId('room-start').click();
    await page
      .getByTestId('classic-loading')
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => shot(page, rec, 'loading'))
      .catch(() => undefined);
    await enterGame(page, rec);
    await page.waitForTimeout(2000);
    await shot(page, rec, 'game-start');
    await play(page, rec);
    await page.waitForTimeout(1500);
    await shot(page, rec, 'after-turns');
  } finally {
    save(rec);
    await ctx.close();
  }
  verify(rec);
});

test('手机横屏 844×390：門禁 → 片頭 → 標題 → 單機對戰 → 對局', async ({ browser }) => {
  const rec = newRec('mobile', '單機對戰（一鍵開局）');
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 } });
  const page = await ctx.newPage();
  tracker(page, rec);
  try {
    await gateIntroTitle(page, rec);
    await page.getByTestId('home-solo').click();
    await page
      .getByTestId('classic-solo-loading')
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => shot(page, rec, 'solo-loading'))
      .catch(() => undefined);
    await enterGame(page, rec);
    await page.waitForTimeout(2000);
    await shot(page, rec, 'game-start');
    // 手机横屏不能有横向滚动
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(844);
    await play(page, rec);
    await page.waitForTimeout(1500);
    await shot(page, rec, 'after-turns');
  } finally {
    save(rec);
    await ctx.close();
  }
  verify(rec);
});
