// 调试（联调终验）：真实素材包 + 台湾图上一次走完「选忍太郎开局 → 各处头像 / 形象 → 中央决策倒计时与提示音 → 与回合菜单、
// 买地、银行、拍卖叠加」，截图与记录写到 .cache/pc/final/<tag>/（含原版素材，不入库）。
// 先起本机服务（本机例外：未设门禁的素材包，只监听回环；端口 3501 / 5501）：
//   PORT=3501 HOST=127.0.0.1 PUBLIC_URL=http://localhost:5501 TRUST_PROXY=0 RICH4_ASSETS_ALLOW_UNGATED=1 \
//   RICH4_ASSETS_DIR=./rich4-assets RICH4_DATA_DIR=./rich4-data RICH4_TEST_MODE=1 DATA_DIR=.cache/pc/final-data \
//   npx tsx apps/server/src/main.ts
//   （apps/client）RICH4_API_TARGET=http://127.0.0.1:3501 npx vite --port 5501 --strictPort
// 用法：node test/pc-final-check.mjs [宽x高=1920x1080] [--skin=original|procedural] [--tag=名字]
// 流程：P1（截图方）建台湾图 fast / compact、2 个电脑；P1 单击忍太郎格子后不点「選這個」直接按 OK（用户的实际操作），
// P2 用 ▶ 翻到金貝貝后直接按「準備」（同样不点「選這個」）。开局后核对服务器记录的角色与页面上各处用到的素材帧；
// 第一个回合菜单放着不动直到超时（完整的 15…1 秒），页面里每 40ms 采样倒计时的秒数 / 颜色 / 位置，并轮询音频引擎日志
// 记下每一声 countdown 音效的实际播放时刻；之后的回合菜单、买地、银行、拍卖各截图，并量倒计时与可见按钮的矩形是否相交。
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.PC_BASE ?? 'http://localhost:5501';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1920x1080').split('x').map(Number);
const SKIN = args.find((a) => a.startsWith('--skin='))?.slice(7) ?? 'original';
const TAG = args.find((a) => a.startsWith('--tag='))?.slice(6) ?? `${SKIN}-${size[0]}x${size[1]}`;
const OUT = `.cache/pc/final/${TAG}`;
mkdirSync(OUT, { recursive: true });
const LOG = [];
const report = { size, skin: SKIN, steps: [], overlaps: [], countdown: null };
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${s}`;
  console.log(line);
  LOG.push(line);
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const mobile = size[0] < 1000;

async function newPage(name) {
  const ctx = await browser.newContext({
    viewport: { width: size[0], height: size[1] },
    deviceScaleFactor: 1,
    ...(mobile && name === 'P1' ? { hasTouch: true } : {}),
  });
  await ctx.addInitScript(() => localStorage.setItem('rich4.introSeen', '1'));
  if (SKIN !== 'original') {
    await ctx.addInitScript((skin) => {
      const k = 'rich4.settings';
      try {
        const cur = JSON.parse(localStorage.getItem(k) ?? 'null');
        if (!cur) localStorage.setItem(k, JSON.stringify({ state: { skin }, version: 2 }));
      } catch {}
    }, SKIN);
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return { ctx, page, errors, name };
}

const A = await newPage('P1');
const B = await newPage('P2');
const pa = A.page;
const pb = B.page;
let shotN = 0;

async function shot(name) {
  shotN++;
  const file = `${OUT}/${String(shotN).padStart(2, '0')}-${name}.png`;
  await pa.screenshot({ path: file });
  log(`shot ${file}`);
  return file;
}

async function state(page) {
  return page.evaluate(() => {
    const h = window.__rich4;
    const g = h?.store?.game?.getState();
    const room = h?.store?.room?.getState().room;
    const d = g?.decision;
    return {
      seq: g?.seq ?? 0,
      idle: h?.eventPlayer?.idle ?? false,
      seat: room?.you?.seat ?? null,
      decision: d ? { kind: d.kind, id: d.decisionId, deadlineAt: d.deadlineAt } : null,
      submitting: g?.submitting ?? null,
      control: room && room.you?.seat != null ? (room.seats[room.you.seat]?.control ?? null) : null,
      offset: h?.store?.connection?.getState().clockOffsetMs ?? 0,
      cd: document.querySelector('[data-testid="decision-countdown"]')?.getAttribute('data-secs') ?? null,
      over: g?.over != null,
    };
  });
}

async function debug(page, op) {
  const s0 = (await state(page)).seq;
  const r = await page.evaluate((o) => window.__rich4.client.debug(o), op);
  if (!r.ok) throw new Error(`debug ${JSON.stringify(op)} → ${JSON.stringify(r)}`);
  await page.waitForFunction((s) => window.__rich4.store.game.getState().seq > s, s0, { timeout: 30_000 });
}

async function act(page) {
  await page.evaluate(() => {
    const h = window.__rich4;
    const d = h.store.game.getState().decision;
    return d ? h.client.act(d.defaultIntent, d.decisionId) : null;
  });
}

async function driveB() {
  const st = await state(pb);
  if (!st.idle || !st.decision || st.submitting !== null) return;
  await act(pb);
}

async function waitDecision(page, kinds, timeout = 120_000, other = null) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const st = await state(page);
    if (st.idle && st.decision && st.submitting === null && kinds.includes(st.decision.kind)) return st;
    if (other) await other();
    await page.waitForTimeout(200);
  }
  await page.screenshot({ path: `${OUT}/fail-${kinds[0]}.png` }).catch(() => {});
  throw new Error(`wait ${kinds} timeout: ${JSON.stringify(await state(page))}`);
}

/** 等 P1 的回合菜单：期间替 P2 做决定，P1 回合菜单以外的决策（上一回合剩下的买地等）按默认回答——
 *  否则会与刚才故意放着超时的回合菜单连成两次超时，进托管（托管中不显示倒计时），后面的场景就不是本人操作了 */
const myTurn = () =>
  waitDecision(pa, ['TURN_MENU'], 180_000, async () => {
    await driveB();
    const s = await state(pa);
    if (s.idle && s.decision && s.submitting === null && s.decision.kind !== 'TURN_MENU') await act(pa);
  });

async function remainingA() {
  return pa.evaluate(() => {
    const h = window.__rich4;
    const d = h.store.game.getState().decision;
    const off = h.store.connection?.getState().clockOffsetMs ?? 0;
    return d?.deadlineAt ? d.deadlineAt - (Date.now() + off) : null;
  });
}

async function waitRemainingBelow(ms) {
  for (;;) {
    const r = await remainingA();
    if (r === null || r <= ms) return r;
    await pa.waitForTimeout(Math.max(20, Math.min(400, r - ms)));
  }
}

async function rollA() {
  const s0 = (await state(pa)).seq;
  await pa.getByTestId('action-roll').click({ timeout: 5000 }).catch(() => {});
  await pa.waitForTimeout(1200);
  const s1 = await state(pa);
  if (s1.seq === s0 && s1.decision?.kind === 'TURN_MENU' && s1.submitting === null) {
    log('  GO 钮没反应，改用 act(defaultIntent)');
    await act(pa);
  }
}

async function finishTurnA() {
  for (let i = 0; i < 10; i++) {
    await pa.waitForTimeout(400);
    const st = await state(pa);
    if (!st.decision) return;
    if (st.decision.kind === 'TURN_MENU' && st.submitting === null) return;
    if (st.idle && st.submitting === null) await act(pa);
  }
}

/** 页面上与角色有关的素材帧 + 服务器记录的角色 */
async function probe(page, label) {
  const r = await page.evaluate(() => {
    const h = window.__rich4;
    const room = h?.store?.room?.getState()?.room ?? null;
    const view = h?.store?.game?.getState()?.view ?? null;
    const sprites = [...document.querySelectorAll('[data-sprite]')]
      .map((e) => e.getAttribute('data-sprite'))
      .filter((s) => /portrait|sidewalk|chibi|xicong/.test(s ?? ''));
    const chips = [...document.querySelectorAll('[data-testid^="chip-"]')].map((e) => ({
      testid: e.getAttribute('data-testid'),
      face: e.querySelector('[data-sprite^="portrait.face72/"]')?.getAttribute('data-sprite') ?? null,
      character: e.querySelector('[data-character]')?.getAttribute('data-character') ?? e.getAttribute('data-character'),
    }));
    const chars = [...document.querySelectorAll('[data-character]')].map(
      (e) => `${e.getAttribute('data-testid') ?? e.tagName.toLowerCase()}:${e.getAttribute('data-character')}`,
    );
    const poses = (view?.players ?? []).map((p) => ({
      seat: p.seat,
      pose: h?.renderer?.board?.actor?.(p.seat)?.poseKey ?? null,
    }));
    return {
      you: room?.you?.seat ?? null,
      seats: room?.seats?.map((s) => s.characterId) ?? null,
      players: view?.players?.map((p) => ({ seat: p.seat, character: p.character })) ?? null,
      sprites: [...new Set(sprites)],
      chips,
      chars: [...new Set(chars)],
      poses,
      preview: document.querySelector('[data-testid="char-preview-name"]')?.textContent ?? null,
      select: document.querySelector('[data-testid="char-select"]')?.textContent ?? null,
    };
  });
  report.steps.push({ label, ...r });
  log(`${label}: seats=${JSON.stringify(r.seats)} players=${JSON.stringify(r.players)} preview=${r.preview} select=${r.select}`);
  if (r.sprites.length) log(`  sprites ${JSON.stringify(r.sprites)}`);
  if (r.chips.length) log(`  chips ${JSON.stringify(r.chips.map((c) => `${c.testid}:${c.face ?? c.character}`))}`);
  if (r.chars.length) log(`  data-character ${JSON.stringify(r.chars)}`);
  if (r.poses.length) log(`  poses ${JSON.stringify(r.poses)}`);
  return r;
}

/** 倒计时的外观与它压到的可见按钮（按钮中心点 elementFromPoint 命中自己才算可见；倒计时本身 pointer-events: none） */
async function overlap(label) {
  const r = await pa.evaluate(() => {
    const cd = document.querySelector('[data-testid="decision-countdown"]');
    if (!cd) return null;
    const num = cd.querySelector('span') ?? cd;
    const cr = cd.getBoundingClientRect();
    const vis = getComputedStyle(cd).visibility;
    const inter = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
    const hits = [];
    for (const b of document.querySelectorAll('button, [role="button"], select, input, a[href]')) {
      const br = b.getBoundingClientRect();
      if (br.width < 2 || br.height < 2) continue;
      const cx = br.left + br.width / 2;
      const cy = br.top + br.height / 2;
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
      const top = document.elementFromPoint(cx, cy);
      if (!top || !(top === b || b.contains(top))) continue;
      if (inter(cr, br))
        hits.push({
          testid: b.getAttribute('data-testid'),
          label: (b.getAttribute('aria-label') ?? b.textContent ?? '').trim().slice(0, 24),
          rect: [br.left, br.top, br.width, br.height].map(Math.round),
        });
    }
    return {
      place: cd.getAttribute('data-place'),
      anchor: cd.getAttribute('data-anchor'),
      kind: cd.getAttribute('data-kind'),
      secs: cd.getAttribute('data-secs'),
      urgent: cd.getAttribute('data-urgent'),
      visibility: vis,
      pointerEvents: getComputedStyle(cd).pointerEvents,
      color: getComputedStyle(num).color,
      rect: [cr.left, cr.top, cr.width, cr.height].map(Math.round),
      hits,
    };
  });
  report.overlaps.push({ label, ...r });
  log(`overlap ${label}: ${JSON.stringify(r)}`);
  return r;
}

/** 页面里装采样器：每 40ms 记倒计时的变化；每 250ms 把音频引擎日志里的 countdown 音效收进来（日志是 500 条的环） */
async function installRecorder() {
  await pa.evaluate(() => {
    const w = window;
    if (w.__finalRec) return;
    const rec = { samples: [], audio: [], seen: new Set() };
    w.__finalRec = rec;
    let last = '';
    setInterval(() => {
      const cd = document.querySelector('[data-testid="decision-countdown"]');
      const g = w.__rich4?.store?.game?.getState();
      const d = g?.decision;
      const sig = cd
        ? [cd.getAttribute('data-decision'), cd.getAttribute('data-secs'), cd.getAttribute('data-urgent'), cd.getAttribute('data-place')].join('|')
        : 'none';
      if (sig === last) return;
      last = sig;
      const off = w.__rich4?.store?.connection?.getState().clockOffsetMs ?? 0;
      const num = cd?.querySelector('span');
      rec.samples.push({
        at: Date.now(),
        decision: cd?.getAttribute('data-decision') ?? null,
        kind: cd?.getAttribute('data-kind') ?? d?.kind ?? null,
        secs: cd ? Number(cd.getAttribute('data-secs')) : null,
        urgent: cd?.getAttribute('data-urgent') ?? null,
        final: cd?.getAttribute('data-final') ?? null,
        place: cd?.getAttribute('data-place') ?? null,
        color: num ? getComputedStyle(num).color : null,
        remainingMs: d?.deadlineAt ? d.deadlineAt - (Date.now() + off) : null,
      });
    }, 40);
    setInterval(() => {
      const log = w.__rich4?.audio?.log ?? [];
      for (const e of log) {
        if (e.kind !== 'sfx' || !String(e.key ?? '').includes('countdown')) continue;
        const k = `${e.t}|${e.op}|${e.key}`;
        if (rec.seen.has(k)) continue;
        rec.seen.add(k);
        rec.audio.push({ at: Math.round(performance.timeOrigin + e.t), op: e.op, key: e.key, bus: e.bus });
      }
    }, 250);
  });
}

try {
// ── 建房：P1 建台湾图 fast / compact、2 个电脑；P2 进房 ──
await pa.goto(`${BASE}/?test=1`);
await pa.getByTestId('screen-home').waitFor({ timeout: 30_000 });
await pa.getByTestId('home-nickname').fill('測試甲');
await pa.getByTestId('home-nickname').blur();
await pa.getByTestId('home-create').click();
await pa.getByTestId('set-map').selectOption('taiwan');
await pa.getByTestId('set-timer').selectOption('fast');
await pa.getByTestId('set-pacing').selectOption('compact');
await pa.getByTestId('set-ai-count').selectOption('2');
await pa.getByTestId('create-submit').click();
await pa.waitForURL(/\/r\/\d{6}/);
const code = /\/r\/(\d{6})/.exec(pa.url())[1];
log(`room ${code}`);
await pb.goto(`${BASE}/?test=1`);
await pb.getByTestId('home-nickname').fill('測試乙');
await pb.getByTestId('home-nickname').blur();
await pb.goto(`${BASE}/r/${code}?test=1`);
await pb.getByTestId('screen-room').waitFor();
await pa.getByTestId('screen-room').waitFor();
await pa.waitForTimeout(1500);
await shot('lobby');

// P1：单击忍太郎格子（用户的实际操作），不点「選這個」
await pa.getByTestId('char-2').click();
await pa.waitForTimeout(800);
await shot('lobby-click-ninja');
await probe(pa, 'P1 单击忍太郎后');
// P2：用 ▶ 翻到金貝貝，不点「選這個」，直接按「準備」
for (let i = 0; i < 13; i++) {
  const name = (await pb.getByTestId('char-preview-name').textContent())?.trim();
  if (name === '金貝貝' || name === '金贝贝') break;
  await pb.getByTestId('char-next').click();
  await pb.waitForTimeout(120);
}
await probe(pb, 'P2 翻到金貝貝（未提交）');
await pb.getByTestId('room-ready').click();
await pb.waitForTimeout(600);
await probe(pb, 'P2 按準備后');
await pa.waitForFunction(() => !document.querySelector('[data-testid="room-start"]')?.hasAttribute('disabled'), undefined, {
  timeout: 20_000,
});
await pa.waitForTimeout(400);
await shot('lobby-before-ok');
await probe(pa, 'P1 按 OK 前');
await pa.getByTestId('room-start').click();
await pa.getByTestId('screen-game').waitFor({ timeout: 60_000 });
await pa.waitForFunction((k) => window.__rich4?.skin?.boardInUse === k, SKIN, { timeout: 60_000 });
const seatA = (await state(pa)).seat;
const seatB = (await state(pb)).seat;
log(`seats A=${seatA} B=${seatB}`);
await installRecorder();

// ── 第一个回合菜单：放着不动直到超时（15…1 秒），截正常 / 最后 10 秒 / 最后 3 秒 ──
let st = await myTurn();
log(`turn menu #1 ${st.decision.id} deadlineAt=${st.decision.deadlineAt}`);
await pa.waitForTimeout(1600); // 「轮到你了」横幅让位约 1 秒
await shot('turn-normal');
await probe(pa, '本人回合（资料栏、座位条、棋盘）');
await overlap('turn-normal');
await waitRemainingBelow(9400);
await pa.waitForTimeout(120);
await shot('turn-last10');
await overlap('turn-last10');
await waitRemainingBelow(2500);
await pa.waitForTimeout(120);
await shot('turn-last3');
await overlap('turn-last3');
const firstTurn = st.decision.id;
// 等超时：电脑代掷，倒计时应在 0 时消失
await pa.waitForFunction((id) => window.__rich4.store.game.getState().decision?.decisionId !== id, firstTurn, {
  timeout: 20_000,
});
log(`turn menu #1 超时后：${JSON.stringify(await state(pa))}`);
await finishTurnA();

