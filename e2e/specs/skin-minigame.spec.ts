// 原版皮肤 A13：小游戏原版视图（original-skin.md §5 A13；design-draft §3.6）。合成素材包（tools/extract 的 syntheticUi
// 小游戏段：自绘图形，逻辑键、帧数、关键尺寸与锚点同原版包）经 page.route 提供，GET /api/access 模拟「门禁开启且已通过」，
// 与 skin-classic-shell 同一种供包方式（默认配置与原版配置下都能跑）。原版美术本身只在本机用真实素材包目视（截图只放 .cache/）。
// 1) 桌面 1920×1080：2 个真人 + 1 名观战者，测试图 test，debug:act 让 P1 依次停在 16（企鹅挖宝，落点码 6）、19（七彩气球，7）、
//    20（喜从天降，8）。本人的遮罩在开局前提前显示并播入场 READY GO（服务器时间对齐，startsAt 恰好播完），遮罩上有「不玩了」；
//    宿主用原版视图（data-view=original），观战遮罩同样是原版视图；经测试钩子注入输入（与指针同一条 sink 路径）；
//    服务器结算（MINIGAME_ENDED）= 结算 DOM 分数 = 原版画面的大号分数 = 本地重放分数；点券按结算增加；
//    观战者收到观战票据与输入帧；喜从天降的接物者用本人角色的原版接物姿态。
// 2) 手机横屏 844×390：入场 FLC 期间遮罩上的「不玩了」与观战的「收起」命中尺寸 ≥44px；点「不玩了」→ 服务器按不玩分支结算，遮罩关闭。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page, Route } from '@playwright/test';
import type { PackManifestV1 } from '../../packages/shared/src/assets/pack';
import {
  acted,
  createRoom,
  currentSeq,
  debugAct,
  expect,
  expectNoErrors,
  joinRoom,
  newPlayer,
  type Player,
  pickCharacter,
  Q,
  roll,
  setReady,
  startGame,
  test,
  waitDecision,
  waitIdle,
  waitMyTurn,
} from '../fixtures/room';

test.setTimeout(300_000);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACK_DIR = join(repoRoot, '.cache', 'synthetic-pack');

const ACCESS_ON = {
  ok: true,
  data: {
    mode: 'passcode',
    granted: true,
    kind: 'p',
    expiresAt: Date.now() + 3_600_000,
    grants: false,
    canGrant: false,
  },
};

let manifest: PackManifestV1;
let servable: Map<string, string>;

test.beforeAll(() => {
  test.setTimeout(120_000);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['run', '--silent', 'extract', '--', 'assets', 'synth', '--out', '.cache/synthetic-pack'], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
  manifest = JSON.parse(readFileSync(join(PACK_DIR, 'manifest.json'), 'utf8')) as PackManifestV1;
  servable = new Map(Object.values(manifest.files).map((f) => [f.path, f.contentType]));
});

async function servePack(page: Page): Promise<void> {
  await page.route('**/pack/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/pack/manifest.json')
      return route.fulfill({ json: manifest, headers: { 'cache-control': 'no-cache' } });
    const rel = decodeURIComponent(path.slice('/pack/'.length));
    const type = servable.get(rel);
    if (!type) return route.fulfill({ status: 404, json: { ok: false, error: { code: 'BAD_REQUEST' } } });
    return route.fulfill({ status: 200, contentType: type, body: readFileSync(join(PACK_DIR, rel)) });
  });
  await page.route('**/api/access', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: ACCESS_ON }) : route.fallback(),
  );
}

async function player(
  browser: Browser,
  nick: string,
  viewport: { width: number; height: number } = { width: 1920, height: 1080 },
): Promise<Player> {
  return newPlayer(browser, nick, Q, {
    setup: async (pg) => {
      await pg.setViewportSize(viewport);
      await servePack(pg);
    },
  });
}

/** 让 seat 从 (node, prev) 出发、强制掷出 1 点前进 */
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

