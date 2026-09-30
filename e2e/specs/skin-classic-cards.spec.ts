// 原版皮肤：亮卡的卡片插画（original-skin.md §4.2「亮卡」；exe v2.06 fcn.00440bac）。合成素材包（tools/extract 的
// syntheticUi：按逻辑键自绘的假图，card.<k> 画的是卡号 k）经 page.route 提供，GET /api/access 模拟成「门禁开启且已通过」，
// 与 skin-classic-dialogs 同一种供包方式（默认配置与原版皮肤配置下都能跑）。
// 两名真人（都走演出路径）+ 一名观战者：P1 用 debug:act 拿到 均富、转向、查税、乌龟、陷害 五张卡，P2 拿免罪卡；
// P1 依次在卡片欄点卡、选目标、使用，陷害 P2 时 P2 的免罪卡自动生效（被动卡亮卡）。三个页面各自记下出现过的每一个亮卡
// 弹窗（MutationObserver），断言：
// - 每张卡在本人页、另一名玩家页、观战页都亮了卡，而且是原版画面（data-classic），不是程序化卡面；
// - 插画的素材键 = card.<卡号>，背景图 = 素材包里 card.<卡号> 那个文件（卡号 → 键 → 文件逐张一致，没有串号）；
// - 出卡是「使用」句式、免罪卡是「生效」句式；插画在消息框下方 (138,200)。
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
  playTurn,
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

/** 页面里出现过的亮卡弹窗（按出现顺序；同一个弹窗的背景图晚一拍才设上，属性变化时刷新） */
interface CastSeen {
  card: number;
  variant: string | null;
  mode: string | null;
  classic: boolean;
  key: string | null;
  src: string | null;
  bg: string;
  line: string;
  artLeft: string;
  artTop: string;
}

/** 在页面脚本之前装上记录器：window.__castSeen */
async function recordCasts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: unknown[] = [];
    const idx = new WeakMap<Element, number>();
    (window as unknown as { __castSeen: unknown[] }).__castSeen = seen;
    const scan = (): void => {
      for (const el of document.querySelectorAll('[data-testid="card-cast-popup"]')) {
        const art = el.querySelector<HTMLElement>('[data-testid="card-cast-art"]');
        const h = el as HTMLElement;
        const row = {
          card: Number(h.dataset.card),
          variant: h.dataset.variant ?? null,
          mode: h.dataset.mode ?? null,
          classic: !!el.closest('[data-classic="true"]'),
          key: art?.dataset.assetKey ?? null,
          src: art?.dataset.src ?? null,
          bg: art?.style.backgroundImage ?? '',
          line: el.querySelector('[data-testid="card-cast-line"]')?.textContent ?? '',
          artLeft: art?.style.left ?? '',
          artTop: art?.style.top ?? '',
        };
        const i = idx.get(el);
        if (i === undefined) {
          idx.set(el, seen.length);
          seen.push(row);
        } else if (row.bg) seen[i] = row;
      }
    };
    new MutationObserver(scan).observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'data-src'],
    });
  });
}

async function castsOf(page: Page): Promise<CastSeen[]> {
  return page.evaluate(() => (window as unknown as { __castSeen: CastSeen[] }).__castSeen);
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
      await recordCasts(pg);
    },
  });
}

async function expectClassic(page: Page): Promise<void> {
  await expect(page.getByTestId('classic-stage')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('screen-game')).toHaveAttribute('data-layout', 'classic');
}

/** 卡片在本人决策（TURN_MENU）里的卡槽 */
async function slotOf(page: Page, card: number): Promise<number> {
  return page.evaluate((c) => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const d = (window as any).__rich4.store.game.getState().decision;
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    return d.options.cards.find((r: any) => r.card === c).slot as number;
  }, card);
}

/** 卡片欄点卡 → 原版目标面板选目标（pick 为 null 时不用选）→ 使用；等本页演出播完 */
async function useCard(page: Page, card: number, pick: string | null): Promise<void> {
  await waitMyTurn(page);
  // 上一次用卡后收起的回合菜单可能还在退场（同名但禁用的格子），等它卸载再展开
  await expect(page.locator('[data-scene][data-testid$="-exit"]')).toHaveCount(0);
  await page.getByTestId('action-cards').click();
  const menu = page.locator('[data-testid="decision-TURN_MENU"][data-scene="classic"]');
  await expect(menu).toHaveAttribute('data-tab', 'cards');
  const cell = menu.getByTestId(`inv-card-${await slotOf(page, card)}`);
  await expect(cell).toBeEnabled();
  await cell.click();
  const picker = menu.getByTestId('target-picker');
  await expect(picker).toBeVisible();
  if (pick) await picker.getByTestId(pick).click();
  await acted(page, () => page.getByTestId('target-confirm').click());
  await waitIdle(page);
}