// ── 第二个回合菜单：展开卡片 / 道具菜单，最后 1.5 秒时掷骰（提交后应立即停） ──
st = await myTurn();
log(`turn menu #2 ${st.decision.id}`);
await pa.waitForTimeout(1600);
await pa
  .getByTestId('action-cards')
  .click({ timeout: 5000 })
  .catch(() => log('  action-cards 点不到'));
await pa.waitForTimeout(800);
await shot('turn-menu-open');
await overlap('turn-menu-open');
await pa.keyboard.press('Escape');
await pa.waitForTimeout(400);
await waitRemainingBelow(1500);
await pa.getByTestId('action-roll').click({ timeout: 3000 }).catch(() => act(pa));
const submittedAt = Date.now();
await pa.waitForTimeout(150);
log(`turn menu #2 提交后 150ms：cd=${(await state(pa)).cd}`);
report.submittedAt = submittedAt;
report.submittedDecision = st.decision.id;
await finishTurnA();

// ── 买地：传送到目标地块前一格、掷 1 点 → 落在无主的住宅上 ──
st = await myTurn();
{
  const cands = [
    { lot: 'L17', node: 58, prev: 59 },
    { lot: 'L22', node: 63, prev: 64 },
    { lot: 'L6', node: 45, prev: 46 },
  ];
  const owners = await pa.evaluate(() =>
    Object.fromEntries(window.__rich4.store.game.getState().latest.lands.map((l) => [l.id, l.owner])),
  );
  const c = cands.find((x) => owners[x.lot] === null) ?? cands[0];
  log(`buy target ${c.lot}`);
  await debug(pa, { op: 'teleport', seat: seatA, node: c.node, prev: c.prev });
  await debug(pa, { op: 'forceNext', purpose: 'dice', values: [1] });
  await waitDecision(pa, ['TURN_MENU']);
  await rollA();
  const d = await waitDecision(pa, ['BUY_LAND', 'UPGRADE_LAND', 'BUY_FACILITY'], 30_000);
  log(`buy decision ${d.decision.kind}`);
  await pa.waitForTimeout(900);
  await shot('buyland');
  await probe(pa, '买地（讲话头像）');
  await overlap('buyland');
  await act(pa);
  await finishTurnA();
}

