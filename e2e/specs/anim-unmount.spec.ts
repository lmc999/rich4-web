// 演出路径（不带 ?anim=instant；E2E 其余用例都是 instant）：角色行走时浏览器后退（棋盘卸载）再前进（重新挂载）。
// 断言：没有页面异常与 console.error（含 ?test=1 打开的批尾对账）、没有演出看门狗中止、rAF 驱动一直在跑、
// 被打断的那一批立即结算（决策马上出现，而不是等 20 秒看门狗），回到对局后能正常答完决策并继续。
// 测试图（fixture test）：从 2 号格（来路 1）强制 3 点走到 5 号格（住宅 L1），出现 BUY_LAND。
import type { Page } from '@playwright/test';
import {
  createRoom,
  currentSeq,
  debugAct,
  expect,
  newPlayer,
  Q_ANIM,
  startGame,
  test,
  waitMyTurn,
  waitSeqAtLeast,
} from '../fixtures/room';

async function rafId(page: Page): Promise<number> {
  // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
  return page.evaluate(() => (window as any).__rich4.client.rafId as number);
}

/** rAF 链还活着：短时间内 rafId 继续增长 */
async function expectRafAlive(page: Page): Promise<void> {
  const a = await rafId(page);
  await expect.poll(() => rafId(page), { timeout: 3000 }).toBeGreaterThan(a + 3);
}

test('行走中后退再前进：没有异常，rAF 不断，被打断的演出立即结算', async ({ browser }) => {
  test.setTimeout(120_000);
  const p = await newPlayer(browser, '演出', Q_ANIM);
  const page = p.page;
  try {
    await createRoom(page, { map: 'test', timer: 'off', aiCount: 1 });
    await startGame(page, [page]);
    await waitMyTurn(page);
    for (const op of [
      { op: 'teleport', seat: 0, node: 2, prev: 1 },
      { op: 'forceNext', purpose: 'dice', values: [3] },
    ]) {
      const s = await currentSeq(page);
      await debugAct(page, op);
      await waitSeqAtLeast(page, s + 1);
    }
    await waitMyTurn(page);
    await page.getByTestId('action-roll').click();
    // 骰子落定、角色开始行走
    await page.waitForFunction(
      () =>
        // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
        (window as any).__rich4.renderer?.board.allActors().some((a: { isWalking: boolean }) => a.isWalking) === true,
      undefined,
      { timeout: 20_000 },
    );

    // 后退：房间页（棋盘）卸载
    await page.goBack();
    await expect(page.getByTestId('screen-home')).toBeVisible();
    await expectRafAlive(page);
    // 被打断的那一批立即结算：BUY_LAND 马上进 store（旧实现要等 20 秒看门狗）
    await page.waitForFunction(
      () => {
        // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
        const h = (window as any).__rich4;
        return h.eventPlayer.idle && h.store.game.getState().decision?.kind === 'BUY_LAND';
      },
      undefined,
      { timeout: 5000 },
    );

    // 前进：棋盘重新挂载，决策框出现，照常答完并继续到下一次轮到我
    await page.goForward();
    await expect(page.getByTestId('screen-game')).toBeVisible();
    await expectRafAlive(page);
    await page.getByTestId('buy-decline').click();
    await waitMyTurn(page, 90_000);
    await expectRafAlive(page);
    expect(p.errors.filter((e) => !e.includes('WebGL') && !e.includes('favicon'))).toEqual([]);
  } finally {
    await p.context.close();
  }
});
