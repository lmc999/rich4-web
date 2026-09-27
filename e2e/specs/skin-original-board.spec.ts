// 原版皮肤 A6/A7：合成素材包 + fixture 地图下的原版棋盘（original-skin.md §3 修正 6：CI 覆盖原版渲染路径）。
// 合成包由 `npm run extract -- assets synth` 现场生成到 .cache/synthetic-pack（全是自绘图形，不入库），用 page.route
// 按 manifest 白名单提供 /pack/*，并把 GET /api/access 模拟成「门禁开启且已通过」。
// 同一房间两名真人：A 拿到素材包 → 原版棋盘（OrigRenderer）；B 没有素材包 → 程序化棋盘。两人按同一脚本开局、行走、买地、
// 付过路费，之后断言：两页的测试钩子（角色座位 / 所在格 / 可见性、路面计数）与 HUD 数值一致，且等于服务器下发的 view；
// A 的原版棋盘画出了角色标记（空地已有主），热键 > 旋转一档 45°；全程无报错。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';
import type { PackManifestV1 } from '../../packages/shared/src/assets/pack';
import {
  acted,
  answer,
  createRoom,
  currentSeq,
  debugAct,
  expect,
  hudSnapshot,
  joinRoom,
  newPlayer,
  pickCharacter,
  Q,
  roll,
  SKIN_ORIGINAL,
  serverSnapshot,
  setReady,
  startGame,
  test,
  waitDecision,
  waitIdle,
  waitMyTurn,
  waitSeqAtLeast,
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
  test.setTimeout(120_000);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['run', '--silent', 'extract', '--', 'assets', 'synth', '--out', '.cache/synthetic-pack'], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
  manifest = JSON.parse(readFileSync(join(PACK_DIR, 'manifest.json'), 'utf8')) as PackManifestV1;
  servable = new Map(Object.values(manifest.files).map((f) => [f.path, f.contentType]));
});

/** 按 manifest 白名单提供 /pack/*（其余 404），并模拟门禁已通过 */
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

interface BoardSnap {
  kind: string | null;
  actors: { seat: number; tile: number | null; visible: boolean }[];
  counts: { objects: number; gods: number; beggars: number; villains: number } | null;
}

/** 测试钩子：棋盘表面（两种渲染器同形） */
async function boardSnap(page: Page): Promise<BoardSnap> {
  return page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const r = (window as any).__rich4?.renderer;
    if (!r) return { kind: null, actors: [], counts: null };
    const actors = r.board
      .allActors()
      .map((a: { seat: number; tile: number | null; root: { visible: boolean } }) => ({
        seat: a.seat,
        tile: a.tile,
        visible: a.root.visible,
      }))
      .sort((x: { seat: number }, y: { seat: number }) => x.seat - y.seat);
    return { kind: r.kind as string, actors, counts: r.board.roads.counts() };
  });
}

/** 服务器 view 里的角色位置（与 boardSnap.actors 同形） */
async function serverActors(page: Page): Promise<BoardSnap['actors']> {
  return page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const v = (window as any).__rich4.store.game.getState().latest;
    return v.players
      .map((p: { seat: number; node: number; placed: boolean }) => ({
        seat: p.seat,
        tile: p.node > 0 ? p.node : null,
        visible: p.placed && p.node > 0,
      }))
      .sort((x: { seat: number }, y: { seat: number }) => x.seat - y.seat);
  });
}

/** 让 seat 从 (node, prev) 出发、强制掷出 1 点 */
async function stepFrom(page: Page, seat: number, node: number, prev: number): Promise<void> {
  await waitMyTurn(page);
  await acted(page, () => debugAct(page, { op: 'teleport', seat, node, prev }));
  await acted(page, () => debugAct(page, { op: 'forceNext', purpose: 'dice', values: [1] }));
  await waitMyTurn(page);
  await acted(page, () => roll(page));
}

async function finishTurn(page: Page, choice: 'confirm' | 'decline', expectKind?: string): Promise<void> {
  if (expectKind) {
    await waitDecision(page, [expectKind]);
    await acted(page, () => answer(page, choice));
  }
  await waitIdle(page);
}

