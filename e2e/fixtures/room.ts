// E2E 夹具（design/client.md §12.2）：fourPlayers（4 个互相隔离的 BrowserContext，各自昵称 P1..P4，停在首页）、
// spectator（第 5 个上下文），以及建房、进房、选角、准备、开局、掷骰、回答决策、读取 HUD 的助手。
// 对局页通过 window.__rich4（开发 / 测试模式的钩子）等待动画空闲与读取状态；点击一律走 data-testid 的 DOM 按钮。
import { type Browser, type BrowserContext, test as base, expect, type Page } from '@playwright/test';

/**
 * 测试页 URL 参数：只提交不播放、关声音、测试构建开关（?test=1：生产构建里也开批尾对账，不一致走 console.error，
 * 下面的 errors 收集到后用例失败；client.md §4.3「CI 中视为测试失败」）
 */
export const Q = 'anim=instant&audio=off&test=1';
/** 播放演出的测试页参数（不带 anim=instant） */
export const Q_ANIM = 'audio=off&test=1';

export interface Player {
  context: BrowserContext;
  page: Page;
  nickname: string;
  /** 页面上的未捕获异常与 console.error */
  errors: string[];
}

export async function newPlayer(browser: Browser, nickname: string, query = Q): Promise<Player> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    // 演出卡住被看门狗中止也算失败（EventPlayer 的 warn）
    if (m.type() === 'warning' && m.text().includes('未结束')) errors.push(`watchdog: ${m.text()}`);
  });
  await page.goto(`/?${query}`);
  const nick = page.getByTestId('home-nickname');
  await nick.fill(nickname);
  await nick.blur();
  return { context, page, nickname, errors };
}

export interface RoomOptions {
  map?: string;
  timer?: 'fast' | 'normal' | 'slow' | 'off';
  aiCount?: 0 | 1 | 2 | 3;
  spectators?: boolean;
}

/** 首页建房，返回房间号（停在房间大厅） */
export async function createRoom(page: Page, o: RoomOptions = {}): Promise<string> {
  await page.getByTestId('home-create').click();
  const map = page.getByTestId('set-map');
  await expect(map.locator(`option[value="${o.map ?? 'test'}"]`)).toHaveCount(1);
  await map.selectOption(o.map ?? 'test');
  await page.getByTestId('set-timer').selectOption(o.timer ?? 'off');
  if (o.spectators === false) await page.getByTestId('set-spectators').uncheck();
  if (o.aiCount) await page.getByTestId('set-ai-count').selectOption(String(o.aiCount));
  await page.getByTestId('create-submit').click();
  await page.waitForURL(/\/r\/\d{6}/);
  await expect(page.getByTestId('screen-room')).toBeVisible();
  const code = /\/r\/(\d{6})/.exec(page.url())?.[1];
  if (!code) throw new Error(`no room code in ${page.url()}`);
  return code;
}

/** 通过邀请链接进房 */
export async function joinRoom(page: Page, code: string, watch = false): Promise<void> {
  await page.goto(`/r/${code}?${Q}${watch ? '&watch=1' : ''}`);
  await expect(page.getByTestId('screen-room')).toBeVisible();
}

export async function pickCharacter(page: Page, id: number): Promise<void> {
  await page.getByTestId(`char-${id}`).click();
  await page.getByTestId('char-select').click();
  await expect(page.getByTestId('char-select')).toHaveText('已选择');
}

export async function setReady(page: Page): Promise<void> {
  await page.getByTestId('room-ready').click();
  await expect(page.getByTestId('room-ready')).toHaveAttribute('aria-pressed', 'true');
}

/** 本页的对局已拿到快照并且动画空闲 */
export async function waitIdle(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const h = (window as any).__rich4;
    return !!h?.store?.game && h.store.game.getState().view !== null && h.eventPlayer.idle;
  });
}

export async function startGame(host: Page, pages: Page[]): Promise<void> {
  await expect(host.getByTestId('room-start')).toBeEnabled();
  await host.getByTestId('room-start').click();
  for (const p of pages) {
    await expect(p.getByTestId('screen-game')).toBeVisible();
    await waitIdle(p);
  }
}

/** 本人当前决策的 kind（没有则 null） */
export async function decisionKind(page: Page): Promise<string | null> {
  // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
  return page.evaluate(() => (window as any).__rich4.store.game.getState().decision?.kind ?? null);
}

/** 等到轮到本页玩家掷骰（TURN_MENU 就绪、动画播完、未提交） */
export async function waitMyTurn(page: Page, timeout = 60_000): Promise<void> {
  await page.waitForFunction(
    () => {
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      const h = (window as any).__rich4;
      const g = h?.store?.game?.getState();
      return !!g && h.eventPlayer.idle && g.decision?.kind === 'TURN_MENU' && g.submitting === null;
    },
    undefined,
    { timeout },
  );
  await expect(page.getByTestId('action-roll')).toBeEnabled();
}

/** 等到本页出现某种（非 TURN_MENU）决策 */
export async function waitDecision(page: Page, kinds: string[], timeout = 30_000): Promise<string> {
  const handle = await page.waitForFunction(
    (ks) => {
      // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
      const h = (window as any).__rich4;
      const g = h?.store?.game?.getState();
      const k = g?.decision?.kind;
      return h?.eventPlayer.idle && g?.submitting === null && k && ks.includes(k) ? k : null;
    },
    kinds,
    { timeout },
  );
  return (await handle.jsonValue()) as string;
}

