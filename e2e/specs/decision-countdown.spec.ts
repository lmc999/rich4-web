// 画面正中央的决策倒计时（本人决策、有截止时间）：两种配置各跑一遍（默认配置为程序化布局，原版配置为经典布局）。
// 房间两名真人（只有一名真人、其余都是电脑的房间不限时）：P1 是被测玩家，P2 另开页面加入，只负责轮到自己时按默认应答。
// 房间计时 fast 档（TURN_MENU 15 秒、买地等确认类 7.5 秒；截止时间另含这批动画的预算），真实计时，不开 RICH4_TIMER_SCALE。
// P1 页面不带 ?audio=off（懒加载音频引擎、点击解锁），提示音从两处断言，不必真的听：
//   window.__rich4.countdown.beeps（倒计时每次请求提示音都记一条）与 window.__rich4.audio.log（引擎放出的 zzfx.countdown*）。
// 断言：倒计时始终在画面正中央（原版：640×480 舞台的中心；程序化：棋盘视口——右栏以外、顶栏以下、底栏（等待条 + 行动区）
// 以上——的中心，与镜头的有效可视区同一块；偏差不超过几像素），等掷骰、展开回合菜单、买地对话框时位置与大小都不变；
// 窗口换成 1100×800（程序化的行动区折成两行）时仍在正中，换回后回到原位；进入最后 10 秒变红并每秒一声、同一秒不重复；
// 掷骰（提交）后这一决策的倒计时立即消失、不再响；随后的买地对话框同样有倒计时与提示音，回答后消失。全程没有页面错误。
import type { Page } from '@playwright/test';
import {
  answer,
  createRoom,
  currentSeq,
  debugAct,
  expect,
  expectNoErrors,
  joinRoom,
  newPlayer,
  SKIN_ORIGINAL,
  setReady,
  startGame,
  test,
  waitDecision,
  waitMyTurn,
  waitSeqAtLeast,
} from '../fixtures/room';

/** 只提交不播放、测试钩子；不关声音 */
const Q_SOUND = 'anim=instant&test=1';
/** 中心偏差上限（CSS 像素） */
const CENTER_TOL = 3;

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

interface Placement {
  /** 倒计时（外框）中心 */
  x: number;
  y: number;
  /** 画面正中：原版为舞台中心，程序化为棋盘视口中心 */
  ex: number;
  ey: number;
  fontSize: string;
  /** 倒计时层挂在哪（程序化：body；原版：经典舞台容器） */
  host: string | null;
}

async function placement(page: Page): Promise<Placement> {
  return page.evaluate(() => {
    const cd = document.querySelector('[data-testid="decision-countdown"]');
    if (!cd) throw new Error('没有中央倒计时');
    const r = cd.getBoundingClientRect();
    const stage = document.querySelector('[data-testid="classic-stage-inner"]');
    let ex: number;
    let ey: number;
    if (stage) {
      const s = stage.getBoundingClientRect();
      ex = s.left + s.width / 2;
      ey = s.top + s.height / 2;
    } else {
      // 棋盘视口：顶栏以下、底栏（等待条 + 行动区，行动区的父元素）以上、右栏以外——与镜头的有效可视区同一块
      const top = document.querySelector('[data-testid="top-bar"]')!.getBoundingClientRect();
      const right = document.querySelector('[data-testid="screen-game"] > aside')!.getBoundingClientRect();
      const bottom = document.querySelector('[data-testid="action-pad"]')!.parentElement!.getBoundingClientRect();
      ex = right.left / 2;
      ey = (top.bottom + bottom.top) / 2;
    }
    const layer = document.querySelector('[data-testid="decision-countdown-layer"]');
    const parent = layer?.parentElement;
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      ex,
      ey,
      fontSize: getComputedStyle(cd).fontSize,
      host: parent === document.body ? 'body' : (parent?.getAttribute('data-testid') ?? null),
    };
  });
}