// ── 银行：传送到 56（来路 55），掷 1 点 → 19（银行） ──
st = await myTurn();
{
  await debug(pa, { op: 'teleport', seat: seatA, node: 56, prev: 55 });
  await debug(pa, { op: 'forceNext', purpose: 'dice', values: [1] });
  await waitDecision(pa, ['TURN_MENU']);
  await rollA();
  const d = await waitDecision(pa, ['BANK_COUNTER', 'BANK_ATM'], 30_000);
  log(`bank decision ${d.decision.kind}`);
  await pa.waitForTimeout(900);
  await shot('bank');
  await overlap('bank');
  await waitRemainingBelow(2500);
  await shot('bank-last3');
  await overlap('bank-last3');
  await act(pa);
  await finishTurnA();
}

// ── 拍卖：P2 站到一块无主的地上，拿拍卖卡（8）出卡 → P1 被问竞拍 ──
{
  await waitDecision(pb, ['TURN_MENU'], 180_000, async () => {
    const s = await state(pa);
    if (s.idle && s.decision && s.submitting === null) await act(pa);
  });
  await debug(pb, { op: 'setCash', seat: seatA, cash: 80000, deposit: null });
  // 站到一块无主的地上（电脑可能已经买走了其中几块）
  const spots = [
    { lot: 'L20', node: 60, prev: 18 },
    { lot: 'L22', node: 62, prev: 63 },
    { lot: 'L6', node: 44, prev: 45 },
    { lot: 'L17', node: 57, prev: 58 },
  ];
  const owners = await pb.evaluate(() =>
    Object.fromEntries(window.__rich4.store.game.getState().latest.lands.map((l) => [l.id, l.owner])),
  );
  const spot = spots.find((x) => owners[x.lot] === null) ?? spots[0];
  log(`auction lot ${spot.lot} owners=${JSON.stringify(spots.map((x) => owners[x.lot]))}`);
  await debug(pb, { op: 'teleport', seat: seatB, node: spot.node, prev: spot.prev });
  await debug(pb, { op: 'give', seat: seatB, cards: [8], items: [] });
  await waitDecision(pb, ['TURN_MENU']);
  const slot = await pb.evaluate(
    () => window.__rich4.store.game.getState().decision.options.cards.find((r) => r.card === 8)?.slot ?? null,
  );
  log(`auction card slot ${slot}`);
  await pb.getByTestId('action-cards').click();
  await pb.getByTestId(`inv-card-${slot}`).click();
  await pb.getByTestId('target-picker').waitFor({ timeout: 10_000 });
  await pb.getByTestId('target-confirm').click();
  const d = await waitDecision(pa, ['AUCTION_BID'], 30_000);
  log(`auction ${d.decision.id}`);
  await pa.waitForTimeout(900);
  await shot('auction');
  await overlap('auction');
  await waitRemainingBelow(2500);
  await shot('auction-last3');
  await overlap('auction-last3');
  await act(pa);
}
await pa.waitForTimeout(1500);

