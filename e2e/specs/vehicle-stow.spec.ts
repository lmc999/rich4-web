// 收起交通工具、改回步行（回归：线上反馈「骑机车和坐汽车开始游戏时，无法收起载具变回步行状态」）。
// 原版做法（v2.06 道具函数表第 14 项 0x4467b1）：真人道具欄右下角那一格画「车 + 禁止圈」，点一下车退回背包、改回步行、
// 骰子只剩 1 颗，不结束回合。开局设置汽车 / 机车，一个真人 + 一个电脑：
// - 原版皮肤（合成素材包，page.route 按 manifest 白名单供包，默认配置与原版配置都能跑）：工具列「道具」打开道具欄，
//   右下角格子是 ui.itemBar/16（汽车）→ 点下去 → 步行（棋子姿态 char.<c>.stand）、GO 竖槽 1 颗、背包多一台汽车；
//   强制点数掷骰 → DICE_ROLLED 只有 1 颗；
// - 程序化皮肤（设置里指定）：行动区「道具」→ 道具页「收起机车，改为步行」→ 步行、行动区的颗数钮消失（只剩 1 颗）
//   → 掷骰 1 颗。
// 两种皮肤都核对：收起不弹「换乘交通工具」提示（原版 0x4467b1 只刷新外观、不说台词），日志记「收起××，改为步行」。
// 梦游卡（architecture §34，ENGINE_VERSION 0.6.0）：骑汽车的电脑中卡时汽车停放（回背包）、梦游结束的回合装回；两次都只换外观、
// 不弹「换乘」提示，日志记「梦游，汽车收回道具栏」「梦游结束，换回汽车」。按配置的缺省皮肤跑（默认配置程序化、原版配置原版）。
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
  expectOriginalSkin,
  newPlayer,
  type Player,
  playTurn,
  startGame,
  test,
  waitIdle,
  waitMyTurn,
  zh,
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

interface Me {
  seat: number;
  character: number;
  vehicle: string;
  diceCount: number;
  items: Record<string, number>;
  canStow: boolean | null;
  allowed: number[] | null;
  pose: string | null;
  statusVehicle: string | null;
}

/** 本人：view 里的交通工具 / 骰子数 / 背包，TURN_MENU 的 vehicle 与可选颗数，棋子的姿态库与状态 */
async function me(page: Page): Promise<Me> {
  return page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const h = (window as any).__rich4;
    const g = h.store.game.getState();
    const seat = h.store.room.getState().room.you.seat as number;
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const p = g.view.players.find((x: any) => x.seat === seat);
    const o = g.decision?.kind === 'TURN_MENU' ? g.decision.options : null;
    const a = h.renderer?.board?.actor(seat);
    return {
      seat,
      character: p.character,
      vehicle: p.vehicle,
      diceCount: p.diceCount,
      items: p.items,
      canStow: o ? (o.vehicle?.canStow ?? null) : null,
      allowed: o ? o.dice.allowed : null,
      pose: a?.poseKey ?? null,
      statusVehicle: a?.currentStatus?.vehicle ?? null,
    };
  });
}

/** 日志里本人的掷骰（DICE_ROLLED 原事件），按发生顺序 */
async function rolls(page: Page, seat: number): Promise<{ dice: number[]; diceCount: number }[]> {
  return page.evaluate((s) => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const log = (window as any).__rich4.store.game.getState().log as any[];
    return log
      .filter((l) => l.type === 'DICE_ROLLED' && l.src?.event?.seat === s)
      .map((l) => ({ dice: l.src.event.dice, diceCount: l.src.event.diceCount }));
  }, seat);
}

/** 从现在起记下每一条新弹出的提示（toast 3.2 秒就消失，事后查 store 会漏） */
async function recordToasts(page: Page): Promise<void> {
  await page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const w = window as any;
    w.__stowToasts = [] as string[];
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    w.__rich4.store.ui.subscribe((st: any, prev: any) => {
      for (const t of st.toasts) if (!prev.toasts.includes(t)) w.__stowToasts.push(t.text);
    });
  });
}

