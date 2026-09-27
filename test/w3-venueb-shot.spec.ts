// 调试（venues/b）：魔法屋、监狱 / 医院、拍卖厅原版场景截图（桌面 1920×1080 或手机横屏 844×390，W3_VP=mobile）。
// 素材包由 page.route 提供：缺省合成包（.cache/synthetic-pack）；W3_PACK_DIR=rich4-assets 时用本机真实素材包
// （界面强制原版，棋盘回退程序化）。截图只写到 .cache/w3-shots（真实素材截图绝不入库）。
// 用法：W3_PACK_DIR=rich4-assets W3_TAG=real CI=1 npx playwright test -c test/w3-playwright.config.ts w3-venueb
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
  Q_ANIM,
  setReady,
  startGame,
  syncPages,
  test,
  waitDecision,
  waitMyTurn,
} from '../e2e/fixtures/room';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACK_DIR = process.env.W3_PACK_DIR
  ? resolve(repoRoot, process.env.W3_PACK_DIR)
  : join(repoRoot, '.cache', 'w3b', 'synth');
const TAG = process.env.W3_TAG ?? 'synth';
const VP = process.env.W3_VP === 'mobile' ? { name: 'mobile', width: 844, height: 390 } : { name: 'desktop', width: 1920, height: 1080 };
const OUT = join(repoRoot, '.cache', 'w3-shots');
const manifest = JSON.parse(readFileSync(join(PACK_DIR, 'manifest.json'), 'utf8'));
const servable = new Map(
  Object.values(manifest.files as Record<string, { path: string; contentType: string }>).map((f) => [f.path, f.contentType]),
);

async function servePack(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('rich4.introSeen', '1');
    } catch {}
  });
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

const shot = async (page: Page, name: string): Promise<void> => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(OUT, `venueb-${name}-${TAG}-${VP.name}.png`) });
};

async function stepOnto(page: Page, seat: number, node: number, prev: number): Promise<void> {
  await waitMyTurn(page);
  await acted(page, () => debugAct(page, { op: 'teleport', seat, node, prev }));
  await acted(page, () => debugAct(page, { op: 'forceNext', purpose: 'dice', values: [1] }));
  await waitMyTurn(page);
  await acted(page, () => page.getByTestId('action-roll').click());
}