interface MgState {
  mode: string;
  phase: string;
  sessionId: string;
  minigameId: string;
  tick: number;
  over: boolean;
  localScore: number;
  finalScore: number | null;
  view: string;
  readyFrame: number;
  // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
  viewDebug: any;
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

/** 本人：遮罩在开局前提前显示（原版入场 FLC 在播、有「不玩了」），随后进入游玩 */
async function waitPrerollThenPlay(page: Page, id: string): Promise<MgState> {
  await expect(page.getByTestId('decision-MINIGAME')).toBeAttached();
  const host = page.locator(`[data-testid="minigame-host"][data-minigame="${id}"][data-mode="play"]`);
  await expect(host).toBeVisible({ timeout: 15_000 });
  await expect(host).toHaveAttribute('data-view', 'original', { timeout: 15_000 });
  // 开局前：READY GO 按服务器时间逐帧播放
  await expect
    .poll(
      async () => {
        const s = await mgState(page);
        return s ? `${s.phase}:${s.readyFrame >= 0}` : null;
      },
      { timeout: 15_000, intervals: [50] },
    )
    .toBe('countdown:true');
  await expect(page.getByTestId('minigame-preroll-decline')).toBeVisible();
  await expect.poll(async () => (await mgState(page))?.phase, { timeout: 15_000 }).toBe('playing');
  await expect(page.getByTestId('minigame-preroll-decline')).toHaveCount(0);
  const s = (await mgState(page))!;
  expect(s.view).toBe('original');
  expect(s.readyFrame).toBe(-1);
  return s;
}

interface MgResult {
  final: boolean;
  shown: number;
  bigScore: number | null;
  state: MgState;
}

/** 页面内每 30ms 看一次：结算画面出现服务器分数时记下 DOM 分数、原版画面的大号分数与宿主状态 */
async function recordResult(page: Page): Promise<void> {
  await page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const w = window as any;
    w.__mgResult = null;
    const tm = setInterval(() => {
      const el = document.querySelector('[data-testid="minigame-final-score"]');
      if (el?.getAttribute('data-final') !== 'true') return;
      const st = w.__rich4.minigame?.state();
      if (st?.phase !== 'result') return;
      w.__mgResult = {
        final: true,
        shown: Number(el.getAttribute('data-value')),
        bigScore: st.viewDebug?.bigScore ?? null,
        state: st,
      };
      clearInterval(tm);
    }, 30);
  });
}

/**
 * 页面内采样（每 30ms）企鹅原版视图亮出的埋藏物个数：开局前（countdown）与记忆阶段（游玩中、sim 仍在 intro）各取最大值。
 * 记忆阶段只有 1 秒，用页面内采样避免轮询错过。
 */
async function sampleBuried(page: Page): Promise<void> {
  await page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const w = window as any;
    const rec = { preroll: -1, intro: -1 };
    w.__mgBuried = rec;
    const tm = setInterval(() => {
      const st = w.__rich4.minigame?.state();
      if (st?.minigameId !== 'penguin') return;
      const n = st.viewDebug?.buried ?? -1;
      if (st.phase === 'countdown') rec.preroll = Math.max(rec.preroll, n);
      else if (st.phase === 'playing' && st.state.phase === 'intro') rec.intro = Math.max(rec.intro, n);
      if (st.phase === 'result') clearInterval(tm);
    }, 30);
  });
}

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
  expect((await mgState(page))!.viewDebug.buried).toBe(0);
  let s = (await mgState(page))!;
  const treasure = nearest(s.state, (k) => k >= 2);
  // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
  await page.evaluate((c) => (window as any).__rich4.minigame.pick(c), treasure);
  await expect.poll(async () => (await mgState(page))!.state.dug[treasure], { timeout: 20_000 }).toBe(1);
  await accept();
  s = (await mgState(page))!;
  expect(s.viewDebug.holes).toBeGreaterThanOrEqual(1);
  // HUD 条的液晶数字跟着 sim：得分框 = 本地分数
  expect(s.viewDebug.hud.at(-1)).toBe(String(s.localScore).padStart(3, '0'));
  const bombCell = nearest(s.state, (k) => k === 1);
  // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
  await page.evaluate((c) => (window as any).__rich4.minigame.pick(c), bombCell);
}

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

