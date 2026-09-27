// 调试（第三波整合）：本机真实素材包上的原版皮肤全流程巡检，截图目视（配置见 test/w3-tour.config.ts）。
// 流程：门禁页 → 片头 → 标题 → 开局设置（台湾、2 电脑）→ 选人大厅 → 邀请 P2（带授权的邀请链接）→ Loading → 对局；
// 对局中房主按回合用 debug:act 传送 + 强制骰子，逐一触发原版场景与对话框：卡片欄 / 道具欄 / 股市 / 公佈欄 / 资产表 / 存档 /
// 托管、买地、升级、银行 ATM 与柜台、商店、乐透投注与开奖、魔法屋（施法坐牢）、监狱保释、医院、新闻、命运、查税（选目标）、
// 拍卖（P2 竞拍、房主观战版拍卖厅）、买设施、兴建旅馆、轮盘（P2 住进旅馆）、老虎机（小财神）、三个小游戏、月结、投降与终局。
// P2 平时由脚本代打（决策一律 defaultIntent），需要它出场时暂停代打。每一步失败只记日志、截图，继续下一步。
// 截图与 summary.json 写到 .cache/w3/tour-<tag>/（含原版素材，不入库）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TAG = process.env.W3_TAG ?? 'desk';
const DESK = { width: 1920, height: 1080 };
const MOBILE = { width: 844, height: 390 };
const HOST_VP = TAG === 'mobile' ? MOBILE : DESK;
const P2_VP = TAG === 'mobile' ? DESK : MOBILE;
const OUT = join(root, '.cache', 'w3', `tour-${TAG}`);
const PASS = readFileSync(join(root, '.cache/w3/passcode.txt'), 'utf8').trim();
// 带声音（验证场景曲切换；headless 下没有实际输出）
const Q = 'test=1';

// biome-ignore lint/suspicious/noExplicitAny: 测试钩子
type Any = any;

interface Rec {
  steps: { name: string; ok: boolean; note?: string }[];
  decisions: Record<string, { host: string[]; p2: string[] }>;
  errors: string[];
  shots: string[];
}
const rec: Rec = { steps: [], decisions: {}, errors: [], shots: [] };
let shotN = 0;

function log(s: string): void {
  console.log(`[tour ${TAG}] ${s}`);
}

async function shot(page: Page, name: string): Promise<void> {
  shotN++;
  const file = join(OUT, `${String(shotN).padStart(3, '0')}-${name}.jpg`);
  await page.screenshot({ path: file, type: 'jpeg', quality: 80 }).catch((e) => log(`shot ${name} 失败 ${e}`));
  rec.shots.push(file.slice(root.length + 1));
}

let recover: (() => Promise<void>) | null = null;

async function step(name: string, fn: () => Promise<void>, pages: Page[]): Promise<boolean> {
  log(`▶ ${name}`);
  try {
    await fn();
    rec.steps.push({ name, ok: true });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0]! : String(e);
    log(`✗ ${name}: ${msg}`);
    rec.steps.push({ name, ok: false, note: msg });
    for (const [i, p] of pages.entries()) await shot(p, `FAIL-${name}-${i}`);
    for (const p of pages) await p.keyboard.press('Escape').catch(() => undefined);
    // 房主若还卡在这一步的决策上（场景没点成功），按默认处理，回到自己的回合菜单或别人的回合，免得后面的步骤全部等超时
    if (recover) await recover().catch((e2) => log(`  恢复失败：${String(e2).split('\n')[0]}`));
    return false;
  }
}

