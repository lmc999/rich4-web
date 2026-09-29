// 掷骰的原版表现（回归：线上反馈①还没掷骰人物就在播掷骰动作；②掷骰音效不是原版的「咚咚」两声；③机车 / 汽车时骰子盘
// 仍只有一颗）。带演出与声音（不加 ?anim=instant&audio=off），一个真人 + 一个电脑，步行、机车、汽车各掷一次
// （debug:act 给交通工具道具并使用、forceNext 强制点数）。
// - 原版皮肤：合成素材包 + fixture 地图（page.route 按 manifest 白名单提供 /pack/*，与 skin-classic-character 同一种供包方式，
//   默认配置与原版配置都能跑）。断言：
//   · 等待掷骰（事件播完、轮到某人）时，所有棋子都不在持骰姿态，本人的站姿帧不随时间变化（原版 state 0）；
//   · GO 钮竖槽的小骰子个数 = 交通工具上限（1/2/3），全亮；
//   · 按 GO 后先播持骰动作（char.<c>.[moto|car.]dice，帧逐 tick 前进），动作播完才出骰子 FLC；颗数 = dice 数，落定的点数面
//     与强制的点数一一对应；电脑的回合同样如此；
//   · 一次掷骰恰好两声「咚」（合成包没有音频 → ZzFX 预设 zzfx.dice），间隔约 7 帧 × 30 ms。
// - 程序化皮肤（设置里指定）：骰子颗数、点数与两声「咚」相同。
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
  debugAct,
  expect,
  expectNoErrors,
  expectOriginalSkin,
  newPlayer,
  type Player,
  startGame,
  test,
  waitIdle,
  waitMyTurn,
} from '../fixtures/room';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PACK_DIR = join(repoRoot, '.cache', 'synthetic-pack');
/** 带演出与声音（测试钩子由 test=1 打开） */
const Q_SOUND = 'test=1';

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

interface Sample {
  t: number;
  idle: boolean;
  cursor: number | null;
  poses: Record<string, { pose: string | null; frame: number; walking: boolean } | null>;
  ov: { rolling: string; seat: string; count: string; faces: string[] } | null;
}

/** 页面内逐帧采样：各座位棋子的姿态库与帧号、行动者、演出是否空闲、骰子覆盖层（ms 毫秒） */
async function startSampler(page: Page, ms: number): Promise<void> {
  await page.evaluate((dur) => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const w = window as any;
    const out: unknown[] = [];
    w.__diceSamples = out;
    const t0 = performance.now();
    const tick = (): void => {
      const h = w.__rich4;
      const g = h?.store?.game?.getState();
      const cur = g?.view?.clock?.cursor;
      const poses: Record<string, unknown> = {};
      for (const p of g?.view?.players ?? []) {
        const a = h.renderer?.board?.actor(p.seat);
        poses[p.seat] = a
          ? { pose: a.poseKey ?? a.currentPose ?? null, frame: a.frameIndex ?? -1, walking: a.isWalking === true }
          : null;
      }
      const ov = document.querySelector('[data-testid="dice-overlay"]') as HTMLElement | null;
      out.push({
        t: performance.now() - t0,
        idle: h?.eventPlayer?.idle === true,
        cursor: cur?.t === 'seat' ? cur.seat : null,
        poses,
        ov: ov
          ? {
              rolling: ov.dataset.rolling ?? '',
              seat: ov.dataset.seat ?? '',
              count: ov.dataset.count ?? '',
              faces: [...ov.querySelectorAll<HTMLElement>('[data-testid="dice-face"]')].map(
                (f) => f.dataset.face ?? '',
              ),
            }
          : null,
      });
      if (performance.now() - t0 < dur) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, ms);
}

async function samples(page: Page): Promise<Sample[]> {
  // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
  return page.evaluate(() => ((window as any).__diceSamples ?? []) as Sample[]);
}

interface SfxLog {
  t: number;
  kind: string;
  op: string;
  key?: string;
}

async function audioLog(page: Page): Promise<SfxLog[]> {
  return page.evaluate(() =>
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    ((window as any).__rich4?.audio?.log ?? []).map((e: SfxLog) => ({ t: e.t, kind: e.kind, op: e.op, key: e.key })),
  );
}

async function mySeat(page: Page): Promise<number> {
  // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
  return page.evaluate(() => (window as any).__rich4.store.room.getState().room.you.seat as number);
}

async function characterOf(page: Page, seat: number): Promise<number> {
  return page.evaluate(
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    (s) => (window as any).__rich4.store.game.getState().view.players.find((p: any) => p.seat === s).character,
    seat,
  );
}

/** 回答本回合掷骰之后出现的决策（全部按拒绝 / 默认），直到又轮到本人掷骰 */
async function untilMyTurn(page: Page): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await waitIdle(page);
    const d = await page.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      const g = (window as any).__rich4.store.game.getState();
      return { kind: g.decision?.kind ?? null, submitting: g.submitting };
    });
    if (d.kind === 'TURN_MENU' && d.submitting === null) break;
    if (d.kind && d.submitting === null) await acted(page, () => answer(page, 'decline'));
    else await page.waitForTimeout(200);
  }
  await waitMyTurn(page, 90_000);
}