// 一页原版、一页程序化：B 页靠「服务器没有素材包」得到程序化棋盘，原版皮肤配置（服务器挂合成包）下不适用
test.skip(SKIN_ORIGINAL, '需要不带素材包的服务器（默认配置）');

test('合成素材包：原版棋盘开局、行走、买地；测试钩子与 HUD 数值和程序化棋盘一致', async ({ browser }) => {
  test.setTimeout(240_000);
  const failed: string[] = [];
  const a = await newPlayer(browser, '原版', Q, {
    setup: async (pg) => {
      pg.on('response', (r) => {
        if (r.status() >= 400) failed.push(`${r.status()} ${new URL(r.url()).pathname}`);
      });
      await servePack(pg);
    },
  });
  const b = await newPlayer(browser, '程序', Q);
  try {
    const code = await createRoom(a.page, { map: 'test', timer: 'off' });
    await joinRoom(b.page, code);
    await pickCharacter(a.page, 9);
    await pickCharacter(b.page, 4);
    await setReady(b.page);
    await startGame(a.page, [a.page, b.page]);

    // A：原版棋盘；B：程序化棋盘
    await expect.poll(async () => (await boardSnap(a.page)).kind, { timeout: 30_000 }).toBe('original');
    await expect(a.page.getByTestId('board-host')).toHaveAttribute('data-skin', 'original');
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const skin = await a.page.evaluate(() => (window as any).__rich4.skin);
    expect(skin).toMatchObject({ boardInUse: 'original', resolution: { skin: 'original', board: 'original' } });
    expect((await boardSnap(b.page)).kind).toBe('procedural');

    // 第 1 轮：A（座位 0）从 4 号格走 1 步到 5 号格买下 L1；B（座位 1）走到 L1 付过路费
    await stepFrom(a.page, 0, 4, 3);
    await finishTurn(a.page, 'confirm', 'BUY_LAND');
    await stepFrom(b.page, 1, 4, 3);
    await finishTurn(b.page, 'decline');

    const seq = await currentSeq(a.page);
    for (const p of [a.page, b.page]) await waitSeqAtLeast(p, seq);

    // HUD：两页一致且等于服务器 view
    const [ha, hb] = await Promise.all([hudSnapshot(a.page), hudSnapshot(b.page)]);
    expect(ha.lots.L1).toEqual({ owner: '0', level: '0' });
    expect(ha).toEqual(hb);
    expect(ha).toEqual(await serverSnapshot(a.page));
    expect(Number(ha.players['1']!.cash)).toBeLessThan(100_000);

    // 测试钩子：角色座位 / 所在格 / 可见性与路面计数，两种渲染器一致，且等于服务器 view
    await expect.poll(async () => (await boardSnap(a.page)).actors).toEqual(await serverActors(a.page));
    const [sa, sb] = await Promise.all([boardSnap(a.page), boardSnap(b.page)]);
    expect(sa.actors).toEqual(sb.actors);
    expect(sa.counts).toEqual(sb.counts);
    expect(sa.actors.find((x) => x.seat === 0)?.tile).toBe(5);

    // 原版棋盘：L1 空地已有主 → 角色标记；热键 > 旋转一档（45°）
    const marks = await a.page.evaluate(
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      () => (window as any).__rich4.renderer.sceneStats().marks as number,
    );
    expect(marks).toBe(1);
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const rotation = () => a.page.evaluate(() => (window as any).__rich4.renderer.rotation as number);
    expect(await rotation()).toBe(0);
    // 焦点不能停在按钮上（热键在输入框 / 按钮上不处理）
    await a.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await a.page.keyboard.press('>');
    await expect.poll(rotation).toBe(1);
    await a.page.keyboard.press('<');
    await expect.poll(rotation).toBe(0);

    expect(failed).toEqual([]);
    for (const p of [a, b]) {
      expect(
        p.errors.filter((e) => !e.includes('WebGL') && !e.includes('favicon')),
        p.nickname,
      ).toEqual([]);
    }
  } finally {
    await a.context.close();
    await b.context.close();
  }
});
