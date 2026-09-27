// 调试：A11 原版通用对话框与弹窗截图（卡片欄、目标选择、道具欄、新闻板、命运板、设施、轮盘、资产表、托管、老虎机）。
// 素材包由 page.route 提供：缺省合成包（.cache/synthetic-pack）；W3_PACK_DIR=rich4-assets 时用本机真实素材包（界面强制原版，
// 棋盘回退程序化）。截图只写到 .cache/w3-shots（真实素材截图绝不入库）。
// 用法：CI=1 npx playwright test -c test/w3-playwright.config.ts w3-a11
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
  playTurn,
  Q,
  Q_ANIM,
  roll,
  setReady,
  startGame,
  test,
  waitDecision,
  waitIdle,
  waitMyTurn,
} from '../e2e/fixtures/room';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACK_DIR = process.env.W3_PACK_DIR
  ? resolve(repoRoot, process.env.W3_PACK_DIR)
  : join(repoRoot, '.cache', 'w3-a11', 'pack');
const TAG = process.env.W3_TAG ?? 'synth';
const OUT = join(repoRoot, '.cache', 'w3-shots');
const VP = process.env.W3_VP === 'mobile' ? { width: 844, height: 390 } : { width: 1920, height: 1080 };

async function servePack(page: Page): Promise<void> {
  const manifest = JSON.parse(readFileSync(join(PACK_DIR, 'manifest.json'), 'utf8'));
  const servable = new Map(
    Object.values(manifest.files as Record<string, { path: string; contentType: string }>).map((f) => [
      f.path,
      f.contentType,
    ]),
  );
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

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(OUT, `a11-${name}-${TAG}-${VP.width}.png`) });
}

async function stepOnto(page: Page, seat: number, node: number, prev: number): Promise<void> {
  await waitMyTurn(page);
  await acted(page, () => debugAct(page, { op: 'teleport', seat, node, prev }));
  await acted(page, () => debugAct(page, { op: 'forceNext', purpose: 'dice', values: [1] }));
  await waitMyTurn(page);
  await acted(page, () => roll(page));
}

async function answerDefault(page: Page): Promise<void> {
  await page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const h = (window as any).__rich4;
    const d = h.store.game.getState().decision;
    if (d && d.kind !== 'TURN_MENU') return h.client.act(d.defaultIntent, d.decisionId);
    return null;
  });
}

