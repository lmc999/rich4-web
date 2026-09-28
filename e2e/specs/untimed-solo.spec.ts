// 只有一名真人时不限时（design/net.md §5.4 有效计时档位；和单机 /solo 一样）：
// - 一名真人 + 3 个电脑、房间档位 fast：大厅计时设置下的说明换成「现在只有一名真人：开局后不计时」并高亮；开局后本人决策没有截止时间、
//   画面中央没有倒计时（原版侧栏显示「不限時」），过了 fast 档回合菜单的时限（15 秒 + 0.8 秒宽限）也不会超时代决；
// - 两名真人 + 2 个电脑：照常有中央倒计时；P2 对局中离开（只剩一名真人）后 P1 的截止时间被取消、倒计时消失。
import type { Page } from '@playwright/test';
import {
  createRoom,
  expect,
  expectNoErrors,
  joinRoom,
  pickCharacter,
  SKIN_ORIGINAL,
  setReady,
  startGame,
  test,
  waitMyTurn,
} from '../fixtures/room';

interface TimerState {
  preset: string | null;
  effective: string | null;
  decisionId: string | null;
  deadlineAt: number | null;
  seq: number;
}

async function timerState(page: Page): Promise<TimerState> {
  return page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const h = (window as any).__rich4;
    const room = h.store.room.getState().room;
    const g = h.store.game.getState();
    return {
      preset: room?.settings.timerPreset ?? null,
      effective: room?.effectiveTimerPreset ?? null,
      decisionId: g.decision?.decisionId ?? null,
      deadlineAt: g.decision?.deadlineAt ?? null,
      seq: g.seq,
    };
  });
}

/** 大厅里计时设置下的说明（程序化：房间设置只读列表；原版：左栏设置行） */
function lobbyHint(page: Page) {
  return page.locator('[data-testid="room-timer-hint"], [data-testid="set-timer-hint"]').first();
}

/** 本人决策「不限时」的显示：没有中央倒计时；原版侧栏写「不限時」 */
async function expectUntimed(page: Page): Promise<void> {
  await expect(page.getByTestId('decision-countdown')).toHaveCount(0);
  if (SKIN_ORIGINAL) await expect(page.getByTestId('classic-my-countdown')).toContainText('不限時');
}

test('一名真人 + 3 个电脑：不限时，没有倒计时，过了时限也不会超时', async ({ fourPlayers }) => {
  test.setTimeout(120_000);
  const p1 = fourPlayers[0]!;
  const a = p1.page;
  await createRoom(a, { map: 'test', timer: 'fast', aiCount: 3 });
  // 此刻就适用：文字本身换成「现在只有一名真人：开局后不计时」（不只靠颜色），并高亮
  await expect(lobbyHint(a)).toHaveText(
    SKIN_ORIGINAL ? '現在只有一名真人：開局後不計時' : '现在只有一名真人：开局后不计时',
  );
  await expect(lobbyHint(a)).toHaveAttribute('data-active', 'true');
  await pickCharacter(a, 0);
  await startGame(a, [a]);
  await waitMyTurn(a);
  const st = await timerState(a);
  expect(st).toMatchObject({ preset: 'fast', effective: 'off', deadlineAt: null });
  await expectUntimed(a);
  // fast 档回合菜单 15 秒 + 网络宽限 0.8 秒：计时的话早已超时代决（掷骰）
  await a.waitForTimeout(17_000);
  expect(await timerState(a)).toMatchObject({ decisionId: st.decisionId, seq: st.seq, deadlineAt: null });
  await expectUntimed(a);
  await expect(a.getByTestId('action-roll')).toBeEnabled();
  expectNoErrors([p1]);
});

test('两名真人：照常倒计时；P2 离开只剩一名真人后，P1 的倒计时取消', async ({ fourPlayers }) => {
  test.setTimeout(120_000);
  const [p1, p2] = fourPlayers;
  const a = p1!.page;
  const b = p2!.page;
  const code = await createRoom(a, { map: 'test', timer: 'normal', aiCount: 2 });
  await joinRoom(b, code);
  await expect(lobbyHint(a)).toHaveAttribute('data-active', 'false');
  await pickCharacter(a, 0);
  await pickCharacter(b, 9);
  await setReady(b);
  await startGame(a, [a, b]);
  await waitMyTurn(a);
  const st = await timerState(a);
  expect(st).toMatchObject({ preset: 'normal', effective: 'normal' });
  expect(st.deadlineAt).not.toBeNull();
  await expect(a.getByTestId('decision-countdown')).toBeVisible();

  // P2 对局中离开（座位转 autopilot:left，由电脑接管）
  // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
  await b.evaluate(() => (window as any).__rich4.client.leaveRoom());
  await expect.poll(async () => (await timerState(a)).effective, { timeout: 10_000 }).toBe('off');
  expect(await timerState(a)).toMatchObject({ decisionId: st.decisionId, deadlineAt: null });
  await expectUntimed(a);
  await expect(a.getByTestId('action-roll')).toBeEnabled();
  expectNoErrors([p1!]);
});