async function recordedToasts(page: Page): Promise<string[]> {
  // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
  return page.evaluate(() => (window as any).__stowToasts as string[]);
}

/** 日志里本人的 VEHICLE（文案 + 原事件的 stowed） */
async function vehicleLog(page: Page, seat: number): Promise<{ text: string; stowed: string | null }[]> {
  return page.evaluate((s) => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const log = (window as any).__rich4.store.game.getState().log as any[];
    return log
      .filter((l) => l.type === 'VEHICLE' && l.src?.event?.seat === s)
      .map((l) => ({ text: l.text, stowed: l.src.event.stowed ?? null }));
  }, seat);
}

/** 强制点数后按 GO，等本人的这次掷骰出现在日志里 */
async function rollWith(page: Page, seat: number, faces: number[]): Promise<{ dice: number[]; diceCount: number }> {
  await acted(page, () => debugAct(page, { op: 'forceNext', purpose: 'dice', values: faces }));
  await waitMyTurn(page);
  const n0 = (await rolls(page, seat)).length;
  await acted(page, () => page.getByTestId('action-roll').click());
  await expect.poll(async () => (await rolls(page, seat)).length).toBeGreaterThan(n0);
  return (await rolls(page, seat)).at(-1)!;
}

test('原版皮肤：汽车开局 → 道具欄右下角「收起汽车」→ 步行、GO 竖槽 1 颗、掷骰 1 颗', async ({ browser }) => {
  test.setTimeout(240_000);
  const p: Player = await newPlayer(browser, '收車', undefined, {
    setup: async (pg) => {
      await pg.setViewportSize({ width: 1920, height: 1080 });
      await servePack(pg);
    },
  });
  const page = p.page;
  try {
    await createRoom(page, { map: 'test', timer: 'off', aiCount: 1, vehicle: 'car' });
    await startGame(page, [page]);
    await expectOriginalSkin(page);
    await waitMyTurn(page);

    const m0 = await me(page);
    expect(m0).toMatchObject({ vehicle: 'car', diceCount: 3, canStow: true, allowed: [1, 2, 3] });
    expect(m0.items['6'] ?? 0).toBe(0);
    expect(m0.pose).toBe(`char.${m0.character}.car.stand`);
    await expect(page.getByTestId('action-dice-count')).toHaveAttribute('data-slots', '3');

    // 工具列「道具」→ 道具欄右下角那一格（图16：汽车 + 禁止圈）
    await page.getByTestId('action-items').click();
    const menu = page.getByTestId('decision-TURN_MENU');
    await expect(menu).toHaveAttribute('data-tab', 'items');
    const cell = page.getByTestId('inv-stow-vehicle');
    await expect(cell).toBeVisible();
    await expect(cell.getByTestId('stow-vehicle-icon')).toHaveAttribute('data-sprite', 'ui.itemBar/16');
    await expect(cell).toHaveAttribute('aria-label', '收起汽車');
    await recordToasts(page);
    await acted(page, () => cell.click());
    await waitMyTurn(page);
    await waitIdle(page);
    // 不弹「換乘交通工具」提示；日志记「收起汽車，改為步行」
    expect((await recordedToasts(page)).filter((t) => t.includes('換乘'))).toEqual([]);
    expect((await vehicleLog(page, m0.seat)).at(-1)).toEqual({
      text: expect.stringContaining('收起汽車，改為步行'),
      stowed: 'car',
    });

    // 步行：姿态库换成步行站姿，GO 竖槽只剩 1 颗，汽车进背包，道具欄已收起
    const m1 = await me(page);
    expect(m1).toMatchObject({ vehicle: 'walk', diceCount: 1, canStow: false, allowed: [1] });
    expect(m1.items['6']).toBe(1);
    expect(m1.pose).toBe(`char.${m1.character}.stand`);
    await expect(page.getByTestId('inv-stow-vehicle')).toHaveCount(0);
    await expect(page.getByTestId('action-dice-count')).toHaveAttribute('data-slots', '1');
    await expect(page.getByTestId('dice-count-die')).toHaveCount(1);

    // 再打开道具欄：右下角空着，汽车在格子里（可以再装上）
    await page.getByTestId('action-items').click();
    await expect(page.getByTestId('inv-item-6')).toBeEnabled();
    await expect(page.getByTestId('inv-stow-vehicle')).toHaveCount(0);
    await page.getByTestId('turn-close').click();

    // 掷骰：强制 4 点，只掷 1 颗
    const r = await rollWith(page, m1.seat, [4, 5, 6]);
    expect(r).toEqual({ dice: [4], diceCount: 1 });
    expectNoErrors([p]);
  } finally {
    await p.context.close();
  }
});