function watchErrors(page: Page, who: string): void {
  page.on('pageerror', (e) => rec.errors.push(`${who} pageerror: ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !/401|ACCESS_REQUIRED/.test(t)) rec.errors.push(`${who} console.error: ${t.slice(0, 300)}`);
    if (m.type() === 'warning' && /未结束|handler 出错|改用程序化|原版场景/.test(t))
      rec.errors.push(`${who} warn: ${t.slice(0, 300)}`);
  });
}

// ───────────────────────── 页面状态 ─────────────────────────

async function st(page: Page): Promise<{
  idle: boolean;
  kind: string | null;
  id: string | null;
  sub: unknown;
  over: boolean;
  date: number | null;
} | null> {
  return page
    .evaluate(() => {
      const h = (window as Any).__rich4;
      const g = h?.store?.game?.getState();
      if (!g) return null;
      return {
        idle: !!h.eventPlayer?.idle,
        kind: g.decision?.kind ?? null,
        id: g.decision?.decisionId ?? null,
        sub: g.submitting,
        over: g.over !== null,
        date: g.view?.clock.date ?? null,
      };
    })
    .catch(() => null);
}

async function waitMyTurn(page: Page, timeout = 120_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const h = (window as Any).__rich4;
      const g = h?.store?.game?.getState();
      return !!g && h.eventPlayer.idle && g.decision?.kind === 'TURN_MENU' && g.submitting === null;
    },
    undefined,
    { timeout },
  );
}

async function waitDecision(page: Page, kinds: string[], timeout = 60_000): Promise<string> {
  const h = await page.waitForFunction(
    (ks) => {
      const hh = (window as Any).__rich4;
      const g = hh?.store?.game?.getState();
      const k = g?.decision?.kind;
      return hh?.eventPlayer.idle && g?.submitting === null && k && ks.includes(k) ? k : null;
    },
    kinds,
    { timeout },
  );
  return (await h.jsonValue()) as string;
}

async function seq(page: Page): Promise<number> {
  return page.evaluate(() => (window as Any).__rich4.store.game.getState().seq as number);
}

async function debug(page: Page, op: Record<string, unknown>): Promise<void> {
  const s0 = await seq(page);
  const r = await page.evaluate((o) => (window as Any).__rich4.client.debug(o), op);
  if (!r.ok) throw new Error(`debug ${JSON.stringify(op)} → ${JSON.stringify(r)}`);
  await page.waitForFunction((s) => (window as Any).__rich4.store.game.getState().seq > s, s0, { timeout: 30_000 });
}

/** 当前决策按 defaultIntent 提交 */
async function actDefault(page: Page): Promise<void> {
  await page.evaluate(() => {
    const h = (window as Any).__rich4;
    const d = h.store.game.getState().decision;
    if (d) return h.client.act(d.defaultIntent, d.decisionId);
    return null;
  });
}

/** 原版场景是否出现（记录每种决策在两页上是原版还是回退） */
async function noteScene(page: Page, who: 'host' | 'p2', kind: string): Promise<string> {
  const el = page.locator(`[data-testid="decision-${kind}"]`).first();
  await el.waitFor({ state: 'attached', timeout: 15_000 }).catch(() => undefined);
  const scene = (await el.getAttribute('data-scene').catch(() => null)) === 'classic' ? 'classic' : 'fallback';
  rec.decisions[kind] ??= { host: [], p2: [] };
  const arr = rec.decisions[kind]![who];
  if (!arr.includes(scene)) arr.push(scene);
  return scene;
}

/** 手机紧凑工具列：有些钮收在「更多」菜单里 */
async function tool(page: Page, id: string, o: { right?: boolean } = {}): Promise<void> {
  const el = page.getByTestId(id).first();
  if (!(await el.isVisible().catch(() => false))) {
    const more = page.getByTestId('tool-more');
    if (await more.isVisible().catch(() => false)) await more.click();
  }
  await el.click(o.right ? { button: 'right' } : {});
}

// ───────────────────────── 棋盘路线（台湾图） ─────────────────────────

/** 从 target 的一个不在岔路上的邻格前进 1 步到 target；返回 {node, prev} */
async function routeTo(page: Page, target: number): Promise<{ node: number; prev: number }> {
  const r = await page.evaluate((n) => {
    const tiles = (window as Any).__rich4.client.currentMap.def.tiles as {
      id: number;
      links: { to: number; blocked: boolean }[];
    }[];
    const nb = (id: number): number[] =>
      (tiles.find((t) => t.id === id)?.links ?? []).filter((l) => !l.blocked).map((l) => l.to);
    for (const p of nb(n)) {
      const out = nb(p);
      if (out.length !== 2) continue;
      const prev = out.find((x) => x !== n);
      if (prev !== undefined) return { node: p, prev };
    }
    return null;
  }, target);
  if (!r) throw new Error(`没有到 ${target} 的直路`);
  return r;
}

/** 本人回合：传送到目标的邻格、强制掷 1、按 GO */
async function stepOnto(page: Page, seat: number, target: number): Promise<void> {
  await waitMyTurn(page);
  const r = await routeTo(page, target);
  await debug(page, { op: 'teleport', seat, node: r.node, prev: r.prev });
  await waitMyTurn(page);
  await debug(page, { op: 'forceNext', purpose: 'dice', values: [1] });
  await waitMyTurn(page);
  await page.getByTestId('action-roll').click();
}

/** 地块的前门格（第一块满足条件的地） */
async function lotFront(
  page: Page,
  want: 'land-free' | 'facility-free' | { lot: string },
): Promise<{ lot: string; front: number }> {
  const r = await page.evaluate((w) => {
    const h = (window as Any).__rich4;
    const v = h.store.game.getState().latest;
    const map = h.client.currentMap;
    const tiles = map.def.tiles as { id: number; links: { to: number; blocked: boolean }[] }[];
    const straight = (front: number): boolean =>
      (tiles.find((t) => t.id === front)?.links ?? [])
        .filter((l) => !l.blocked)
        .some((l) => (tiles.find((t) => t.id === l.to)?.links ?? []).filter((x) => !x.blocked).length === 2);
    let pool: { id: string; owner: number | null }[];
    if (typeof w === 'object') pool = [...v.lands, ...v.facilities].filter((l: Any) => l.id === w.lot);
    else if (w === 'land-free') pool = v.lands.filter((l: Any) => l.owner === null);
    else pool = v.facilities.filter((l: Any) => l.owner === null);
    const me = h.store.game.getState().decision?.seat ?? -1;
    const occupied = new Set(v.players.filter((p: Any) => p.seat !== me).map((p: Any) => p.node));
    for (const l of pool) {
      const fronts = map.lot(l.id).frontTiles as number[];
      const f = fronts.find((x) => straight(x) && !occupied.has(x));
      if (f !== undefined) return { lot: l.id, front: f };
    }
    return null;
  }, want);
  if (!r) throw new Error(`找不到地块 ${JSON.stringify(want)}`);
  return r;
}

async function tileOfKind(page: Page, kind: string): Promise<number> {
  const id = await page.evaluate(
    (k) => ((window as Any).__rich4.client.currentMap.def.tiles as Any[]).find((t) => t.kind === k)?.id ?? null,
    kind,
  );
  if (id === null) throw new Error(`地图上没有 ${kind}`);
  return id as number;
}

// ───────────────────────── 代打 ─────────────────────────

/** 后台代打：某页的决策一律按 defaultIntent（暂停时不动） */
function autoplay(page: Page, who: 'host' | 'p2') {
  const ctl = { on: true, stop: false };
  const done = (async () => {
    let last: string | null = null;
    while (!ctl.stop) {
      if (ctl.on) {
        const s = await st(page);
        if (s?.over) break;
        if (s && s.idle && s.id && s.sub === null && s.id !== last) {
          last = s.id;
          if (s.kind && s.kind !== 'TURN_MENU') await noteScene(page, who, s.kind);
          await actDefault(page).catch(() => {
            last = null;
          });
        }
      }
      await page.waitForTimeout(250).catch(() => undefined);
    }
  })();
  return { ctl, done };
}

/** 房主走完一段之后，把非本回合的决策（比如意外触发的）都按默认处理，直到回到本人的回合菜单 */
async function settleHost(page: Page, timeout = 180_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const s = await st(page);
    if (s?.over) return;
    if (s?.idle && s.sub === null && s.kind === 'TURN_MENU') return;
    if (s?.idle && s.sub === null && s.kind && s.kind !== 'TURN_MENU') {
      await noteScene(page, 'host', s.kind);
      await actDefault(page);
    }
    await page.waitForTimeout(300);
  }
  throw new Error('房主一直没有回到回合菜单');
}

/**
 * 等某个画面出现（乐透开奖、月结）：期间房主的决策一律按默认处理，轮到房主就掷骰（日子要往前走），
 * 直到 selector 可见
 */
async function waitShowing(page: Page, testId: string, timeout = 240_000): Promise<void> {
  const t0 = Date.now();
  const loc = page.getByTestId(testId);
  while (Date.now() - t0 < timeout) {
    if (await loc.isVisible().catch(() => false)) return;
    const s = await st(page);
    if (s?.idle && s.sub === null && s.kind) {
      if (s.kind === 'TURN_MENU') await page.getByTestId('action-roll').click().catch(() => undefined);
      else {
        await noteScene(page, 'host', s.kind);
        await actDefault(page);
      }
    }
    await page.waitForTimeout(150);
  }
  throw new Error(`${testId} 一直没有出现`);
}

/** 推进到 P2 的回合（房主的回合照常掷骰、其余决策按默认处理；P2 的代打此时应已暂停） */
async function untilTurnOf(host: Page, other: Page, timeout = 240_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const o = await st(other);
    if (o?.idle && o.sub === null && o.kind === 'TURN_MENU') return;
    if (o?.idle && o.sub === null && o.kind && o.kind !== 'TURN_MENU') await actDefault(other);
    const s = await st(host);
    if (s?.idle && s.sub === null && s.kind) {
      if (s.kind === 'TURN_MENU') await host.getByTestId('action-roll').click().catch(() => undefined);
      else await actDefault(host);
    }
    await host.waitForTimeout(200);
  }
  throw new Error('一直没有轮到 P2');
}

// ───────────────────────── 巡检 ─────────────────────────

test('原版皮肤全流程巡检（真实素材包）', async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  const ctxs: BrowserContext[] = [];
  const hostCtx = await browser.newContext({ viewport: HOST_VP });
  ctxs.push(hostCtx);
  const A = await hostCtx.newPage();
  watchErrors(A, 'host');
  let B: Page | null = null;
  const both = (): Page[] => (B ? [A, B] : [A]);

  try {
    // ── 门禁 → 片头 → 标题 ──
    await step(
      '门禁页',
      async () => {
        await A.goto(`/?${Q}`);
        await expect(A.getByTestId('access-gate')).toBeVisible();
        await shot(A, 'access-gate');
        await A.getByTestId('access-passcode').fill(PASS);
        await A.getByTestId('access-submit').click();
        await A.waitForLoadState('load');
      },
      [A],
    );
    await step(
      '片头',
      async () => {
        await expect(A.getByTestId('intro')).toBeVisible({ timeout: 30_000 });
        await A.waitForTimeout(2500);
        await shot(A, 'intro');
        await A.getByTestId('intro-skip').click();
        await expect(A.getByTestId('intro')).toHaveCount(0);
      },
      [A],
    );
    await step(
      '标题画面',
      async () => {
        const home = A.getByTestId('screen-home');
        await expect(home).toHaveAttribute('data-screen', 'title', { timeout: 30_000 });
        await A.waitForTimeout(800);
        await shot(A, 'title');
        await A.getByTestId('home-nickname').fill('房主');
        await A.getByTestId('home-nickname').blur();
        await A.getByTestId('title-option').click();
        await A.waitForTimeout(500);
        await shot(A, 'title-option');
        await A.keyboard.press('Escape');
      },
      [A],
    );

    // ── 开局设置 → 选人大厅 ──
    let code = '';
    await step(
      '开局设置',
      async () => {
        await A.getByTestId('home-create').click();
        await expect(A.getByTestId('screen-setup')).toBeVisible();
        await A.getByTestId('set-map').selectOption('taiwan');
        await A.getByTestId('set-timer').selectOption('off');
        await A.getByTestId('set-ai-count').selectOption('2');
        // 胜利条件：资产 10 倍（终局用：最后把房主的现金调到目标以上，下一天就结算）
        await A.getByTestId('set-win').selectOption('10');
        await A.waitForTimeout(600);
        await shot(A, 'setup');
        await A.getByTestId('create-submit').click();
        await A.waitForURL(/\/r\/\d{6}/);
        code = /\/r\/(\d{6})/.exec(A.url())![1]!;
      },
      [A],
    );
    let invite = '';
    await step(
      '选人大厅',
      async () => {
        await expect(A.getByTestId('screen-room')).toBeVisible();
        await A.getByTestId('char-9').click();
        await A.waitForTimeout(800);
        await shot(A, 'lobby-pick');
        await A.getByTestId('char-select').click();
        invite = await A.evaluate(
          () => (document.querySelector('[data-testid="invite-url"]') as HTMLInputElement | null)?.value ?? '',
        );
        if (!/#g=/.test(invite)) throw new Error(`邀请链接没有授权片段：${invite}`);
      },
      [A],
    );

    // ── 邀请 P2（新的浏览器上下文，经授权片段过门禁） ──
    await step(
      '邀请 P2',
      async () => {
        const ctx = await browser.newContext({ viewport: P2_VP });
        ctxs.push(ctx);
        B = await ctx.newPage();
        watchErrors(B, 'p2');
        const u = new URL(invite);
        await B.goto(`${u.pathname}?${Q}${u.hash}`);
        await expect(B.getByTestId('screen-room')).toBeVisible({ timeout: 60_000 });
        await B.getByTestId('char-4').click();
        await B.getByTestId('char-select').click();
        await B.getByTestId('room-ready').click();
        await A.waitForTimeout(800);
        await shot(A, 'lobby-ready');
        await shot(B, 'p2-lobby');
      },
      [A],
    );
    if (!B) throw new Error('P2 没进房');
    const P2 = B as Page;

    await step(
      'Loading 与开局',
      async () => {
        await expect(A.getByTestId('room-start')).toBeEnabled();
        await A.getByTestId('room-start').click();
        await A.getByTestId('classic-loading')
          .waitFor({ state: 'visible', timeout: 10_000 })
          .then(() => shot(A, 'loading'))
          .catch(() => log('没截到 Loading'));
        for (const p of [A, P2]) {
          await expect(p.getByTestId('screen-game')).toHaveAttribute('data-layout', 'classic', { timeout: 60_000 });
          await p.waitForFunction(() => (window as Any).__rich4?.skin?.boardInUse === 'original', undefined, {
            timeout: 60_000,
          });
        }
        await waitMyTurn(A, 180_000);
        await A.waitForTimeout(1500);
        await shot(A, 'game-start');
        await shot(P2, 'p2-game-start');
      },
      [A, P2],
    );

    recover = async () => {
      p2.ctl.on = true;
      // 收起回合菜单（含股市 / 公佈欄子页）
      await A.evaluate(() => (window as Any).__rich4.store.ui.getState().openPanel(null)).catch(() => undefined);
      await settleHost(A);
    };
    const p2 = autoplay(P2, 'p2');
    const S = 0;
    // P2 的座位（电脑在建房时先占了 1、2 号座位，P2 通常是 3 号）
    const S2 = (await P2.evaluate(() => (window as Any).__rich4.store.room.getState().room.you.seat)) as number;
    log(`P2 座位 ${S2}`);

    // ── 回合菜单里的界面（不消耗回合） ──
    await step(
      '准备道具与日期',
      async () => {
        await waitMyTurn(A);
        await debug(A, { op: 'setDate', date: 20100104 });
        await waitMyTurn(A);
        await debug(A, { op: 'give', seat: S, cards: [26, 8, 17], items: [{ item: 2, qty: 1 }] });
        await waitMyTurn(A);
        await debug(A, { op: 'setPoints', seat: S, points: 900 });
        await waitMyTurn(A);
      },
      both(),
    );
    await step(
      '卡片欄',
      async () => {
        await tool(A, 'action-cards');
        const menu = A.getByTestId('decision-TURN_MENU');
        await expect(menu).toHaveAttribute('data-tab', 'cards');
        await noteScene(A, 'host', 'TURN_MENU');
        await A.waitForTimeout(600);
        await shot(A, 'cardbar');
        await tool(A, 'action-items');
        await A.waitForTimeout(500);
        await shot(A, 'itembar');
        await A.keyboard.press('Escape');
        await waitMyTurn(A);
      },
      [A],
    );
    await step(
      '股市',
      async () => {
        await tool(A, 'action-stock');
        const sheet = A.getByTestId('turn-stock-sheet');
        await expect(sheet).toBeVisible();
        await A.waitForTimeout(600);
        await shot(A, 'stock');
        await sheet.getByTestId('stock-pick-0').click();
        await A.waitForTimeout(500);
        await shot(A, 'stock-detail');
        await sheet.getByTestId('stock-exit').click();
        await A.keyboard.press('Escape');
        await waitMyTurn(A);
      },
      [A],
    );
    await step(
      '公佈欄',
      async () => {
        await tool(A, 'action-board');
        await expect(A.locator('[data-testid="decision-TURN_MENU"][data-venue="bulletin"]')).toBeVisible();
        await A.waitForTimeout(600);
        await shot(A, 'bulletin');
        await A.getByTestId('board-sell').click();
        await expect(A.locator('[data-venue="bulletin"]')).toHaveAttribute('data-step', 'kind');
        await A.waitForTimeout(400);
        await shot(A, 'bulletin-kinds');
        // Esc：类别 → 板面 → 关闭
        await A.keyboard.press('Escape');
        await expect(A.locator('[data-venue="bulletin"]')).toHaveAttribute('data-step', 'board');
        await A.keyboard.press('Escape');
        await waitMyTurn(A);
      },
      [A],
    );
    await step(
      '资产表',
      async () => {
        await tool(A, 'action-info');
        const sheet = A.getByTestId('classic-assets');
        await expect(sheet).toBeVisible();
        await A.waitForTimeout(600);
        await shot(A, 'assets');
        await sheet.getByTestId('assets-page-1').click();
        await A.waitForTimeout(300);
        await shot(A, 'assets-estate');
        await sheet.getByTestId('assets-exit').click();
      },
      [A],
    );
    await step(
      '存档窗与托管',
      async () => {
        await tool(A, 'tool-save');
        await expect(A.getByTestId('classic-saves')).toBeVisible();
        await A.waitForTimeout(500);
        await shot(A, 'saves');
        await A.keyboard.press('Escape');
        await tool(A, 'action-autopilot', { right: true });
        await expect(A.getByTestId('trustee-dialog')).toBeVisible();
        await A.waitForTimeout(400);
        await shot(A, 'trustee');
        await A.keyboard.press('Escape');
        await waitMyTurn(A);
      },
      [A],
    );
    await step(
      '查税卡选目标',
      async () => {
        await waitMyTurn(A);
        // 把 P2 传到房主旁边（查税卡只能对视窗内的对手用）
        const near = await A.evaluate(() => {
          const h = (window as Any).__rich4;
          const v = h.store.game.getState().latest;
          const me = v.players.find((p: Any) => p.seat === 0);
          const t = (h.client.currentMap.def.tiles as Any[]).find((x) => x.id === me.node);
          return t.links.find((l: Any) => !l.blocked)?.to ?? null;
        });
        if (near !== null) {
          await debug(A, { op: 'teleport', seat: S2, node: near });
          await waitMyTurn(A);
        }
        // 回合菜单的候选在决策生成时算好：再发一张查税卡让服务器重发回合菜单（候选按 P2 的新位置）
        await debug(A, { op: 'give', seat: S, cards: [26], items: [] });
        await waitMyTurn(A);
        const slot = await A.evaluate(
          () =>
            (window as Any).__rich4.store.game
              .getState()
              .decision.options.cards.find((r: Any) => r.card === 26 && r.usable)?.slot ?? null,
        );
        if (slot === null) throw new Error('查税卡不可用（对手不在视窗内）');
        await tool(A, 'action-cards');
        await A.getByTestId(`inv-card-${slot}`).click();
        await expect(A.getByTestId('target-picker')).toBeVisible();
        await A.waitForTimeout(600);
        await shot(A, 'target-picker');
        const seat = await A.locator('[data-testid^="target-seat-"]').first().getAttribute('data-testid');
        await A.getByTestId(seat!).click();
        await A.getByTestId('target-confirm').click();
        await A.waitForTimeout(1500);
        await shot(A, 'card-cast');
        await settleHost(A);
      },
      [A],
    );

    // ── 买地 ──
    let myLot = '';
    await step(
      '买地',
      async () => {
        const l = await lotFront(A, 'land-free');
        myLot = l.lot;
        await stepOnto(A, S, l.front);
        await waitDecision(A, ['BUY_LAND']);
        await noteScene(A, 'host', 'BUY_LAND');
        await A.waitForTimeout(800);
        await shot(A, 'buy-land');
        await A.getByTestId('buy-confirm').click();
        await settleHost(A);
      },
      [A],
    );
    await step(
      '升级',
      async () => {
        const l = await lotFront(A, { lot: myLot });
        await stepOnto(A, S, l.front);
        await waitDecision(A, ['UPGRADE_LAND']);
        await noteScene(A, 'host', 'UPGRADE_LAND');
        await A.waitForTimeout(800);
        await shot(A, 'upgrade');
        await A.getByTestId('upgrade-confirm').click();
        await settleHost(A);
      },
      [A],
    );

    // ── 银行 ──
    await step(
      '银行',
      async () => {
        await stepOnto(A, S, await tileOfKind(A, 'bank'));
        await waitDecision(A, ['BANK_ATM', 'BANK_COUNTER']);
        let k = await waitDecision(A, ['BANK_ATM', 'BANK_COUNTER']);
        await noteScene(A, 'host', k);
        await A.waitForTimeout(800);
        await shot(A, `bank-${k}`);
        await A.getByTestId('bank-skip').first().click();
        k = await waitDecision(A, ['BANK_ATM', 'BANK_COUNTER', 'TURN_MENU']).catch(() => 'TURN_MENU');
        if (k !== 'TURN_MENU') {
          await noteScene(A, 'host', k);
          await A.waitForTimeout(800);
          await shot(A, `bank-${k}`);
          await A.getByTestId('bank-skip').first().click();
        }
        await settleHost(A);
      },
      [A],
    );

    // ── 商店 ──
    await step(
      '商店',
      async () => {
        await stepOnto(A, S, await tileOfKind(A, 'shop'));
        await waitDecision(A, ['SHOP']);
        await noteScene(A, 'host', 'SHOP');
        await A.waitForTimeout(800);
        await shot(A, 'shop-cards');
        await A.getByTestId('shop-page-item').click();
        await A.waitForTimeout(500);
        await shot(A, 'shop-items');
        await A.getByTestId('shop-leave').click();
        await settleHost(A);
      },
      [A],
    );

    // ── 乐透投注 → 开奖（15 日） ──
    await step(
      '乐透投注',
      async () => {
        await stepOnto(A, S, await tileOfKind(A, 'lottery'));
        await waitDecision(A, ['LOTTERY']);
        await noteScene(A, 'host', 'LOTTERY');
        await A.waitForTimeout(1000);
        await shot(A, 'lottery');
        const free = await A.evaluate(
          () =>
            ((window as Any).__rich4.store.game.getState().decision.options.sold as (number | null)[]).findIndex(
              (o) => o === null,
            ),
        );
        // 号码格按显示的号码（1 起）编 testid
        await A.getByTestId(`lottery-ball-${free + 1}`).click();
        await A.waitForTimeout(400);
        await shot(A, 'lottery-confirm');
        await A.getByTestId('lottery-buy').click();
        await settleHost(A);
      },
      [A],
    );
    await step(
      '乐透开奖',
      async () => {
        await waitMyTurn(A);
        const d = await A.evaluate(() => (window as Any).__rich4.store.game.getState().view.clock.date as number);
        const ym = Math.trunc(d / 100);
        await debug(A, { op: 'setDate', date: ym * 100 + 14 });
        await waitMyTurn(A);
        await A.getByTestId('action-roll').click();
        await waitShowing(A, 'lottery-draw-scene');
        await A.waitForTimeout(1200);
        await shot(A, 'lottery-draw');
        await shot(P2, 'p2-lottery-draw');
        await A.waitForTimeout(2500);
        await shot(A, 'lottery-draw-reveal');
        await settleHost(A);
      },
      [A, P2],
    );

    // ── 魔法屋（P2 现金最多 → 坐牢） ──
    await step(
      '魔法屋',
      async () => {
        await waitMyTurn(A);
        await debug(A, { op: 'setCash', seat: S2, cash: 900_000, deposit: null });
        await waitMyTurn(A);
        await debug(A, { op: 'forceNext', purpose: 'magicCond', values: [3] });
        await stepOnto(A, S, await tileOfKind(A, 'magic'));
        await waitDecision(A, ['MAGIC_CAST']);
        await noteScene(A, 'host', 'MAGIC_CAST');
        await A.waitForTimeout(1200);
        await shot(A, 'magic');
        await A.getByTestId('magic-effect-2').hover();
        await A.waitForTimeout(300);
        await shot(A, 'magic-hover');
        await A.getByTestId('magic-effect-2').click();
        await A.waitForTimeout(300);
        await shot(A, 'magic-confirm');
        await A.getByTestId('magic-confirm').click();
        await A.getByTestId('magic-cast-flic')
          .waitFor({ state: 'visible', timeout: 5000 })
          .then(async () => {
            await A.waitForTimeout(700);
            await shot(A, 'magic-cast');
          })
          .catch(() => log('没截到施法 FLC'));
        await settleHost(A);
      },
      [A],
    );

    // ── 监狱保释 P2、医院 ──
    await step(
      '监狱',
      async () => {
        await waitMyTurn(A);
        await debug(A, { op: 'setPoints', seat: S, points: 900 });
        await stepOnto(A, S, await tileOfKind(A, 'jail'));
        await waitDecision(A, ['BAIL']);
        await noteScene(A, 'host', 'BAIL');
        await A.waitForTimeout(1000);
        await shot(A, 'jail');
        const jailed = await A.evaluate(
          (s2) =>
            ((window as Any).__rich4.store.game.getState().latest.players as Any[]).some(
              (p) => p.seat === s2 && p.st.jail > 0,
            ),
          S2,
        );
        if (jailed) {
          await A.getByTestId(`bail-seat-${S2}`).click();
          await A.waitForTimeout(400);
          await shot(A, 'jail-pick');
          await A.getByTestId('bail-confirm').click();
        } else {
          await A.getByTestId('bail-hire-thief').click();
          await A.waitForTimeout(400);
          await shot(A, 'jail-pick');
          await A.getByTestId('bail-skip').click();
        }
        await settleHost(A);
      },
      [A],
    );
    await step(
      '医院',
      async () => {
        await stepOnto(A, S, await tileOfKind(A, 'hospital'));
        await waitDecision(A, ['BAIL']);
        await noteScene(A, 'host', 'BAIL');
        await A.waitForTimeout(1000);
        await shot(A, 'hospital');
        await A.getByTestId('bail-hire-spy').click();
        await A.waitForTimeout(400);
        await shot(A, 'hospital-pick');
        await A.getByTestId('bail-skip').click();
        await settleHost(A);
      },
      [A],
    );

    // ── 新闻、命运 ──
    await step(
      '新闻',
      async () => {
        await waitMyTurn(A);
        await debug(A, { op: 'stackDeck', deck: 'news', ids: [11] });
        await stepOnto(A, S, await tileOfKind(A, 'news'));
        await A.getByTestId('news-popup').waitFor({ state: 'visible', timeout: 60_000 });
        await A.waitForTimeout(1200);
        await shot(A, 'news');
        await settleHost(A);
      },
      [A],
    );
    await step(
      '命运',
      async () => {
        await waitMyTurn(A);
        await debug(A, { op: 'stackDeck', deck: 'fate', ids: [25] });
        await stepOnto(A, S, await tileOfKind(A, 'fate'));
        await A.getByTestId('fate-popup').waitFor({ state: 'visible', timeout: 60_000 });
        await A.waitForTimeout(1200);
        await shot(A, 'fate');
        await settleHost(A);
      },
      [A],
    );

    // ── 拍卖：房主在自己的地上出拍卖卡；P2 竞拍（暂停代打），房主看观战版拍卖厅 ──
    await step(
      '拍卖',
      async () => {
        await waitMyTurn(A);
        // 与 events / venues-b 的 E2E 相同：站在一块无主地上出拍卖卡
        const l = await lotFront(A, 'land-free');
        await debug(A, { op: 'teleport', seat: S, node: l.front });
        await waitMyTurn(A);
        // 回合菜单的候选在决策生成时算好：传送之后再发拍卖卡，让服务器按新位置重发回合菜单
        await debug(A, { op: 'give', seat: S, cards: [8], items: [] });
        await waitMyTurn(A);
        p2.ctl.on = false;
        const row = await A.evaluate(() =>
          (window as Any).__rich4.store.game
            .getState()
            .decision.options.cards.find((r: Any) => r.card === 8 && r.usable),
        );
        log(`  拍卖卡 ${JSON.stringify(row).slice(0, 200)}`);
        await A.evaluate(() => {
          const h = (window as Any).__rich4;
          const dd = h.store.game.getState().decision;
          const row =
            dd.options.cards.find((r: Any) => r.card === 8 && r.usable) ??
            dd.options.cards.find((r: Any) => r.card === 8);
          const tg = row.targets;
          const target =
            tg.t === 'underfoot'
              ? { t: 'underfoot', facility: null }
              : tg.t === 'lot'
                ? { t: 'lot', lot: tg.lots[0], facility: null }
                : { t: 'none' };
          return h.client.act({ type: 'USE_CARD', slot: row.slot, card: 8, target }, dd.decisionId);
        });
        await waitDecision(P2, ['AUCTION_BID'], 90_000);
        await noteScene(P2, 'p2', 'AUCTION_BID');
        await A.getByTestId('classic-auction-watch')
          .waitFor({ state: 'visible', timeout: 20_000 })
          .catch(() => log('房主没看到观战版拍卖厅'));
        await P2.waitForTimeout(1000);
        await shot(P2, 'p2-auction');
        await shot(A, 'auction-watch');
        const scene = P2.getByTestId('decision-AUCTION_BID');
        await scene.getByTestId('auction-bid-0').click();
        // 之后每次被问都退出
        for (let i = 0; i < 6; i++) {
          const k = await waitDecision(P2, ['AUCTION_BID'], 20_000).catch(() => null);
          if (!k) break;
          if (i === 0) {
            await P2.waitForTimeout(600);
            await shot(P2, 'p2-auction-again');
            await shot(A, 'auction-watch-2');
          }
          // AI 出价很快，P2 的决策频繁重问：点不到就经测试钩子提交 QUIT
          await scene
            .getByTestId('auction-quit')
            .click({ timeout: 5000 })
            .catch(() =>
              P2.evaluate(() => {
                const h = (window as Any).__rich4;
                const d = h.store.game.getState().decision;
                if (d?.kind === 'AUCTION_BID') return h.client.act({ type: 'QUIT' }, d.decisionId);
                return null;
              }),
            );
        }
        p2.ctl.on = true;
        await settleHost(A);
      },
      [A, P2],
    );
    p2.ctl.on = true;

    // ── 设施：买地 → 兴建旅馆 → P2 住进旅馆（轮盘） ──
    let fac = '';
    await step(
      '买设施',
      async () => {
        const l = await lotFront(A, 'facility-free');
        fac = l.lot;
        await stepOnto(A, S, l.front);
        await waitDecision(A, ['BUY_FACILITY']);
        await noteScene(A, 'host', 'BUY_FACILITY');
        await A.waitForTimeout(800);
        await shot(A, 'buy-facility');
        await A.getByTestId('buy-confirm').click();
        await settleHost(A);
      },
      [A],
    );
    await step(
      '兴建旅馆',
      async () => {
        const l = await lotFront(A, { lot: fac });
        await stepOnto(A, S, l.front);
        await waitDecision(A, ['BUILD_FACILITY']);
        await noteScene(A, 'host', 'BUILD_FACILITY');
        await A.waitForTimeout(800);
        await shot(A, 'build-facility');
        await A.getByTestId('facility-type-hotel').click();
        await A.getByTestId('facility-confirm').click();
        await settleHost(A);
      },
      [A],
    );
    await step(
      '轮盘（P2 住旅馆）',
      async () => {
        p2.ctl.on = false;
        await untilTurnOf(A, P2);
        const l = await lotFront(P2, { lot: fac });
        const r = await routeTo(P2, l.front);
        await debug(P2, { op: 'teleport', seat: S2, node: r.node, prev: r.prev });
        await waitMyTurn(P2);
        await debug(P2, { op: 'forceNext', purpose: 'wheel', values: [7] });
        await waitMyTurn(P2);
        await debug(P2, { op: 'forceNext', purpose: 'dice', values: [1] });
        await waitMyTurn(P2);
        await P2.getByTestId('action-roll').click();
        p2.ctl.on = true;
        const wheel = A.getByTestId('roulette-popup');
        await wheel.waitFor({ state: 'visible', timeout: 60_000 });
        await A.waitForTimeout(500);
        await shot(A, 'roulette-spin');
        await shot(P2, 'p2-roulette');
        await A.waitForTimeout(2000);
        await shot(A, 'roulette-stop');
        await settleHost(A);
      },
      [A, P2],
    );
    p2.ctl.on = true;

    // ── 老虎机：小财神 ──
    await step(
      '老虎机',
      async () => {
        await waitMyTurn(A);
        const god = await A.evaluate(() => {
          const v = (window as Any).__rich4.store.game.getState().view;
          const g = v.gods.find((x: Any) => x.kind === 1 && x.where.t === 'road');
          return g ? (g.where.node as number) : null;
        });
        if (god === null) throw new Error('小财神不在路上');
        await debug(A, { op: 'forceNext', purpose: 'slot', values: [1, 2, 3] });
        await stepOnto(A, S, god);
        const slot = A.getByTestId('god-slot');
        await slot.waitFor({ state: 'visible', timeout: 60_000 });
        await A.waitForTimeout(600);
        await shot(A, 'slot-rolling');
        await A.waitForTimeout(2500);
        await shot(A, 'slot-stop');
        await settleHost(A);
      },
      [A],
    );

    // ── 月结 ──
    await step(
      '月结',
      async () => {
        await waitMyTurn(A);
        const d = await A.evaluate(() => (window as Any).__rich4.store.game.getState().view.clock.date as number);
        const y = Math.trunc(d / 10000);
        const m = Math.trunc(d / 100) % 100;
        const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
        await debug(A, { op: 'setDate', date: y * 10000 + m * 100 + last });
        await waitMyTurn(A);
        await A.getByTestId('action-roll').click();
        await waitShowing(A, 'monthly-popup');
        await A.waitForTimeout(1500);
        await shot(A, 'monthly');
        await shot(P2, 'p2-monthly');
        await settleHost(A);
      },
      [A, P2],
    );

    // ── 小游戏 ──
    for (const [kind, id] of [
      ['penguin', 'penguin'],
      ['balloon', 'balloon'],
      ['xicong', 'xicong'],
    ] as const) {
      await step(
        `小游戏 ${id}`,
        async () => {
          await stepOnto(A, S, await tileOfKind(A, kind));
          await waitDecision(A, ['MINIGAME']);
          await noteScene(A, 'host', 'MINIGAME');
          await A.waitForTimeout(600);
          await shot(A, `mg-${id}-intro`);
          // 原版开局倒计时对话框只有「不玩了」，倒计时结束自动开局（不点任何钮）
          const host = A.locator(`[data-testid="minigame-host"][data-minigame="${id}"]`);
          await host.waitFor({ state: 'visible', timeout: 30_000 });
          const view = await host.getAttribute('data-view');
          log(`  小游戏 ${id} 视图 ${view}`);
          await A.waitForTimeout(900);
          await shot(A, `mg-${id}-ready`);
          await A.waitForFunction(() => (window as Any).__rich4.minigame?.state()?.phase === 'playing', undefined, {
            timeout: 30_000,
          });
          await A.waitForTimeout(3000);
          // 随手点几下（企鹅走格、气球射击、喜从天降左右移动）
          const box = await host.boundingBox();
          if (box) {
            for (let i = 0; i < 6; i++) {
              await A.mouse.click(box.x + box.width * (0.3 + 0.08 * i), box.y + box.height * (0.45 + 0.03 * (i % 3)));
              await A.waitForTimeout(400);
            }
          }
          await shot(A, `mg-${id}-play`);
          await A.waitForFunction(() => (window as Any).__rich4.minigame?.state()?.phase === 'result', undefined, {
            timeout: 60_000,
          });
          await A.waitForTimeout(500);
          await shot(A, `mg-${id}-result`);
          await host.waitFor({ state: 'detached', timeout: 30_000 });
          await settleHost(A);
        },
        [A],
      );
    }

    // ── 投降与终局：P2 先投降（死神附身对象），房主再投降 → 终局 ──
    await step(
      'P2 投降',
      async () => {
        p2.ctl.on = false;
        await untilTurnOf(A, P2);
        await tool(P2, 'action-cards');
        await P2.getByTestId('turn-surrender').click();
        await P2.waitForTimeout(500);
        await shot(P2, 'p2-surrender');
        await P2.getByTestId('surrender-confirm').click();
        const k = await waitDecision(P2, ['DEATH_GOD_TARGET'], 30_000).catch(() => null);
        if (k) {
          await noteScene(P2, 'p2', 'DEATH_GOD_TARGET');
          await P2.waitForTimeout(600);
          await shot(P2, 'p2-deathgod');
          await actDefault(P2);
        }
        p2.ctl.on = true;
      },
      [A, P2],
    );
    await step(
      '终局（资产达标）',
      async () => {
        // 只剩一个真人时不能投降（canSurrender 要求至少两个真人）：把房主的现金调到胜利条件（10 倍）以上，下一天结算终局
        await waitMyTurn(A, 180_000);
        await debug(A, { op: 'setCash', seat: S, cash: 5_000_000, deposit: null });
        await waitMyTurn(A);
        await A.getByTestId('action-roll').click();
        await waitShowing(A, 'game-over-screen');
        await A.waitForTimeout(1500);
        await shot(A, 'game-over');
        await shot(P2, 'p2-game-over');
      },
      [A, P2],
    );
    p2.ctl.stop = true;
    await p2.done.catch(() => undefined);

    const audio = await A.evaluate(() => {
      const a = (window as Any).__rich4?.audio;
      if (!a) return null;
      const music: string[] = [];
      for (const e of (a.log ?? []) as Any[]) {
        if (e.kind !== 'music') continue;
        const k = `${e.op}:${e.key ?? ''}`;
        if (music.at(-1) !== k) music.push(k);
      }
      const count: Record<string, number> = {};
      for (const e of (a.log ?? []) as Any[]) count[`${e.kind}.${e.op}`] = (count[`${e.kind}.${e.op}`] ?? 0) + 1;
      return { state: a.state, count, music: music.slice(-80) };
    }).catch(() => null);
    Object.assign(rec, { audio });
    const failed = rec.steps.filter((s) => !s.ok);
    log(`完成：${rec.steps.length - failed.length}/${rec.steps.length} 步成功，错误 ${rec.errors.length} 条`);
    for (const f of failed) log(`  失败 ${f.name}: ${f.note}`);
    for (const e of rec.errors.slice(0, 30)) log(`  ${e}`);
  } finally {
    writeFileSync(join(OUT, 'summary.json'), `${JSON.stringify({ tag: TAG, ...rec }, null, 2)}\n`);
    for (const c of ctxs) await c.close().catch(() => undefined);
  }
});
