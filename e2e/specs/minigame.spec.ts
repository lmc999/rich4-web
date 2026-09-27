// 三个原版小游戏（architecture M8 验证 4；design/minigames-ai.md §6–§7）：2 个真人 + 1 名观战者，测试图 'test'。
// debug:act 传送并强制骰子，让 P1 依次停在 16 号（企鹅挖宝）、19 号（七彩气球）、20 号（喜从天降）；
// 倒计时后进入宿主，经测试钩子 window.__rich4.minigame 注入输入（与指针输入同一条 sink 路径：tick 归属、上传、提交）。
// 断言：服务器结算的点券（MINIGAME_ENDED、view 的点券差）= 客户端结算画面显示的分数 = 本地重放分数；
// 观战者收到观战票据（含种子、role=spectator）与本局的输入帧；各页面 HUD 的点券与服务器快照一致。
// 路线（fixture test）：15 → 16；20 → 19（来路 13）；19 → 20（来路 4）；P2 每回合 12 → 13（得 30 点）。
import type { Page } from '@playwright/test';
import {
  createRoom,
  currentSeq,
  debugAct,
  expect,
  hudSnapshot,
  joinRoom,
  newPlayer,
  type Player,
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

test.setTimeout(300_000);

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

interface Recv {
  watch: {
    ticket: { sessionId: string; seed: number; role: string; minigameId: string; seat: number };
    mode: string;
  }[];
  frames: { sessionId: string; seq: number; n: number }[];
  ended: { seat: number; mode: string; score: number }[];
}

/** 在页面上挂接收器：观战票据、输入帧、批次里的 MINIGAME_ENDED */
async function listen(page: Page): Promise<void> {
  await page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const w = window as any;
    const rec = { watch: [], frames: [], ended: [] } as Recv;
    w.__mgRecv = rec;
    const t = w.__rich4.client.transport;
    t.on('game:minigameWatch', (m: Recv['watch'][number]) => rec.watch.push(m));
    t.on('game:minigameFrames', (f: { sessionId: string; seq: number; events: unknown[] }) =>
      rec.frames.push({ sessionId: f.sessionId, seq: f.seq, n: f.events.length }),
    );
    t.on('game:batch', (b: { events: { type: string; seat: number; mode: string; score: number }[] }) => {
      for (const e of b.events)
        if (e.type === 'MINIGAME_ENDED') rec.ended.push({ seat: e.seat, mode: e.mode, score: e.score });
    });
  });
}

async function recv(page: Page): Promise<Recv> {
  // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
  return page.evaluate(() => (window as any).__mgRecv as Recv);
}

/** 宿主的 debugState()；state 是 sim 状态的 JSON（按游戏读取需要的字段） */
interface MgState {
  phase: string;
  sessionId: string;
  minigameId: string;
  tick: number;
  over: boolean;
  localScore: number;
  finalScore: number | null;
  // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
  state: any;
}

async function mgState(page: Page): Promise<MgState | null> {
  // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
  return page.evaluate(() => ((window as any).__rich4.minigame?.state() ?? null) as MgState | null);
}

async function pointsOf(page: Page, seat: number): Promise<number> {
  return page.evaluate(
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    (s) => (window as any).__rich4.store.game.getState().latest.players.find((p: any) => p.seat === s).points as number,
    seat,
  );
}

/** 等宿主进入游玩阶段 */
async function waitPlaying(page: Page, id: string): Promise<MgState> {
  await expect(page.getByTestId('decision-MINIGAME')).toBeVisible();
  await expect(page.locator(`[data-testid="minigame-host"][data-minigame="${id}"]`)).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await mgState(page))?.phase, { timeout: 15_000 }).toBe('playing');
  return (await mgState(page))!;
}

/** 企鹅：先挖离企鹅最近的宝物，再挖最近的炸弹（挖到即结束） */
async function playPenguin(page: Page): Promise<void> {
  const nearest = (st: MgState['state'], want: (k: number) => boolean): number => {
    const rc = (c: number) => [Math.floor(c / 9), c % 9];
    const [r0, c0] = rc(st.cell);
    let best = -1;
    let bestD = 1e9;
    for (let c = 0; c < 81; c++) {
      if (!want(st.board[c]) || c === st.cell) continue;
      const [r, cc] = rc(c);
      const d = Math.max(Math.abs(r - r0!), Math.abs(cc - c0!));
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  };
  // 记忆阶段结束（play）且可以操作
  const accept = async () =>
    expect
      .poll(
        async () => {
          const s = await mgState(page);
          return s !== null && s.state.phase === 'play' && s.state.walk === null && s.state.digLeft === 0;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  await accept();
  let s = (await mgState(page))!;
  const treasure = nearest(s.state, (k) => k >= 2);
  // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
  await page.evaluate((c) => (window as any).__rich4.minigame.pick(c), treasure);
  await expect.poll(async () => (await mgState(page))!.state.dug[treasure], { timeout: 20_000 }).toBe(1);
  await accept();
  s = (await mgState(page))!;
  const bombCell = nearest(s.state, (k) => k === 1);
  // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
  await page.evaluate((c) => (window as any).__rich4.minigame.pick(c), bombCell);
}

/** 气球：每 250ms 瞄准一个正在上升的气球的中心开枪 */
async function playBalloon(page: Page): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const s = await mgState(page);
    if (!s || s.over || s.phase === 'result') return;
    await page.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      const h = (window as any).__rich4.minigame;
      const st = h.state()?.state;
      if (!st) return;
      for (let k = 0; k < 16; k++) {
        if (st.x[k] !== 0 && st.pop[k] === 0 && st.y[k] > 60 && st.y[k] < 420 && st.kind[k] !== 10) {
          h.click(st.x[k], Math.max(0, st.y[k] - 8));
          return;
        }
      }
    });
    await page.waitForTimeout(250);
  }
}

