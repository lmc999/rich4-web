// 原版皮肤：随机事件的原版画面（用户反馈「随机事件显示的卡片没有贴图」）。合成素材包（tools/extract 的 syntheticUi：
// 按逻辑键自绘的假图，illustration.fate.<i> 画的是插图号 i、card.<k> 画的是卡号 k）经 page.route 提供，GET /api/access
// 模拟成「门禁开启且已通过」，与 skin-classic-cards 同一种供包方式（默认配置与原版皮肤配置下都能跑）。
// 两名真人（手牌私密）+ 一名观战者，三页都走演出路径，各自记下出现过的命运板与亮卡弹窗（MutationObserver）：
// 1) 命运板：P1 预置命运 3（支票跳票）走到命运格 → 三页都是原版命运板（data-classic），板面 Panel#66 图1、插图键按 exe
//    插图表 0x473dd8 = illustration.fate.3、背景图是素材包里那个文件、表情头像 portrait.speaker.9 的图3；不是程序化翻面卡；
//    命运板 440×480 盖着工具列：板子显示期间 P2 点板子顶部 (100,20)（「托管」钮的位置）、观战者点 (260,20)（「查询」）——
//    只结束各自的命运板，点击不穿到板子下面看不见的工具列（托管不切换、不开资产表）；
// 2) 卡片格得卡：P2 走到卡片格 → P2 本人看到原版亮卡（卡图 = 抽到的那张 card.<k>，「得到XX！」）；P1 与观战者只看到
//    「XX 得到一張卡片！」的消息框（没有卡图、没有卡号，私密手牌）。
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
  newPlayer,
  type Player,
  pickCharacter,
  Q_ANIM,
  setReady,
  startGame,
  test,
  waitIdle,
  waitMyTurn,
} from '../fixtures/room';

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
  test.setTimeout(180_000);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['run', '--silent', 'extract', '--', 'assets', 'synth', '--out', '.cache/synthetic-pack'], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
  manifest = JSON.parse(readFileSync(join(PACK_DIR, 'manifest.json'), 'utf8')) as PackManifestV1;
  servable = new Map(Object.values(manifest.files).map((f) => [f.path, f.contentType]));
});

/** 整图条目在素材包里的 URL（manifest 的带哈希文件名） */
function imageUrlOf(key: string): string {
  const e = manifest.entries[key];
  if (e?.type !== 'image') throw new Error(`${key} 不是整图条目`);
  return `/pack/${manifest.files[e.file]!.path}`;
}

interface FateSeen {
  fate: number;
  slot: number;
  phase: string | null;
  classic: boolean;
  board: string | null;
  key: string | null;
  bg: string;
  face: string | null;
  title: string;
}

interface GainSeen {
  card: number | null;
  variant: string | null;
  mode: string | null;
  classic: boolean;
  key: string | null;
  bg: string;
  line: string;
}

/** 在页面脚本之前装上记录器：window.__fateSeen / window.__gainSeen（同一个弹窗属性变化时刷新） */
async function recordEvents(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const fates: unknown[] = [];
    const gains: unknown[] = [];
    const idx = new WeakMap<Element, number>();
    const w = window as unknown as { __fateSeen: unknown[]; __gainSeen: unknown[] };
    w.__fateSeen = fates;
    w.__gainSeen = gains;
    const put = (list: unknown[], el: Element, row: unknown): void => {
      const i = idx.get(el);
      if (i === undefined) {
        idx.set(el, list.length);
        list.push(row);
      } else list[i] = row;
    };
    const scan = (): void => {
      for (const el of document.querySelectorAll('[data-testid="fate-popup"]')) {
        const h = el as HTMLElement;
        const art = el.querySelector<HTMLElement>('[data-testid="fate-art"]');
        put(fates, el, {
          fate: Number(h.dataset.fate),
          slot: Number(h.dataset.slot),
          phase: h.dataset.phase ?? null,
          classic: !!el.closest('[data-classic="true"]'),
          board: el.querySelector('[data-testid="fate-board"]')?.getAttribute('data-sprite') ?? null,
          key: art?.dataset.assetKey ?? null,
          bg: art?.style.backgroundImage ?? '',
          face: el.querySelector('[data-testid="fate-face"]')?.getAttribute('data-sprite') ?? null,
          title: el.querySelector('[data-testid="fate-title"]')?.textContent ?? '',
        });
      }
      for (const el of document.querySelectorAll('[data-testid="card-cast-popup"][data-variant="gain"]')) {
        const h = el as HTMLElement;
        const art = el.querySelector<HTMLElement>('[data-testid="card-cast-art"]');
        put(gains, el, {
          card: h.dataset.card === undefined ? null : Number(h.dataset.card),
          variant: h.dataset.variant ?? null,
          mode: h.dataset.mode ?? null,
          classic: !!el.closest('[data-classic="true"]'),
          key: art?.dataset.assetKey ?? null,
          bg: art?.style.backgroundImage ?? '',
          line: el.querySelector('[data-testid="card-cast-line"]')?.textContent ?? '',
        });
      }
    };
    new MutationObserver(scan).observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'data-sprite', 'data-src'],
    });
  });
}

