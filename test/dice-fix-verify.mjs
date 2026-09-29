// 审查修复的整体验证（原版皮肤 + 真实素材包；一个真人 + 一个电脑，台湾图）。端口 3961 / 5961（本机例外，起法同
// test/dice-verify-shots.mjs 头部，把 3931 / 5931 换成 3961 / 5961、DATA_DIR 换成 .cache/dice/fix/data）。
// ①⑤ 选颗数跨决策保留、换车作废：汽车上点竖槽第 1 个小骰子 → 用机器娃娃（服务器换 decisionId 重发 TURN_MENU）→ 竖槽仍 1 颗
//    → 鼠标按 GO → DICE_ROLLED 1 颗；下一回合选 2 颗 → 装备机车（上限 2）→ 装备汽车（竖槽回到 3，不复活 2）→ 空格掷 3 颗
// ④ GO 点击声：鼠标按 GO、点竖槽时音频日志里有 sfx.001（ui 总线）；键盘空格按 GO 没有
// ③ 停留：对自己用停留卡 → GO 画帧 2（data-state=stay）、竖槽全灰；鼠标按 GO 原地不动（dice 为空）
// ② 骰子跟着人物：每次掷骰量人物锚点（舞台坐标）、FLC 左上与比例，核对 FLC 左上 − 锚点 = ((136,48) − (220,260) + T[槽]) × k；
//    另拖动镜头让人物离开视窗中心再掷，骰子仍在人物头顶
// ⑥ 快艇持骰库预取：进局后 char.<c>.boat.dice 已载入（没有在快艇上掷过骰）
// 截图、报告写到 .cache/dice/fix/<名字>/（含原版素材，不入库）。
// 用法：node test/dice-fix-verify.mjs [宽x高=1280x960] [--mobile] [--name=desktop]
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.DICE_BASE ?? 'http://localhost:5961';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1280x960').split('x').map(Number);
const MOBILE = args.includes('--mobile');
const NAME = args.find((a) => a.startsWith('--name='))?.slice('--name='.length) ?? `${size[0]}x${size[1]}`;
const OUT = `.cache/dice/fix/${NAME}`;
mkdirSync(OUT, { recursive: true });
const report = { size, mobile: MOBILE, checks: [], samples: [] };
const log = (s) => console.log(`[${new Date().toISOString().slice(11, 23)}] ${s}`);
const check = (name, ok, detail) => {
  report.checks.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} ${name} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
};

// 原版表 0x4730ac（layout.DICE_FLC_OFFSETS）
const T = [
  [4, 12],
  [12, 12],
  [8, 6],
  [-4, -6],
  [-12, -12],
  [-24, -12],
  [-20, -6],
  [-12, 6],
];

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({
  viewport: { width: size[0], height: size[1] },
  deviceScaleFactor: MOBILE ? 2 : 1,
  ...(MOBILE ? { isMobile: true, hasTouch: true } : {}),
});
await ctx.addInitScript(() => localStorage.setItem('rich4.introSeen', '1'));
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 300));
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

