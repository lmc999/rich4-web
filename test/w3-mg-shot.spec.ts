// 调试（A13）：三款小游戏原版视图的目视截图（桌面 1280×960 与手机横屏 844×390）：入场 READY GO、企鹅记忆阶段、游玩中、
// 观战、结算大号分数。素材包由 page.route 提供（W3_PACK_DIR，缺省合成包 .cache/synthetic-pack）；真实素材包时强制原版界面
// （fixture 地图在真实包里没有棋盘绑定，棋盘回退程序化，不影响小游戏）。截图只写到 .cache/w3-mg/shots（不入库）。
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
  : join(repoRoot, '.cache', 'synthetic-pack');
const TAG = process.env.W3_PACK_DIR ? 'real' : 'synth';
const OUT = join(repoRoot, '.cache', 'w3-mg', 'shots');
const manifest = JSON.parse(readFileSync(join(PACK_DIR, 'manifest.json'), 'utf8'));
const servable = new Map(
  Object.values(manifest.files as Record<string, { path: string; contentType: string }>).map((f) => [
    f.path,
    f.contentType,
  ]),
);
const ACCESS_ON = {
  ok: true,
  data: { mode: 'passcode', granted: true, kind: 'p', expiresAt: Date.now() + 3_600_000, grants: false, canGrant: false },
};

async function servePack(page: Page): Promise<void> {
  await page.route('**/pack/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/pack/manifest.json')
      return route.fulfill({ json: manifest, headers: { 'cache-control': 'no-cache' } });
    const rel = decodeURIComponent(path.slice('/pack/'.length));
    const type = servable.get(rel);
    if (!type) return route.fulfill({ status: 404, json: { ok: false } });
    return route.fulfill({ status: 200, contentType: type, body: readFileSync(join(PACK_DIR, rel)) });
  });
  await page.route('**/api/access', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: ACCESS_ON }) : route.fallback(),
  );
  await page.addInitScript(() => {
    try {
      const raw = localStorage.getItem('rich4.settings');
      const cur = raw ? JSON.parse(raw) : { state: {}, version: 2 };
      cur.state = { ...(cur.state ?? {}), skin: 'original' };
      localStorage.setItem('rich4.settings', JSON.stringify(cur));
    } catch {}
  });
}

// biome-ignore lint/suspicious/noExplicitAny: 调试
async function mg(page: Page): Promise<any> {
  // biome-ignore lint/suspicious/noExplicitAny: 调试
  return page.evaluate(() => (window as any).__rich4.minigame?.state() ?? null);
}

