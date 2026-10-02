// 联机时（2 名真人）对手看不到别人手上的卡片与道具（shared view/project.ts；net/room.ts effectiveHandVisibility 在开局时
// 按真人座位数锁定为私密）：
// - P2 查看 P1：程序化皮肤的卡片 / 道具面板只显示张数与总数；原版皮肤的资产表没有卡片格与道具格，「卡片 / 道具」栏是总数；
// - P1 自己的回合菜单照常列出自己的卡片与道具；
// - 抓两个页面收到的全部 socket.io 帧，用 shared 的 findHandLeaks 深度扫描：别人的卡号、道具号、牌堆张数不出现。
// 两种配置都能跑：默认配置（程序化皮肤）与 e2e/playwright.original.config.ts（原版皮肤）。
// 设 E2E_SHOT_DIR（相对仓库根）时把两边的画面截图存到该目录。
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { findHandLeaks } from '../../packages/shared/src/view/handLeaks';
import {
  acted,
  createRoom,
  debugAct,
  expect,
  expectNoErrors,
  joinRoom,
  newPlayer,
  pickCharacter,
  Q,
  roomOf,
  SKIN_ORIGINAL,
  setReady,
  startGame,
  syncPages,
  test,
  waitIdle,
  waitMyTurn,
} from '../fixtures/room';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOT_DIR = process.env.E2E_SHOT_DIR ? resolve(repoRoot, process.env.E2E_SHOT_DIR) : null;
const SKIN = SKIN_ORIGINAL ? 'original' : 'procedural';

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOT_DIR) return;
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOT_DIR, `e2e-${SKIN}-${name}.png`) });
}

interface Frame {
  event: string;
  payload: unknown;
}

/** 记录页面收到的 socket.io 事件帧（42[...]；ack 帧 43 不含对局状态之外的东西，也一并扫描） */
function captureFrames(page: Page, sink: Frame[]): void {
  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => {
      const text = typeof f.payload === 'string' ? f.payload : f.payload.toString('utf8');
      const m = /^4([23])\d*(\[.*)$/s.exec(text);
      if (!m) return;
      try {
        const arr = JSON.parse(m[2]!) as unknown[];
        if (m[1] === '2') sink.push({ event: String(arr[0]), payload: arr[1] });
        else sink.push({ event: 'ack', payload: arr[0] });
      } catch {
        // 非 JSON 帧（二进制附件等）不是对局数据
      }
    });
  });
}

interface SeatSeen {
  cards: number[] | null;
  items: number[] | null;
  cardCount: number;
  itemCount: number;
  poolsNull: boolean;
}

async function seatSeen(page: Page, seat: number): Promise<SeatSeen> {
  return page.evaluate((s) => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const v = (window as any).__rich4.store.game.getState().latest;
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const p = v.players.find((x: any) => x.seat === s);
    return {
      cards: p.cards,
      items: p.items,
      cardCount: p.cardCount,
      itemCount: p.itemCount,
      poolsNull: v.pools === null,
    };
  }, seat);
}

