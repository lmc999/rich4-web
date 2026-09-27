// 原版皮肤 A8：原版舞台（OrigStage）在合成素材包下的 4 页面一致性（original-skin.md §3 修正 6、§5 A8）。
// 合成包由 `npm run extract -- assets synth` 现场生成到 .cache/synthetic-pack（全是自绘图形，不入库）；本用例再现场编码几段
// 自绘的合成 FLC（64×64 色块，帧数与帧间隔同 shared/view/pacing 的原版时长）和一张 flic-map，并入 manifest（重算哈希路径与
// packId），用 page.route 按白名单提供 /pack/*，GET /api/access 模拟成「门禁开启且已通过」。4 个页面都用原版棋盘：
// 1) cards 类：买地、点券格、购地卡、陷害卡（警车）、路障、拆除卡、均富卡——每一步 4 页面的 HUD 与服务器 view 一致，
//    显示态与棋盘舞台（路面物件数、关押外观）一致；P4 走演出路径（不带 anim=instant），原版舞台取用了合成 FLIC（点券、警车）；
// 2) events 类：新闻、命运、魔法屋——4 页面 HUD / 显示态 / 日志一致，P4 的演出弹窗出现；
// 全程无报错（handler 出错、看门狗中止都算失败）。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from '@playwright/test';
import { buildFlc } from '../../apps/client/src/skin/flic/testing/flcBuilder';
import { ASSET_SCHEMA, hashedPath } from '../../packages/shared/src/assets/common';
import type { FlicInfo, FlicMapV1 } from '../../packages/shared/src/assets/media';
import {
  DATA_KEYS,
  type PackManifestV1,
  safeParsePackManifest,
  withPackId,
} from '../../packages/shared/src/assets/pack';
import { ORIGINAL_FLICS } from '../../packages/shared/src/view/pacing';
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
  pickReadyStart,
  playTurn,
  Q,
  Q_ANIM,
  roll,
  serverSnapshot,
  syncPages,
  test,
  waitDecision,
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

/** 合成 FLIC 的边长（摆放用「角色旁」，以锚点为中心） */
const FLIC_PX = 64;
/** 并入的合成 FLIC：原版舞台在 cards / events 场景里会用到的几段 */
const FLICS = [
  ORIGINAL_FLICS.policeCar,
  ORIGINAL_FLICS.ambulance,
  ORIGINAL_FLICS.pointsGain,
  ORIGINAL_FLICS.cardGain,
  ORIGINAL_FLICS.explosionSmall,
  ORIGINAL_FLICS.godLeave,
];
const flicPath = (use: string): string => `flic/e2e/${use.replace(/\./g, '-')}.flc`;

let manifest: PackManifestV1;
/** 实际路径 → 内容类型与内容（合成包文件按需读盘，合成 FLIC 与 flic-map 在内存里） */
let servable: Map<string, { type: string; body: () => Buffer }>;

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** 编码一段合成 FLC：每帧整块换一个颜色（调色板写在首帧），左上角一个透明像素 */
function fakeFlc(frames: number, frameMs: number): Buffer {
  const palette = new Uint8Array(768);
  for (let i = 1; i < 256; i++) {
    palette[i * 3] = (i * 53) & 255;
    palette[i * 3 + 1] = (i * 97) & 255;
    palette[i * 3 + 2] = (i * 151) & 255;
  }
  return Buffer.from(
    buildFlc({
      width: FLIC_PX,
      height: FLIC_PX,
      speed: frameMs,
      frames: Array.from({ length: frames }, (_, f) => {
        const pixels = new Uint8Array(FLIC_PX * FLIC_PX).fill(1 + (f % 250));
        pixels[0] = 0;
        return { pixels, encoding: 'byterun' as const, ...(f === 0 ? { palette } : {}) };
      }),
    }),
  );
}

