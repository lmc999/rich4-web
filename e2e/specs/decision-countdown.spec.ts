// 画面中央的决策倒计时（本人决策、有截止时间）：两种配置各跑一遍（默认配置为程序化布局，原版配置为经典布局）。
// 房间计时 fast 档（TURN_MENU 15 秒、买地等确认类 7.5 秒；截止时间另含这批动画的预算），真实计时，不开 RICH4_TIMER_SCALE。
// 页面不带 ?audio=off（懒加载音频引擎、点击解锁），提示音从两处断言，不必真的听：
//   window.__rich4.countdown.beeps（倒计时每次请求提示音都记一条）与 window.__rich4.audio.log（引擎放出的 zzfx.countdown*）。
// 断言：轮到本人掷骰时中央倒计时出现（等掷骰：center）；进入最后 10 秒变红并每秒一声、同一秒不重复；掷骰（提交）后这一决策的
// 倒计时立即消失、不再响；随后的买地对话框（避让到上方：top）同样有倒计时与提示音，回答后消失。全程没有页面错误。
import type { Page } from '@playwright/test';
import {
  answer,
  createRoom,
  currentSeq,
  debugAct,
  expect,
  expectNoErrors,
  newPlayer,
  SKIN_ORIGINAL,
  startGame,
  test,
  waitDecision,
  waitMyTurn,
  waitSeqAtLeast,
} from '../fixtures/room';

/** 只提交不播放、测试钩子；不关声音 */
const Q_SOUND = 'anim=instant&test=1';

interface BeepRec {
  decisionId: string;
  secs: number;
  level: string;
  audio: boolean;
}

async function beepsFor(page: Page, id: string): Promise<BeepRec[]> {
  return page.evaluate(
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    (d) => ((window as any).__rich4?.countdown?.beeps ?? []).filter((b: BeepRec) => b.decisionId === d) as BeepRec[],
    id,
  );
}

async function countdownSfx(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    ((window as any).__rich4?.audio?.log ?? [])
      .filter((e: { kind: string; key?: string }) => e.kind === 'sfx' && e.key?.startsWith('zzfx.countdown'))
      .map((e: { op: string; key: string }) => `${e.op}:${e.key}`),
  );
}

async function myDecisionId(page: Page): Promise<string> {
  // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
  return page.evaluate(() => (window as any).__rich4.store.game.getState().decision.decisionId as string);
}

/** 这一决策的提示音：只在最后 10 秒，每个整秒最多一次，秒数递减 */
function expectBeepShape(beeps: BeepRec[]): void {
  const secs = beeps.map((b) => b.secs);
  expect(secs.length).toBeGreaterThan(0);
  for (const s of secs) expect(s).toBeLessThanOrEqual(10);
  expect(new Set(secs).size).toBe(secs.length);
  expect([...secs].sort((a, b) => b - a)).toEqual(secs);
  for (const b of beeps) expect(b.level).toBe(b.secs <= 3 ? 'final' : 'tick');
}

test('中央决策倒计时：等掷骰时出现，最后 10 秒每秒提示音，提交后消失；决策框在中央时避让', async ({ browser }) => {
  test.setTimeout(150_000);
  const p = await newPlayer(browser, '计时', Q_SOUND);
  const page = p.page;
  try {
    await createRoom(page, { map: 'test', timer: 'fast', aiCount: 1 });
    await startGame(page, [page]);
    await waitMyTurn(page);
    // 先安排好这一回合：传送到 4 号格（来路 3）、强制 1 点，掷骰后落在无主的住宅 L1 → 买地
    for (const op of [
      { op: 'teleport', seat: 0, node: 4, prev: 3 },
      { op: 'forceNext', purpose: 'dice', values: [1] },
    ]) {
      const s = await currentSeq(page);
      await debugAct(page, op);
      await waitSeqAtLeast(page, s + 1);
    }
    await waitMyTurn(page);

    // ── 等掷骰：画面中央（center），与决策同一个 id ──
    const turnId = await myDecisionId(page);
    const cd = page.getByTestId('decision-countdown');
    await expect(cd).toBeVisible();
    await expect(cd).toHaveAttribute('data-decision', turnId);
    await expect(cd).toHaveAttribute('data-kind', 'TURN_MENU');
    await expect(cd).toHaveAttribute('data-variant', SKIN_ORIGINAL ? 'classic' : 'hud');
    await expect(cd).toHaveAttribute('data-place', 'center');
    await expect(cd).toHaveAttribute('role', 'timer');
    if (SKIN_ORIGINAL) {
      // 经典布局：经 portal 挂在舞台容器上（在原版场景之上）
      const parent = await page
        .getByTestId('decision-countdown-layer')
        .evaluate((el) => el.parentElement?.getAttribute('data-testid') ?? null);
      expect(parent).toBe('classic-stage');
    }

    // ── 最后 10 秒：变红、每秒一声（引擎也真的放了 zzfx.countdown） ──
    await expect(cd).toHaveAttribute('data-urgent', 'true', { timeout: 30_000 });
    await expect.poll(async () => (await beepsFor(page, turnId)).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    expectBeepShape(await beepsFor(page, turnId));
    expect((await beepsFor(page, turnId)).every((b) => b.audio)).toBe(true);
    await expect
      .poll(async () => (await countdownSfx(page)).some((x) => /^(play|late):zzfx\.countdown$/.test(x)), {
        timeout: 10_000,
      })
      .toBe(true);
    await expect(page.getByTestId('decision-countdown-live')).not.toHaveText('');

    // ── 掷骰（提交）：这一决策的倒计时立即消失，之后不再响 ──
    const s0 = await currentSeq(page);
    await page.getByTestId('action-roll').click();
    await expect(page.locator(`[data-testid="decision-countdown"][data-decision="${turnId}"]`)).toHaveCount(0, {
      timeout: 2_000,
    });
    const n = (await beepsFor(page, turnId)).length;
    await waitSeqAtLeast(page, s0 + 1);

    // ── 买地：对话框在中央，倒计时避让到上方（top）；确认类 7.5 秒，一出现就在最后 10 秒 ──
    await waitDecision(page, ['BUY_LAND']);
    const buyId = await myDecisionId(page);
    const cd2 = page.locator(`[data-testid="decision-countdown"][data-decision="${buyId}"]`);
    await expect(cd2).toHaveAttribute('data-place', 'top');
    await expect(cd2).toHaveAttribute('data-urgent', 'true');
    await expect.poll(async () => (await beepsFor(page, buyId)).length, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
    expectBeepShape(await beepsFor(page, buyId));
    await answer(page, 'decline');
    await expect(cd2).toHaveCount(0, { timeout: 2_000 });
    const m = (await beepsFor(page, buyId)).length;
    await page.waitForTimeout(2_500);
    expect((await beepsFor(page, turnId)).length).toBe(n);
    expect((await beepsFor(page, buyId)).length).toBe(m);

    expectNoErrors([p]);
  } finally {
    await p.context.close();
  }
});
