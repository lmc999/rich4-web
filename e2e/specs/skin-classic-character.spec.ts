// 原版皮肤：选人 → 进局的角色一致性（回归：线上反馈「选的是忍太郎，头像却是金贝贝」）。合成素材包 + fixture 地图
// （与 skin-classic-screens 同一种供包方式：page.route 按 manifest 白名单提供 /pack/*，GET /api/access 模拟成「门禁开启且
// 已通过」）。根因：选人画面单击头像 / ◀ ▶ 只移动光标（预览、名字、侧视走动都换成该角色），没点「选这个」就按 OK 时，
// 服务器给没选角色的座位随机分配。现在单击头像即选定、OK / 准备前先提交光标上的角色。合成包的图是按键生成的假图，
// 断言落在「用了哪个键 / 帧」上：
// - 房主用 ▶ 翻到忍太郎（2）、不点「選這個」直接 OK；P2 单击金貝貝（11）的格子后准备；
// - 服务器认定的 characterId、左栏座位条头像（portrait.face72/c）与名字、右侧资料栏大头像、棋盘角色姿态库（char.<c>.*）、
//   买地场景的讲话头像（portrait.speaker.<c>）都与所选角色一致。
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
  joinRoom,
  newPlayer,
  type Player,
  Q,
  setReady,
  startGame,
  test,
  waitDecision,
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

async function classicPlayer(browser: Parameters<typeof newPlayer>[0], nick: string): Promise<Player> {
  return newPlayer(browser, nick, Q, {
    setup: async (pg) => {
      await pg.setViewportSize({ width: 1920, height: 1080 });
      await servePack(pg);
    },
  });
}

/** 服务器认定的「座位 → 角色号」（对局 view） */
async function characters(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const v = (window as any).__rich4.store.game.getState().view;
    const out: Record<string, number> = {};
    for (const p of v.players) out[String(p.seat)] = p.character;
    return out;
  });
}

/** 棋盘上某座位角色当前用的姿态库逻辑键 */
async function poseKey(page: Page, seat: number): Promise<string | null> {
  return page.evaluate(
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    (s) => (window as any).__rich4.renderer?.board.actor(s)?.poseKey ?? null,
    seat,
  );
}

test('选人：只移动光标就按 OK 也按光标上的角色开局；单击头像即选定；进局后各处的素材键与所选角色一致', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const a = await classicPlayer(browser, 'P1');
  const b = await classicPlayer(browser, 'P2');
  const [A, B] = [a.page, b.page];
  try {
    const code = await createRoom(A, { map: 'test', timer: 'off' });
    await joinRoom(B, code);
    await expect(A.getByTestId('screen-room')).toHaveAttribute('data-screen', 'select');

    // 房主：▶ 翻两格到忍太郎——预览、名字、走动都是忍太郎，但还没提交（座位牌空、按钮是「選這個」）
    await A.getByTestId('char-next').click();
    await A.getByTestId('char-next').click();
    await expect(A.getByTestId('char-preview-name')).toHaveText('忍太郎');
    await expect(A.getByTestId('char-walker')).toHaveAttribute('data-sheet', 'title.sidewalk.2.walk');
    await expect(A.getByTestId('char-select')).toHaveText('選這個');
    await expect(A.getByTestId('classic-seat-0').locator('[data-sprite]')).toHaveCount(0);

    // P2：单击金貝貝的格子即选定（座位牌与房主那边的格子立即反映）
    await B.getByTestId('char-11').click();
    await expect(B.getByTestId('char-select')).toHaveText('已選擇');
    await expect(B.getByTestId('char-11')).toHaveAttribute('data-mine', 'true');
    await expect(A.getByTestId('char-11')).toHaveAttribute('data-taken', 'true');
    await expect(A.getByTestId('classic-seat-1').locator('[data-sprite]')).toHaveAttribute(
      'data-sprite',
      'portrait.face72/11',
    );
    await setReady(B);

    // 房主直接 OK：先提交光标上的忍太郎再开局
    await startGame(A, [A, B], { clearBoard: false });
    for (const p of [A, B]) expect(await characters(p)).toEqual({ '0': 2, '1': 11 });

    for (const p of [A, B]) {
      // 左栏座位条：头像帧与名字
      await expect(p.getByTestId('chip-0').locator('[data-sprite^="portrait.face72/"]')).toHaveAttribute(
        'data-sprite',
        'portrait.face72/2',
      );
      await expect(p.getByTestId('chip-0')).toContainText('忍太郎');
      await expect(p.getByTestId('chip-1').locator('[data-sprite^="portrait.face72/"]')).toHaveAttribute(
        'data-sprite',
        'portrait.face72/11',
      );
      await expect(p.getByTestId('chip-1')).toContainText('金貝貝');
      // 棋盘角色：姿态库 char.<c>.*
      await expect.poll(() => poseKey(p, 0)).toMatch(/^char\.2\./);
      await expect.poll(() => poseKey(p, 1)).toMatch(/^char\.11\./);
    }

    // 右侧资料栏大头像：跟随当前行动者（1P 忍太郎）；点左栏 2P 查看金貝貝
    await waitMyTurn(A);
    const avatar = A.getByTestId('classic-avatar');
    await expect(avatar).toHaveAttribute('data-character', '2');
    await expect(avatar.locator('[data-sprite]')).toHaveAttribute('data-sprite', 'portrait.face72/2');
    await expect(A.getByTestId('classic-profile-name')).toHaveText('忍太郎');
    await A.getByTestId('chip-1').click();
    await expect(avatar).toHaveAttribute('data-character', '11');
    await expect(avatar.locator('[data-sprite]')).toHaveAttribute('data-sprite', 'portrait.face72/11');
    await expect(A.getByTestId('classic-profile-name')).toHaveText('金貝貝');
    await A.getByTestId('chip-1').click();

    // 买地场景的讲话头像：portrait.speaker.2（先收走开局随机摆在路上的神明、礼物、宝箱：开局时没收，强制 1 点的路线
    // 偶尔被它们打断——曾有一次失败截图里 1P 带着住院标记、回合直接交给 2P，买地没出现）
    await acted(A, () => debugAct(A, { op: 'clearBoard' }));
    await acted(A, () => debugAct(A, { op: 'teleport', seat: 0, node: 4, prev: 3 }));
    await acted(A, () => debugAct(A, { op: 'forceNext', purpose: 'dice', values: [1] }));
    await waitMyTurn(A);
    await acted(A, () => A.getByTestId('action-roll').click());
    await waitDecision(A, ['BUY_LAND']);
    const speaker = A.locator('[data-testid="decision-BUY_LAND"][data-scene="classic"]').getByTestId(
      'classic-buy-speaker',
    );
    await expect(speaker).toHaveAttribute('data-character', '2');
    await expect(speaker.locator('[data-sprite="portrait.speaker.2/0"]')).toHaveCount(1);
    expectNoErrors([a, b]);
  } finally {
    for (const p of [a, b]) await p.context.close();
  }
});