test('程序化皮肤：机车开局 → 道具页「收起机车，改为步行」→ 步行、只能选 1 颗、掷骰 1 颗', async ({ browser }) => {
  test.setTimeout(240_000);
  const p: Player = await newPlayer(browser, '收车程式', undefined, {
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
    await createRoom(page, { map: 'test', timer: 'off', aiCount: 1, vehicle: 'moto' });
    // 不用 startGame：原版配置下它会断言原版皮肤，这里设置里指定了程序化皮肤
    await page.getByTestId('room-start').click();
    await expect(page.getByTestId('screen-game')).toBeVisible();
    await waitIdle(page);
    await acted(page, () => debugAct(page, { op: 'clearBoard' }));
    await expect(page.getByTestId('screen-game')).not.toHaveAttribute('data-layout', 'classic');
    await waitMyTurn(page);

    const m0 = await me(page);
    expect(m0).toMatchObject({ vehicle: 'moto', diceCount: 2, canStow: true, allowed: [1, 2] });
    expect(m0.statusVehicle).toBe('moto');
    await expect(page.getByTestId('action-dice-2')).toBeEnabled();
    await expect(page.getByTestId('action-roll')).toContainText('掷骰（2 颗）');

    await page.getByTestId('action-items').click();
    const sheet = page.getByTestId('turn-inventory');
    await expect(sheet.getByTestId('inv-vehicle')).toContainText('机车');
    const btn = sheet.getByTestId('inv-stow-vehicle');
    await expect(btn).toHaveText('收起机车，改为步行');
    await recordToasts(page);
    await acted(page, () => btn.click());
    await waitMyTurn(page);
    await waitIdle(page);
    expect((await recordedToasts(page)).filter((t) => t.includes('换乘'))).toEqual([]);
    expect((await vehicleLog(page, m0.seat)).at(-1)).toEqual({
      text: expect.stringContaining('收起机车，改为步行'),
      stowed: 'moto',
    });

    const m1 = await me(page);
    expect(m1).toMatchObject({ vehicle: 'walk', diceCount: 1, canStow: false, allowed: [1] });
    expect(m1.items['5']).toBe(1);
    expect(m1.statusVehicle).toBe('walk');
    await expect(page.getByTestId('turn-inventory')).toHaveCount(0);
    // 行动区：步行只有 1 颗可选时不显示颗数钮，掷骰钮写 1 颗
    await expect(page.getByTestId('action-dice-2')).toHaveCount(0);
    await expect(page.getByTestId('action-roll')).toContainText('掷骰（1 颗）');

    const r = await rollWith(page, m1.seat, [3, 5]);
    expect(r).toEqual({ dice: [3], diceCount: 1 });
    expectNoErrors([p]);
  } finally {
    await p.context.close();
  }
});

interface SeatVehicle {
  vehicle: string;
  parked: { vehicle: string; dice: number } | null;
  car: number;
}

/** 某个座位在本页 view 里的座驾、停放的座驾与背包里的汽车数（单真人 + 电脑：手牌公开） */
async function seatVehicle(page: Page, seat: number): Promise<SeatVehicle> {
  return page.evaluate((s) => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const g = (window as any).__rich4.store.game.getState();
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const p = g.view.players.find((x: any) => x.seat === s);
    return { vehicle: p.vehicle, parked: p.parked, car: p.items?.[6] ?? -1 };
  }, seat);
}

