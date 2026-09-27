// 整合手测（原版皮肤全流程）：用本机 Chrome 打开 test/w2-play-dev.sh 起的开发服（真实素材包 + 口令门禁），
// 建台湾图 4 人房（本人 + 3 电脑，原版节奏），本人的回合走经典外壳的 DOM（GO 钮、决策对话框按钮），打满 N 回合。
// 记录：事件类型覆盖、原版舞台播放的 FLIC、决策种类、控制台错误 / 看门狗 / handler 出错；首次出现的 FLIC 演出与决策
// 各截一张图，另每 5 天截一张。截图与日志写到 .cache/w3（含原版素材，不入库）。
// --cover：在指定天数的本人回合用 debug:act 发卡 / 传送，走经典外壳的 DOM 出陷害卡（入狱 + 警车）、放路障、
// 买股票、踩自己的地升级，补齐自然对局里不一定出现的项目。
// 用法：node test/w2-play.mjs [宽x高] [--days=22] [--tag=desk] [--cover] [--debug=script]
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.W3_BASE ?? 'http://localhost:5419';
const PASS = readFileSync('.cache/w3/passcode.txt', 'utf8').trim();
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1920x1080').split('x').map(Number);
const DAYS = Number(args.find((a) => a.startsWith('--days='))?.slice(7) ?? 22);
const TAG = args.find((a) => a.startsWith('--tag='))?.slice(6) ?? `${size[0]}x${size[1]}`;
const SCRIPTED = args.includes('--debug=script');
const COVER = args.includes('--cover');
const OUT = `.cache/w3/play-${TAG}`;
mkdirSync(OUT, { recursive: true });
const LOG = `${OUT}/play.log`;
writeFileSync(LOG, '');
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`;
  console.log(line);
  appendFileSync(LOG, `${line}\n`);
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 1 });
const r = await ctx.request.post(`${BASE}/api/access`, { data: { passcode: PASS } });
if (r.status() !== 200) throw new Error(`access ${r.status()}`);
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error') errors.push(`console.error: ${t}`);
  if (m.type() === 'warning' && /未结束|handler 出错|回退|失败|超预算/.test(t)) errors.push(`warn: ${t}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

let shotN = 0;
async function shot(name) {
  shotN++;
  const file = `${OUT}/${String(shotN).padStart(3, '0')}-${name}.jpg`;
  await page.screenshot({ path: file, type: 'jpeg', quality: 70 }).catch(() => {});
  log(`shot ${file}`);
}

await page.goto(`${BASE}/?test=1`);
await page.getByTestId('home-nickname').fill('測試者');
await page.getByTestId('home-nickname').blur();
await page.getByTestId('home-create').click();
await page.getByTestId('set-map').selectOption('taiwan');
await page.getByTestId('set-timer').selectOption('normal');
await page.getByTestId('set-pacing').selectOption('original');
await page.getByTestId('set-ai-count').selectOption('3');
await page.getByTestId('create-submit').click();
await page.waitForURL(/\/r\/\d{6}/);
await page.getByTestId('char-9').click();
await page.getByTestId('char-select').click();
await page.getByTestId('room-start').click();
await page.getByTestId('screen-game').waitFor();
await page.waitForFunction(() => window.__rich4?.store?.game?.getState().view !== null, undefined, { timeout: 60_000 });
log(`game started, url ${page.url()}`);

const seenEvents = new Map();
const seenFlics = new Map();
const seenDecisions = new Map();
const firstDays = new Map();
let lastLogId = 0;
let lastDate = null;
let days = 0;
let myTurns = 0;
let lastShotDay = -1;

/** 页面状态（一次 evaluate 取全） */
async function probe() {
  return page.evaluate((after) => {
    const h = window.__rich4;
    const g = h.store.game.getState();
    const stage = h.client?.board?.stage;
    const cur = stage?.currentEvent ?? null;
    return {
      date: g.view?.clock.date ?? null,
      idle: h.eventPlayer.idle,
      decision: g.decision ? { kind: g.decision.kind, id: g.decision.decisionId } : null,
      submitting: g.submitting,
      over: g.over !== null,
      cur,
      log: g.log.filter((l) => l.id > after).map((l) => ({ id: l.id, type: l.type, text: l.text })),
      skin: h.skin ? { skin: h.skin.resolution.skin, board: h.skin.boardInUse, lang: h.skin.lang } : null,
      pacing: h.store.room.getState().room?.settings.pacing ?? null,
    };
  }, lastLogId);
}

/** 等本人的回合菜单重新就绪（debug:act / 非终结操作之后服务器会重发） */
async function waitMenu() {
  await page.waitForFunction(
    () => {
      const h = window.__rich4;
      const g = h.store.game.getState();
      return h.eventPlayer.idle && g.decision?.kind === 'TURN_MENU' && g.submitting === null;
    },
    undefined,
    { timeout: 60_000 },
  );
}