test(`venues/b 原版场景截图（${VP.name}）`, async ({ browser }) => {
  test.setTimeout(300_000);
  mkdirSync(OUT, { recursive: true });
  const mk = (n: string, q = Q) =>
    newPlayer(browser, n, q, {
      setup: async (pg) => {
        await pg.setViewportSize({ width: VP.width, height: VP.height });
        await servePack(pg);
      },
    });
  const players = [await mk('P1', Q_ANIM), await mk('P2'), await mk('P3'), await mk('P4')];
  const pages = players.map((p) => p.page);
  const [a, b, c, d] = pages as [Page, Page, Page, Page];
  try {
    const code = await createRoom(a, { map: 'test', timer: 'off' });
    for (const p of [b, c, d]) await joinRoom(p, code);
    const chars = [9, 4, 0, 3];
    for (let i = 0; i < 4; i++) await pickCharacter(pages[i]!, chars[i]!);
    for (const p of [b, c, d]) await setReady(p);
    await startGame(a, pages);
    await expect(a.getByTestId('classic-stage')).toBeVisible({ timeout: 30_000 });

    // ── 魔法屋：P1 在 9 号格，条件「现金最多的人」= P2 ──
    await waitMyTurn(a);
    await acted(a, () => debugAct(a, { op: 'setCash', seat: 1, cash: 900000, deposit: null }));
    await acted(a, () => debugAct(a, { op: 'forceNext', purpose: 'magicCond', values: [3] }));
    await stepOnto(a, 0, 8, 7);
    await waitDecision(a, ['MAGIC_CAST']);
    const magic = a.getByTestId('decision-MAGIC_CAST');
    await expect(magic).toBeVisible();
    console.log('magic data-scene =', await magic.getAttribute('data-scene'));
    await shot(a, 'magic');
    await a.getByTestId('magic-effect-4').hover();
    await shot(a, 'magic-hover4');
    await a.getByTestId('magic-effect-9').hover();
    await shot(a, 'magic-hover9');
    await a.getByTestId('magic-effect-2').click();
    await shot(a, 'magic-confirm');
    await a.getByTestId('magic-confirm').click();
    await a.waitForTimeout(700);
    await shot(a, 'magic-cast');
    await syncPages(pages, a);

    // ── 监狱：P3 在 14 号格保释 P2 / 看恶人 ──
    await waitMyTurn(c);
    await acted(c, () => debugAct(c, { op: 'setPoints', seat: 2, points: 400 }));
    await stepOnto(c, 2, 15, 16);
    await waitDecision(c, ['BAIL']);
    const jail = c.getByTestId('decision-BAIL');
    console.log('jail data-scene =', await jail.getAttribute('data-scene'));
    await shot(c, 'jail');
    await c.getByTestId('bail-hire-thief').click();
    await shot(c, 'jail-thief');
    await c.getByTestId('bail-seat-1').click();
    await shot(c, 'jail-seat1');
    await acted(c, () => c.getByTestId('bail-confirm').click());
    await syncPages(pages, c);

    // ── 医院：P4 在 15 号格 ──
    await waitMyTurn(d);
    await acted(d, () => debugAct(d, { op: 'setPoints', seat: 3, points: 400 }));
    await stepOnto(d, 3, 16, 17);
    await waitDecision(d, ['BAIL']);
    await shot(d, 'hospital');
    await d.getByTestId('bail-hire-spy').click();
    await shot(d, 'hospital-spy');
    await acted(d, () => d.getByTestId('bail-skip').click());
    await syncPages(pages, d);

    // ── 拍卖卡：P1 站在 L1 出卡；P2 / P3 / P4 竞拍 ──
    await waitMyTurn(a);
    await acted(a, () => debugAct(a, { op: 'teleport', seat: 0, node: 5, prev: 4 }));
    await acted(a, () => debugAct(a, { op: 'give', seat: 0, cards: [8], items: [] }));
    await waitMyTurn(a);
    await acted(a, () =>
      a.evaluate(() => {
        // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
        const h = (window as any).__rich4;
        const dd = h.store.game.getState().decision;
        // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
        const row = dd.options.cards.find((r: any) => r.card === 8);
        const tg = row.targets;
        const target =
          tg.t === 'underfoot' ? { t: 'underfoot', facility: null } : tg.t === 'lot' ? { t: 'lot', lot: tg.lots[0], facility: null } : { t: 'none' };
        return h.client.act({ type: 'USE_CARD', slot: row.slot, card: 8, target }, dd.decisionId);
      }),
    );
    // P2 刚被保释（待释放，算受困）不参加竞拍：P3、P4 竞价
    for (const p of [c, d]) await waitDecision(p, ['AUCTION_BID']);
    await shot(c, 'auction');
    await acted(c, () => c.getByTestId('auction-bid-0').click());
    await syncPages(pages, c);
    await waitDecision(d, ['AUCTION_BID']);
    await shot(d, 'auction-leader');
    await d.getByTestId('auction-bid-1000').hover();
    await shot(d, 'auction-hover');
    await acted(d, () => d.getByTestId('auction-bid-1000').click());
    await syncPages(pages, d);
    await waitDecision(c, ['AUCTION_BID']);
    await shot(c, 'auction-p3');
    await acted(c, () => c.getByTestId('auction-quit').click());
    await syncPages(pages, c);
    await a.waitForTimeout(500);
    await shot(a, 'after-auction');
  } finally {
    for (const p of players) await p.context.close();
  }
});