async function stepFrom(page: Page, seat: number, node: number, prev: number): Promise<void> {
  await waitMyTurn(page);
  await acted(page, () => debugAct(page, { op: 'teleport', seat, node, prev }));
  await acted(page, () => debugAct(page, { op: 'forceNext', purpose: 'dice', values: [1] }));
  await waitMyTurn(page);
  await acted(page, () => roll(page));
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${TAG}-${name}.png`) });
  const s = await mg(page);
  console.log(name, s?.phase, s?.view, 'ready', s?.readyFrame, JSON.stringify(s?.viewDebug ?? null).slice(0, 300));
}

async function waitFor(page: Page, pred: string, timeout = 20_000): Promise<void> {
  await page.waitForFunction(
    (src) => {
      // biome-ignore lint/suspicious/noExplicitAny: 调试
      const s = (window as any).__rich4.minigame?.state();
      // biome-ignore lint/security/noGlobalEval: 调试脚本
      return s ? new Function('s', `return ${src}`)(s) : false;
    },
    pred,
    { timeout, polling: 30 },
  );
}

for (const vp of [
  { name: 'desktop', width: 1280, height: 960 },
  { name: 'mobile', width: 844, height: 390 },
]) {
  test(`小游戏原版视图截图（${vp.name}）`, async ({ browser }) => {
    mkdirSync(OUT, { recursive: true });
    const mk = (n: string) =>
      newPlayer(browser, n, Q, {
        setup: async (pg) => {
          await pg.setViewportSize({ width: vp.width, height: vp.height });
          await servePack(pg);
        },
      });
    const a0 = await mk('P1');
    const b0 = await mk('P2');
    const [a, b] = [a0.page, b0.page];
    try {
      const code = await createRoom(a, { map: 'test', timer: 'off' });
      await joinRoom(b, code);
      await pickCharacter(a, 9);
      await pickCharacter(b, 4);
      await setReady(b);
      await startGame(a, [a, b]);

      const games: [string, number, number, (p: Page) => Promise<void>][] = [
        [
          'penguin',
          15,
          14,
          async (p) => {
            await waitFor(p, "s.phase === 'playing' && s.state.phase === 'intro' && s.viewDebug && s.viewDebug.buried > 0");
            await shot(p, `${vp.name}-penguin-2-intro`);
            await waitFor(p, "s.state.phase === 'play' && s.state.walk === null && s.state.digLeft === 0");
            for (let k = 0; k < 3; k++) {
              const st = await mg(p);
              const target = st.state.board.findIndex((v: number, c: number) => v >= 2 && c !== st.state.cell);
              // biome-ignore lint/suspicious/noExplicitAny: 调试
              await p.evaluate((c) => (window as any).__rich4.minigame.pick(c), target);
              await p.waitForTimeout(700);
              if (k === 0) await shot(p, `${vp.name}-penguin-3-walk`);
              await waitFor(p, "s.phase === 'result' || (s.state.walk === null && s.state.digLeft === 0)");
            }
            await shot(p, `${vp.name}-penguin-4-dug`);
          },
        ],
        [
          'balloon',
          20,
          13,
          async (p) => {
            for (let k = 0; k < 40; k++) {
              await p.evaluate(() => {
                // biome-ignore lint/suspicious/noExplicitAny: 调试
                const h = (window as any).__rich4.minigame;
                const st = h.state()?.state;
                if (!st) return;
                for (let i = 0; i < 16; i++) {
                  if (st.x[i] !== 0 && st.pop[i] === 0 && st.y[i] > 60 && st.y[i] < 420) {
                    h.click(st.x[i], st.y[i] - 8);
                    return;
                  }
                }
              });
              await p.waitForTimeout(200);
              if (k === 20) await shot(p, `${vp.name}-balloon-3-play`);
            }
          },
        ],
        [
          'xicong',
          19,
          4,
          async (p) => {
            for (let k = 0; k < 60; k++) {
              await p.evaluate(() => {
                // biome-ignore lint/suspicious/noExplicitAny: 调试
                const h = (window as any).__rich4.minigame;
                const st = h.state()?.state;
                if (!st) return;
                let best = -1;
                for (let i = 0; i < 16; i++) {
                  if (st.ix[i] === 0 || st.ikind[i] === 4) continue;
                  if (best < 0 || st.iy[i] > st.iy[best]) best = i;
                }
                h.cursor(best >= 0 ? st.ix[best] : 320);
              });
              await p.waitForTimeout(120);
              if (k === 25) await shot(p, `${vp.name}-xicong-3-play`);
            }
          },
        ],
      ];
      for (const [id, node, prev, play] of games) {
        await stepFrom(a, 0, node, prev);
        await waitDecision(a, ['MINIGAME']);
        await waitFor(a, `s.minigameId === '${id}' && s.phase === 'countdown' && s.readyFrame >= 9`);
        await shot(a, `${vp.name}-${id}-1-ready`);
        await waitFor(a, "s.phase === 'playing'");
        await play(a);
        const watch = b.locator('[data-testid="minigame-host"][data-mode="spectate"]');
        if ((await watch.count()) > 0) await shot(b, `${vp.name}-${id}-5-spectate`);
        await waitFor(a, "s.phase === 'result'", 60_000);
        await a.waitForTimeout(300);
        await shot(a, `${vp.name}-${id}-6-result`);
        await expect(a.getByTestId('minigame-host')).toHaveCount(0, { timeout: 15_000 });
        await waitIdle(a);
        await stepFrom(b, 1, 12, 11);
        await waitIdle(b);
      }
    } finally {
      for (const p of [a0, b0]) await p.context.close();
    }
  });
}