test('联机 2 名真人：P2 的各界面看不到 P1 的卡片与道具（只有张数与总数），P1 自己看得到；两边收到的帧没有泄漏', async ({
  browser,
}) => {
  const framesA: Frame[] = [];
  const framesB: Frame[] = [];
  const a = await newPlayer(browser, 'P1', Q, { setup: async (p) => captureFrames(p, framesA) });
  const b = await newPlayer(browser, 'P2', Q, { setup: async (p) => captureFrames(p, framesB) });
  try {
    const A = a.page;
    const B = b.page;
    const code = await createRoom(A, { map: 'test', timer: 'off', aiCount: 1 });
    await joinRoom(B, code);
    await pickCharacter(A, 9);
    await pickCharacter(B, 4);
    await setReady(B);
    await startGame(A, [A, B]);
    // 服务器开局时锁定为私密（大厅里没有这个选项）
    expect((await roomOf(A))!.settings.handVisibility).toBe('private');
    const youB = (await roomOf(B))!.you;
    expect(youB.role).toBe('player');
    const seatB = youB.seat!;
    expect(seatB).not.toBe(0);

    await waitMyTurn(A);
    await acted(A, () =>
      debugAct(A, {
        op: 'give',
        seat: 0,
        cards: [13, 18, 1],
        items: [
          { item: 8, qty: 3 },
          { item: 2, qty: 1 },
        ],
      }),
    );
    await syncPages([A, B]);
    await waitMyTurn(A);

    // 数据层：P2 只拿到张数与总数，牌堆张数为 null；P1 看得到自己的
    const own = await seatSeen(A, 0);
    expect(own.cards).toEqual([13, 18, 1]);
    expect(own.items![8]).toBeGreaterThanOrEqual(3);
    const other = await seatSeen(B, 0);
    expect(other).toEqual({ cards: null, items: null, cardCount: 3, itemCount: own.itemCount, poolsNull: true });

    // P2 的界面：点 P1 的座位再查看
    await B.getByTestId('chip-0').click();
    if (SKIN_ORIGINAL) {
      await B.getByTestId('action-info').click();
      const sheet = B.getByTestId('classic-assets');
      await expect(sheet).toBeVisible();
      await expect(sheet).toHaveAttribute('data-seat', '0');
      await expect(sheet.getByTestId('assets-cards')).toHaveAttribute('data-value', '3');
      await expect(sheet.getByTestId('assets-items')).toHaveAttribute('data-value', String(own.itemCount));
      await expect(sheet.locator('[data-testid^="assets-card-"]')).toHaveCount(0);
      await expect(sheet.locator('[data-testid^="assets-item-"]')).toHaveCount(0);
      await shot(B, 'p2-views-p1-assets');
      await B.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);
    } else {
      await B.getByTestId('action-cards').click();
      await expect(B.getByTestId('panel-cards')).toBeVisible();
      await expect(B.getByTestId('inv-cards-hidden')).toContainText('3');
      await expect(B.locator('[data-testid^="inv-card-"]')).toHaveCount(0);
      await shot(B, 'p2-views-p1-cards');
      await B.keyboard.press('Escape');
      await expect(B.getByTestId('panel-cards')).toHaveCount(0);
      await B.getByTestId('action-items').click();
      await expect(B.getByTestId('panel-items')).toBeVisible();
      await expect(B.getByTestId('inv-items-hidden')).toContainText(String(own.itemCount));
      await expect(B.locator('[data-testid^="inv-item-"]')).toHaveCount(0);
      await shot(B, 'p2-views-p1-items');
      await B.keyboard.press('Escape');
      await expect(B.getByTestId('panel-items')).toHaveCount(0);
    }

    // P1 自己的回合菜单：卡片欄与道具欄照常列出
    await waitIdle(A);
    await A.getByTestId('action-cards').click();
    for (const slot of [0, 1, 2]) await expect(A.getByTestId(`inv-card-${slot}`)).toBeAttached();
    await shot(A, 'p1-own-cards');
    // 收起再从行动区打开道具欄（程序化皮肤的卡片页是盖住行动区的抽屉）
    await A.keyboard.press('Escape');
    await expect(A.locator('[data-testid^="inv-card-"]')).toHaveCount(0);
    await expect(A.locator('[data-scene][data-testid$="-exit"]')).toHaveCount(0);
    await A.getByTestId('action-items').click();
    await expect(A.getByTestId('inv-item-8')).toBeAttached();
    await expect(A.getByTestId('inv-item-2')).toBeAttached();
    await shot(A, 'p1-own-items');

    // 深度扫描两边收到的全部帧
    expect(framesB.some((f) => f.event === 'game:batch')).toBe(true);
    expect(framesB.some((f) => f.event === 'game:snapshot')).toBe(true);
    expect(framesB.flatMap((f) => findHandLeaks(f.payload, seatB).map((l) => `${f.event} ${l}`))).toEqual([]);
    expect(framesA.flatMap((f) => findHandLeaks(f.payload, 0).map((l) => `${f.event} ${l}`))).toEqual([]);
    // 对照：P1 自己的帧里确实有自己的卡（扫描不是空转）
    expect(JSON.stringify(framesA.filter((f) => f.event === 'game:batch').map((f) => f.payload))).toContain(
      '"cards":[13,18,1]',
    );
    expectNoErrors([a, b]);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});
