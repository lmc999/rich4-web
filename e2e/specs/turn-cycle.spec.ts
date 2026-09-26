// 回合循环（design/client.md §12.2 用例 2；architecture M3 验证 3）：4 个真人，用 debug:act 传送与强制骰子，
// 完成买地、付过路费、升级；断言 4 个页面上 data-testid 标记的现金 / 存款 / 点券与地块归属完全一致，且等于服务器下发的 view。
// 测试图（fixture test）：从 4 号格（来路 3）走 1 步到 5 号格（住宅 L1）；从 10 号格（来路 9）走 1 步到 11 号格（住宅 L4）。
import type { Page } from '@playwright/test';
import {
  answer,
  createRoom,
  currentSeq,
  debugAct,
  expect,
  hudSnapshot,
  joinRoom,
  pickCharacter,
  roll,
  serverSnapshot,
  setReady,
  startGame,
  test,
  waitDecision,
  waitIdle,
  waitMyTurn,
  waitSeqAtLeast,
} from '../fixtures/room';

/** 执行一个会产生新批次的操作，并等本页收到这一批（避免跨连接的请求乱序） */
async function acted(page: Page, fn: () => Promise<unknown>): Promise<void> {
  const s0 = await currentSeq(page);
  await fn();
  await waitSeqAtLeast(page, s0 + 1);
}

/** 让 seat 从 (node, prev) 出发、强制掷出 1 点 */
async function stepFrom(page: Page, seat: number, node: number, prev: number): Promise<void> {
  await waitMyTurn(page);
  await acted(page, () => debugAct(page, { op: 'teleport', seat, node, prev }));
  await acted(page, () => debugAct(page, { op: 'forceNext', purpose: 'dice', values: [1] }));
  await waitMyTurn(page);
  await acted(page, () => roll(page));
}

/** 走完本回合：出现买地 / 升级就按 choice 回答 */
async function finishTurn(page: Page, choice: 'confirm' | 'decline', expectKind?: string): Promise<void> {
  if (expectKind) {
    await waitDecision(page, [expectKind]);
    await acted(page, () => answer(page, choice));
  }
  await waitIdle(page);
}

test('买地、过路费、升级：四个页面的 HUD 与服务器快照一致', async ({ fourPlayers }) => {
  const pages = fourPlayers.map((p) => p.page);
  const [a, b, c, d] = pages as [Page, Page, Page, Page];
  const code = await createRoom(a, { map: 'test', timer: 'off' });
  for (const p of [b, c, d]) await joinRoom(p, code);
  await pickCharacter(a, 9);
  await pickCharacter(b, 4);
  await pickCharacter(c, 0);
  await pickCharacter(d, 3);
  for (const p of [b, c, d]) await setReady(p);
  await startGame(a, pages);

  // 第 1 轮：P1 买 L1；P2 在 L1 付过路费；P3 买 L4；P4 在 L4 付过路费
  await stepFrom(a, 0, 4, 3);
  await finishTurn(a, 'confirm', 'BUY_LAND');
  await stepFrom(b, 1, 4, 3);
  await finishTurn(b, 'decline');
  await stepFrom(c, 2, 10, 9);
  await finishTurn(c, 'confirm', 'BUY_LAND');
  await stepFrom(d, 3, 10, 9);
  await finishTurn(d, 'decline');

  // 第 2 轮：P1 回到 L1 加盖
  await stepFrom(a, 0, 4, 3);
  await finishTurn(a, 'confirm', 'UPGRADE_LAND');

  // 所有页面追上同一个 seq 后比较
  const seq = await currentSeq(a);
  for (const p of pages) await waitSeqAtLeast(p, seq);
  const snaps = await Promise.all(pages.map((p) => hudSnapshot(p)));
  const server = await serverSnapshot(a);
  expect(Object.keys(snaps[0]!.players)).toHaveLength(4);
  expect(snaps[0]!.lots.L1).toEqual({ owner: '0', level: '1' });
  expect(snaps[0]!.lots.L4).toEqual({ owner: '2', level: '0' });
  for (const s of snaps) expect(s).toEqual(snaps[0]);
  expect(snaps[0]).toEqual(server);
  // 过路费确实发生：P2 与 P4 的现金低于初始值 100000（总资金 20 万，一半存款）
  expect(Number(snaps[0]!.players['1']!.cash)).toBeLessThan(100_000);
  expect(Number(snaps[0]!.players['3']!.cash)).toBeLessThan(100_000);

  for (const p of fourPlayers) {
    expect(
      p.errors.filter((e) => !e.includes('WebGL') && !e.includes('favicon')),
      p.nickname,
    ).toEqual([]);
  }
});