/** debug:act（只在 RICH4_TEST_MODE=1 的服务器上注册） */
export async function debugAct(page: Page, op: Record<string, unknown>): Promise<void> {
  const r = await page.evaluate(
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    (o) => (window as any).__rich4.client.debug(o) as Promise<{ ok: boolean; error?: unknown }>,
    op,
  );
  expect(r.ok, JSON.stringify(r)).toBe(true);
}

/** 服务器处理完 debug 后本页的 seq 追上 */
export async function waitSeqAtLeast(page: Page, seq: number): Promise<void> {
  await page.waitForFunction(
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    (s) => (window as any).__rich4.store.game.getState().seq >= s && (window as any).__rich4.eventPlayer.idle,
    seq,
  );
}

export async function currentSeq(page: Page): Promise<number> {
  // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
  return page.evaluate(() => (window as any).__rich4.store.game.getState().seq as number);
}

/** 点行动区的掷骰按钮（DOM 备用按钮） */
export async function roll(page: Page): Promise<void> {
  await page.getByTestId('action-roll').click();
}

const CONFIRM_BUTTONS: Record<string, [string, string]> = {
  BUY_LAND: ['buy-confirm', 'buy-decline'],
  BUY_FACILITY: ['buy-confirm', 'buy-decline'],
  UPGRADE_LAND: ['upgrade-confirm', 'upgrade-decline'],
  UPGRADE_FACILITY: ['upgrade-confirm', 'upgrade-decline'],
};

/**
 * 回答确认类决策（买地 / 升级点对话框按钮）；其他 kind 若有 GenericChoice 就点「按默认处理」，
 * 否则（专用对话框，按钮因 kind 而异）经测试钩子提交该决策的 defaultIntent。
 */
export async function answer(page: Page, choice: 'confirm' | 'decline'): Promise<string> {
  const kind = await decisionKind(page);
  if (!kind) throw new Error('no decision');
  const ids = CONFIRM_BUTTONS[kind];
  if (ids) {
    await page.getByTestId(ids[choice === 'confirm' ? 0 : 1]).click();
    return kind;
  }
  const generic = page.getByTestId('generic-default');
  if ((await generic.count()) > 0) {
    await generic.click();
    return kind;
  }
  await page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const h = (window as any).__rich4;
    const d = h.store.game.getState().decision;
    return h.client.act(d.defaultIntent, d.decisionId);
  });
  return kind;
}

/** 本页 HUD 上 4 个座位的现金 / 存款 / 点券与全部地块归属（读 data-testid） */
export interface HudSnapshot {
  players: Record<string, { cash: string | null; deposit: string | null; points: string | null }>;
  lots: Record<string, { owner: string | null; level: string | null }>;
}

export async function hudSnapshot(page: Page): Promise<HudSnapshot> {
  return page.evaluate(() => {
    const val = (id: string): string | null =>
      document.querySelector(`[data-testid="${id}"]`)?.getAttribute('data-value') ?? null;
    const players: HudSnapshot['players'] = {};
    for (const chip of document.querySelectorAll('[data-testid^="chip-"][data-current]')) {
      const seat = (chip.getAttribute('data-testid') ?? '').slice('chip-'.length);
      players[seat] = { cash: val(`p${seat}-cash`), deposit: val(`p${seat}-deposit`), points: val(`p${seat}-points`) };
    }
    const lots: HudSnapshot['lots'] = {};
    for (const li of document.querySelectorAll('[data-testid="hud-lots"] li')) {
      lots[li.getAttribute('data-lot') ?? '?'] = {
        owner: li.getAttribute('data-owner'),
        level: li.getAttribute('data-level'),
      };
    }
    return { players, lots };
  });
}

/** 本页收到的最新权威 view（批尾 batch.view）换算成与 HUD 同形的快照 */
export async function serverSnapshot(page: Page): Promise<HudSnapshot> {
  return page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: 测试钩子
    const v = (window as any).__rich4.store.game.getState().latest;
    const players: HudSnapshot['players'] = {};
    for (const p of v.players) {
      players[String(p.seat)] = { cash: String(p.cash), deposit: String(p.deposit), points: String(p.points) };
    }
    const lots: HudSnapshot['lots'] = {};
    for (const l of [...v.lands, ...v.facilities]) {
      lots[l.id] = { owner: l.owner === null ? '' : String(l.owner), level: String(l.level) };
    }
    return { players, lots };
  });
}

interface Fixtures {
  fourPlayers: Player[];
  spectator: Player;
}

export const test = base.extend<Fixtures>({
  fourPlayers: async ({ browser }, use) => {
    const players: Player[] = [];
    for (let i = 1; i <= 4; i++) players.push(await newPlayer(browser, `P${i}`));
    await use(players);
    for (const p of players) await p.context.close();
  },
  spectator: async ({ browser }, use) => {
    const p = await newPlayer(browser, '观众');
    await use(p);
    await p.context.close();
  },
});

export { expect };
