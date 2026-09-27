// M7 体验修复的目测脚本（临时，不进测试套件）：对 5198（vite preview）+ 3198（RICH4_TEST_MODE 服务器）
// 在 844×390 横屏与 1280×800 桌面下截图：小游戏开场对话框、托管分段按钮、玩家条紧凑徽章、玩家面板徽章、终局资产构成。
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:5198';
const OUT = new URL('./m7-shots/', import.meta.url).pathname;
const Q = 'anim=instant&audio=off&test=1';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 } });
const page = await ctx.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('console.error', m.text());
});
const dbg = (op) => page.evaluate((o) => window.__rich4.client.debug(o), op);
const idle = () =>
  page.waitForFunction(() => {
    const h = window.__rich4;
    return !!h?.store?.game && h.store.game.getState().view !== null && h.eventPlayer.idle;
  });
const myTurn = () =>
  page.waitForFunction(() => {
    const h = window.__rich4;
    const g = h?.store?.game?.getState();
    return !!g && h.eventPlayer.idle && g.decision?.kind === 'TURN_MENU' && g.submitting === null;
  });

await page.goto(`${BASE}/?${Q}`);
await page.getByTestId('home-nickname').fill('目测');
await page.getByTestId('home-nickname').blur();
await page.getByTestId('home-create').click();
await page.getByTestId('set-map').selectOption('test');
await page.getByTestId('set-timer').selectOption('off');
await page.getByTestId('set-ai-count').selectOption('3');
await page.getByTestId('create-submit').click();
await page.waitForURL(/\/r\/\d{6}/);
await page.getByTestId('room-start').click();
await page.getByTestId('screen-game').waitFor();
await idle();
await dbg({ op: 'clearBoard' });
await myTurn();
await page.screenshot({ path: `${OUT}landscape-turn.png` });

// 玩家条紧凑徽章 + 分段托管按钮（本地改显示用的 view，只为截图）
const inject = () => page.evaluate(() => {
  const g = window.__rich4.store.game.getState();
  const v = g.view;
  const players = v.players.map((p) =>
    p.seat === 1
      ? {
          ...p,
          god: { kind: 2, days: 4 },
          st: { ...p.st, jail: 3 },
          bomb: { fuse: 12 },
          insuranceDays: 5,
          loan: 30000,
          loanDue: 19980601,
        }
      : p.seat === 2
        ? { ...p, alliance: { seat: 3, days: 5 }, st: { ...p.st, hospital: 2 } }
        : p,
  );
  g.resetTo({ epoch: g.epoch, seq: g.seq, view: { ...v, players }, pending: g.pending, decision: g.decision });
});
await inject();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}landscape-badges.png` });
await page.getByTestId('action-trustee-settings').click();
await page.getByTestId('trustee-dialog').waitFor();
await page.screenshot({ path: `${OUT}landscape-trustee.png` });
await page.keyboard.press('Escape');

// 小游戏开场（企鹅：15 → 16）
await dbg({ op: 'teleport', seat: 0, node: 15, prev: 14 });
await dbg({ op: 'forceNext', purpose: 'dice', values: [1] });
await myTurn();
await page.getByTestId('action-roll').click();
await page.waitForFunction(() => window.__rich4.store.game.getState().decision?.kind === 'MINIGAME', undefined, {
  timeout: 30_000,
});
await page.getByTestId('decision-MINIGAME').waitFor();
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}landscape-minigame.png` });
const m = await page.evaluate(() => {
  const f = document.querySelector('[data-testid="decision-MINIGAME"]');
  const [b, t] = f.querySelectorAll(':scope > fieldset');
  return { sh: b.scrollHeight, ch: b.clientHeight, bb: b.getBoundingClientRect().bottom, tt: t.getBoundingClientRect().top };
});
console.log('minigame body/foot', JSON.stringify(m));
await page.getByTestId('minigame-decline').click().catch(() => {});

// 桌面：玩家面板徽章、终局资产构成
await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForTimeout(500);
await page.evaluate(() => {
  const u = window.__rich4.store.ui ?? null;
  u?.getState().setInspectSeat?.(1);
});
await page.getByTestId('chip-1').click();
await inject();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}desktop-panel.png` });
await page.evaluate(() => {
  const g = window.__rich4.store.game.getState();
  const v = g.view;
  const ranking = v.players
    .map((p) => ({ seat: p.seat, netWorth: p.cash + p.deposit + 50000 * p.seat, alive: p.seat !== 3 }))
    .sort((a, b) => b.netWorth - a.netWorth);
  g.setOver({
    epoch: g.epoch,
    result: { reason: 'timeLimit', code: 2, winner: ranking[0].seat, date: 19990101, elapsedDays: 365, ranking },
    ranking: ranking.map(({ seat, netWorth }) => ({ seat, netWorth })),
  });
});
await page.getByTestId('game-over').waitFor();
await page.screenshot({ path: `${OUT}desktop-gameover.png` });
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}landscape-gameover.png` });

// 首页读取存档面板
await page.goto(`${BASE}/?${Q}`);
await page.getByTestId('home-load-open').click();
await page.getByTestId('home-saves').waitFor();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}landscape-home-saves.png` });
await page.setViewportSize({ width: 1280, height: 800 });
await page.screenshot({ path: `${OUT}desktop-home-saves.png` });

await browser.close();
console.log('done');
