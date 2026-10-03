// 原版皮肤 A12 第二组场所屏（original-skin.md §4.2、§5 A12；ui/classic/venues/b）：合成素材包 + fixture 地图（与
// skin-classic-shell 同一种供包方式：page.route 按 manifest 白名单提供 /pack/*，GET /api/access 模拟成「门禁开启且已通过」），
// 场景走原版精灵路径（data-scene="classic"），全部用 DOM 备用控件（与程序化对话框同名的 data-testid）操作。
// 1) 魔法屋 → 监狱保释 → 医院雇恶人（4 个真人；P1、P3 为手机横屏 844×390，量实际命中尺寸 ≥44px）：P1 在魔法屋对「现金最多的
//    人」P2 施「坐牢 3 天」；P3 停在监狱保释格选 P2 → YES 保释；P4 停在医院保释格雇流氓；4 页 HUD 与服务器快照一致；
// 1b) 获释位置（VERIFY V-M7，原版 0x40d184 获释不换节点）：2 个真人，P1 魔法屋把 P2 关进监狱、下一圈停在保释格保释他；P2 获释
//    （RELEASED / RETURNED）后两页的 view 与棋盘上 P2 都在关押格 14、来路 = 14、不是关押外观；P2 下一回合强制岔路 0 往回走到 13
//    （旧实现获释后来路固定为 13，只能往 15 走）；
// 2) 拍卖卡四人竞价：P1 在 L1 出拍卖卡，P2（手机）/ P3 / P4 在原版拍卖厅并发竞价——出价后其他人的场景刷新价格与领先者，
//    Q 版小人与领先描边在场；卖方 P1 与退出的 P2 看观战版原版拍卖厅（classic-auction-watch）；P3 成交；
// 3) 公佈欄挂牌购买：P1 回合里点工具列 SALE → 原版公佈欄（回合菜单的原版场景套了 venues/b 的 ClassicBoardSheet）→
//    类别 → 表格 → 计算器输入价格 → 挂一张卡；P2 回合里打开公佈欄，点挂牌看明细并买下。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';
import type { PackManifestV1 } from '../../packages/shared/src/assets/pack';
import {
  acted,
  createRoom,
  debugAct,
  expect,
  expectNoErrors,
  hudSnapshot,
  joinRoom,
  newPlayer,
  type Player,
  pickCharacter,
  Q,
  serverSnapshot,
  setReady,
  startGame,
  syncPages,
  test,
  waitDecision,
  waitIdle,
  waitMyTurn,
} from '../fixtures/room';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACK_DIR = join(repoRoot, '.cache', 'synthetic-pack');
const MOBILE = { width: 844, height: 390 };
const DESKTOP = { width: 1920, height: 1080 };

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

async function classicPlayer(
  browser: Parameters<typeof newPlayer>[0],
  nick: string,
  viewport: { width: number; height: number },
): Promise<Player> {
  return newPlayer(browser, nick, Q, {
    setup: async (pg) => {
      await pg.setViewportSize(viewport);
      await servePack(pg);
    },
  });
}

/** 4 人各自选角（9、4、0、3 号）、准备、开局，等经典布局就绪 */
async function startFour(players: Player[]): Promise<void> {
  const pages = players.map((p) => p.page);
  const code = await createRoom(pages[0]!, { map: 'test', timer: 'off' });
  for (const p of pages.slice(1)) await joinRoom(p, code);
  const chars = [9, 4, 0, 3];
  for (let i = 0; i < pages.length; i++) await pickCharacter(pages[i]!, chars[i]!);
  for (const p of pages.slice(1)) await setReady(p);
  await startGame(pages[0]!, pages);
  for (const p of pages) await expect(p.getByTestId('classic-stage')).toBeVisible({ timeout: 30_000 });
}

