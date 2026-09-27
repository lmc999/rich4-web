// w2 审查修正目视：用本机 Chrome 打开 test/w2-dev.sh 起的开发服（真实素材包 + 口令门禁），建台湾图房间开局，
// 把 4 人传到同一格、给 0 号挂炸弹、2 号冬眠，截棋盘与经典外壳（GO 钮骰子数竖槽、日历太阳 / 月亮）的局部图到
// .cache/w2-review/fix-shots（含原版素材，不入库）。用法：node test/w2-review-shots.mjs
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.W2_BASE ?? 'http://localhost:5417';
const PASS = process.env.W2_PASS ?? 'w2-pass-4417';
const OUT = '.cache/w2-review/fix-shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await ctx.request.post(`${BASE}/api/access`, { data: { passcode: PASS } });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[error] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(`${BASE}/?audio=off`);
  await page.getByTestId('home-nickname').fill('測試者');
  await page.getByTestId('home-create').click();
  await page.getByTestId('set-map').selectOption('taiwan');
  await page.getByTestId('set-timer').selectOption('off');
  await page.getByTestId('set-ai-count').selectOption('3');
  await page.getByTestId('create-submit').click();
  await page.waitForURL(/\/r\/\d{6}/);
  await page.getByTestId('char-9').click();
  await page.getByTestId('char-select').click();
  await page.getByTestId('room-start').click();
  await page.getByTestId('classic-stage').waitFor();
  const idle = () =>
    page.waitForFunction(
      () => {
        const h = window.__rich4;
        const g = h?.store?.game?.getState();
        return !!g && h.eventPlayer.idle && g.decision?.kind === 'TURN_MENU' && g.submitting === null;
      },
      undefined,
      { timeout: 120_000 },
    );
  await idle();
  await page.waitForTimeout(1500);
  // 外壳：GO 钮与骰子数竖槽、日历
  const clip = async (id, name, pad = 0) => {
    const b = await page.getByTestId(id).boundingBox();
    await page.screenshot({
      path: `${OUT}/${name}.png`,
      clip: { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad },
    });
  };
  await clip('action-roll', 'go-dice-slot', 30);
  await clip('classic-calendar', 'calendar-month');
  await page.getByTestId('classic-cal-sun').click();
  await clip('classic-calendar', 'calendar-day');
  await page.getByTestId('classic-cal-moon').click();

  // 棋盘：4 人同格、炸弹、冬眠
  const node = await page.evaluate(() => window.__rich4.store.game.getState().view.players[0].node);
  for (const seat of [1, 2, 3]) {
    const r = await page.evaluate((o) => window.__rich4.client.debug(o), { op: 'teleport', seat, node });
    if (!r.ok) console.log('teleport failed', JSON.stringify(r));
  }
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const r = window.__rich4.renderer;
    const a0 = r.board.actor(0);
    a0.setStatus({ ...a0.currentStatus, bomb: 7 });
    const a2 = r.board.actor(2);
    a2.setStatus({ ...a2.currentStatus, hibernate: true });
    r.follow(0);
  });
  await page.waitForTimeout(1500);
  const board = await page.getByTestId('classic-board-slot').boundingBox();
  const shotBoard = async (name) => {
    const p = await page.evaluate(() => {
      const r = window.__rich4.renderer;
      return r.camera.worldToScreen(r.board.actor(0).boardPos());
    });
    const w = 520;
    const h = 460;
    await page.screenshot({
      path: `${OUT}/${name}.png`,
      clip: {
        x: Math.max(board.x, board.x + p.x - w / 2),
        y: Math.max(board.y, board.y + p.y - h * 0.75),
        width: w,
        height: h,
      },
    });
  };
  await shotBoard('four-on-tile-bomb-zzz');
  // 只留 0 号在这一格：单人挂炸弹
  for (const seat of [1, 2, 3]) {
    await page.evaluate((o) => window.__rich4.client.debug(o), { op: 'teleport', seat, node: node + 3 });
  }
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const r = window.__rich4.renderer;
    const a0 = r.board.actor(0);
    a0.setStatus({ ...a0.currentStatus, bomb: 7 });
  });
  await page.waitForTimeout(600);
  await shotBoard('bomb-fuse');
  await page.evaluate(() => window.__rich4.renderer.rotate(2));
  await page.waitForTimeout(800);
  await shotBoard('bomb-fuse-view2');
  await page.screenshot({ path: `${OUT}/full.png` });
  await ctx.close();
} finally {
  await browser.close();
}