test('A11 原版对话框与弹窗截图', async ({ browser }) => {
  test.setTimeout(600_000);
  mkdirSync(OUT, { recursive: true });
  const mk = (n: string, q: string) =>
    newPlayer(browser, n, q, {
      setup: async (pg) => {
        await pg.setViewportSize(VP);
        await servePack(pg);
      },
    });
  const a = await mk('P1', Q);
  const b = await mk('P2', Q);
  // 演出页：观战者（不带 anim=instant），看新闻、命运、轮盘、老虎机
  const c = await mk('W', Q_ANIM);
  const A = a.page;
  const B = b.page;
  const C = c.page;
  try {
    const code = await createRoom(A, { map: 'test', timer: 'off' });
    await joinRoom(B, code);
    await C.goto(`/r/${code}?${Q_ANIM}&watch=1`);
    await pickCharacter(A, 9);
    await pickCharacter(B, 4);
    await setReady(B);
    await startGame(A, [A, B]);
    await expect(C.getByTestId('screen-game')).toBeVisible({ timeout: 30_000 });
    await expect(A.getByTestId('classic-stage')).toBeVisible({ timeout: 30_000 });
    const gods = await A.evaluate(
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      () => (window as any).__rich4.store.game.getState().view.gods.map((g: any) => ({ kind: g.kind, where: g.where })),
    );
    console.log('gods', JSON.stringify(gods));

    // ── 卡片欄 / 道具欄 / 目标选择 ──
    await waitMyTurn(A);
    await acted(A, () => debugAct(A, { op: 'give', seat: 0, cards: [17, 3, 1, 26], items: [{ item: 2, qty: 2 }, { item: 7, qty: 1 }] }));
    await waitMyTurn(A);
    await A.getByTestId('action-cards').click();
    await expect(A.locator('[data-testid="decision-TURN_MENU"][data-scene="classic"]')).toBeVisible();
    await A.getByTestId('inv-card-0').hover();
    await shot(A, 'cards');
    await A.getByTestId('turn-items').click();
    await A.getByTestId('inv-item-2').hover();
    await shot(A, 'items');
    await A.getByTestId('inv-item-2').click();
    await expect(A.getByTestId('target-picker')).toBeVisible();
    await shot(A, 'target');
    await A.getByTestId('target-cancel').click();
    await A.getByTestId('inv-item-7').click();
    await shot(A, 'target-missile');
    await A.getByTestId('target-cancel').click();
    await A.getByTestId('turn-close').click();

    // ── 新闻板 ──
    await acted(A, () => debugAct(A, { op: 'stackDeck', deck: 'news', ids: [11] }));
    await stepOnto(A, 0, 1, 18);
    await expect(C.getByTestId('news-popup')).toBeVisible({ timeout: 20_000 });
    await C.waitForTimeout(900);
    await shot(C, 'news');
    await waitIdle(C);
    await waitIdle(A);

    // P2：走到点券格
    await playTurn(B, 1, { node: 12, prev: 11, dice: 1 });

    // ── 命运板 ──
    await acted(A, () => debugAct(A, { op: 'stackDeck', deck: 'fate', ids: [25] }));
    await stepOnto(A, 0, 2, 1);
    await expect(C.getByTestId('fate-popup')).toBeVisible({ timeout: 20_000 });
    await shot(C, 'fate');
    await waitIdle(C);
    await waitIdle(A);
    await playTurn(B, 1, { node: 12, prev: 11, dice: 1 });

    // ── 设施：买下 F1 → 兴建（设施类别选择） ──
    await stepOnto(A, 0, 16, 15);
    await waitDecision(A, ['BUY_FACILITY']);
    await shot(A, 'buy-facility');
    await acted(A, () => A.getByTestId('buy-confirm').click());
    await waitIdle(A);
    await playTurn(B, 1, { node: 12, prev: 11, dice: 1 });
    await stepOnto(A, 0, 16, 15);
    await waitDecision(A, ['BUILD_FACILITY']);
    await A.getByTestId('facility-type-hotel').click();
    await shot(A, 'build-facility');
    await acted(A, () => A.getByTestId('facility-confirm').click());
    await waitIdle(A);

    // ── 轮盘：P2 住进 P1 的旅馆（P1 的演出页弹出转盘） ──
    await acted(B, () => debugAct(B, { op: 'forceNext', purpose: 'wheel', values: [7] }));
    await stepOnto(B, 1, 16, 15);
    const wheel = C.getByTestId('roulette-popup');
    for (let i = 0; i < 20; i++) {
      const dbg = await C.evaluate(() => {
        // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
        const g = (window as any).__rich4.store.game.getState();
        return {
          vis: document.visibilityState,
          anim: g.anim,
          // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
          log: g.log.slice(-4).map((l: any) => `${l.id}:${l.type}:${l.src ? 'src' : '-'}`),
          popups: [...document.querySelectorAll('[data-testid="popup"]')].map((e) => e.getAttribute('data-kind')),
        };
      });
      console.log('dbg', JSON.stringify(dbg));
      if (dbg.popups.includes('roulette')) break;
      await C.waitForTimeout(300);
    }
    await expect(wheel).toBeVisible({ timeout: 30_000 });
    await expect(wheel).toHaveAttribute('data-done', 'true', { timeout: 5000 });
    await shot(C, 'roulette');
    await waitIdle(C);
    await waitIdle(B);
    await answerDefault(B);

    // ── 月结颁奖：在演出页的显示态日志里补一行 MONTHLY_REPORT（纯展示） ──
    await C.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      const g = (window as any).__rich4.store.game.getState();
      const view = g.view;
      g.pushLog([
        {
          seq: g.seq,
          type: 'MONTHLY_REPORT',
          text: '月結',
          date: view.clock.date,
          src: {
            event: {
              type: 'MONTHLY_REPORT',
              rows: [
                { seat: 0, netWorth: 215000, loss: 0, gain: 0, interest: 0 },
                { seat: 1, netWorth: 180000, loss: 0, gain: 0, interest: 0 },
              ],
              champion: 0,
              tragic: null,
            },
            view,
          },
        },
      ]);
    });
    await expect(C.getByTestId('monthly-popup')).toBeVisible({ timeout: 5000 });
    await shot(C, 'monthly');

    // ── 资产表 / 托管 ──
    await waitMyTurn(A);
    await A.getByTestId('action-info').click();
    await expect(A.getByTestId('classic-assets')).toBeVisible();
    await shot(A, 'assets-0');
    await A.getByTestId('assets-page-1').click();
    await shot(A, 'assets-1');
    await A.getByTestId('assets-page-2').click();
    await shot(A, 'assets-2');
    await A.getByTestId('assets-exit').click();
    await A.getByTestId('action-autopilot').click({ button: 'right' });
    await expect(A.getByTestId('trustee-dialog')).toBeVisible();
    await shot(A, 'trustee');
    await A.keyboard.press('Escape');
    await A.getByTestId('tool-save').click();
    await expect(A.getByTestId('classic-saves')).toBeVisible();
    await A.waitForTimeout(600);
    await shot(A, 'saves');
    await A.keyboard.press('Escape');

    // ── 老虎机：走到小财神上 ──
    const wealth = gods.find(
      (g: { kind: number; where: { t: string; node?: number } }) => g.kind === 1 && g.where.t === 'road',
    );
    if (wealth?.where.node) {
      const n = wealth.where.node as number;
      const prev = n === 1 ? 18 : n - 1;
      const prev2 = prev === 1 ? 18 : prev - 1;
      await acted(A, () => debugAct(A, { op: 'forceNext', purpose: 'slot', values: [1, 2, 3] }));
      await stepOnto(A, 0, prev, prev2);
      const slot = C.getByTestId('god-slot');
      await expect(slot).toBeVisible({ timeout: 30_000 });
      await C.waitForTimeout(200);
      await shot(C, 'slot-rolling');
      await expect(slot).toHaveAttribute('data-rolling', 'false', { timeout: 5000 });
      await shot(C, 'slot');
    }
  } finally {
    await a.context.close();
    await b.context.close();
    await c.context.close();
  }
});