/** 本人回合：传送到 (node, prev)，强制掷出 1 点并掷骰（落到下一格；来路决定方向，避开岔路） */
async function stepOnto(page: Page, seat: number, node: number, prev: number): Promise<void> {
  await waitMyTurn(page);
  await acted(page, () => debugAct(page, { op: 'teleport', seat, node, prev }));
  await acted(page, () => debugAct(page, { op: 'forceNext', purpose: 'dice', values: [1] }));
  await waitMyTurn(page);
  await acted(page, () => page.getByTestId('action-roll').click());
}

/** 原版场景已出现（决策层里是原版场景而不是程序化对话框） */
async function expectScene(page: Page, kind: string, venue: string): Promise<void> {
  const scene = page.getByTestId(`decision-${kind}`);
  await expect(scene).toBeVisible();
  await expect(scene).toHaveAttribute('data-scene', 'classic');
  await expect(scene).toHaveAttribute('data-venue', venue);
}

/**
 * 控件的实际命中尺寸（CSS 像素）：过控件中心的横线与竖线上逐像素 elementFromPoint，量出落在该控件（含透明热区）
 * 上的连续长度（同 skin-classic-shell）
 */
async function hitSize(page: Page, testId: string): Promise<{ w: number; h: number }> {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) throw new Error(`没有 ${id}`);
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
  }, testId);
}

async function expectHit44(page: Page, ids: string[]): Promise<void> {
  for (const id of ids) {
    const hs = await hitSize(page, id);
    expect(hs.w, id).toBeGreaterThanOrEqual(44);
    expect(hs.h, id).toBeGreaterThanOrEqual(44);
  }
}

interface SeatState {
  cash: number;
  deposit: number;
  points: number;
  jail: number;
  cards: number[] | null;
}

async function seatState(page: Page, seat: number): Promise<SeatState> {
  return page.evaluate((s) => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const v = (window as any).__rich4.store.game.getState().latest;
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const p = v.players.find((x: any) => x.seat === s);
    return { cash: p.cash, deposit: p.deposit, points: p.points, jail: p.st.jail, cards: p.cards };
  }, seat);
}

async function logTypes(page: Page): Promise<string[]> {
  // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
  return page.evaluate(() => (window as any).__rich4.store.game.getState().log.map((l: any) => l.type as string));
}

/** 4 页追上同一 seq，HUD 与服务器快照一致 */
async function consistent(pages: Page[]): Promise<void> {
  await syncPages(pages);
  const server = await serverSnapshot(pages[0]!);
  for (const p of pages) expect(await hudSnapshot(p)).toEqual(server);
}