async function debug(op) {
  const s0 = await page.evaluate(() => window.__rich4.store.game.getState().seq);
  const r = await page.evaluate((o) => window.__rich4.client.debug(o), op);
  if (!r.ok) throw new Error(`debug ${JSON.stringify(op)} → ${JSON.stringify(r)}`);
  await page.waitForFunction((s) => window.__rich4.store.game.getState().seq > s, s0, { timeout: 30_000 });
  await waitMenu();
}

async function menuOptions() {
  return page.evaluate(() => window.__rich4.store.game.getState().decision?.options ?? null);
}

/** 回合菜单 → 卡片 / 道具 → 点一张 → 目标面板里 pick → 确认 */
async function useFromSheet(sheet, tile, pick) {
  await page.getByTestId(`action-${sheet}`).click();
  await page.getByTestId(tile).click();
  const picker = page.getByTestId('target-picker');
  await picker.waitFor({ timeout: 10_000 });
  await shot(`picker-${tile}`);
  if (pick) await pick(picker);
  await page.getByTestId('target-confirm').click();
  await page.waitForTimeout(500);
  await waitMenu();
}

const covered = new Set();
/** 按天安排的补充动作（本人回合开始、掷骰之前）；返回 false 表示今天做不了（例如休市），明天再试 */
const coverPlan = [
  {
    id: 'give',
    fromDay: 1,
    run: async () => {
      await debug({ op: 'give', seat: 0, cards: [17], items: [{ item: 2, qty: 1 }] });
      return true;
    },
  },
  {
    // 陷害卡只能对视窗半宽内的对手用：候选为空时明天再试
    id: 'frame',
    fromDay: 1,
    run: async () => {
      const o = await menuOptions();
      const row = o?.cards?.find((r) => r.card === 17);
      const seat = row?.usable ? row.targets.actors?.find((a) => a.t === 'seat')?.seat : undefined;
      if (seat === undefined) return false;
      await useFromSheet('cards', `inv-card-${row.slot}`, (p) => p.getByTestId(`target-actor-seat-${seat}`).click());
      log(`  cover frame → seat ${seat}`);
      return true;
    },
  },
  {
    id: 'roadblock',
    fromDay: 1,
    run: async () => {
      const o = await menuOptions();
      const row = o?.items?.find((r) => r.item === 2);
      if (!row?.usable) return false;
      await useFromSheet('items', 'inv-item-2', (p) => p.locator('[data-testid^="target-node-"]').first().click());
      return true;
    },
  },
  {
    id: 'stock',
    fromDay: 3,
    run: async () => {
      const o = await menuOptions();
      const row = o?.stock?.rows?.find((r) => !r.suspended && !r.limitUp && !r.limitDown && r.maxBuy >= 100);
      if (!row) return false;
      await page.getByTestId('action-stock').click();
      const sheet = page.getByTestId('turn-stock-sheet');
      await sheet.waitFor({ timeout: 10_000 });
      await sheet.getByTestId(`stock-pick-${row.idx}`).click();
      await sheet.getByTestId('stock-side-buy').click();
      await sheet.getByRole('spinbutton').first().fill('100');
      await shot('stock-sheet');
      await sheet.getByTestId('stock-submit').click();
      await page.waitForTimeout(500);
      await waitMenu();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      return true;
    },
  },
  {
    id: 'upgrade',
    fromDay: 5,
    run: async () => {
      const where = await page.evaluate(() => {
        const h = window.__rich4;
        const v = h.store.game.getState().latest;
        const map = h.client.currentMap;
        const mine = v.lands.find((l) => l.owner === 0 && l.level < 5);
        if (!mine || !map) return null;
        const front = map.lot(mine.id).frontTiles[0];
        const prev = map.def.tiles.find((t) => t.links.some((l) => l.to === front));
        return prev ? { node: prev.id, front, lot: mine.id } : null;
      });
      if (!where) return false;
      // 来路取 node 的另一个邻格（不能是要去的 front，否则会朝反方向走）
      const back = await page.evaluate(
        ([n, f]) => {
          const map = window.__rich4.client.currentMap;
          const t = map.def.tiles.find((x) => x.id !== f && x.links.some((l) => l.to === n));
          return t?.id ?? null;
        },
        [where.node, where.front],
      );
      await debug({ op: 'teleport', seat: 0, node: where.node, ...(back !== null ? { prev: back } : {}) });
      await debug({ op: 'forceNext', purpose: 'dice', values: [1] });
      log(`  cover upgrade: ${where.lot} via ${where.node} → ${where.front}`);
      return true;
    },
  },
];

/** 每个本人回合最多做成一项；做不了（返回 false）的留到之后的回合 */
async function cover() {
  for (const c of coverPlan) {
    if (covered.has(c.id) || days < c.fromDay) continue;
    try {
      if (await c.run()) {
        covered.add(c.id);
        log(`  cover ${c.id} done (day ${days})`);
        return;
      }
    } catch (e) {
      log(`  cover ${c.id} failed: ${e.message.split('\n')[0]}`);
      covered.add(c.id);
      await shot(`cover-fail-${c.id}`);
      await page.keyboard.press('Escape').catch(() => {});
      return;
    }
  }
}