// ── 汇总：提示音请求（测试钩子）、音频引擎实际播放、采样到的倒计时变化 ──
const rec = await pa.evaluate(() => ({
  beeps: window.__rich4.countdown?.beeps ?? [],
  samples: window.__finalRec.samples,
  audio: window.__finalRec.audio,
  audioState: window.__rich4.audio?.state ?? null,
  offset: window.__rich4.store.connection?.getState().clockOffsetMs ?? 0,
}));
report.countdown = rec;
log(`audio state ${JSON.stringify(rec.audioState)} offset=${rec.offset}`);
// 第一个回合菜单（超时那次）的时间线：以第一次采样到的截止时刻为基准，列出每一声的「剩余 ms」
const firstSamples = rec.samples.filter((s) => s.decision === firstTurn);
const deadlineLocal = firstSamples.length
  ? firstSamples[0].at + (firstSamples[0].remainingMs ?? 0)
  : null;
log(`#1 samples: ${JSON.stringify(firstSamples.map((s) => `${s.secs}${s.urgent === 'true' ? 'R' : ''}@${s.place}:${s.color}:剩${s.remainingMs}`))}`);
const gone = rec.samples.find((s, i) => i > 0 && rec.samples[i - 1].decision === firstTurn && s.decision !== firstTurn);
if (gone) log(`#1 消失：${JSON.stringify(gone)}（相对截止 ${deadlineLocal ? gone.at - deadlineLocal : '?'}ms）`);
for (const b of rec.beeps) {
  const rel = deadlineLocal && b.decisionId === firstTurn ? ` 距截止 ${deadlineLocal - b.at}ms` : '';
  log(`beep ${b.decisionId.slice(-8)} secs=${b.secs} ${b.level} audio=${b.audio} at=${new Date(b.at).toISOString().slice(11, 23)}${rel}`);
}
for (const a of rec.audio) {
  const rel = deadlineLocal ? ` 距#1截止 ${deadlineLocal - a.at}ms` : '';
  log(`engine ${a.op} ${a.key} bus=${a.bus} at=${new Date(a.at).toISOString().slice(11, 23)}${rel}`);
}
const afterSubmit = rec.beeps.filter((b) => b.decisionId === report.submittedDecision && b.at > submittedAt);
log(`#2 提交后的提示音请求：${afterSubmit.length}`);
} catch (e) {
  log(`失败 ${e?.stack ?? e}`);
  await shot('FAIL').catch(() => {});
  process.exitCode = 1;
} finally {
  log(`errors A: ${JSON.stringify(A.errors.slice(0, 10))}`);
  log(`errors B: ${JSON.stringify(B.errors.slice(0, 10))}`);
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${OUT}/log.txt`, `${LOG.join('\n')}\n`);
  await browser.close();
}