/** 合成包 manifest 并入合成 FLIC 与 flic-map（fx.board / data 两个组），重算 packId；通过与 PackClient 相同的校验 */
function withFlics(base: PackManifestV1): { m: PackManifestV1; extra: Map<string, Buffer> } {
  const extra = new Map<string, Buffer>();
  const files: PackManifestV1['files'] = { ...base.files };
  const entries: PackManifestV1['entries'] = { ...base.entries };
  const addFile = (
    lp: string,
    kind: 'flic' | 'data',
    type: 'application/octet-stream' | 'application/json',
    body: Buffer,
  ) => {
    const h = sha(body);
    const path = hashedPath(lp, h);
    files[lp] = { path, bytes: body.length, sha256: h, kind, contentType: type };
    extra.set(path, body);
    return body.length;
  };
  const flics: Record<string, FlicInfo> = {};
  const fxFiles: string[] = [];
  let fxBytes = 0;
  for (const f of FLICS) {
    const key = `flic.e2e.${f.use}`;
    const lp = flicPath(f.use);
    fxBytes += addFile(lp, 'flic', 'application/octet-stream', fakeFlc(f.frames, f.frameMs));
    fxFiles.push(lp);
    entries[key] = {
      type: 'flic',
      group: 'fx.board',
      confidence: 'exe',
      src: ['e2e'],
      file: lp,
      w: FLIC_PX,
      h: FLIC_PX,
      frames: f.frames,
      frameMs: f.frameMs,
      durationMs: f.frames * f.frameMs,
      transparency: 'index0',
      sfx: null,
    };
    flics[key] = {
      uses: [f.use],
      w: FLIC_PX,
      h: FLIC_PX,
      frames: f.frames,
      frameMs: f.frameMs,
      durationMs: f.frames * f.frameMs,
      sfx: null,
      opaque: false,
      trim: null,
      placement: { kind: 'actor' },
      confidence: 'exe',
      src: ['e2e'],
    };
  }
  const map: FlicMapV1 = { schema: ASSET_SCHEMA.flicMap, flics, src: ['e2e'] };
  const dataLp = 'data/e2e-flic-map.json';
  const dataBytes = addFile(dataLp, 'data', 'application/json', Buffer.from(JSON.stringify(map)));
  entries[DATA_KEYS.flicMap] = {
    type: 'data',
    group: 'data',
    confidence: 'exe',
    src: ['e2e'],
    file: dataLp,
    schema: ASSET_SCHEMA.flicMap,
  };
  const groups: PackManifestV1['groups'] = {
    ...base.groups,
    'fx.board': { category: 'fx', provenance: 'synthetic', files: fxFiles.sort(), bytes: fxBytes },
    data: { category: 'data', provenance: 'synthetic', files: [dataLp], bytes: dataBytes },
  };
  const { packId: _old, ...rest } = base;
  const m = withPackId({ ...rest, features: { ...base.features, fx: true }, groups, files, entries });
  const r = safeParsePackManifest(JSON.parse(JSON.stringify(m)));
  if (!r.ok) throw new Error(`合成 manifest 校验失败：${r.issues.slice(0, 3).join('; ')}`);
  return { m, extra };
}

test.beforeAll(() => {
  test.setTimeout(120_000);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npm, ['run', '--silent', 'extract', '--', 'assets', 'synth', '--out', '.cache/synthetic-pack'], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
  const base = JSON.parse(readFileSync(join(PACK_DIR, 'manifest.json'), 'utf8')) as PackManifestV1;
  const { m, extra } = withFlics(base);
  manifest = m;
  servable = new Map();
  for (const f of Object.values(m.files)) {
    const mem = extra.get(f.path);
    servable.set(f.path, { type: f.contentType, body: mem ? () => mem : () => readFileSync(join(PACK_DIR, f.path)) });
  }
});

/** 按 manifest 白名单提供 /pack/*（其余 404），并模拟门禁已通过；记下请求过的合成 FLIC */
function servePack(flicRequests: string[]): (page: Page) => Promise<void> {
  return async (page) => {
    await page.route('**/pack/**', async (route: Route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/pack/manifest.json')
        return route.fulfill({ json: manifest, headers: { 'cache-control': 'no-cache' } });
      const rel = decodeURIComponent(path.slice('/pack/'.length));
      const f = servable.get(rel);
      if (!f) return route.fulfill({ status: 404, json: { ok: false, error: { code: 'BAD_REQUEST' } } });
      if (rel.startsWith('flic/e2e/')) flicRequests.push(rel);
      return route.fulfill({ status: 200, contentType: f.type, body: f.body() });
    });
    await page.route('**/api/access', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: ACCESS_ON }) : route.fallback(),
    );
  };
}

/** 4 个页面都拿到原版棋盘 */
async function expectOriginalBoards(pages: Page[]): Promise<void> {
  for (const p of pages) {
    await expect
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      .poll(() => p.evaluate(() => (window as any).__rich4?.renderer?.kind ?? null), { timeout: 30_000 })
      .toBe('original');
    await expect(p.getByTestId('board-host')).toHaveAttribute('data-skin', 'original');
  }
}