/** 喜从天降：光标追最近的非炸弹掉落物 */
async function playXicong(page: Page): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const s = await mgState(page);
    if (!s || s.over || s.phase === 'result') return;
    await page.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      const h = (window as any).__rich4.minigame;
      const st = h.state()?.state;
      if (!st) return;
      let best = -1;
      for (let k = 0; k < 16; k++) {
        if (st.ix[k] === 0 || st.ikind[k] === 4) continue;
        if (best < 0 || st.iy[k] > st.iy[best]) best = k;
      }
      h.cursor(best >= 0 ? st.ix[best] : 320);
    });
    await page.waitForTimeout(150);
  }
}

/** 一局小游戏：玩、等本地结束与服务器结算，比对分数；返回服务器分数 */
async function oneGame(
  a: Page,
  spec: Page,
  id: 'penguin' | 'balloon' | 'xicong',
  play: (p: Page) => Promise<void>,
): Promise<{ score: number; sessionId: string }> {
  await waitDecision(a, ['MINIGAME']);
  const before = await pointsOf(a, 0);
  const endedBefore = (await recv(a)).ended.length;
  const st = await waitPlaying(a, id);
  // 观战者（对局页进入时已安装小游戏会话）：live 观战遮罩弹出，跟着输入帧播放
  await expect(spec.locator(`[data-testid="minigame-host"][data-mode="spectate"][data-minigame="${id}"]`)).toBeVisible({
    timeout: 15_000,
  });
  await play(a);
  // 本地结束 → 提交 → 结算画面显示服务器分数
  await expect(a.getByTestId('minigame-final-score')).toHaveAttribute('data-final', 'true', { timeout: 60_000 });
  const shown = Number(await a.getByTestId('minigame-final-score').getAttribute('data-value'));
  const local = (await mgState(a))?.localScore;
  await expect.poll(async () => (await recv(a)).ended.length, { timeout: 15_000 }).toBeGreaterThan(endedBefore);
  const ended = (await recv(a)).ended.at(-1)!;
  expect(ended).toEqual({ seat: 0, mode: 'played', score: shown });
  if (local !== undefined) expect(local).toBe(shown);
  // 2 秒后回棋盘
  await expect(a.getByTestId('minigame-host')).toHaveCount(0, { timeout: 10_000 });
  await waitIdle(a);
  expect(await pointsOf(a, 0)).toBe(Math.min(65535, before + shown));
  // 观战者：本局的观战票据与输入帧
  const r = await recv(spec);
  const w = r.watch.find((x) => x.ticket.sessionId === st.sessionId);
  expect(w, 'spectator watch ticket').toBeDefined();
  expect(w!.mode).toBe('live');
  expect(w!.ticket).toMatchObject({ role: 'spectator', minigameId: id, seat: 0 });
  expect(typeof w!.ticket.seed).toBe('number');
  const frames = r.frames.filter((f) => f.sessionId === st.sessionId);
  expect(frames.length).toBeGreaterThanOrEqual(2);
  expect(frames[0]!.seq).toBe(0);
  expect(frames.reduce((n, f) => n + f.n, 0)).toBeGreaterThan(0);
  return { score: shown, sessionId: st.sessionId };
}

test('企鹅挖宝、七彩气球、喜从天降：服务器结算与客户端显示一致，观战者收到输入帧', async ({ browser }) => {
  const players: Player[] = [await newPlayer(browser, 'P1'), await newPlayer(browser, 'P2')];
  const watcher = await newPlayer(browser, '观众');
  const [a, b] = players.map((p) => p.page) as [Page, Page];
  const w = watcher.page;
  try {
    const code = await createRoom(a, { map: 'test', timer: 'off' });
    await joinRoom(b, code);
    await joinRoom(w, code, true);
    await pickCharacter(a, 2);
    await pickCharacter(b, 5);
    await setReady(b);
    await startGame(a, [a, b, w]);
    for (const p of [a, b, w]) await listen(p);

    // 企鹅挖宝
    await stepFrom(a, 0, 15, 14);
    const g1 = await oneGame(a, w, 'penguin', playPenguin);
    await stepFrom(b, 1, 12, 11);
    await waitIdle(b);

    // 七彩气球
    await stepFrom(a, 0, 20, 13);
    const g2 = await oneGame(a, w, 'balloon', playBalloon);
    await stepFrom(b, 1, 12, 11);
    await waitIdle(b);

    // 喜从天降
    await stepFrom(a, 0, 19, 4);
    const g3 = await oneGame(a, w, 'xicong', playXicong);
    expect(new Set([g1.sessionId, g2.sessionId, g3.sessionId]).size).toBe(3);

    // 其他玩家（P2）也收到直播票据；玩家本人收不到自己的
    expect((await recv(b)).watch.length).toBe(3);
    expect((await recv(a)).watch.length).toBe(0);

    // 三个页面的 HUD 与服务器快照一致
    const seq = await currentSeq(a);
    for (const p of [a, b, w]) await waitSeqAtLeast(p, seq);
    const server = await serverSnapshot(a);
    for (const p of [a, b, w]) expect(await hudSnapshot(p)).toEqual(server);
    for (const p of [...players, watcher]) {
      expect(
        p.errors.filter((e) => !e.includes('WebGL') && !e.includes('favicon')),
        p.nickname,
      ).toEqual([]);
    }
  } finally {
    for (const p of [...players, watcher]) await p.context.close();
  }
});