async function oneGame(
  a: Page,
  spec: Page,
  id: 'penguin' | 'balloon' | 'xicong',
  play: (p: Page) => Promise<void>,
): Promise<{ score: number; sessionId: string; state: MgState }> {
  await waitDecision(a, ['MINIGAME']);
  if (id === 'penguin') await sampleBuried(a);
  await recordResult(a);
  const before = await pointsOf(a, 0);
  const endedBefore = (await recv(a)).ended.length;
  const st = await waitPrerollThenPlay(a, id);
  // 观战遮罩：同样是原版视图
  const watch = spec.locator(`[data-testid="minigame-host"][data-mode="spectate"][data-minigame="${id}"]`);
  await expect(watch).toBeVisible({ timeout: 15_000 });
  await expect(watch).toHaveAttribute('data-view', 'original', { timeout: 15_000 });
  await play(a);
  if (id === 'penguin') {
    // 开局前不亮出埋藏物；记忆阶段亮出全部 28 件（原版 0x413f39(1)）
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const buried = await a.evaluate(() => (window as any).__mgBuried as { preroll: number; intro: number });
    expect(buried).toEqual({ preroll: 0, intro: 28 });
  }
  // 结算画面（服务器分数到达后停留 2 秒）：页面内记录下来再断言，页面慢时也不会错过
  await expect
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    .poll(async () => (await a.evaluate(() => (window as any).__mgResult as MgResult | null))?.final, {
      timeout: 60_000,
    })
    .toBe(true);
  // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
  const res = (await a.evaluate(() => (window as any).__mgResult as MgResult))!;
  const shown = res.shown;
  const end = res.state;
  // 原版画面：结算大号分数 = 结算 DOM 分数 = 本地重放分数
  expect(res.bigScore).toBe(shown);
  expect(end.localScore).toBe(shown);
  expect(end.finalScore).toBe(shown);
  await expect.poll(async () => (await recv(a)).ended.length, { timeout: 15_000 }).toBeGreaterThan(endedBefore);
  const ended = (await recv(a)).ended.at(-1)!;
  expect(ended).toEqual({ seat: 0, mode: 'played', score: shown });
  await expect(a.getByTestId('minigame-host')).toHaveCount(0, { timeout: 10_000 });
  await waitIdle(a);
  expect(await pointsOf(a, 0)).toBe(Math.min(65535, before + shown));
  const r = await recv(spec);
  const w = r.watch.find((x) => x.ticket.sessionId === st.sessionId);
  expect(w, 'spectator watch ticket').toBeDefined();
  expect(w!.mode).toBe('live');
  expect(w!.ticket).toMatchObject({ role: 'spectator', minigameId: id, seat: 0 });
  const frames = r.frames.filter((f) => f.sessionId === st.sessionId);
  expect(frames.length).toBeGreaterThanOrEqual(2);
  expect(frames[0]!.seq).toBe(0);
  expect(frames.reduce((n, f) => n + f.n, 0)).toBeGreaterThan(0);
  return { score: shown, sessionId: st.sessionId, state: end };
}