/** 显示态里的路面物件、关押、手牌数与附身神明，加上原版舞台实际画出的路面物件数与关押外观 */
async function combatState(page: Page): Promise<{
  objects: { kind: string; node: number }[];
  players: { seat: number; node: number; jail: number; hospital: number; cardCount: number; god: number | null }[];
  stage: { kind: string | null; objects: number; confined: (string | null)[]; visible: boolean[] };
}> {
  return page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const h = (window as any).__rich4;
    const v = h.store.game.getState().view;
    const r = h.renderer;
    const board = r?.board;
    return {
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      objects: v.objects.map((o: any) => ({ kind: o.kind, node: o.node })),
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      players: v.players.map((p: any) => ({
        seat: p.seat,
        node: p.node,
        jail: p.st.jail,
        hospital: p.st.hospital,
        cardCount: p.cardCount,
        god: p.god?.kind ?? null,
      })),
      stage: {
        kind: r?.kind ?? null,
        objects: board ? board.roads.counts().objects : -1,
        // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
        confined: v.players.map((p: any) => board?.actor(p.seat)?.currentStatus.confined?.where ?? null),
        // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
        visible: v.players.map((p: any) => board?.actor(p.seat)?.root.visible ?? false),
      },
    };
  });
}

type Combat = Awaited<ReturnType<typeof combatState>>;

function expectStageMatches(s: Combat): void {
  expect(s.stage.kind).toBe('original');
  expect(s.stage.objects).toBe(s.objects.length);
  expect(s.stage.confined).toEqual(
    s.players.map((p) => (p.jail !== 0 ? 'jail' : p.hospital !== 0 ? 'hospital' : null)),
  );
}

/** 4 页面追上同一 seq；HUD 与服务器快照一致，对抗状态与舞台一致 */
async function consistentCombat(pages: Page[]) {
  await syncPages(pages);
  const huds = await Promise.all(pages.map((p) => hudSnapshot(p)));
  const server = await serverSnapshot(pages[0]!);
  for (const h of huds) expect(h).toEqual(server);
  const states = await Promise.all(pages.map((p) => combatState(p)));
  for (const s of states) {
    expect(s).toEqual(states[0]);
    expectStageMatches(s);
  }
  return { hud: server, state: states[0]! };
}

async function slotOf(page: Page, card: number): Promise<number> {
  const slot = await page.evaluate((c) => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const d = (window as any).__rich4.store.game.getState().decision;
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const row = d?.kind === 'TURN_MENU' ? d.options.cards.find((r: any) => r.card === c) : null;
    return row ? (row.slot as number) : -1;
  }, card);
  expect(slot, `card ${card} not in menu`).toBeGreaterThanOrEqual(0);
  return slot;
}

async function use(
  page: Page,
  sheet: 'cards' | 'items',
  tile: string,
  pick?: (picker: ReturnType<Page['getByTestId']>) => Promise<void>,
): Promise<void> {
  await waitMyTurn(page);
  await page.getByTestId(`action-${sheet}`).click();
  const btn = page.getByTestId(tile);
  await expect(btn).toBeEnabled();
  await btn.click();
  const picker = page.getByTestId('target-picker');
  await expect(picker).toBeVisible();
  if (pick) await pick(picker);
  await acted(page, () => page.getByTestId('target-confirm').click());
  await waitIdle(page);
  await waitMyTurn(page);
}

/** 3 个 anim=instant 页面 + 1 个演出页（P4），全部拿到合成素材包 */
async function fourOriginalPlayers(
  browser: Parameters<typeof newPlayer>[0],
  flicRequests: string[],
): Promise<Player[]> {
  const players: Player[] = [];
  for (let i = 1; i <= 3; i++) players.push(await newPlayer(browser, `P${i}`, Q, { setup: servePack([]) }));
  players.push(await newPlayer(browser, 'P4', Q_ANIM, { setup: servePack(flicRequests) }));
  return players;
}

async function openRoom(players: Player[]): Promise<Page[]> {
  const pages = players.map((p) => p.page);
  const [a, b, c, d] = pages as [Page, Page, Page, Page];
  const code = await createRoom(a, { map: 'test', timer: 'off' });
  for (const p of [b, c]) await joinRoom(p, code);
  await d.goto(`/r/${code}?${Q_ANIM}`);
  await expect(d.getByTestId('screen-room')).toBeVisible();
  await pickReadyStart(pages);
  await expectOriginalBoards(pages);
  return pages;
}