test('魔法屋施法坐牢 → 监狱保释 → 医院雇恶人：原版场景、DOM 备用控件、手机热区 ≥44px', async ({ browser }) => {
  test.setTimeout(240_000);
  const players = [
    await classicPlayer(browser, 'P1', MOBILE),
    await classicPlayer(browser, 'P2', DESKTOP),
    await classicPlayer(browser, 'P3', MOBILE),
    await classicPlayer(browser, 'P4', DESKTOP),
  ];
  const pages = players.map((p) => p.page);
  const [a, , c, d] = pages as [Page, Page, Page, Page];
  try {
    await startFour(players);

    // ── 魔法屋：P1 在 9 号格，条件预置 3「现金最多的人」= P2 ──
    await waitMyTurn(a);
    await acted(a, () => debugAct(a, { op: 'setCash', seat: 1, cash: 900_000, deposit: null }));
    await acted(a, () => debugAct(a, { op: 'forceNext', purpose: 'magicCond', values: [3] }));
    await stepOnto(a, 0, 8, 7);
    await waitDecision(a, ['MAGIC_CAST']);
    await expectScene(a, 'MAGIC_CAST', 'magic');
    await expect(a.getByTestId('magic-targets')).toHaveAttribute('data-targets', '1');
    await expectHit44(a, ['magic-effect-0', 'magic-effect-2', 'magic-effect-6', 'magic-effect-9']);
    await a.getByTestId('magic-effect-2').click();
    await expect(a.getByTestId('decision-MAGIC_CAST')).toHaveAttribute('data-pick', '2');
    await expectHit44(a, ['magic-confirm', 'magic-cancel']);
    await acted(a, () => a.getByTestId('magic-confirm').click());
    await waitIdle(a);
    await syncPages(pages, a);
    expect((await seatState(a, 1)).jail).toBeGreaterThan(0);
    expect(await logTypes(a)).toContain('MAGIC_CAST');

    // ── 监狱：P2 坐牢跳过；P3 停在 14 号保释格，保释 P2 ──
    await waitMyTurn(c);
    await acted(c, () => debugAct(c, { op: 'setPoints', seat: 2, points: 400 }));
    await stepOnto(c, 2, 15, 16);
    await waitDecision(c, ['BAIL']);
    await expectScene(c, 'BAIL', 'jail');
    await expect(c.getByTestId('bail-points')).toHaveAttribute('data-value', '400');
    await expect(c.getByTestId('bail-hire-thief')).toBeEnabled();
    await expect(c.getByTestId('bail-hire-robber')).toBeEnabled();
    await expect(c.getByTestId('bail-confirm')).toBeDisabled();
    await c.getByTestId('bail-seat-1').click();
    await expect(c.getByTestId('bail-confirm')).toBeEnabled();
    await expectHit44(c, ['bail-seat-1', 'bail-hire-thief', 'bail-confirm', 'bail-skip']);
    await acted(c, () => c.getByTestId('bail-confirm').click());
    await syncPages(pages, c);
    expect((await seatState(c, 2)).points).toBe(370);
    expect(await logTypes(c)).toContain('BAIL');

    // ── 医院：P4 停在 15 号保释格，雇流氓 ──
    await waitMyTurn(d);
    await acted(d, () => debugAct(d, { op: 'setPoints', seat: 3, points: 400 }));
    await stepOnto(d, 3, 16, 17);
    await waitDecision(d, ['BAIL']);
    await expectScene(d, 'BAIL', 'hospital');
    await d.getByTestId('bail-hire-thug').click();
    await acted(d, () => d.getByTestId('bail-confirm').click());
    await syncPages(pages, d);
    expect((await seatState(d, 3)).points).toBe(100);
    expect(await logTypes(d)).toContain('VILLAIN_HIRED');

    await consistent(pages);
    expectNoErrors(players);
  } finally {
    for (const p of players) await p.context.close();
  }
});

/** 本页棋盘上 seat 的角色：所在格、是否可见、关押外观（两种渲染器同形的测试钩子） */
async function actorOnBoard(
  page: Page,
  seat: number,
): Promise<{ tile: number | null; visible: boolean; confined: string | null } | null> {
  return page.evaluate((s) => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const r = (window as any).__rich4?.renderer;
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const a = r?.board.allActors().find((x: any) => x.seat === s);
    if (!a) return null;
    const c = a.currentStatus?.confined;
    return { tile: a.tile, visible: a.root.visible, confined: c ? (typeof c === 'string' ? c : c.where) : null };
  }, seat);
}

/** 本页 view 里 seat 的位置与关押计数 */
async function seatPos(page: Page, seat: number): Promise<{ node: number; prevNode: number; jail: number }> {
  return page.evaluate((s) => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const v = (window as any).__rich4.store.game.getState().latest;
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const p = v.players.find((x: any) => x.seat === s);
    return { node: p.node, prevNode: p.prevNode, jail: p.st.jail };
  }, seat);
}