/** 倒计时在画面正中，且与 ref（上一次量的）位置、字号相同 */
async function expectCentered(page: Page, ref?: Placement): Promise<Placement> {
  const p = await placement(page);
  expect(Math.abs(p.x - p.ex), JSON.stringify(p)).toBeLessThanOrEqual(CENTER_TOL);
  expect(Math.abs(p.y - p.ey), JSON.stringify(p)).toBeLessThanOrEqual(CENTER_TOL);
  expect(p.host).toBe(SKIN_ORIGINAL ? 'classic-stage' : 'body');
  if (ref) {
    expect(Math.abs(p.x - ref.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(p.y - ref.y)).toBeLessThanOrEqual(1);
    expect(p.fontSize).toBe(ref.fontSize);
  }
  return p;
}

/** P2：轮到自己时按默认应答（页面内定时检查，只让对局走下去） */
async function autoAnswer(page: Page): Promise<void> {
  await page.evaluate(() => {
    setInterval(() => {
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      const h = (window as any).__rich4;
      const g = h?.store?.game?.getState();
      const d = g?.decision;
      if (h?.eventPlayer?.idle && d && g.submitting === null) void h.client.act(d.defaultIntent, d.decisionId);
    }, 250);
  });
}

test('中央决策倒计时：始终在画面正中央，最后 10 秒每秒提示音，提交后消失', async ({ browser }) => {
  test.setTimeout(150_000);
  const p1 = await newPlayer(browser, '计时', Q_SOUND);
  const p2 = await newPlayer(browser, '陪练');
  const page = p1.page;
  try {
    const code = await createRoom(page, { map: 'test', timer: 'fast', aiCount: 0 });
    await joinRoom(p2.page, code);
    await setReady(p2.page);
    await startGame(page, [page, p2.page]);
    await autoAnswer(p2.page);
    await waitMyTurn(page);
    // 先安排好这一回合：传送到 4 号格（来路 3）、强制 1 点，掷骰后落在无主的住宅 L1 → 买地
    const seat = await page.evaluate(
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      () => (window as any).__rich4.store.game.getState().decision.seat as number,
    );
    for (const op of [
      { op: 'teleport', seat, node: 4, prev: 3 },
      { op: 'forceNext', purpose: 'dice', values: [1] },
    ]) {
      const s = await currentSeq(page);
      await debugAct(page, op);
      await waitSeqAtLeast(page, s + 1);
    }
    await waitMyTurn(page);

    // ── 等掷骰：画面正中，与决策同一个 id ──
    const turnId = await myDecisionId(page);
    const cd = page.getByTestId('decision-countdown');
    await expect(cd).toBeVisible();
    await expect(cd).toHaveAttribute('data-decision', turnId);
    await expect(cd).toHaveAttribute('data-kind', 'TURN_MENU');
    await expect(cd).toHaveAttribute('data-variant', SKIN_ORIGINAL ? 'classic' : 'hud');
    await expect(cd).toHaveAttribute('role', 'timer');
    await expect(cd).not.toHaveAttribute('data-place');
    const home = await expectCentered(page);

    // ── 展开回合菜单（程序化：决策层的对话框；原版：回合菜单场景）：位置、字号不变 ──
    await page.getByTestId('action-menu').click();
    await expect(page.getByTestId('decision-TURN_MENU')).toBeVisible();
    await expectCentered(page, home);
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    await page.evaluate(() => (window as any).__rich4.store.ui.getState().openPanel(null));
    await expect(page.getByTestId('decision-TURN_MENU')).toHaveCount(0);

    // ── 窗口 1100×800（程序化：右栏 260，带文字标签的行动区放不下一行、折成两行）：仍在画面正中；换回原尺寸后回到原位 ──
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: 1100, height: 800 });
    if (!SKIN_ORIGINAL) {
      await expect
        .poll(() => page.getByTestId('action-pad').evaluate((el) => el.getBoundingClientRect().height))
        .toBeGreaterThan(90);
    }
    // 等尺寸变化后的布局与实测高度稳定下来
    const offCenter = async (): Promise<number> => {
      const p = await placement(page);
      return Math.max(Math.abs(p.x - p.ex), Math.abs(p.y - p.ey));
    };
    await expect.poll(offCenter).toBeLessThanOrEqual(CENTER_TOL);
    await expectCentered(page);
    await page.setViewportSize(size);
    await expect.poll(async () => Math.abs((await placement(page)).y - home.y)).toBeLessThanOrEqual(1);
    await expectCentered(page, home);

    // ── 最后 10 秒：变红、每秒一声（引擎也真的放了 zzfx.countdown），位置不变 ──
    await expect(cd).toHaveAttribute('data-urgent', 'true', { timeout: 30_000 });
    await expectCentered(page, home);
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

    // ── 买地：对话框在中央，倒计时照样在画面正中（压在对话框上）；确认类 7.5 秒，一出现就在最后 10 秒 ──
    await waitDecision(page, ['BUY_LAND']);
    const buyId = await myDecisionId(page);
    const cd2 = page.locator(`[data-testid="decision-countdown"][data-decision="${buyId}"]`);
    await expect(cd2).toHaveAttribute('data-urgent', 'true');
    await expect(page.getByTestId('decision-BUY_LAND')).toBeVisible();
    await expectCentered(page, home);
    await expect.poll(async () => (await beepsFor(page, buyId)).length, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
    expectBeepShape(await beepsFor(page, buyId));
    await answer(page, 'decline');
    await expect(cd2).toHaveCount(0, { timeout: 2_000 });
    const m = (await beepsFor(page, buyId)).length;
    await page.waitForTimeout(2_500);
    expect((await beepsFor(page, turnId)).length).toBe(n);
    expect((await beepsFor(page, buyId)).length).toBe(m);

    expectNoErrors([p1, p2]);
  } finally {
    await p1.context.close();
    await p2.context.close();
  }
});