test('cards 类（原版舞台）：买地、点券、购地 / 陷害 / 拆除 / 均富卡与路障，4 个页面结果一致', async ({ browser }) => {
  test.setTimeout(300_000);
  const flicRequests: string[] = [];
  const players = await fourOriginalPlayers(browser, flicRequests);
  try {
    const pages = await openRoom(players);
    const [a, b, c, d] = pages as [Page, Page, Page, Page];

    // 第 1 轮：P2 停在 L1 买地，其余人去点券格（P4 的演出页播放点券 FLIC）
    await playTurn(a, 0, { node: 12, prev: 11, dice: 1 });
    await playTurn(b, 1, { node: 4, prev: 3, dice: 1, choice: 'confirm' });
    await playTurn(c, 2, { node: 12, prev: 11, dice: 1 });
    await playTurn(d, 3, { node: 12, prev: 11, dice: 1 });
    let snap = await consistentCombat(pages);
    expect(snap.hud.lots.L1?.owner).toBe('1');
    expect(flicRequests.some((r) => r.startsWith(flicPath(ORIGINAL_FLICS.pointsGain.use).replace(/\.flc$/, '')))).toBe(
      true,
    );

    // 第 2 轮：P1 传送到 L1，发 购地、陷害、拆除、均富 与 1 个路障
    await waitMyTurn(a);
    await acted(a, () => debugAct(a, { op: 'teleport', seat: 0, node: 5, prev: 4 }));
    await acted(a, () => debugAct(a, { op: 'give', seat: 0, cards: [3, 17, 12, 1], items: [{ item: 2, qty: 1 }] }));
    await waitMyTurn(a);
    await syncPages(pages);

    await use(a, 'cards', `inv-card-${await slotOf(a, 3)}`);
    snap = await consistentCombat(pages);
    expect(snap.hud.lots.L1?.owner).toBe('0');

    // 陷害卡：P2 入狱（P4 的演出页播放警车 FLIC），4 页面都显示原版关押外观
    await use(a, 'cards', `inv-card-${await slotOf(a, 17)}`, async (picker) => {
      await picker.getByTestId('target-actor-seat-1').click();
    });
    snap = await consistentCombat(pages);
    expect(snap.state.players[1]!.jail).toBeGreaterThan(0);
    expect(snap.state.stage.confined[1]).toBe('jail');
    expect(flicRequests.some((r) => r.startsWith(flicPath(ORIGINAL_FLICS.policeCar.use).replace(/\.flc$/, '')))).toBe(
      true,
    );

    await use(a, 'items', 'inv-item-2', async (picker) => {
      await picker.locator('[data-testid^="target-node-"]').first().click();
    });
    snap = await consistentCombat(pages);
    expect(snap.state.objects.filter((o) => o.kind === 'roadblock')).toHaveLength(1);

    await use(a, 'cards', `inv-card-${await slotOf(a, 12)}`, async (picker) => {
      await picker.locator('[data-testid^="target-object-"]').first().click();
    });
    snap = await consistentCombat(pages);
    expect(snap.state.objects.filter((o) => o.kind === 'roadblock')).toHaveLength(0);

    await use(a, 'cards', `inv-card-${await slotOf(a, 1)}`);
    snap = await consistentCombat(pages);
    const cashes = Object.values(snap.hud.players).map((p) => Number(p.cash));
    expect(Math.max(...cashes) - Math.min(...cashes)).toBeLessThanOrEqual(1);

    await acted(a, () => a.getByTestId('action-roll').click());
    await waitIdle(a);
    await consistentCombat(pages);
    // 演出弹窗都已收起，FLIC 精灵不残留
    await expect(d.getByTestId('popup')).toHaveCount(0);
    const leftover = await d.evaluate(
      () =>
        // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
        ((window as any).__rich4.renderer.layers.overlay.children as { label?: string }[]).filter((x) =>
          (x.label ?? '').startsWith('flic:'),
        ).length,
    );
    expect(leftover).toBe(0);
    expectNoErrors(players);
  } finally {
    for (const p of players) await p.context.close();
  }
});

/** 显示态里与事件格相关的部分（HUD 同源）与日志 */
async function eventState(page: Page): Promise<{
  players: { seat: number; node: number; cash: number; deposit: number; cardCount: number }[];
  log: string[];
  stage: string | null;
}> {
  return page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const h = (window as any).__rich4;
    const g = h.store.game.getState();
    return {
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      players: g.view.players.map((p: any) => ({
        seat: p.seat,
        node: p.node,
        cash: p.cash,
        deposit: p.deposit,
        cardCount: p.cardCount,
      })),
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      log: g.log.map((l: any) => `${l.type}|${l.text}`),
      stage: h.renderer?.kind ?? null,
    };
  });
}