test('获释留在关押格：魔法屋坐牢 → 保释 → P2 获释后仍在 14、来路 14，下一回合可往回走到 13', async ({ browser }) => {
  test.setTimeout(180_000);
  const players = [await classicPlayer(browser, 'P1', DESKTOP), await classicPlayer(browser, 'P2', DESKTOP)];
  const pages = players.map((p) => p.page);
  const [a, b] = pages as [Page, Page];
  const HOLD = 14;
  try {
    const code = await createRoom(a, { map: 'test', timer: 'off' });
    await joinRoom(b, code);
    await pickCharacter(a, 9);
    await pickCharacter(b, 4);
    await setReady(b);
    await startGame(a, pages);
    for (const p of pages) await expect(p.getByTestId('classic-stage')).toBeVisible({ timeout: 30_000 });

    // ── P1 在魔法屋对「现金最多的人」P2 施「坐牢 3 天」（P2 还没跳伞：直接落在监狱关押格 14） ──
    await waitMyTurn(a);
    await acted(a, () => debugAct(a, { op: 'setCash', seat: 1, cash: 900_000, deposit: null }));
    await acted(a, () => debugAct(a, { op: 'forceNext', purpose: 'magicCond', values: [3] }));
    await stepOnto(a, 0, 8, 7);
    await waitDecision(a, ['MAGIC_CAST']);
    await a.getByTestId('magic-effect-2').click();
    await acted(a, () => a.getByTestId('magic-confirm').click());
    await syncPages(pages, a);
    expect(await seatPos(a, 1)).toMatchObject({ node: HOLD, prevNode: HOLD });
    expect((await seatPos(a, 1)).jail).toBeGreaterThan(0);

    // ── P2 受阻；P1 停在保释格 14 保释 P2 ──
    await waitMyTurn(a);
    await acted(a, () => debugAct(a, { op: 'setPoints', seat: 0, points: 400 }));
    await stepOnto(a, 0, 15, 16);
    await waitDecision(a, ['BAIL']);
    await a.getByTestId('bail-seat-1').click();
    await acted(a, () => a.getByTestId('bail-confirm').click());
    await syncPages(pages, a);

    // ── P2 的回合：获释、走回棋盘（不掷骰）→ 又轮到 P1：两页的 view 与棋盘上 P2 都还在关押格 14 ──
    await waitMyTurn(a);
    await syncPages(pages, a);
    expect(await logTypes(a)).toEqual(expect.arrayContaining(['RELEASED', 'RETURNED']));
    for (const p of pages) {
      expect(await seatPos(p, 1)).toEqual({ node: HOLD, prevNode: HOLD, jail: 0 });
      expect(await actorOnBoard(p, 1)).toEqual({ tile: HOLD, visible: true, confined: null });
    }

    // ── P1 走开（12 → 13 得点，无决策）；P2 的回合强制岔路 0：从 14 往回走到 13 ──
    await stepOnto(a, 0, 12, 11);
    await waitMyTurn(b);
    await acted(b, () => debugAct(b, { op: 'forceNext', purpose: 'fork', values: [0] }));
    await acted(b, () => debugAct(b, { op: 'forceNext', purpose: 'dice', values: [1] }));
    await waitMyTurn(b);
    await acted(b, () => b.getByTestId('action-roll').click());
    await waitIdle(b);
    await syncPages(pages, b);
    for (const p of pages) {
      expect(await seatPos(p, 1)).toMatchObject({ node: 13, prevNode: HOLD });
      expect((await actorOnBoard(p, 1))?.tile).toBe(13);
    }
    expectNoErrors(players);
  } finally {
    for (const p of players) await p.context.close();
  }
});