test('A11 原版对话框截图（被动卡、升级、生日、研究所）', async ({ browser }) => {
  test.setTimeout(600_000);
  mkdirSync(OUT, { recursive: true });
  const mk = (n: string, q: string) =>
    newPlayer(browser, n, q, {
      setup: async (pg) => {
        await pg.setViewportSize(VP);
        await servePack(pg);
      },
    });
  const a = await mk('P1', Q);
  const b = await mk('P2', Q);
  const A = a.page;
  const B = b.page;
  const useCardOn = async (card: number, targetTestId: string): Promise<void> => {
    await waitMyTurn(A);
    const slot = await A.evaluate((c) => {
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      const d = (window as any).__rich4.store.game.getState().decision;
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      return d.options.cards.find((r: any) => r.card === c).slot as number;
    }, card);
    await A.getByTestId('action-cards').click();
    await A.getByTestId(`inv-card-${slot}`).click();
    await A.getByTestId('target-picker').getByTestId(targetTestId).click();
    await acted(A, () => A.getByTestId('target-confirm').click());
  };
  try {
    const code = await createRoom(A, { map: 'test', timer: 'off' });
    await joinRoom(B, code);
    await pickCharacter(A, 9);
    await pickCharacter(B, 4);
    await setReady(B);
    await startGame(A, [A, B]);
    await stepOnto(A, 0, 4, 3);
    await waitDecision(A, ['BUY_LAND']);
    await acted(A, () => A.getByTestId('buy-confirm').click());
    await waitIdle(A);
    await playTurn(B, 1, { node: 12, prev: 11, dice: 1 });

    // 免费卡：P1 查税 → P2 被问
    await waitMyTurn(A);
    await acted(A, () => debugAct(A, { op: 'give', seat: 0, cards: [26, 17], items: [] }));
    await acted(A, () => debugAct(A, { op: 'give', seat: 1, cards: [20, 19, 13, 14], items: [] }));
    await useCardOn(26, 'target-seat-1');
    await waitDecision(B, ['USE_FREE_CARD']);
    await shot(B, 'free-card');
    await acted(B, () => B.getByTestId('free-confirm').click());
    await waitIdle(A);
    // 嫁祸卡：P1 陷害 → P2 被问
    await useCardOn(17, 'target-actor-seat-1');
    await waitDecision(B, ['SCAPEGOAT']);
    await B.getByTestId('scapegoat-seat-0').click();
    await shot(B, 'scapegoat');
    await acted(B, () => B.getByTestId('scapegoat-decline').click());
    await waitIdle(A);

    // 升级
    await stepOnto(A, 0, 4, 3);
    await waitDecision(A, ['UPGRADE_LAND']);
    await shot(A, 'upgrade');
    await acted(A, () => A.getByTestId('upgrade-confirm').click());
    await waitIdle(A);

    // 生日（命运 5）
    await acted(A, () => debugAct(A, { op: 'stackDeck', deck: 'fate', ids: [5] }));
    await stepOnto(A, 0, 2, 1);
    await waitDecision(A, ['BIRTHDAY_PICK']);
    await A.getByTestId('birthday-1-1').hover();
    await shot(A, 'birthday');
    await acted(A, () => A.getByTestId('birthday-confirm').click());
    await waitIdle(A);

    // 研究所：买下 F1 → 兴建研究所 → 再停 → 不加盖 → 研发
    await stepOnto(A, 0, 16, 15);
    await waitDecision(A, ['BUY_FACILITY']);
    await acted(A, () => A.getByTestId('buy-confirm').click());
    await waitIdle(A);
    await stepOnto(A, 0, 16, 15);
    await waitDecision(A, ['BUILD_FACILITY']);
    await A.getByTestId('facility-type-lab').click();
    await acted(A, () => A.getByTestId('facility-confirm').click());
    await waitIdle(A);
    await stepOnto(A, 0, 16, 15);
    await waitDecision(A, ['UPGRADE_FACILITY']);
    await shot(A, 'upgrade-facility');
    await acted(A, () => A.getByTestId('upgrade-decline').click());
    await waitDecision(A, ['RESEARCH']);
    await A.getByTestId('research-1').click();
    await shot(A, 'research');
    await acted(A, () => A.getByTestId('research-confirm').click());
  } finally {
    await a.context.close();
    await b.context.close();
  }
});