test('亮卡：本人、另一名玩家、观战者看到的卡片插画都是 card.<卡号> 那一张（出卡 5 张 + 免罪卡被动生效）', async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const a = await classicPlayer(browser, 'P1');
  const b = await classicPlayer(browser, 'P2');
  const w = await classicPlayer(browser, 'W');
  const [A, B, W] = [a.page, b.page, w.page];
  try {
    const code = await createRoom(A, { map: 'test', timer: 'off' });
    // P2 与观战页都走演出路径（joinRoom 固定带 anim=instant，这里自己进房）
    await B.goto(`/r/${code}?${Q_ANIM}`);
    await expect(B.getByTestId('screen-room')).toBeVisible();
    await W.goto(`/r/${code}?${Q_ANIM}&watch=1`);
    await pickCharacter(A, 9);
    await pickCharacter(B, 4);
    await setReady(B);
    await startGame(A, [A, B]);
    for (const p of [A, B, W]) await expectClassic(p);

    // 第 1 轮：两人走到相邻的格子（P1 13 号点券格、P2 12 号），第 2 轮 P1 的目标都在视窗内
    await playTurn(A, 0, { node: 12, prev: 11 });
    await playTurn(B, 1, { node: 11, prev: 10 });

    // 第 2 轮：P1 拿 5 张卡、P2 拿免罪卡
    await waitMyTurn(A);
    await acted(A, () => debugAct(A, { op: 'give', seat: 0, cards: [1, 6, 26, 30, 17], items: [] }));
    await acted(A, () => debugAct(A, { op: 'give', seat: 1, cards: [21], items: [] }));
    await waitMyTurn(A);

    const plays: { card: number; pick: string | null }[] = [
      { card: 1, pick: null },
      { card: 6, pick: 'target-actor-seat-1' },
      { card: 26, pick: 'target-seat-1' },
      { card: 30, pick: 'target-actor-seat-1' },
      { card: 17, pick: 'target-actor-seat-1' },
    ];
    for (const { card, pick } of plays) await useCard(A, card, pick);
    for (const p of [B, W]) await waitIdle(p);

    // 陷害 P2 → P2 的免罪卡自动生效（被动卡亮卡）
    const expected = [
      ...plays.map((x) => ({ card: x.card, variant: 'cast', mode: 'use' })),
      { card: 21, variant: 'passive', mode: 'passive' },
    ];
    for (const [page, who] of [
      [A, '本人'],
      [B, '另一名玩家'],
      [W, '观战者'],
    ] as const) {
      await expect
        .poll(async () => (await castsOf(page)).map((c) => c.card).sort((x, y) => x - y), { timeout: 30_000 })
        .toEqual(expected.map((x) => x.card).sort((x, y) => x - y));
      const seen = await castsOf(page);
      for (const want of expected) {
        const got = seen.find((c) => c.card === want.card);
        expect(got, `${who} 卡 ${want.card}`).toBeTruthy();
        expect(
          {
            classic: got!.classic,
            variant: got!.variant,
            mode: got!.mode,
            key: got!.key,
            src: got!.src,
            bg: got!.bg,
            at: [got!.artLeft, got!.artTop],
          },
          `${who} 卡 ${want.card}`,
        ).toEqual({
          classic: true,
          variant: want.variant,
          mode: want.mode,
          key: `card.${want.card}`,
          src: imageUrlOf(`card.${want.card}`),
          bg: `url("${imageUrlOf(`card.${want.card}`)}")`,
          at: ['138px', '200px'],
        });
        // 句式：出卡「<名>\n\n使用XX卡」、免罪卡「<名>\n\nXX卡生效！」（繁体界面，这两个词繁简同形）
        expect(got!.line, `${who} 卡 ${want.card}`).toContain(want.mode === 'passive' ? '生效' : '使用');
      }
    }
    // 30 张插画文件各不相同（合成包按卡号画），上面比对的 URL 因而能区分串号
    expect(new Set(Array.from({ length: 30 }, (_, i) => imageUrlOf(`card.${i + 1}`))).size).toBe(30);
    // 陷害被免罪抵消：P2 没进监狱
    const jail = await W.evaluate(
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      () => (window as any).__rich4.store.game.getState().view.players[1].st.jail as number,
    );
    expect(jail).toBe(0);
    expectNoErrors([a, b, w]);
  } finally {
    for (const p of [a, b, w]) await p.context.close();
  }
});