async function state() {
  return page.evaluate(() => {
    const h = window.__rich4;
    const g = h?.store?.game?.getState();
    const room = h?.store?.room?.getState().room;
    const d = g?.decision;
    return {
      seq: g?.seq ?? 0,
      idle: h?.eventPlayer?.idle ?? false,
      seat: room?.you?.seat ?? null,
      decision: d ? { kind: d.kind, id: d.decisionId, dice: d.options?.dice ?? null } : null,
      submitting: g?.submitting ?? null,
      players: (g?.view?.players ?? []).map((p) => ({
        seat: p.seat,
        vehicle: p.vehicle,
        diceCount: p.diceCount,
        node: p.node,
        character: p.character,
      })),
    };
  });
}
async function act(intent = null) {
  return page.evaluate((it) => {
    const h = window.__rich4;
    const d = h.store.game.getState().decision;
    return d ? h.client.act(it ?? d.defaultIntent, d.decisionId) : null;
  }, intent);
}
async function debug(op) {
  const s0 = (await state()).seq;
  const r = await page.evaluate((o) => window.__rich4.client.debug(o), op);
  if (!r.ok) throw new Error(`debug ${JSON.stringify(op)} → ${JSON.stringify(r)}`);
  await page.waitForFunction((s) => window.__rich4.store.game.getState().seq > s, s0, { timeout: 30_000 });
}
async function myTurn(timeout = 240_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const st = await state();
    if (st.idle && st.decision && st.submitting === null) {
      if (st.decision.kind === 'TURN_MENU') return st;
      await act();
    }
    await page.waitForTimeout(120);
  }
  throw new Error('myTurn timeout');
}
/** 做一次菜单操作（非终结）后等服务器重发的 TURN_MENU */
async function menuAct(intent) {
  const before = (await state()).decision?.id;
  await act(intent);
  await page.waitForFunction(
    (id) => {
      const h = window.__rich4;
      const d = h.store.game.getState().decision;
      return h.eventPlayer.idle && d && d.kind === 'TURN_MENU' && d.decisionId !== id;
    },
    before,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(300);
  return state();
}
const slot = () =>
  page.evaluate(() => {
    const dc = document.querySelector('[data-testid="action-dice-count"]');
    const go = document.querySelector('[data-testid="action-roll"]');
    return {
      value: dc?.getAttribute('data-value'),
      slots: dc?.getAttribute('data-slots'),
      on: [...(dc?.querySelectorAll('[data-testid="dice-count-die"]') ?? [])].map((e) => e.getAttribute('data-on')),
      goState: go?.getAttribute('data-state'),
      goFrame: go?.getAttribute('data-frame'),
      goSprite: go?.querySelector('[data-sprite]')?.getAttribute('data-sprite') ?? null,
      label: go?.getAttribute('aria-label'),
    };
  });
/** 鼠标点竖槽里第 i 个小骰子 */
async function clickDie(i) {
  const c = await page.evaluate((k) => {
    const e = document.querySelectorAll('[data-testid="dice-count-die"]')[k];
    const b = e.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, i);
  if (MOBILE) await page.touchscreen.tap(c.x, c.y);
  else await page.mouse.click(c.x, c.y);
  await page.waitForTimeout(250);
}
/** 鼠标点 GO 的钮面（掩膜区 3：钮内约 (47,34)） */
async function clickGo() {
  const b = await page.getByTestId('action-roll').boundingBox();
  const x = b.x + (47 / 72) * b.width;
  const y = b.y + (34 / 67) * b.height;
  if (MOBILE) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}
const now = () => page.evaluate(() => performance.now());
/** 音频日志里 t0 之后的界面音 / 音效（key、op、总线） */
const soundsSince = (t0) =>
  page.evaluate(
    (t) =>
      (window.__rich4?.audio?.log ?? [])
        .filter((e) => e.t >= t && e.kind === 'sfx')
        .map((e) => ({ t: Math.round(e.t - t), op: e.op, key: e.key ?? '', detail: e.detail ?? '' })),
    t0,
  );

// DICE_ROLLED 事件
await page.exposeFunction('__fixEv', (e) => report.samples.push({ ev: e }));
const rolls = [];
await page.exposeFunction('__fixRoll', (e) => rolls.push(e));

/** 舞台换算、人物锚点（boardPos）在舞台坐标里的位置、骰子覆盖层 */
async function measure(seat) {
  return page.evaluate((s) => {
    const h = window.__rich4;
    const surf = h.renderer;
    const go = document.querySelector('[data-testid="action-roll"]').getBoundingClientRect();
    const scale = go.width / 72;
    const ox = go.left - 360 * scale;
    const oy = go.top - 400 * scale;
    const toStage = (x, y) => ({ x: +((x - ox) / scale).toFixed(2), y: +((y - oy) / scale).toFixed(2) });
    const canvas = document.querySelector('[data-testid="screen-game"] canvas');
    const cr = canvas.getBoundingClientRect();
    const a = surf.board.actor(s);
    const foot = a ? surf.camera.worldToScreen(a.boardPos()) : null;
    const ov = document.querySelector('[data-testid="dice-overlay"]');
    const r = ov?.getBoundingClientRect();
    return {
      stageScale: +scale.toFixed(4),
      cameraZoom: +surf.camera.zoom.toFixed(4),
      anchorStage: foot ? toStage(cr.left + foot.x, cr.top + foot.y) : null,
      flc: r ? { ...toStage(r.left, r.top), w: +(r.width / scale).toFixed(2), h: +(r.height / scale).toFixed(2) } : null,
      slot: ov ? Number(ov.getAttribute('data-slot')) : null,
      k: ov ? Number(ov.getAttribute('data-scale')) : null,
      tracked: ov?.getAttribute('data-tracked') ?? null,
      rolling: ov?.getAttribute('data-rolling') ?? null,
      count: ov?.getAttribute('data-count') ?? null,
    };
  }, seat);
}
/** FLC 左上 − 锚点 = ((136,48) − (220,260) + T[槽]) × k（没夹边时） */
function expectRelative(tag, m) {
  if (!m.flc || !m.anchorStage || m.slot === null) {
    check(`${tag}：骰子覆盖层与人物锚点`, false, m);
    return;
  }
  const [dx, dy] = T[m.slot];
  const want = { x: m.anchorStage.x + (136 - 220 + dx) * m.k, y: m.anchorStage.y + (48 - 260 + dy) * m.k };
  const clampedY = Math.abs(m.flc.y - 28) < 0.6;
  const okX = Math.abs(m.flc.x - want.x) <= 1.2;
  const okY = Math.abs(m.flc.y - want.y) <= 1.2 || clampedY;
  const kWant = Math.min(1.5, Math.max(0.5, m.cameraZoom / m.stageScale));
  check(`${tag}：FLC 相对人物锚点按原版偏移 × k`, okX && okY && m.tracked === 'true', {
    anchor: m.anchorStage,
    flc: m.flc,
    want,
    slot: m.slot,
    k: m.k,
    clampedY,
  });
  check(`${tag}：比例 k = 棋盘缩放 / 舞台缩放`, Math.abs(m.k - kWant) < 0.01 && Math.abs(m.flc.w - 189 * m.k) < 1.5, {
    k: m.k,
    kWant,
    w: m.flc.w,
  });
}
/** 按 GO 之后：等骰子 FLC 出现量一次、落定再量一次（截图） */
async function watchRoll(tag, seat) {
  await page.waitForFunction(
    () => document.querySelector('[data-testid="dice-overlay"]')?.getAttribute('data-rolling') === 'true',
    null,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(80);
  const rolling = await measure(seat);
  await page.screenshot({ path: `${OUT}/${tag}-flic.png` });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="dice-overlay"]')?.getAttribute('data-rolling') === 'false',
    null,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(60);
  const faces = await measure(seat);
  await page.screenshot({ path: `${OUT}/${tag}-faces.png` });
  report.samples.push({ tag, rolling, faces });
  expectRelative(`${tag}（滚动）`, rolling);
  expectRelative(`${tag}（落定）`, faces);
  return { rolling, faces };
}

// ── 建房：一个真人 + 一个电脑，台湾图 ──
await page.goto(`${BASE}/?test=1`);
await page.getByTestId('home-nickname').fill('修復丁');
await page.getByTestId('home-nickname').blur();
await page.getByTestId('home-create').click();
await page.getByTestId('set-map').selectOption('taiwan');
await page.getByTestId('set-timer').selectOption('off');
await page.getByTestId('set-ai-count').selectOption('1');
await page.getByTestId('create-submit').click();
await page.waitForURL(/\/r\/\d{6}/);
await page.getByTestId('char-2').click();
if ((await page.getByTestId('screen-room').getAttribute('data-screen')) !== 'select')
  await page.getByTestId('char-select').click();
await page.waitForTimeout(400);
await page.getByTestId('room-start').click();
await page.getByTestId('screen-game').waitFor({ timeout: 60_000 });
await page.waitForFunction(
  () => window.__rich4?.store?.game?.getState().view !== null && window.__rich4.eventPlayer.idle,
  null,
  { timeout: 60_000 },
);
report.skin = await page.evaluate(() => window.__rich4.skin);
report.packId = await page.evaluate(() => window.__rich4?.store?.skin?.getState?.().pack?.packId ?? null);
log(`skin ${JSON.stringify(report.skin)} pack ${report.packId}`);
await page.evaluate(() =>
  window.__rich4.client.transport.on('game:batch', (p) => {
    for (const e of p.events)
      if (e.type === 'DICE_ROLLED') window.__fixRoll({ seat: e.seat, dice: e.dice, diceCount: e.diceCount });
  }),
);
await debug({ op: 'clearBoard' });

let st = await myTurn();
const me = st.seat;
const character = st.players.find((p) => p.seat === me).character;

// ⑥ 快艇持骰库预取（还没在快艇上掷过骰）
await page.waitForFunction(() => window.__rich4?.renderer?.loaded === true, null, { timeout: 60_000 });
await page.waitForTimeout(1500);
const boat = await page.evaluate((c) => {
  const r = window.__rich4.renderer;
  return { tiles: r.skin.boatTiles.length, settled: r.assets.settled(`char.${c}.boat.dice`) };
}, character);
check('⑥ 地图有快艇节点时，进局就预取了 boat.dice', boat.tiles === 0 || boat.settled === true, boat);

await debug({
  op: 'give',
  seat: me,
  cards: [14],
  items: [
    { item: 6, qty: 1 },
    { item: 5, qty: 1 },
    { item: 1, qty: 1 },
  ],
});
st = await myTurn();
st = await menuAct({ type: 'USE_ITEM', item: 6, target: { t: 'none' } });
let s0 = await slot();
check('汽车：竖槽 3 个全亮', s0.slots === '3' && s0.value === '3' && s0.on.join() === 'true,true,true', s0);

// ①⑤ 选 1 颗（鼠标点竖槽 → 同时放 Effect#1）
let t0 = await now();
await clickDie(0);
let snd = await soundsSince(t0);
s0 = await slot();
check('选 1 颗：竖槽只亮第 1 个', s0.value === '1' && s0.on.join() === 'true,false,false', s0);
check('④ 鼠标点竖槽放 Effect#1（sfx.001）', snd.some((e) => e.key === 'sfx.001' && e.op === 'play'), snd);
await page.screenshot({ path: `${OUT}/1-picked-1.png` });
const idCar = (await state()).decision.id;
st = await menuAct({ type: 'USE_ITEM', item: 1, target: { t: 'none' } });
s0 = await slot();
check(
  '①⑤ 用机器娃娃后（服务器换 decisionId 重发 TURN_MENU，current 仍 3）：仍是 1 颗',
  st.decision.id !== idCar &&
    st.decision.dice.current === 3 &&
    s0.value === '1' &&
    s0.on.join() === 'true,false,false' &&
    /1/.test(s0.label ?? ''),
  { before: idCar, after: st.decision, slot: s0 },
);
await page.screenshot({ path: `${OUT}/2-after-doll.png` });
await debug({ op: 'forceNext', purpose: 'dice', values: [4] });
await myTurn();
rolls.length = 0;
t0 = await now();
await clickGo();
const r1 = await watchRoll('car-pick1', me);
snd = await soundsSince(t0);
const goClick = snd.find((e) => e.key === 'sfx.001' && e.op === 'play');
check('④ 鼠标按 GO 先放 Effect#1（sfx.001），早于两声「咚」', !!goClick && goClick.t < 300, snd.slice(0, 6));
await page.waitForTimeout(400);
check(
  '①⑤ 按 GO 实际掷 1 颗',
  rolls[0]?.seat === me && rolls[0]?.diceCount === 1 && rolls[0]?.dice.length === 1 && r1.faces.count === '1',
  rolls[0],
);

// ①⑤ 下一回合（current = 1）：选 2 颗 → 装备机车（上限 2）→ 再装备汽车：回到新上限 3，不复活 2
st = await myTurn();
s0 = await slot();
check('下一回合：引擎写回的 current = 1（竖槽亮 1 个）', s0.value === '1' && s0.slots === '3', s0);
await clickDie(1);
s0 = await slot();
check('选 2 颗', s0.value === '2', s0);
st = await menuAct({ type: 'USE_ITEM', item: 5, target: { t: 'none' } });
s0 = await slot();
check('装备机车：上限 2、current 2', s0.slots === '2' && s0.value === '2', { slot: s0, dice: st.decision.dice });
st = await menuAct({ type: 'USE_ITEM', item: 6, target: { t: 'none' } });
s0 = await slot();
check('再装备汽车：竖槽回到新上限 3（换车作废旧的选择，不复活 2）', s0.slots === '3' && s0.value === '3', {
  slot: s0,
  dice: st.decision.dice,
});
await page.screenshot({ path: `${OUT}/3-moto-then-car.png` });
// ② 拖动镜头：人物离开视窗中心再掷，骰子仍在人物头顶
await debug({ op: 'forceNext', purpose: 'dice', values: [1, 2, 3] });
await myTurn();
const moved = await page.evaluate(async () => {
  const cam = window.__rich4.renderer.camera;
  const c = cam.center;
  cam.onUserGesture();
  await cam.panTo({ x: c.x - 70, y: c.y - 45 }, 0);
  return { from: c, to: cam.center };
});
log(`camera ${JSON.stringify(moved)}`);
rolls.length = 0;
t0 = await now();
// ④ 键盘空格按 GO：不出点击声
await page.locator('body').focus();
await page.keyboard.press(' ');
const r2 = await watchRoll('car-dragged', me);
snd = await soundsSince(t0);
check(
  '④ 键盘空格按 GO 不放 Effect#1',
  !snd.some((e) => e.key === 'sfx.001'),
  snd.slice(0, 6),
);
check(
  '② 拖动镜头后人物不在视窗中心，骰子仍按人物位置摆',
  r2.rolling.anchorStage !== null && Math.hypot(r2.rolling.anchorStage.x - 220, r2.rolling.anchorStage.y - 276) > 40,
  r2.rolling.anchorStage,
);
await page.waitForTimeout(400);
check('再装备汽车后按 GO 掷 3 颗', rolls[0]?.diceCount === 3 && rolls[0]?.dice.length === 3, rolls[0]);

// ③ 停留：对自己用停留卡
st = await myTurn();
const cardRow = await page.evaluate(() => {
  const d = window.__rich4.store.game.getState().decision;
  return d.options.cards.find((r) => r.card === 14) ?? null;
});
st = await menuAct({
  type: 'USE_CARD',
  slot: cardRow.slot,
  card: 14,
  target: { t: 'actor', actor: { t: 'seat', seat: me } },
});
s0 = await slot();
check(
  '③ 停留：GO 画停留帧 2（data-state=stay），竖槽全灰',
  st.decision.dice.locked === 'stay' &&
    s0.goState === 'stay' &&
    s0.goFrame === '2' &&
    s0.goSprite === 'ui.goButton/2' &&
    s0.on.every((x) => x === 'false'),
  { dice: st.decision.dice, slot: s0 },
);
await page.screenshot({ path: `${OUT}/4-stay.png` });
rolls.length = 0;
t0 = await now();
await clickGo();
await page.waitForTimeout(1500);
snd = await soundsSince(t0);
check('③ 停留时按 GO：原地不动（dice 为空），照样放 Effect#1', rolls[0]?.dice.length === 0 && snd.some((e) => e.key === 'sfx.001'), {
  roll: rolls[0],
  snd: snd.slice(0, 4),
});

report.errors = errors;
check('控制台没有错误', errors.length === 0, errors);
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
const failed = report.checks.filter((c) => !c.ok);
log(`done → ${OUT}/report.json：${report.checks.length - failed.length}/${report.checks.length} PASS`);
await browser.close();
process.exit(failed.length > 0 ? 1 : 0);
