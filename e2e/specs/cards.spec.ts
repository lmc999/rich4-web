// 卡片与道具（M6；任务「cards」）：4 个真人，debug:act 传送、发卡发道具，全部出卡操作点回合菜单卡片 / 道具页的 DOM 按钮，
// 目标从 TargetPicker 的 DOM 候选列表里选（不点画布）：
//   第 1 轮：P2 走到 L1（5 号格）买地；其余人走到点券格。
//   第 2 轮：P1 传送到 L1 → 发 购地、陷害、拆除、均富 四张卡与 1 个路障 →
//     购地卡买下脚下 P2 的 L1 → 陷害卡把 P2 送进监狱 → 路障放到路上 → 拆除卡拆掉路障 → 均富卡平均现金 → 掷骰结束。
// 每一步之后 4 个页面追上同一个 seq，HUD（现金 / 存款 / 点券 / 地块归属）与服务器下发的 view 完全一致；
// 显示态 view（EventPlayer 折叠出的，不是服务器批尾 view）与棋盘舞台（路面物件数、角色关押外观）在 4 页面一致，
// 且舞台与显示态相符。测试图（fixture test）：4 卡片 → 5 L1 → 6 L2 → 7 L3；12 → 13（点券格）。
// 另有一个不带 ?anim=instant 的用例：放路障、陷害走完 handler、BoardStage 与弹窗的演出路径（handler 抛错计为失败）。
import type { Page } from '@playwright/test';
import {
  acted,
  createRoom,
  debugAct,
  expect,
  expectNoErrors,
  hudSnapshot,
  joinRoom,
  newPlayer,
  pickReadyStart,
  playTurn,
  Q_ANIM,
  serverSnapshot,
  startGame,
  syncPages,
  test,
  waitIdle,
  waitMyTurn,
} from '../fixtures/room';

/**
 * 对抗状态：显示态 view（HUD 同源，EventPlayer 折叠出的）里的路面物件、关押 / 住院计数、手牌数、附身神明，
 * 加上棋盘舞台上实际画出的路面物件数与各角色的关押外观（renderer.board）。
 */
async function combatState(page: Page): Promise<{
  objects: { kind: string; node: number }[];
  players: { seat: number; node: number; jail: number; hospital: number; cardCount: number; god: number | null }[];
  stage: { objects: number; confined: (string | null)[] };
}> {
  return page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const h = (window as any).__rich4;
    const v = h.store.game.getState().view;
    const board = h.renderer?.board;
    return {
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      objects: v.objects.map((o: any) => ({ kind: o.kind, node: o.node })),
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      players: v.players.map((p: any) => ({
        seat: p.seat,
        node: p.node,
        jail: p.st.jail,
        hospital: p.st.hospital,
        cardCount: p.cardCount,
        god: p.god?.kind ?? null,
      })),
      stage: {
        objects: board ? board.roads.counts().objects : -1,
        // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
        confined: v.players.map((p: any) => board?.actor(p.seat)?.currentStatus.confined?.where ?? null),
      },
    };
  });
}

/** 舞台与显示态相符：路面物件数一致，坐牢 / 住院的角色显示关押外观 */
function expectStageMatches(s: Awaited<ReturnType<typeof combatState>>): void {
  expect(s.stage.objects).toBe(s.objects.length);
  expect(s.stage.confined).toEqual(
    s.players.map((p) => (p.jail !== 0 ? 'jail' : p.hospital !== 0 ? 'hospital' : null)),
  );
}

/** 4 页面追上同一 seq；HUD 与服务器快照一致，对抗状态一致；返回参考页的快照 */
async function consistent(pages: Page[]) {
  await syncPages(pages);
  const huds = await Promise.all(pages.map((p) => hudSnapshot(p)));
  const server = await serverSnapshot(pages[0]!);
  for (const h of huds) expect(h).toEqual(server);
  const states = await Promise.all(pages.map((p) => combatState(p)));
  for (const s of states) {
    expect(s).toEqual(states[0]);
    expectStageMatches(s);
  }
  return { hud: server, state: states[0]! };
}

/** 当前回合菜单里某张卡所在的卡槽 */
async function slotOf(page: Page, card: number): Promise<number> {
  const slot = await page.evaluate((c) => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const d = (window as any).__rich4.store.game.getState().decision;
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const row = d?.kind === 'TURN_MENU' ? d.options.cards.find((r: any) => r.card === c) : null;
    return row ? (row.slot as number) : -1;
  }, card);
  expect(slot, `card ${card} not in menu`).toBeGreaterThanOrEqual(0);
  return slot;
}

/** 行动区「卡片」/「道具」→ 点卡或道具 → 在目标面板里点 pick（可选）→ 确认；等服务器重发回合菜单 */
async function use(
  page: Page,
  sheet: 'cards' | 'items',
  tile: string,
  pick?: (picker: ReturnType<Page['getByTestId']>) => Promise<void>,
): Promise<void> {
  await waitMyTurn(page);
  await page.getByTestId(`action-${sheet}`).click();
  const btn = page.getByTestId(tile);
  await expect(btn).toBeEnabled();
  await btn.click();
  const picker = page.getByTestId('target-picker');
  await expect(picker).toBeVisible();
  if (pick) await pick(picker);
  await acted(page, () => page.getByTestId('target-confirm').click());
  await waitIdle(page);
  await waitMyTurn(page);
}