const CONFIRM = {
  BUY_LAND: 'buy-confirm',
  BUY_FACILITY: 'buy-confirm',
  UPGRADE_LAND: 'upgrade-confirm',
  UPGRADE_FACILITY: 'upgrade-confirm',
};

/** 本人的决策：掷骰点 GO 钮（经典外壳），买地 / 升级点确认，其余点「按默认处理」或提交 defaultIntent */
async function answer(kind) {
  if (kind === 'TURN_MENU') {
    myTurns++;
    if (COVER) {
      await cover();
      await waitMenu();
    }
    const go = page.getByTestId('action-roll');
    await go.click({ timeout: 5000 });
    return;
  }
  const id = CONFIRM[kind];
  if (id && (await page.getByTestId(id).count()) > 0) {
    await page.getByTestId(id).click({ timeout: 5000 });
    return;
  }
  const generic = page.getByTestId('generic-default');
  if ((await generic.count()) > 0) {
    await generic.click({ timeout: 5000 });
    return;
  }
  await page.evaluate(() => {
    const h = window.__rich4;
    const d = h.store.game.getState().decision;
    return h.client.act(d.defaultIntent, d.decisionId);
  });
}

const t0 = Date.now();
let answeredId = null;
let stuckSince = Date.now();
while (days < DAYS) {
  const s = await probe();
  if (s.over) {
    log('game over');
    break;
  }
  if (lastDate === null) log(`skin ${JSON.stringify(s.skin)} pacing ${s.pacing}`);
  if (s.date !== lastDate) {
    if (lastDate !== null) days++;
    lastDate = s.date;
    log(`day ${days} date ${s.date} (turns ${myTurns}, events ${seenEvents.size}, flics ${seenFlics.size})`);
    if (days % 5 === 0 && days !== lastShotDay) {
      lastShotDay = days;
      await shot(`day${days}`);
    }
  }
  for (const l of s.log) {
    lastLogId = Math.max(lastLogId, l.id);
    seenEvents.set(l.type, (seenEvents.get(l.type) ?? 0) + 1);
    if (!firstDays.has(l.type)) {
      firstDays.set(l.type, days);
      log(`  first ${l.type}: ${l.text}`);
    }
  }
  if (s.cur?.flicKey) {
    const k = `${s.cur.type}:${s.cur.flicKey}`;
    if (!seenFlics.has(k)) {
      seenFlics.set(k, 1);
      log(`  flic ${k} budget ${s.cur.budget}`);
      await page.waitForTimeout(500);
      await shot(`flic-${s.cur.type}`);
    } else seenFlics.set(k, seenFlics.get(k) + 1);
  }
  if (s.decision && s.idle && s.submitting === null && s.decision.id !== answeredId) {
    const kind = s.decision.kind;
    if (!seenDecisions.has(kind)) {
      seenDecisions.set(kind, 0);
      await page.waitForTimeout(400);
      await shot(`decision-${kind}`);
    }
    seenDecisions.set(kind, seenDecisions.get(kind) + 1);
    answeredId = s.decision.id;
    try {
      await answer(kind);
    } catch (e) {
      log(`  answer ${kind} failed: ${e.message.split('\n')[0]}`);
      answeredId = null;
    }
    stuckSince = Date.now();
  }
  if (!s.idle || s.decision) stuckSince = Date.now();
  if (Date.now() - stuckSince > 120_000) {
    log('no progress for 120s');
    await shot('stuck');
    break;
  }
  await page.waitForTimeout(250);
}
await shot('final');
// 音频：场景曲切换与各类声音次数（__rich4.audio.log；?audio=off 时为 null）
const audio = await page.evaluate(() => {
  const a = window.__rich4?.audio;
  if (!a) return null;
  const log = a.log ?? [];
  const count = {};
  for (const e of log) count[`${e.kind}.${e.op}`] = (count[`${e.kind}.${e.op}`] ?? 0) + 1;
  const music = log.filter((e) => e.kind === 'music').map((e) => `${e.op}:${e.key ?? ''}`);
  return { state: a.state, count, music: music.slice(-60) };
});
const summary = {
  audio,
  days,
  minutes: Math.round((Date.now() - t0) / 600) / 100,
  myTurns,
  events: Object.fromEntries([...seenEvents].sort()),
  flics: Object.fromEntries([...seenFlics].sort()),
  decisions: Object.fromEntries([...seenDecisions].sort()),
  covered: [...covered],
  errors,
};
writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
log(`summary: ${JSON.stringify({ days, myTurns, events: seenEvents.size, flics: seenFlics.size, errors: errors.length })}`);
for (const e of errors.slice(0, 40)) log(`  ${e}`);
if (!SCRIPTED) await browser.close();