const BAD_TEXT = /undefined|NaN|\{\{|\[object|\b(?:events|news|fate|magic|hud|ui):[A-Za-z0-9]/;

async function consistentEvents(pages: Page[]) {
  await syncPages(pages);
  const huds = await Promise.all(pages.map((p) => hudSnapshot(p)));
  const server = await serverSnapshot(pages[0]!);
  for (const h of huds) expect(h).toEqual(server);
  const states = await Promise.all(pages.map((p) => eventState(p)));
  for (const s of states) {
    expect({ ...s, log: s.log.slice(-40) }).toEqual({ ...states[0]!, log: states[0]!.log.slice(-40) });
    expect(s.stage).toBe('original');
    for (const line of s.log) expect(line).not.toMatch(BAD_TEXT);
  }
  return states[0]!;
}

async function stepOnto(page: Page, seat: number, node: number, prev: number): Promise<void> {
  await waitMyTurn(page);
  await acted(page, () => debugAct(page, { op: 'teleport', seat, node, prev }));
  await acted(page, () => debugAct(page, { op: 'forceNext', purpose: 'dice', values: [1] }));
  await waitMyTurn(page);
  await acted(page, () => roll(page));
}

test('events 类（原版舞台）：新闻、命运、魔法屋，4 个页面结果一致，演出页弹窗出现', async ({ browser }) => {
  test.setTimeout(300_000);
  const players = await fourOriginalPlayers(browser, []);
  try {
    const pages = await openRoom(players);
    const [a, b, c, d] = pages as [Page, Page, Page, Page];
    const s0 = await consistentEvents(pages);
    const cash = (s: typeof s0, seat: number) => s.players.find((p) => p.seat === seat)!;

    // 新闻「所得税」：全员缴现金的 5%
    await waitMyTurn(a);
    await acted(a, () => debugAct(a, { op: 'stackDeck', deck: 'news', ids: [11] }));
    await stepOnto(a, 0, 1, 18);
    await expect(d.getByTestId('news-popup')).toHaveAttribute('data-news', '11');
    const s1 = await consistentEvents(pages);
    for (const seat of [0, 1, 2, 3]) {
      const before = cash(s0, seat).cash;
      expect(cash(s1, seat).cash, `seat ${seat}`).toBe(before - Math.trunc(before * 0.05));
    }

    // 命运「继承遗产」：+10000 × 物价指数
    await waitMyTurn(b);
    await acted(b, () => debugAct(b, { op: 'stackDeck', deck: 'fate', ids: [25] }));
    const pi = await b.evaluate(
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      () => (window as any).__rich4.store.game.getState().latest.econ.priceIndex as number,
    );
    await stepOnto(b, 1, 2, 1);
    await expect(d.getByTestId('fate-popup')).toHaveAttribute('data-fate', '25');
    const s2 = await consistentEvents(pages);
    expect(cash(s2, 1).cash).toBe(cash(s1, 1).cash + 10000 * pi);

    // 魔法屋：条件 3「现金最多的人」→ 现金全部存入（P4 的演出页：女巫施法弹窗与原版舞台的魔法阵）
    await waitMyTurn(c);
    await acted(c, () => debugAct(c, { op: 'forceNext', purpose: 'magicCond', values: [3] }));
    await stepOnto(c, 2, 8, 7);
    await waitDecision(c, ['MAGIC_CAST']);
    await c.getByTestId('magic-effect-4').click();
    await acted(c, () => c.getByTestId('magic-confirm').click());
    // 原版皮肤下文字一律繁体（U5）
    await expect(d.locator('[data-testid="popup"][data-kind="magic"]')).toContainText('現金全部存入');
    await waitIdle(c);
    const s3 = await consistentEvents(pages);
    expect(cash(s3, 1).cash).toBe(0);
    expect(cash(s3, 1).deposit).toBe(cash(s2, 1).deposit + cash(s2, 1).cash);

    await waitMyTurn(d);
    await acted(d, () => roll(d));
    await waitIdle(d);
    await consistentEvents(pages);
    expectNoErrors(players);
  } finally {
    for (const p of players) await p.context.close();
  }
});