test('桌面：三款小游戏用原版视图，入场 READY GO、结算大号分数与服务器一致，观战者收到输入帧', async ({ browser }) => {
  const a0 = await player(browser, 'P1');
  const b0 = await player(browser, 'P2');
  const w0 = await player(browser, '观众');
  const [a, b, w] = [a0.page, b0.page, w0.page];
  try {
    const code = await createRoom(a, { map: 'test', timer: 'off' });
    await joinRoom(b, code);
    await joinRoom(w, code, true);
    await pickCharacter(a, 2);
    await pickCharacter(b, 5);
    await setReady(b);
    await startGame(a, [a, b, w]);
    for (const p of [a, b, w]) await listen(p);

    await stepFrom(a, 0, 15, 14);
    await oneGame(a, w, 'penguin', playPenguin);
    await stepFrom(b, 1, 12, 11);
    await waitIdle(b);

    await stepFrom(a, 0, 20, 13);
    const g2 = await oneGame(a, w, 'balloon', playBalloon);
    // 准星：素材包有 ui.cursor（Data#0 图6–8）时用原版三帧，没有时画简单十字（可选条目，不影响原版视图）
    expect(g2.state.viewDebug.reticle).toBe(Object.hasOwn(manifest.entries, 'ui.cursor') ? 'sprite' : 'fallback');
    await stepFrom(b, 1, 12, 11);
    await waitIdle(b);

    await stepFrom(a, 0, 19, 4);
    const g3 = await oneGame(a, w, 'xicong', playXicong);
    // 接物者用本人角色（2 号）的原版接物姿态
    expect(g3.state.viewDebug.catcher).toMatch(/^mg\.xicong\.char\.2#/);
    expect((await currentSeq(a)) > 0).toBe(true);
    expectNoErrors([a0, b0, w0], [/WebGL/, /favicon/]);
  } finally {
    for (const p of [a0, b0, w0]) await p.context.close();
  }
});

interface HitProbe {
  hit: { w: number; h: number } | null;
  view: string | null;
  stage: { w: number; h: number } | null;
  scrollOk: boolean | null;
  clicked: boolean;
  frame: number;
}

/**
 * 页面内探针（每 16ms 看一次）：testId 一出现就量命中尺寸（同 hitSize 的算法）、遮罩的 data-view、舞台尺寸与横向滚动；
 * click 为 true 时等测试放行（window.__probeGo）或入场 FLC 快播完（第 14 帧起，约剩 0.7 秒）立即点下。
 * 「不玩了」只在入场 READY GO 的 2.28 秒里存在：量尺寸与点击都在页面里做，不经过测试进程的往返与默认轮询。
 */
async function armProbe(page: Page, testId: string, click: boolean): Promise<void> {
  await page.evaluate(
    ([id, doClick]) => {
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      const w = window as any;
      const rec = { hit: null, view: null, stage: null, scrollOk: null, clicked: false, frame: -1 } as HitProbe;
      w.__probe = rec;
      w.__probeGo = false;
      const measure = (el: Element): { w: number; h: number } => {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const on = (x: number, y: number): boolean => {
          const hit = document.elementFromPoint(x, y);
          return hit !== null && (hit === el || el.contains(hit));
        };
        const span = (dx: number, dy: number): number => {
          let n = 0;
          for (let k = 1; k < 200; k++) {
            if (!on(cx + dx * k, cy + dy * k)) break;
            n++;
          }
          return n;
        };
        if (!on(cx, cy)) return { w: 0, h: 0 };
        return { w: span(-1, 0) + span(1, 0) + 1, h: span(0, -1) + span(0, 1) + 1 };
      };
      const tm = setInterval(() => {
        const el = document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
        if (!el) return;
        if (rec.hit === null) {
          rec.hit = measure(el);
          const host = document.querySelector('[data-testid="minigame-host"]');
          rec.view = host?.getAttribute('data-view') ?? null;
          const r = (host?.firstElementChild as HTMLElement | null)?.getBoundingClientRect();
          rec.stage = r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
          rec.scrollOk = document.documentElement.scrollWidth <= window.innerWidth;
        }
        if (!doClick) {
          clearInterval(tm);
          return;
        }
        const frame = w.__rich4.minigame?.state()?.readyFrame ?? -1;
        if (w.__probeGo || frame >= 14) {
          clearInterval(tm);
          rec.frame = frame;
          rec.clicked = true;
          el.click();
        }
      }, 16);
    },
    [testId, click] as const,
  );
}

async function probeOf(page: Page): Promise<HitProbe> {
  // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
  return page.evaluate(() => (window as any).__probe as HitProbe);
}

test('手机横屏 844×390：入场期间「不玩了」与观战「收起」命中 ≥44px；不玩了按不玩分支结算', async ({ browser }) => {
  const vp = { width: 844, height: 390 };
  const a0 = await player(browser, 'P1', vp);
  const b0 = await player(browser, 'P2', vp);
  const [a, b] = [a0.page, b0.page];
  try {
    const code = await createRoom(a, { map: 'test', timer: 'off' });
    await joinRoom(b, code);
    await pickCharacter(a, 7);
    await pickCharacter(b, 1);
    await setReady(b);
    await startGame(a, [a, b]);
    for (const p of [a, b]) await listen(p);
    const endedBefore = (await recv(a)).ended.length;
    // 先在页面里布好探针：本人（P1）的「不玩了」、观战者（P2）遮罩的「收起」
    await armProbe(a, 'minigame-preroll-decline', true);
    await armProbe(b, 'minigame-close', false);
    await stepFrom(a, 0, 20, 13);
    await waitDecision(a, ['MINIGAME']);
    // 观战者量到「收起」后放行本人点「不玩了」（等不到时探针在入场 FLC 快播完前自己点）
    await expect.poll(async () => (await probeOf(b)).hit, { timeout: 15_000, intervals: [50] }).not.toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    await a.evaluate(() => ((window as any).__probeGo = true));
    await expect.poll(async () => (await probeOf(a)).clicked, { timeout: 15_000, intervals: [50] }).toBe(true);
    const d = await probeOf(a);
    expect(d.view).toBe('original');
    expect(Math.min(d.hit!.w, d.hit!.h)).toBeGreaterThanOrEqual(44);
    // 舞台按 390 高缩放（520×390），页面不横向滚动
    expect(d.stage).toEqual({ w: 520, h: 390 });
    expect(d.scrollOk).toBe(true);
    const c = await probeOf(b);
    expect(Math.min(c.hit!.w, c.hit!.h)).toBeGreaterThanOrEqual(44);
    expect(c.scrollOk).toBe(true);
    // 不玩了 → 服务器按不玩分支结算（MINIGAME_ENDED skipped），遮罩关闭
    await expect.poll(async () => (await recv(a)).ended.length, { timeout: 15_000 }).toBeGreaterThan(endedBefore);
    expect((await recv(a)).ended.at(-1)).toMatchObject({ seat: 0, mode: 'skipped' });
    await expect(a.getByTestId('minigame-host')).toHaveCount(0, { timeout: 10_000 });
    await expect(b.getByTestId('minigame-host')).toHaveCount(0, { timeout: 10_000 });
    expectNoErrors([a0, b0], [/WebGL/, /favicon/]);
  } finally {
    for (const p of [a0, b0]) await p.context.close();
  }
});