/** 装上交通工具（道具 5 机车、6 汽车），回到掷骰菜单 */
async function equip(page: Page, seat: number, item: 5 | 6): Promise<void> {
  await acted(page, () => debugAct(page, { op: 'give', seat, cards: [], items: [{ item, qty: 1 }] }));
  await waitMyTurn(page);
  await acted(page, () =>
    page.evaluate((it) => {
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      const h = (window as any).__rich4;
      const d = h.store.game.getState().decision;
      return h.client.act({ type: 'USE_ITEM', item: it, target: { t: 'none' } }, d.decisionId);
    }, item),
  );
  await waitMyTurn(page);
}

/** 等待掷骰时（本页演出空闲、轮到某人、没有骰子覆盖层）谁都不在持骰姿态 */
function expectStillWhileWaiting(ss: Sample[], tag: string): void {
  for (const s of ss) {
    if (!s.idle || s.ov !== null || s.cursor === null) continue;
    for (const [seat, a] of Object.entries(s.poses)) {
      expect(a?.pose ?? '', `${tag}：t=${Math.round(s.t)} 座位 ${seat} 等待掷骰时的姿态`).not.toMatch(/\.dice$/);
    }
  }
}

/** 某座位这次掷骰的演出：持骰动作先于骰子 FLC；颗数与点数；返回持骰动作里出现的帧 */
function expectRoll(ss: Sample[], seat: number, faces: number[], tag: string): number[] {
  const s = String(seat);
  const firstThrow = ss.findIndex((x) => (x.poses[s]?.pose ?? '').endsWith('.dice'));
  const firstRoll = ss.findIndex((x) => x.ov?.seat === s && x.ov.rolling === 'true');
  expect(firstThrow, `${tag}：持骰动作`).toBeGreaterThanOrEqual(0);
  expect(firstRoll, `${tag}：骰子 FLC`).toBeGreaterThan(firstThrow);
  const rolling = ss.find((x) => x.ov?.seat === s && x.ov.rolling === 'true')!;
  expect(rolling.ov!.count, `${tag}：滚动的颗数`).toBe(String(faces.length));
  const settled = ss.find((x) => x.ov?.seat === s && x.ov.rolling === 'false');
  expect(settled?.ov?.faces, `${tag}：落定的点数`).toEqual(faces.map(String));
  const frames = ss
    .slice(firstThrow, firstRoll)
    .map((x) => x.poses[s])
    .filter((a) => a?.pose?.endsWith('.dice'))
    .map((a) => a!.frame);
  return [...new Set(frames)];
}

/** 这次掷骰的「咚」：恰好两声，间隔约 7 帧 × 30 ms */
function expectKnocks(log: SfxLog[], key: string, tag: string): void {
  const knocks = log.filter((e) => e.kind === 'sfx' && e.key === key && (e.op === 'play' || e.op === 'late'));
  expect(knocks.length, `${tag}：${key} 次数 ${JSON.stringify(log.filter((e) => e.kind === 'sfx'))}`).toBe(2);
  const gap = knocks[1]!.t - knocks[0]!.t;
  expect(gap, `${tag}：两声的间隔`).toBeGreaterThan(120);
  expect(gap, `${tag}：两声的间隔`).toBeLessThan(400);
}

const CASES = [
  { tag: '步行', item: null, faces: [3], vehicle: '' },
  { tag: '机车', item: 5, faces: [3, 4], vehicle: 'moto.' },
  { tag: '汽车', item: 6, faces: [2, 5, 6], vehicle: 'car.' },
] as const;