test('拍卖卡四人竞价：原版拍卖厅并发出价，其他人的价格与领先者实时刷新，P3 成交', async ({ browser }) => {
  test.setTimeout(240_000);
  const players = [
    await classicPlayer(browser, 'P1', DESKTOP),
    await classicPlayer(browser, 'P2', MOBILE),
    await classicPlayer(browser, 'P3', DESKTOP),
    await classicPlayer(browser, 'P4', DESKTOP),
  ];
  const pages = players.map((p) => p.page);
  const [a, b, c, d] = pages as [Page, Page, Page, Page];
  try {
    await startFour(players);
    // P1 站在无主的 L1 上，用拍卖卡（回合菜单的卡片欄属于通用对话框组：这里经测试钩子提交 USE_CARD）
    await waitMyTurn(a);
    await acted(a, () => debugAct(a, { op: 'teleport', seat: 0, node: 5, prev: 4 }));
    await acted(a, () => debugAct(a, { op: 'give', seat: 0, cards: [8], items: [] }));
    await waitMyTurn(a);
    await acted(a, () =>
      a.evaluate(() => {
        // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
        const h = (window as any).__rich4;
        const dd = h.store.game.getState().decision;
        // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
        const row = dd.options.cards.find((r: any) => r.card === 8);
        const tg = row.targets;
        const target =
          tg.t === 'underfoot'
            ? { t: 'underfoot', facility: null }
            : tg.t === 'lot'
              ? { t: 'lot', lot: tg.lots[0], facility: null }
              : { t: 'none' };
        return h.client.act({ type: 'USE_CARD', slot: row.slot, card: 8, target }, dd.decisionId);
      }),
    );
    for (const p of [b, c, d]) {
      await waitDecision(p, ['AUCTION_BID']);
      await expectScene(p, 'AUCTION_BID', 'auction');
    }
    // 卖方 P1 没有竞拍决策：看观战版原版拍卖厅（只读）
    const watchA = a.getByTestId('classic-auction-watch');
    await expect(watchA).toBeVisible();
    await expect(watchA).toHaveAttribute('data-scene', 'classic');
    // 场景里的价格牌（公开竞价横幅里也有 auction-price，按场景限定）
    const scene = (p: Page) => p.getByTestId('decision-AUCTION_BID');
    const start = Number(await scene(b).getByTestId('auction-price').getAttribute('data-value'));
    expect(start).toBeGreaterThan(0);
    // 3 位竞拍者的 Q 版小人都在场
    for (const s of [1, 2, 3]) await expect(scene(b).getByTestId(`auction-bidder-${s}`)).toHaveCount(1);
    await expectHit44(b, ['auction-pass', 'auction-bid-100', 'auction-bid-10000', 'auction-quit', 'auction-bid-0']);

    const bid = async (page: Page, testId: string): Promise<void> => {
      await waitDecision(page, ['AUCTION_BID']);
      const btn = scene(page).getByTestId(testId);
      await expect(btn).toBeEnabled();
      await acted(page, () => btn.click());
      await syncPages(pages, page);
    };
    // P2 按起拍价 → 其他人看到领先者 P2
    await bid(b, 'auction-bid-0');
    await waitDecision(c, ['AUCTION_BID']);
    await expect(scene(c).getByTestId('auction-leader')).toHaveAttribute('data-leader', '1');
    await expect(scene(c).getByTestId('auction-bidder-1')).toHaveAttribute('data-leader', 'true');
    await expect(scene(c).getByTestId('auction-price')).toHaveAttribute('data-value', String(start));
    // P3 这轮不加价 → P4 +1000 → 其他人看到新价格与领先者 P4
    await bid(c, 'auction-pass');
    await bid(d, 'auction-bid-1000');
    await waitDecision(b, ['AUCTION_BID']);
    await expect(scene(b).getByTestId('auction-price')).toHaveAttribute('data-value', String(start + 1000));
    await expect(scene(b).getByTestId('auction-leader')).toHaveAttribute('data-leader', '3');
    // P2 退出 → P3 +500 → P4 不加价 → P3 成交；退出的 P2 改看观战版拍卖厅
    await bid(b, 'auction-quit');
    await expect(b.getByTestId('classic-auction-watch')).toHaveAttribute('data-scene', 'classic');
    await bid(c, 'auction-bid-500');
    await bid(d, 'auction-pass');
    await waitMyTurn(a);
    await consistent(pages);
    const lotOwner = await a.evaluate(
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      () => (window as any).__rich4.store.game.getState().latest.lands.find((l: any) => l.id === 'L1').owner,
    );
    expect(lotOwner).toBe(2);
    expect(await logTypes(a)).toContain('AUCTION_ENDED');
    expectNoErrors(players);
  } finally {
    for (const p of players) await p.context.close();
  }
});

