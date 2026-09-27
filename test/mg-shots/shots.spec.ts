// 调试用：让 P1 依次进入三个小游戏，在游玩中截图（桌面 1280×800 与手机横屏 844×390）。
import type { Page } from '@playwright/test';
import {
  createRoom,
  currentSeq,
  debugAct,
  expect,
  joinRoom,
  newPlayer,
  pickCharacter,
  roll,
  setReady,
  startGame,
  test,
  waitDecision,
  waitIdle,
  waitMyTurn,
  waitSeqAtLeast,
} from '../../e2e/fixtures/room';

test.setTimeout(300_000);
const OUT = process.env.MG_SHOTS_DIR ?? '/tmp/mg-shots';

async function acted(page: Page, fn: () => Promise<unknown>): Promise<void> {
  const s0 = await currentSeq(page);
  await fn();
  await waitSeqAtLeast(page, s0 + 1);
}
async function stepFrom(page: Page, seat: number, node: number, prev: number): Promise<void> {
  await waitMyTurn(page);
  await acted(page, () => debugAct(page, { op: 'teleport', seat, node, prev }));
  await acted(page, () => debugAct(page, { op: 'forceNext', purpose: 'dice', values: [1] }));
  await waitMyTurn(page);
  await acted(page, () => roll(page));
}
// biome-ignore lint/suspicious/noExplicitAny: 调试
const st = (p: Page) => p.evaluate(() => (window as any).__rich4.minigame?.state() ?? null);

test('shots', async ({ browser }) => {
  const a0 = await newPlayer(browser, 'P1');
  const b0 = await newPlayer(browser, 'P2');
  const a = a0.page;
  const b = b0.page;
  const mobile = process.env.MG_MOBILE === '1';
  if (mobile) await a.setViewportSize({ width: 844, height: 390 });
  const code = await createRoom(a, { map: 'test', timer: 'off' });
  await joinRoom(b, code);
  await pickCharacter(a, 2);
  await pickCharacter(b, 5);
  await setReady(b);
  await startGame(a, [a, b]);
  const tag = mobile ? 'm' : 'd';
  const games: [string, number, number][] = [
    ['penguin', 15, 14],
    ['balloon', 20, 13],
    ['xicong', 19, 4],
  ];
  for (const [id, node, prev] of games) {
    await stepFrom(a, 0, node, prev);
    await waitDecision(a, ['MINIGAME']);
    await a.screenshot({ path: `${OUT}/${tag}-${id}-0-intro.png` });
    await expect(a.getByTestId('minigame-host')).toBeVisible({ timeout: 15_000 });
    await a.waitForTimeout(800);
    await a.screenshot({ path: `${OUT}/${tag}-${id}-1-countdown.png` });
    await expect.poll(async () => (await st(a))?.phase, { timeout: 15_000 }).toBe('playing');
    await a.waitForTimeout(id === 'penguin' ? 300 : 2500);
    await a.screenshot({ path: `${OUT}/${tag}-${id}-2-play.png` });
    // 随便操作一下
    for (let i = 0; i < 12; i++) {
      await a.evaluate((gid) => {
        // biome-ignore lint/suspicious/noExplicitAny: 调试
        const h = (window as any).__rich4.minigame;
        const s = h.state()?.state;
        if (!s) return;
        if (gid === 'penguin') h.pick([47, 38, 29, 48][Math.floor(Math.random() * 4)]);
        if (gid === 'balloon')
          for (let k = 0; k < 16; k++)
            if (s.x[k] && s.y[k] < 400) {
              h.click(s.x[k], s.y[k]);
              break;
            }
        if (gid === 'xicong') {
          let best = -1;
          for (let k = 0; k < 16; k++) if (s.ix[k] && s.ikind[k] !== 4 && (best < 0 || s.iy[k] > s.iy[best])) best = k;
          h.cursor(best >= 0 ? s.ix[best] : 320);
        }
      }, id);
      await a.waitForTimeout(400);
    }
    await a.screenshot({ path: `${OUT}/${tag}-${id}-3-play.png` });
    await expect(a.getByTestId('minigame-result')).toBeVisible({ timeout: 60_000 });
    await a.screenshot({ path: `${OUT}/${tag}-${id}-4-result.png` });
    await expect(a.getByTestId('minigame-host')).toHaveCount(0, { timeout: 10_000 });
    await waitIdle(a);
    await stepFrom(b, 1, 12, 11);
    await waitIdle(b);
  }
  await a0.context.close();
  await b0.context.close();
});