/** 日志里某座位的 VEHICLE（文案 + 原事件的 via / vehicle） */
async function vehicleVia(page: Page, seat: number): Promise<{ text: string; via: string | null; vehicle: string }[]> {
  return page.evaluate((s) => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const log = (window as any).__rich4.store.game.getState().log as any[];
    return log
      .filter((l) => l.type === 'VEHICLE' && l.src?.event?.seat === s)
      .map((l) => ({ text: l.text, via: l.src.event.via ?? null, vehicle: l.src.event.vehicle }));
  }, seat);
}

test('梦游卡：骑汽车的电脑中卡时汽车停放、梦游结束装回，两次都只换外观、不提示「换乘」', async ({ browser }) => {
  test.setTimeout(300_000);
  const p: Player = await newPlayer(browser, '夢遊卡');
  const page = p.page;
  try {
    await createRoom(page, { map: 'test', timer: 'off', aiCount: 1, vehicle: 'car' });
    await startGame(page, [page]);
    await waitMyTurn(page);
    expect(await seatVehicle(page, 1)).toMatchObject({ vehicle: 'car', parked: null, car: 0 });

    // 0 号（本人）对 1 号（电脑）用梦游卡：回合菜单的卡片欄经测试钩子提交 USE_CARD（1 号还没跳伞，先放到 6 号格）
    await acted(page, () => debugAct(page, { op: 'teleport', seat: 1, node: 6, prev: 5 }));
    await acted(page, () => debugAct(page, { op: 'give', seat: 0, cards: [16], items: [] }));
    await waitMyTurn(page);
    await recordToasts(page);
    await acted(page, () =>
      page.evaluate(() => {
        // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
        const h = (window as any).__rich4;
        const dd = h.store.game.getState().decision;
        // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
        const row = dd.options.cards.find((r: any) => r.card === 16);
        const target = { t: 'actor', actor: { t: 'seat', seat: 1 } };
        return h.client.act({ type: 'USE_CARD', slot: row.slot, card: 16, target }, dd.decisionId);
      }),
    );
    await waitMyTurn(page);
    await waitIdle(page);
    expect(await seatVehicle(page, 1)).toEqual({
      vehicle: 'walk',
      parked: { vehicle: 'car', dice: 3, engineer: null },
      car: 1,
    });
    expect(await vehicleVia(page, 1)).toEqual([
      {
        text: expect.stringContaining(zh('梦游，汽车收回道具栏，改为步行', '夢遊，汽車收回道具欄，改為步行')),
        via: 'sleepwalk',
        vehicle: 'walk',
      },
    ]);

    // 本人先收起自己的汽车（只掷 1 颗），之后每回合从 12 掷 1 点落到 13（得 30 点），只让电脑走；电脑梦游 5 个回合，
    // 第 6 个回合醒来装回汽车。万一出现别的决策（电脑对本人用了卡等）按默认处理（playTurn）
    await acted(page, () =>
      page.evaluate(() => {
        // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
        const h = (window as any).__rich4;
        return h.client.act({ type: 'STOW_VEHICLE' }, h.store.game.getState().decision.decisionId);
      }),
    );
    for (let i = 0; i < 12 && (await vehicleVia(page, 1)).length < 2; i++) {
      await playTurn(page, 0, { node: 12, prev: 11, dice: 1 });
    }
    expect(await vehicleVia(page, 1)).toEqual([
      expect.objectContaining({ via: 'sleepwalk' }),
      { text: expect.stringContaining(zh('梦游结束，换回汽车', '夢遊結束，換回汽車')), via: 'wake', vehicle: 'car' },
    ]);
    expect((await seatVehicle(page, 1)).parked).toBeNull();
    // 整段都没有弹「换乘交通工具」
    expect((await recordedToasts(page)).filter((t) => t.includes(zh('换乘', '換乘')))).toEqual([]);
    expectNoErrors([p]);
  } finally {
    await p.context.close();
  }
});
