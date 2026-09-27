// 断线重连（design/client.md §12.2 用例 4；architecture M5 验证 2；net.md §5.2–5.3）：
// 1) P3 在自己回合打开回合菜单后 context.setOffline(true)：P3 页面出现断线遮罩；其他人看到 P3 离线、
//    宽限（本房间设为 5 秒）过后看到托管徽标，电脑代打 P3 的回合；断网 8 秒以上后恢复网络：
//    P3 自动重连、遮罩消失并提示「已重新连接」，页面上没有残留的对话框，托管解除，4 个页面 HUD 一致；
// 2) 刷新 P3 页面：凭 localStorage 的 token 与 lastRoom 恢复原座位；
// 3) 同一 token 再开一个标签页：旧页收到「已在其他页面打开」，新页接管座位；旧页点「在这里继续」可再抢回。
import type { Page } from '@playwright/test';
import {
  createRoom,
  expect,
  expectNoErrors,
  hudSnapshot,
  joinRoom,
  pickReadyStart,
  playTurn,
  Q,
  roomOf,
  serverSnapshot,
  syncPages,
  test,
  waitIdle,
  waitMyTurn,
} from '../fixtures/room';

/** 断网至少这么久再恢复（architecture M5 验证 2） */
const OFFLINE_MS = 8000;

async function mySeatOf(page: Page): Promise<number | null> {
  const r = await roomOf(page);
  return r?.you.role === 'player' ? (r.you.seat ?? null) : null;
}

/** 等到本页显示的当前行动者是 seat（动画空闲） */
async function waitCursorSeat(page: Page, seat: number, timeout = 45_000): Promise<void> {
  await page.waitForFunction(
    (s) => {
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      const h = (window as any).__rich4;
      const cur = h?.store?.game?.getState().view?.clock.cursor;
      return h?.eventPlayer.idle && cur?.t === 'seat' && cur.seat === s;
    },
    seat,
    { timeout },
  );
}

async function expectHudsAgree(pages: Page[]): Promise<void> {
  await syncPages(pages);
  const snaps = await Promise.all(pages.map((p) => hudSnapshot(p)));
  for (const s of snaps) expect(s).toEqual(snaps[0]);
  expect(snaps[0]).toEqual(await serverSnapshot(pages[0]!));
}

test('P3 断线托管后恢复、刷新续座、同 token 两标签页顶替', async ({ fourPlayers }) => {
  test.setTimeout(240_000);
  const pages = fourPlayers.map((p) => p.page);
  const [a, b, c, d] = pages as [Page, Page, Page, Page];
  const p3 = fourPlayers[2]!;
  const code = await createRoom(a, { map: 'test', timer: 'off' });
  for (const p of [b, c, d]) await joinRoom(p, code);
  // 断线宽限缩到 5 秒（客户端补丁允许的最小值），用例不用等 15 秒
  const r = await a.evaluate(
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    () => (window as any).__rich4.client.updateSettings({ reconnectGraceSec: 5 }) as Promise<{ ok: boolean }>,
  );
  expect(r.ok).toBe(true);
  await pickReadyStart(pages);

  await playTurn(a, 0);
  await playTurn(b, 1);
  // 轮到 P3：打开回合菜单的股票页（留一个打开着的对话框），然后断网
  await waitMyTurn(c);
  await c.getByTestId('action-stock').click();
  const layer = c.getByTestId('decision-layer');
  await expect(layer).toBeVisible();
  const staleDecision = await layer.getAttribute('data-decision');
  expect(staleDecision).toBeTruthy();
  const offAt = Date.now();
  await p3.context.setOffline(true);

  // P3 页面：断线 1 秒后出现遮罩，带托管倒计时
  await expect(c.getByTestId('reconnect-overlay')).toBeVisible({ timeout: 30_000 });
  // 其他人：P3 离线，宽限过后进入托管（chip 上的托管徽标），电脑接着打
  for (const p of [a, b, d]) await expect(p.getByTestId('chip-2-autopilot')).toBeVisible({ timeout: 45_000 });
  await expect(c.getByTestId('reconnect-grace')).toHaveAttribute('data-left', '0');
  // 电脑替 P3 走完这一回合（轮到 P4）
  await waitCursorSeat(a, 3);
  const wait = OFFLINE_MS - (Date.now() - offAt);
  if (wait > 0) await c.waitForTimeout(wait);

  await p3.context.setOffline(false);
  await expect(c.getByTestId('reconnect-overlay')).toHaveCount(0, { timeout: 30_000 });
  await expect(c.getByTestId('toast').filter({ hasText: '已重新连接' })).toBeVisible();
  // 托管解除（所有页面），P3 页面没有残留对话框
  for (const p of pages) await expect(p.getByTestId('chip-2-autopilot')).toHaveCount(0, { timeout: 20_000 });
  await waitIdle(c);
  await waitCursorSeat(c, 3);
  await expect(c.locator(`[data-decision="${staleDecision}"]`)).toHaveCount(0);
  await expect(c.getByTestId('decision-layer')).toHaveCount(0);
  await expect(c.getByTestId('action-roll')).toBeDisabled();
  await expect(c.getByTestId('reconnect-overlay')).toHaveCount(0);
  expect((await roomOf(c))?.seats[2]?.control).toBe('human');
  await expectHudsAgree(pages);

  // 刷新页面：凭 token 恢复原座位
  await c.reload();
  await expect(c.getByTestId('screen-game')).toBeVisible();
  await waitIdle(c);
  expect(await mySeatOf(c)).toBe(2);
  for (const p of pages) await expect(p.getByTestId('chip-2-autopilot')).toHaveCount(0);
  await expectHudsAgree(pages);

  // 同一 token 再开一个标签页：旧页被顶替，新页接管座位
  const c2 = await p3.context.newPage();
  await c2.goto(`/r/${code}?${Q}`);
  await expect(c2.getByTestId('screen-game')).toBeVisible();
  await waitIdle(c2);
  expect(await mySeatOf(c2)).toBe(2);
  await expect(c.getByTestId('replaced-overlay')).toBeVisible({ timeout: 15_000 });
  await expect(c2.getByTestId('replaced-overlay')).toHaveCount(0);
  // 旧页选择「在这里继续」：抢回会话，新页反过来被顶替
  await c.getByTestId('replaced-reclaim').click();
  await expect(c.getByTestId('replaced-overlay')).toHaveCount(0);
  await expect(c2.getByTestId('replaced-overlay')).toBeVisible({ timeout: 15_000 });
  await waitIdle(c);
  expect(await mySeatOf(c)).toBe(2);
  await c2.close();

  // 游戏仍能继续：轮到谁就由谁走一步（P3 的回合已由电脑代打）
  await expectHudsAgree(pages);
  // 断网期间 socket.io 重连失败会打印 console.error（net::ERR_INTERNET_DISCONNECTED），与应用无关
  expectNoErrors(fourPlayers, [/ERR_INTERNET_DISCONNECTED/, /WebSocket connection/, /net::ERR_/]);
});
