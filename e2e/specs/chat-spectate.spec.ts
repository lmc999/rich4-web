// 聊天与观战（design/client.md §12.2 用例 5；architecture M5 验证 2；net.md §9）：
// - 聊天、快捷语与表情传播到全部 5 个上下文（4 名玩家 + 1 名观战者），表情在玩家条与棋盘角色头顶出现气泡；
// - 房主把观战者聊天改为「仅观战者可见」后，观战者的消息与表情只有观战者收到（观战频道隔离）；
// - 屏蔽某人后不再显示他的消息；
// - 观战者 HUD 标「观战中」，没有任何操作按钮。
import type { Locator, Page } from '@playwright/test';
import {
  createRoom,
  expect,
  expectNoErrors,
  joinRoom,
  openChat,
  pickReadyStart,
  sendChat,
  test,
} from '../fixtures/room';

const msg = (p: Page, text: string): Locator => p.getByTestId('chat-msg').filter({ hasText: text });
const emote = (p: Page, id: string): Locator => p.locator(`[data-testid="chat-emote"][data-emote="${id}"]`);

test('聊天与表情传播到 5 个上下文，观战频道隔离，观战者无操作按钮', async ({ fourPlayers, spectator }) => {
  test.setTimeout(180_000);
  const pages = fourPlayers.map((p) => p.page);
  const [a, b, c, d] = pages as [Page, Page, Page, Page];
  const w = spectator.page;
  const all = [...pages, w];
  const code = await createRoom(a, { map: 'test', timer: 'off' });
  for (const p of [b, c, d]) await joinRoom(p, code);
  await joinRoom(w, code, true);
  await expect(a.getByTestId('spectator-count')).toHaveAttribute('data-value', '1');
  // 大厅里也能聊天
  await sendChat(w, '大厅里观众打招呼');
  for (const p of all) await expect(msg(p, '大厅里观众打招呼')).toBeVisible();
  await pickReadyStart(pages, all);

  // 观战者：右上角「观战中」，没有任何操作按钮
  await expect(w.getByTestId('top-bar').getByText('观战中')).toBeVisible();
  for (const id of [
    'action-roll',
    'action-autopilot',
    'action-cards',
    'action-items',
    'action-stock',
    'menu-trustee',
  ]) {
    await expect(w.getByTestId(id)).toHaveCount(0);
  }
  await expect(w.getByTestId('decision-layer')).toHaveCount(0);
  await expect(a.getByTestId('action-roll')).toBeVisible();

  for (const p of all) await openChat(p);

  // 1) 玩家聊天 → 5 个上下文都收到
  await sendChat(a, '大家好，开局啦');
  for (const p of all) await expect(msg(p, '大家好，开局啦')).toBeVisible();

  // 2) 表情 → 5 个上下文的聊天栏出现表情行；玩家条 2P 的 DOM 气泡与棋盘上 2P 角色的 Pixi 头顶气泡
  //    （头顶气泡总线 socialStore → BoardCanvas → PlayerActor.say）都出现。气泡只显示 2 秒：先在 5 个页面
  //    同时挂上等待再发表情，并行检查，避免串行轮询在负载高时错过窗口
  const speechSeen = all.map((p) =>
    p.waitForFunction(
      () => {
        // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
        const a = (window as any).__rich4.renderer?.board.actor(1);
        return !!a && a.root.children.some((c: { label?: string }) => c.label === 'speech');
      },
      undefined,
      { polling: 50, timeout: 20_000 },
    ),
  );
  const domSeen = all.map((p) => p.getByTestId('bubble-1').waitFor({ state: 'visible', timeout: 20_000 }));
  await b.getByTestId('emote-open').click();
  await b.getByTestId('emote-laugh').click();
  await Promise.all([...speechSeen, ...domSeen]);
  await Promise.all(all.map((p) => expect(emote(p, 'laugh')).toBeVisible()));

  // 3) 快捷语
  await d.getByTestId('chat-quick-open').click();
  await d.getByTestId('chat-quick-0').click();
  for (const p of all) await expect(msg(p, '快点啦～')).toBeVisible();

  // 4) 观战者发言（默认 spectatorChat=all）：所有人可见，玩家的「观战」页签里也能看到
  await expect(w.getByTestId('chat-audience')).toHaveText('你的消息所有人可见');
  await sendChat(w, '观众路过');
  for (const p of all) await expect(msg(p, '观众路过')).toBeVisible();
  await a.getByTestId('chat-tab-spectators').click();
  await expect(msg(a, '观众路过')).toBeVisible();
  await expect(msg(a, '大家好，开局啦')).toHaveCount(0);
  await a.getByTestId('chat-tab-all').click();

  // 5) 房主改为「仅观战者可见」：观战者的消息与表情只到观战者
  await a.getByTestId('spectator-host-opts').locator('summary').click();
  await a.getByTestId('spectator-chat-mode').selectOption('spectators');
  await expect(w.getByTestId('chat-audience')).toHaveText('你的消息只有观战者可见');
  await sendChat(w, '只有观众能看到');
  await expect(msg(w, '只有观众能看到')).toBeVisible();
  await expect(msg(w, '只有观众能看到')).toHaveAttribute('data-audience', 'spectators');
  await w.getByTestId('emote-open').click();
  await w.getByTestId('emote-cool').click();
  await expect(emote(w, 'cool')).toBeVisible();
  // 之后玩家再发一条：玩家都收到这条，但收不到上面观战者的那条与表情
  await sendChat(c, '玩家的后续消息');
  for (const p of all) await expect(msg(p, '玩家的后续消息')).toBeVisible();
  for (const p of pages) {
    await expect(msg(p, '只有观众能看到')).toHaveCount(0);
    await expect(emote(p, 'cool')).toHaveCount(0);
  }

  // 6) 屏蔽：P3 屏蔽 P2，P2 的新消息 P3 看不到，P4 照常看到
  const fromB = c.locator('[data-testid="chat-emote"][data-kind="seat"]').first();
  await fromB.hover();
  await fromB.getByTestId('chat-mute').click();
  await expect(c.getByTestId('chat-muted')).toContainText('已屏蔽 1 人');
  await expect(emote(c, 'laugh')).toHaveCount(0);
  await sendChat(b, '被屏蔽的一句话');
  await expect(msg(d, '被屏蔽的一句话')).toBeVisible();
  await expect(msg(c, '被屏蔽的一句话')).toHaveCount(0);

  expectNoErrors([...fourPlayers, spectator]);
});