async function fatesOf(page: Page): Promise<FateSeen[]> {
  return page.evaluate(() => (window as unknown as { __fateSeen: FateSeen[] }).__fateSeen);
}

async function gainsOf(page: Page): Promise<GainSeen[]> {
  return page.evaluate(() => (window as unknown as { __gainSeen: GainSeen[] }).__gainSeen);
}

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

async function classicPlayer(browser: Parameters<typeof newPlayer>[0], nick: string): Promise<Player> {
  return newPlayer(browser, nick, Q_ANIM, {
    setup: async (pg) => {
      await pg.setViewportSize({ width: 1920, height: 1080 });
      await servePack(pg);
      await recordEvents(pg);
    },
  });
}

async function expectClassic(page: Page): Promise<void> {
  await expect(page.getByTestId('classic-stage')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('screen-game')).toHaveAttribute('data-layout', 'classic');
}

/** 命运板显示期间，按舞台逻辑坐标 (x, y) 真实点一下（场景根随舞台缩放：按它的屏幕矩形换算） */
async function clickOnFateBoard(page: Page, x: number, y: number): Promise<void> {
  const board = page.locator('[data-testid="fate-popup"][data-phase="board"]');
  await board.waitFor({ state: 'visible', timeout: 30_000 });
  const scene = page.locator('[data-scene="classic"][data-kind="fate"]').first();
  const box = await scene.boundingBox();
  if (!box) throw new Error('命运板场景没有矩形');
  const s = box.width / 640;
  await page.mouse.click(box.x + x * s, box.y + y * s);
}

/** 传送到 (node, prev)、强制骰子 1、按 GO 掷骰；wait 为 false 时按下 GO 就返回（不等本页把这一批演完） */
async function stepOnto(
  page: Page,
  seat: number,
  node: number,
  prev: number,
  o: { wait?: boolean } = {},
): Promise<void> {
  await waitMyTurn(page);
  await acted(page, () => debugAct(page, { op: 'teleport', seat, node, prev }));
  await acted(page, () => debugAct(page, { op: 'forceNext', purpose: 'dice', values: [1] }));
  await waitMyTurn(page);
  if (o.wait === false) await page.getByTestId('action-roll').click();
  else await acted(page, () => page.getByTestId('action-roll').click());
}