test('公佈欄挂牌购买：P1 挂一张卡，P2 在自己的回合买下', async ({ browser }) => {
  test.setTimeout(180_000);
  const players = [await classicPlayer(browser, 'P1', DESKTOP), await classicPlayer(browser, 'P2', DESKTOP)];
  const pages = players.map((p) => p.page);
  const [a, b] = pages as [Page, Page];
  try {
    const code = await createRoom(a, { map: 'test', timer: 'off' });
    await joinRoom(b, code);
    await pickCharacter(a, 9);
    await pickCharacter(b, 4);
    await setReady(b);
    await startGame(a, pages);
    await waitMyTurn(a);
    await acted(a, () => debugAct(a, { op: 'give', seat: 0, cards: [12], items: [] }));
    await waitMyTurn(a);

    // 工具列 SALE（本人回合：展开回合菜单并直接打开公佈欄子页）→ 原版公佈欄（dialogs/TurnMenuFull 套了 ClassicBoardSheet）
    await a.getByTestId('action-board').click();
    const board = a.locator('[data-testid="decision-TURN_MENU"][data-venue="bulletin"]');
    await expect(board).toBeVisible();
    await expect(board).toHaveAttribute('data-scene', 'classic');
    await expect(a.getByTestId('board-empty')).toBeVisible();
    await a.getByTestId('board-sell').click();
    await expect(a.getByTestId('board-kind-stock')).toBeDisabled();
    await a.getByTestId('board-kind-card').click();
    await a.getByTestId('board-pick-card-12').click();
    await a.getByTestId('board-calc-input').fill('1500');
    await acted(a, () => a.getByTestId('board-list').click());
    // 重问后回到板面，自己的挂牌钉在板上
    await expect(board).toHaveAttribute('data-step', 'board');
    await expect(a.locator('[data-testid^="listing-"][data-mine="true"]')).toHaveCount(1);
    await a.getByTestId('board-exit').click();
    await expect(a.getByTestId('decision-TURN_MENU')).toHaveCount(0);
    // P1 从 17 号格走 1 步到 18 号地产（买地决策按默认处理）
    await stepOnto(a, 0, 17, 16);
    await waitIdle(a);
    for (let i = 0; i < 4; i++) {
      const k = await a.evaluate(
        // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
        () => (window as any).__rich4.store.game.getState().decision?.kind ?? null,
      );
      if (!k) break;
      await acted(a, () =>
        a.evaluate(() => {
          // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
          const h = (window as any).__rich4;
          const dd = h.store.game.getState().decision;
          return h.client.act(dd.defaultIntent, dd.decisionId);
        }),
      );
    }
    const before = await seatState(a, 0);

    await waitMyTurn(b);
    await b.getByTestId('action-board').click();
    await expect(b.locator('[data-testid="decision-TURN_MENU"][data-venue="bulletin"]')).toBeVisible();
    const listing = b.locator('[data-testid^="listing-"][data-mine="false"]').first();
    await expect(listing).toBeVisible();
    const id = ((await listing.getAttribute('data-testid')) ?? '').slice('listing-'.length);
    await listing.click();
    await expect(b.getByTestId('listing-seller')).toBeVisible();
    await acted(b, () => b.getByTestId(`listing-buy-${id}`).click());
    await syncPages(pages, b);
    expect((await seatState(b, 1)).cards).toContain(12);
    const after = await seatState(b, 0);
    expect(after.cash + after.deposit).toBe(before.cash + before.deposit + 1500);
    expectNoErrors(players);
  } finally {
    for (const p of players) await p.context.close();
  }
});