test('出卡与道具：DOM 选目标，4 个页面结果一致', async ({ fourPlayers }) => {
  const pages = fourPlayers.map((p) => p.page);
  const [a, b, c, d] = pages as [Page, Page, Page, Page];
  const code = await createRoom(a, { map: 'test', timer: 'off' });
  for (const p of [b, c, d]) await joinRoom(p, code);
  await pickReadyStart(pages);

  // 第 1 轮：P2 停在 L1 买地，其余人去点券格
  await playTurn(a, 0, { node: 12, prev: 11, dice: 1 });
  await playTurn(b, 1, { node: 4, prev: 3, dice: 1, choice: 'confirm' });
  await playTurn(c, 2, { node: 12, prev: 11, dice: 1 });
  await playTurn(d, 3, { node: 12, prev: 11, dice: 1 });
  let snap = await consistent(pages);
  expect(snap.hud.lots.L1?.owner).toBe('1');

  // 第 2 轮：P1 传送到 L1（先传送再发卡：发卡会按新位置重发回合菜单）
  await waitMyTurn(a);
  await acted(a, () => debugAct(a, { op: 'teleport', seat: 0, node: 5, prev: 4 }));
  await acted(a, () => debugAct(a, { op: 'give', seat: 0, cards: [3, 17, 12, 1], items: [{ item: 2, qty: 1 }] }));
  await waitMyTurn(a);
  await syncPages(pages);

  // 购地卡：脚下 P2 的 L1 → P1
  const cash0 = Number(snap.hud.players['0']!.cash);
  await use(a, 'cards', `inv-card-${await slotOf(a, 3)}`);
  snap = await consistent(pages);
  expect(snap.hud.lots.L1?.owner).toBe('0');
  expect(Number(snap.hud.players['0']!.cash)).toBeLessThan(cash0);

  // 陷害卡：从 DOM 候选里选 P2 → 入狱
  await use(a, 'cards', `inv-card-${await slotOf(a, 17)}`, async (picker) => {
    await picker.getByTestId('target-actor-seat-1').click();
  });
  snap = await consistent(pages);
  expect(snap.state.players[1]!.jail).toBeGreaterThan(0);

  // 路障：放在候选的第一个格子
  await use(a, 'items', 'inv-item-2', async (picker) => {
    await picker.locator('[data-testid^="target-node-"]').first().click();
  });
  snap = await consistent(pages);
  expect(snap.state.objects.filter((o) => o.kind === 'roadblock')).toHaveLength(1);

  // 拆除卡：拆掉刚放的路障（候选列表里的路面物件）
  await use(a, 'cards', `inv-card-${await slotOf(a, 12)}`, async (picker) => {
    await picker.locator('[data-testid^="target-object-"]').first().click();
  });
  snap = await consistent(pages);
  expect(snap.state.objects.filter((o) => o.kind === 'roadblock')).toHaveLength(0);

  // 均富卡：没有目标，直接确认；在场玩家现金拉平（余数销毁）
  await use(a, 'cards', `inv-card-${await slotOf(a, 1)}`);
  snap = await consistent(pages);
  const cashes = Object.values(snap.hud.players).map((p) => Number(p.cash));
  expect(Math.max(...cashes) - Math.min(...cashes)).toBeLessThanOrEqual(1);
  expect(snap.state.players[0]!.cardCount).toBe(0);

  // 掷骰结束本回合
  await acted(a, () => a.getByTestId('action-roll').click());
  await waitIdle(a);
  await consistent(pages);

  expectNoErrors(fourPlayers);
});

test('演出路径（不带 anim=instant）：放路障、陷害走完 handler、舞台与弹窗，舞台与显示态一致', async ({ browser }) => {
  test.setTimeout(150_000);
  const p = await newPlayer(browser, '演出', Q_ANIM);
  const a = p.page;
  try {
    await createRoom(a, { map: 'test', timer: 'off', aiCount: 1 });
    await startGame(a, [a]);
    await waitMyTurn(a);
    // 1P 站在 L1 门前；电脑（2P）直接放到棋盘上（debug 传送会让它落地），发陷害卡与 1 个路障
    await acted(a, () => debugAct(a, { op: 'teleport', seat: 0, node: 5, prev: 4 }));
    await acted(a, () => debugAct(a, { op: 'teleport', seat: 1, node: 12, prev: 11 }));
    await acted(a, () => debugAct(a, { op: 'give', seat: 0, cards: [17], items: [{ item: 2, qty: 1 }] }));
    await waitMyTurn(a);

    // 路障：物件落下（BoardStage.dropObject）
    await use(a, 'items', 'inv-item-2', async (picker) => {
      await picker.locator('[data-testid^="target-node-"]').first().click();
    });
    let s = await combatState(a);
    expect(s.objects.filter((o) => o.kind === 'roadblock')).toHaveLength(1);
    expectStageMatches(s);

    // 陷害卡：出卡弹窗 + 光束 + 警车押走（BoardStage.escort），之后 2P 显示为关押外观
    await use(a, 'cards', `inv-card-${await slotOf(a, 17)}`, async (picker) => {
      await picker.getByTestId('target-actor-seat-1').click();
    });
    s = await combatState(a);
    expect(s.players[1]!.jail).toBeGreaterThan(0);
    expect(s.stage.confined[1]).toBe('jail');
    expectStageMatches(s);
    // 演出弹窗已收起
    await expect(a.getByTestId('popup')).toHaveCount(0);

    expectNoErrors([p]);
  } finally {
    await p.context.close();
  }
});