test('随机事件的原版画面：命运板贴原版插图；卡片格得卡本人亮真卡、别人只见消息框', async ({ browser }) => {
  test.setTimeout(360_000);
  const a = await classicPlayer(browser, 'P1');
  const b = await classicPlayer(browser, 'P2');
  const w = await classicPlayer(browser, 'W');
  const [A, B, W] = [a.page, b.page, w.page];
  try {
    const code = await createRoom(A, { map: 'test', timer: 'off' });
    await B.goto(`/r/${code}?${Q_ANIM}`);
    await expect(B.getByTestId('screen-room')).toBeVisible();
    await W.goto(`/r/${code}?${Q_ANIM}&watch=1`);
    await pickCharacter(A, 9);
    await pickCharacter(B, 4);
    await setReady(B);
    await startGame(A, [A, B]);
    for (const p of [A, B, W]) await expectClassic(p);

    // ── 命运板：P1 预置命运 3，从 2 号格走到 3 号命运格 ──
    await waitMyTurn(A);
    await acted(A, () => debugAct(A, { op: 'stackDeck', deck: 'fate', ids: [3] }));
    // 掷骰后不等演出结束（acted 会等到本页空闲，那时命运板早已收起）：命运板显示期间点板子顶部（下面是工具列）——
    // P2 点「托管」的位置、观战者点「查询」的位置
    const autoBefore = await B.getByTestId('action-autopilot').getAttribute('aria-pressed');
    await stepOnto(A, 0, 2, 1, { wait: false });
    await Promise.all([clickOnFateBoard(B, 100, 20), clickOnFateBoard(W, 260, 20)]);
    for (const [page, who] of [
      [B, '另一名玩家'],
      [W, '观战者'],
    ] as const) {
      // 只结束自己这一页的命运板（原版 fcn.00452c39：鼠标键放开即结束）
      await expect(page.locator('[data-testid="fate-popup"][data-phase="board"]'), who).toHaveCount(0, {
        timeout: 2_000,
      });
    }
    for (const p of [A, B, W]) await waitIdle(p);
    // 点击没有穿到工具列：托管没切换（切换要经服务器往返，等完这一批再看），资产表没打开
    await expect(B.getByTestId('action-autopilot')).toHaveAttribute('aria-pressed', autoBefore ?? 'false');
    for (const p of [B, W]) await expect(p.getByTestId('classic-assets')).toHaveCount(0);
    for (const [page, who] of [
      [A, '本人'],
      [B, '另一名玩家'],
      [W, '观战者'],
    ] as const) {
      await expect.poll(async () => (await fatesOf(page)).length, { timeout: 30_000, message: who }).toBeGreaterThan(0);
      const seen = await fatesOf(page);
      const board = seen.find((f) => f.phase === 'board');
      expect(board, who).toBeTruthy();
      expect(
        { classic: board!.classic, fate: board!.fate, slot: board!.slot, board: board!.board, key: board!.key },
        who,
      ).toEqual({ classic: true, fate: 3, slot: 3, board: 'ui.newsBoard/1', key: 'illustration.fate.3' });
      expect(board!.bg, who).toBe(`url("${imageUrlOf('illustration.fate.3')}")`);
      // 表情头像：抽到命运的 P1（角色 9）的讲话头像图3（exe 处理函数 3 的参数 0 分支）
      expect(board!.face, who).toBe('portrait.speaker.9/3');
      expect(board!.title.length, who).toBeGreaterThan(0);
    }
    // 40 张命运插图各不相同（合成包按插图号画），上面比对的 URL 因而能区分插图串号
    expect(new Set(Array.from({ length: 40 }, (_, i) => imageUrlOf(`illustration.fate.${i}`))).size).toBe(40);

    // ── 卡片格得卡：P2 从 3 号格走到 4 号卡片格 ──
    await waitMyTurn(B);
    const before = await B.evaluate(
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      () => [...((window as any).__rich4.store.game.getState().view.players[1].cards as number[])],
    );
    await stepOnto(B, 1, 3, 2);
    for (const p of [A, B, W]) await waitIdle(p);
    const after = await B.evaluate(
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      () => [...((window as any).__rich4.store.game.getState().view.players[1].cards as number[])],
    );
    expect(after.length).toBe(before.length + 1);
    const k = after.at(-1)!;
    // 本人：原版亮卡，卡图就是抽到的那一张
    await expect.poll(async () => (await gainsOf(B)).length, { timeout: 30_000 }).toBe(1);
    const mine = (await gainsOf(B))[0]!;
    expect({ classic: mine.classic, card: mine.card, mode: mine.mode, key: mine.key, bg: mine.bg }).toEqual({
      classic: true,
      card: k,
      mode: 'gain',
      key: `card.${k}`,
      bg: `url("${imageUrlOf(`card.${k}`)}")`,
    });
    expect(mine.line).toContain('得到');
    // 别人与观战者：只有消息框，没有卡图、没有卡号（私密手牌）
    for (const [page, who] of [
      [A, '另一名玩家'],
      [W, '观战者'],
    ] as const) {
      await expect.poll(async () => (await gainsOf(page)).length, { timeout: 30_000, message: who }).toBe(1);
      const g = (await gainsOf(page))[0]!;
      expect({ classic: g.classic, card: g.card, mode: g.mode, key: g.key }, who).toEqual({
        classic: true,
        card: null,
        mode: 'gainHidden',
        key: null,
      });
      expect(g.line, who).toMatch(/得到一[张張]卡片/);
    }
    expectNoErrors([a, b, w]);
  } finally {
    for (const p of [a, b, w]) await p.context.close();
  }
});
