// 超时代决（design/client.md §12.2 用例 3；DEV-09）：P2 不操作，截止后服务器执行 defaultIntent，
// 所有页面弹 toast「…超时，已由电脑代为决定」，游戏继续（又轮回 P1）。
// 这里用 fast 档的真实时限（TURN_MENU 15 秒 + 0.8 秒宽限）。服务器支持 RICH4_TIMER_SCALE（测试模式）缩放计时，但 E2E 不开：
// P1 的回合要先做几次 debug:act 再掷骰，缩短后 P1 自己也可能超时，用例就不稳定了。
import type { Page } from '@playwright/test';
import {
  answer,
  createRoom,
  currentSeq,
  debugAct,
  decisionKind,
  expect,
  joinRoom,
  roll,
  setReady,
  startGame,
  test,
  waitIdle,
  waitMyTurn,
  waitSeqAtLeast,
  zh,
} from '../fixtures/room';

/** 传送到 4 号格（来路 3）、强制 1 点：落在住宅 L1，拒绝购买（与随机开局位置无关） */
async function playTurn(page: Page, seat: number): Promise<void> {
  await waitMyTurn(page);
  for (const op of [
    { op: 'teleport', seat, node: 4, prev: 3 },
    { op: 'forceNext', purpose: 'dice', values: [1] },
  ]) {
    const s = await currentSeq(page);
    await debugAct(page, op);
    await waitSeqAtLeast(page, s + 1);
  }
  await waitMyTurn(page);
  const s0 = await currentSeq(page);
  await roll(page);
  await waitSeqAtLeast(page, s0 + 1);
  await waitIdle(page);
  const k = await decisionKind(page);
  if (k && k !== 'TURN_MENU') await answer(page, 'decline');
}

test('P2 不操作：超时后电脑代为决定，游戏继续', async ({ fourPlayers }) => {
  test.setTimeout(150_000);
  const [p1, p2] = fourPlayers;
  const a = p1!.page;
  const b = p2!.page;
  const code = await createRoom(a, { map: 'test', timer: 'fast', aiCount: 0 });
  await joinRoom(b, code);
  // 3、4 号座位补电脑
  await a.getByTestId('seat-2-add-ai').click();
  await a.getByTestId('seat-3-add-ai').click();
  await expect(a.getByTestId('seat-3')).toHaveAttribute('data-kind', 'ai');
  await setReady(b);
  await startGame(a, [a, b]);

  await playTurn(a, 0);
  // 轮到 P2：按钮可用，但 P2 什么都不做
  await waitMyTurn(b);
  await expect(b.getByTestId('waiting-banner')).toHaveCount(0);
  await expect(a.getByTestId('waiting-banner')).toHaveAttribute('data-seat', '1');
  // 15 秒截止 + 0.8 秒宽限后服务器代决
  const toast = zh('2P 超时，已由电脑代为决定', '2P 超時，已由電腦代為決定');
  await expect(b.getByTestId('toast').filter({ hasText: toast })).toBeVisible({ timeout: 30_000 });
  await expect(a.getByTestId('toast').filter({ hasText: toast })).toBeVisible({ timeout: 5_000 });
  // 游戏继续：两个电脑走完后又轮到 P1
  await waitMyTurn(a, 60_000);
  for (const p of [p1!, p2!]) {
    expect(
      p.errors.filter((e) => !e.includes('WebGL') && !e.includes('favicon')),
      p.nickname,
    ).toEqual([]);
  }
});