test('原版皮肤：掷骰前静止、按 GO 后先播持骰动作；步行 / 机车 / 汽车的骰子盘 1 / 2 / 3 颗；一次掷骰两声「咚」', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const p: Player = await newPlayer(browser, '擲骰', Q_SOUND, {
    setup: async (pg) => {
      await pg.setViewportSize({ width: 1920, height: 1080 });
      await servePack(pg);
    },
  });
  const page = p.page;
  try {
    await createRoom(page, { map: 'test', timer: 'off', aiCount: 1 });
    await startGame(page, [page]);
    await expectOriginalSkin(page);
    const seat = await mySeat(page);
    const c = await characterOf(page, seat);
    let aiRolls = 0;
    for (const k of CASES) {
      await waitMyTurn(page);
      if (k.item !== null) await equip(page, seat, k.item);
      await acted(page, () => debugAct(page, { op: 'forceNext', purpose: 'dice', values: [...k.faces] }));
      await waitMyTurn(page);

      // 等待掷骰：静止的站姿，帧不变
      await startSampler(page, 700);
      await page.waitForTimeout(800);
      const before = await samples(page);
      const mine = before.map((x) => x.poses[String(seat)]);
      expect(new Set(mine.map((a) => `${a?.pose}#${a?.frame}`)), `${k.tag}：掷骰前`).toEqual(
        new Set([`char.${c}.${k.vehicle}stand#${mine[0]?.frame}`]),
      );
      expectStillWhileWaiting(before, `${k.tag}：掷骰前`);

      // GO 钮竖槽：小骰子个数 = 交通工具上限，全亮
      const dc = page.getByTestId('action-dice-count');
      await expect(dc).toHaveAttribute('data-slots', String(k.faces.length));
      await expect(dc).toHaveAttribute('data-value', String(k.faces.length));
      const dies = page.getByTestId('dice-count-die');
      await expect(dies).toHaveCount(k.faces.length);
      for (let i = 0; i < k.faces.length; i++) {
        await expect(dies.nth(i)).toHaveAttribute('data-on', 'true');
        await expect(dies.nth(i).locator('[data-sprite]')).toHaveAttribute('data-sprite', `ui.goButton/${2 * i + 7}`);
      }

      // 按 GO：持骰动作 → 骰子 FLC（颗数 = dice 数）→ 点数面；两声「咚」
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      await page.evaluate(() => (window as any).__rich4.audio?.clearLog());
      await startSampler(page, 5000);
      await page.getByTestId('action-roll').click();
      await page.waitForTimeout(5200);
      const ss = await samples(page);
      const frames = expectRoll(ss, seat, [...k.faces], k.tag);
      expect(frames.length, `${k.tag}：持骰动作逐 tick 换帧 ${frames}`).toBeGreaterThan(1);
      expect(ss.some((x) => x.poses[String(seat)]?.pose === `char.${c}.${k.vehicle}dice`)).toBe(true);
      expectStillWhileWaiting(ss, `${k.tag}：掷骰后`);
      expectKnocks(await audioLog(page), 'zzfx.dice', k.tag);

      // 走完、应答落点决策，电脑回合里同样：等待时不摆持骰姿态、先动作后骰子
      await startSampler(page, 20_000);
      await untilMyTurn(page);
      const ai = await samples(page);
      expectStillWhileWaiting(ai, `${k.tag}：电脑回合`);
      const aiSeat = Object.keys(ai[0]?.poses ?? {}).find((s) => s !== String(seat));
      if (aiSeat && ai.some((x) => x.ov?.seat === aiSeat && x.ov.rolling === 'false')) {
        const settled = ai.find((x) => x.ov?.seat === aiSeat && x.ov.rolling === 'false')!;
        expectRoll(ai, Number(aiSeat), settled.ov!.faces.map(Number), `${k.tag}：电脑`);
        aiRolls++;
      }
    }
    // 三个电脑回合里至少有一次看到它掷骰（它也可能被送进医院、监狱而跳过）
    expect(aiRolls).toBeGreaterThan(0);
    expectNoErrors([p]);
  } finally {
    await p.context.close();
  }
});

test('程序化皮肤：骰子颗数与点数按引擎的 dice；一次掷骰两声「咚」（ZzFX）', async ({ browser }) => {
  test.setTimeout(240_000);
  const p: Player = await newPlayer(browser, '擲骰程式', Q_SOUND, {
    setup: async (pg) => {
      await pg.addInitScript(() => {
        try {
          localStorage.setItem('rich4.settings', JSON.stringify({ state: { skin: 'procedural' }, version: 2 }));
        } catch {}
      });
    },
  });
  const page = p.page;
  try {
    await createRoom(page, { map: 'test', timer: 'off', aiCount: 1 });
    // 不用 startGame：原版配置下它会断言原版皮肤，这里设置里指定了程序化皮肤
    await page.getByTestId('room-start').click();
    await expect(page.getByTestId('screen-game')).toBeVisible();
    await waitIdle(page);
    await acted(page, () => debugAct(page, { op: 'clearBoard' }));
    await expect(page.getByTestId('screen-game')).not.toHaveAttribute('data-layout', 'classic');
    const seat = await mySeat(page);
    for (const k of CASES) {
      await waitMyTurn(page);
      if (k.item !== null) await equip(page, seat, k.item);
      await acted(page, () => debugAct(page, { op: 'forceNext', purpose: 'dice', values: [...k.faces] }));
      await waitMyTurn(page);
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      await page.evaluate(() => (window as any).__rich4.audio?.clearLog());
      await startSampler(page, 4000);
      await page.getByTestId('action-roll').click();
      await page.waitForTimeout(4200);
      const ss = await samples(page);
      const rolling = ss.find((x) => x.ov?.seat === String(seat) && x.ov.rolling === 'true');
      expect(rolling?.ov?.count, k.tag).toBe(String(k.faces.length));
      const settled = ss.find((x) => x.ov?.seat === String(seat) && x.ov.rolling === 'false');
      expect(settled?.ov?.faces, k.tag).toEqual(k.faces.map(String));
      expectKnocks(await audioLog(page), 'zzfx.dice', k.tag);
      await untilMyTurn(page);
    }
    expectNoErrors([p]);
  } finally {
    await p.context.close();
  }
});
