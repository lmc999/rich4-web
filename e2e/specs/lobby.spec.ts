// 大厅（design/client.md §12.2 用例 1）：建房、邀请链接加入、角色互斥、准备、开始；
// 满员后第 5 人自动成为观战者；房主踢人（被踢者回到首页并看到提示）。
import { E2E_PASSCODE } from '../fixtures/access';
import { createRoom, expect, joinRoom, pickCharacter, setReady, startGame, test, zh } from '../fixtures/room';

test('建房、加入、角色互斥、准备、满员转观战、踢人、开始', async ({ fourPlayers, spectator }) => {
  const [p1, p2, p3, p4] = fourPlayers;
  const code = await createRoom(p1!.page, { map: 'test', timer: 'off' });
  await expect(p1!.page.getByTestId('room-code')).toHaveText(code);
  // 门禁开启（RICH4_E2E_PASSCODE）时邀请框是带授权片段的链接（#g=<token>），否则是普通链接
  const grant = E2E_PASSCODE ? '#g=[A-Za-z0-9_-]{43}' : '';
  await expect(p1!.page.getByTestId('invite-url')).toHaveValue(new RegExp(`/r/${code}${grant}$`));

  await joinRoom(p2!.page, code);
  await joinRoom(p3!.page, code);
  await joinRoom(p4!.page, code);
  // 每个页面都看到 4 个真人座位
  for (const p of fourPlayers) {
    for (let s = 0; s < 4; s++) await expect(p.page.getByTestId(`seat-${s}`)).toHaveAttribute('data-kind', 'human');
    await expect(p.page.getByTestId('seat-1-name')).toHaveText('P2');
  }

  // 角色互斥：P2 选了孙小美（9），P3 看到它被占用、不能选
  await pickCharacter(p2!.page, 9);
  await expect(p3!.page.getByTestId('char-9')).toHaveAttribute('data-taken', 'true');
  await expect(p3!.page.getByTestId('char-9')).toHaveAttribute('aria-disabled', 'true');
  // 轮播翻到孙小美（0 号起向后 9 步）：「选这个」按钮禁用并提示被 2P 选走
  for (let i = 0; i < 9; i++) await p3!.page.getByTestId('char-next').click();
  await expect(p3!.page.getByTestId('char-preview-name')).toHaveText(zh('孙小美', '孫小美'));
  await expect(p3!.page.getByTestId('char-select')).toBeDisabled();
  await expect(p3!.page.getByTestId('char-select')).toHaveText(zh('已被 2P 选走', '已被 2P 選走'));
  await pickCharacter(p3!.page, 4);
  await pickCharacter(p1!.page, 0);

  // 满员后第 5 人以玩家身份进入 → 自动成为观战者
  await spectator.page.goto(`/r/${code}?anim=instant&audio=off`);
  await expect(spectator.page.getByTestId('screen-room')).toBeVisible();
  await expect(spectator.page.getByText(zh('👁 观战中', '👁 觀戰中')).first()).toBeVisible();
  await expect(p1!.page.getByTestId('spectator-list')).toContainText('观众');

  // 房主开始按钮：有人没准备时禁用
  await expect(p1!.page.getByTestId('room-start')).toBeDisabled();
  await setReady(p2!.page);
  await setReady(p3!.page);

  // 房主踢掉 P4：P4 回到首页并看到提示；空位补电脑
  await p1!.page.getByTestId('seat-3-kick').click();
  await expect(p4!.page.getByTestId('screen-home')).toBeVisible();
  await expect(p4!.page.getByTestId('home-closed-note')).toContainText(zh('请出', '請出'));
  await expect(p1!.page.getByTestId('seat-3')).toHaveAttribute('data-kind', 'empty');
  await p1!.page.getByTestId('seat-3-add-ai').click();
  await expect(p1!.page.getByTestId('seat-3')).toHaveAttribute('data-kind', 'ai');

  await startGame(p1!.page, [p1!.page, p2!.page, p3!.page, spectator.page]);
  // 观战者没有掷骰按钮
  await expect(spectator.page.getByTestId('action-roll')).toHaveCount(0);
  await expect(p2!.page.getByTestId('action-roll')).toBeVisible();

  for (const p of [...fourPlayers, spectator]) {
    expect(
      p.errors.filter((e) => !e.includes('WebGL') && !e.includes('favicon')),
      p.nickname,
    ).toEqual([]);
  }
});
