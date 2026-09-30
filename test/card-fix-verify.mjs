// 修复验证（亮卡审查发现 1–6，原版皮肤 + 本机真实素材包）：连本机实例（缺省 http://localhost:5761，vite 开发服务器；
// 服务器须 RICH4_TEST_MODE=1、RICH4_ASSETS_DIR=./rich4-assets），开一局台湾图：P1 = 桌面 1920×1080，P2 = 手机横屏 844×390
// （isMobile + hasTouch，点击走 tap），不带电脑。截图与记录写到 .cache/card/fix/。
// S2 任意输入跳过：P1 出均富卡，亮卡开出约 300 ms 时 P1 按一下 Shift、P2 在棋盘视窗上点一下，量弹窗寿命（原来 1.5 秒），
//    亮卡期间没有「点一下跳过」钮；
// S3 旧素材包兜底（卡图下垫黑底）：观战页用 page.route 把 card.10 / card.18 换成按旧规则（四角 4 连通泛洪、RGB 0 → 透明）
//    抠过的图，注入亮卡弹窗，截插画元素；另开一页不换图（新包的不透明图）截同一张——两者应逐像素相同；再在换图页里临时
//    去掉黑底截一张（修复前的样子），应当与不透明图不同（透出棋盘）；
// S1 被动卡：P2 持复仇卡，P1 对 P2 出梦游卡 → 复仇卡生效。采样亮卡期间两页的 toast（应暂缓：DOM 里没有）与 classicShown，
//    亮卡中途与结束后截图（手机页：没有「以牙還牙！」气泡、没有盖住消息框的 toast；结束后 toast 重新出现）；
//    读音频日志：Effect#62 在亮卡开始时，卡片台词在亮卡结束之后，被动卡后面接着对方（P1）的反应台词。
// 用法：node test/card-fix-verify.mjs [站点]
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';

const BASE = process.argv[2] ?? 'http://localhost:5761';
const OUT = '.cache/card/fix';
const SHOTS = `${OUT}/shots`;
mkdirSync(SHOTS, { recursive: true });
mkdirSync(`${OUT}/oldpack`, { recursive: true });
writeFileSync(`${OUT}/verify.log`, '');

const DESK = { width: 1920, height: 1080 };
const MOBILE = { width: 844, height: 390 };
const manifest = JSON.parse(readFileSync('rich4-assets/manifest.json', 'utf8'));

function log(...a) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  console.log(line);
  appendFileSync(`${OUT}/verify.log`, `${line}\n`);
}

const result = { base: BASE, packId: manifest.packId, s1: {}, s2: {}, s3: {}, errors: {} };
const save = () => writeFileSync(`${OUT}/verify.json`, JSON.stringify(result, null, 2));

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});

async function newPage(name, opts) {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript(() => localStorage.setItem('rich4.introSeen', '1'));
  const page = await ctx.newPage();
  result.errors[name] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') result.errors[name].push(`${m.type()}: ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => result.errors[name].push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) result.errors[name].push(`http ${r.status()} ${r.url()}`);
  });
  return { ctx, page };
}

const { page: A } = await newPage('P1', { viewport: DESK, deviceScaleFactor: 1 });
const { page: B } = await newPage('P2', { viewport: MOBILE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const whoOf = (page) => (page === A ? 'P1' : page === B ? 'P2' : 'W');
const vpOf = (page) => {
  const v = page.viewportSize();
  return `${v.width}x${v.height}`;
};
const press = (page, loc) => (page === B ? loc.tap() : loc.click());

let shotN = 0;
/** 截经典舞台（640×480 等比缩放后的区域） */
async function shot(page, name) {
  shotN++;
  const file = `${SHOTS}/${String(shotN).padStart(3, '0')}-${name}-${whoOf(page)}-${vpOf(page)}.png`;
  const r = await page.evaluate(() => {
    const st = document.querySelector('[data-testid="classic-stage"]');
    if (!st) return null;
    const [sx, sy] = (st.getAttribute('data-stage') ?? '0,0').split(',').map(Number);
    const k = Number(st.getAttribute('data-scale'));
    const b = st.getBoundingClientRect();
    return { x: b.left + sx, y: b.top + sy, width: 640 * k, height: 480 * k };
  });
  await page.screenshot({ path: file, ...(r ? { clip: r } : {}) });
  return file;
}

async function state(page) {
  return page.evaluate(() => {
    const h = window.__rich4;
    const g = h?.store?.game?.getState();
    const d = g?.decision;
    const c = g?.view?.clock?.cursor;
    return {
      seq: g?.seq ?? 0,
      idle: h?.eventPlayer?.idle ?? false,
      decision: d ? { kind: d.kind, id: d.decisionId, seat: d.seat } : null,
      submitting: g?.submitting ?? null,
      turn: c && c.t === 'seat' ? c.seat : null,
    };
  });
}

async function debug(page, op) {
  const s0 = (await state(page)).seq;
  const r = await page.evaluate((o) => window.__rich4.client.debug(o), op);
  if (!r.ok) throw new Error(`debug ${JSON.stringify(op)} → ${JSON.stringify(r)}`);
  await page.waitForFunction((s) => window.__rich4.store.game.getState().seq > s, s0, { timeout: 30_000 });
}

async function act(page, intent = null) {
  return page.evaluate((it) => {
    const h = window.__rich4;
    const d = h.store.game.getState().decision;
    return d ? h.client.act(it ?? d.defaultIntent, d.decisionId) : null;
  }, intent);
}

/** 两页都自动应答（keep 页上的回合菜单除外），直到 until() 为真 */
async function pump(until, { timeout = 120_000, keep = null } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await until()) return true;
    for (const page of [A, B]) {
      const st = await state(page).catch(() => null);
      if (!st?.idle || !st.decision || st.submitting !== null) continue;
      if (page === keep && st.decision.kind === 'TURN_MENU') continue;
      await act(page);
    }
    await A.waitForTimeout(100);
  }
  return false;
}

async function waitTurnMenu(page, timeout = 120_000) {
  const ok = await pump(
    async () => {
      const st = await state(page);
      return st.idle && st.decision?.kind === 'TURN_MENU' && st.submitting === null;
    },
    { keep: page, timeout },
  );
  if (!ok) throw new Error(`${whoOf(page)} 等不到回合菜单`);
}

async function idleBoth(timeout = 30_000) {
  for (const p of [A, B]) {
    await p.waitForFunction(() => window.__rich4.eventPlayer.idle === true, undefined, { timeout });
  }
}

/** 在页面里装记录器：亮卡弹窗开关、classicShown、toast（store 与 DOM）按 30 ms 采样，只记变化 */
async function installRecorder(page) {
  await page.evaluate(async () => {
    const { usePopupStore } = await import('/src/ui/popups/popupStore.ts');
    const rec = { rows: [], opens: {}, closes: {} };
    window.__fixRec = rec;
    usePopupStore.subscribe((st, prev) => {
      const now = performance.now();
      if (st.current && st.current !== prev.current && st.current.kind === 'cardCast') {
        rec.opens[st.current.popupId] = { t: now, card: st.current.card, variant: st.current.variant };
      }
      if (prev.current && prev.current.kind === 'cardCast' && st.current?.popupId !== prev.current.popupId) {
        rec.closes[prev.current.popupId] = now;
      }
    });
    let last = '';
    setInterval(() => {
      const st = usePopupStore.getState();
      const ui = window.__rich4.store.ui.getState();
      const row = {
        cast: st.current?.kind === 'cardCast' ? `${st.current.popupId}:${st.current.card}` : null,
        classicShown: st.classicShown ? `${st.classicShown.popupId}:${st.classicShown.kind}` : null,
        toastsInStore: ui.toasts.map((x) => x.text),
        toastsInDom: [...document.querySelectorAll('[data-testid="toast"]')].map((x) => x.textContent),
        skipBtn: !!document.querySelector('[data-testid="popup-skip"]'),
        castDom: !!document.querySelector('[data-testid="card-cast-popup"]'),
      };
      const key = JSON.stringify(row);
      if (key !== last) {
        last = key;
        rec.rows.push({ t: Math.round(performance.now()), ...row });
      }
    }, 30);
  });
}

async function recOf(page) {
  return page.evaluate(() => window.__fixRec);
}

async function audioLog(page) {
  return page.evaluate(() => {
    const a = window.__rich4?.audio;
    return a ? { state: a.state, log: a.log.map((e) => ({ ...e, t: Math.round(e.t) })) } : null;
  });
}

// ───────────────────────── 开局 ─────────────────────────

async function setupRoom() {
  await A.goto(`${BASE}/?test=1`);
  await A.getByTestId('home-nickname').fill('測試甲');
  await A.getByTestId('home-nickname').blur();
  await A.getByTestId('home-create').click();
  await A.getByTestId('set-map').selectOption('taiwan');
  await A.getByTestId('set-timer').selectOption('off');
  await A.getByTestId('set-ai-count').selectOption('0');
  await A.getByTestId('create-submit').click();
  await A.waitForURL(/\/r\/\d{6}/);
  const code = /\/r\/(\d{6})/.exec(A.url())[1];
  await B.goto(`${BASE}/?test=1`);
  await B.getByTestId('home-nickname').fill('測試乙');
  await B.getByTestId('home-nickname').blur();
  await B.goto(`${BASE}/r/${code}?test=1`);
  await B.getByTestId('screen-room').waitFor();
  for (const [p, c] of [
    [A, 2],
    [B, 9],
  ]) {
    await press(p, p.getByTestId(`char-${c}`));
    if ((await p.getByTestId('screen-room').getAttribute('data-screen')) !== 'select')
      await press(p, p.getByTestId('char-select'));
  }
  await press(B, B.getByTestId('room-ready'));
  await A.waitForTimeout(500);
  await A.getByTestId('room-start').click();
  for (const p of [A, B]) {
    await p.getByTestId('classic-stage').waitFor({ timeout: 90_000 });
    await p.waitForFunction(() => window.__rich4?.store?.game?.getState().view != null, undefined, { timeout: 60_000 });
  }
  result.room = code;
  result.skin = await A.evaluate(() => window.__rich4.skin);
  result.pacing = await A.evaluate(() => window.__rich4.store.game.getState().view?.config?.pacing ?? null);
  log('room', code, result.skin, result.pacing);
  return code;
}

/** P1 经卡片欄出卡：点卡 → 目标面板 → （选目标）→ 确认 */
async function castViaUi(page, card, pick) {
  const d = await page.evaluate(() => window.__rich4.store.game.getState().decision);
  const row = d.options.cards.find((r) => r.card === card);
  if (!row) throw new Error(`${whoOf(page)} 手里没有卡 ${card}`);
  if (!(await page.getByTestId('turn-inventory').isVisible().catch(() => false))) {
    await press(page, page.getByTestId('action-cards'));
    await page.getByTestId('turn-inventory').waitFor();
  }
  await press(page, page.getByTestId(`inv-card-${row.slot}`));
  const picker = page.getByTestId('target-picker');
  await picker.waitFor({ timeout: 5000 });
  if (pick) await press(page, picker.getByTestId(pick));
  await press(page, page.getByTestId('target-confirm'));
}

/** 等某页出现亮卡弹窗（DOM），返回出现时刻（页面 performance.now） */
async function waitCastDom(page, timeout = 20_000) {
  await page.getByTestId('card-cast-popup').waitFor({ timeout });
  return page.evaluate(() => performance.now());
}

// ───────────────────────── S2：任意输入跳过 ─────────────────────────

async function s2() {
  log('S2 任意输入跳过：P1 出均富卡');
  await castViaUi(A, 1, null);
  const [ta, tb] = await Promise.all([waitCastDom(A), waitCastDom(B)]);
  await A.waitForTimeout(300);
  const skipBtn = {
    P1: await A.getByTestId('popup-skip').count(),
    P2: await B.getByTestId('popup-skip').count(),
  };
  const shots = [await shot(A, 's2-card1-before-skip'), await shot(B, 's2-card1-before-skip')];
  const ka = await A.evaluate(() => performance.now());
  await A.keyboard.press('Shift');
  // 手机页：在棋盘视窗左上一带点一下（与 E2E 的「回合菜单不挡棋盘」取点相同）
  const pt = await B.evaluate(() => {
    const st = document.querySelector('[data-testid="classic-stage"]');
    const [sx, sy] = (st.getAttribute('data-stage') ?? '0,0').split(',').map(Number);
    const k = Number(st.getAttribute('data-scale'));
    const r = st.getBoundingClientRect();
    return { x: r.left + sx + 60 * k, y: r.top + sy + 120 * k };
  });
  const kb = await B.evaluate(() => performance.now());
  await B.touchscreen.tap(pt.x, pt.y);
  await A.getByTestId('card-cast-popup').waitFor({ state: 'detached', timeout: 5000 });
  const ga = await A.evaluate(() => performance.now());
  await B.getByTestId('card-cast-popup').waitFor({ state: 'detached', timeout: 5000 });
  const gb = await B.evaluate(() => performance.now());
  result.s2 = {
    skipButtonsDuringShow: skipBtn,
    P1: { shownMs: Math.round(ga - ta), afterKeyMs: Math.round(ga - ka) },
    P2: { shownMs: Math.round(gb - tb), afterTapMs: Math.round(gb - kb) },
    shots,
  };
  log('S2', result.s2);
  save();
  await idleBoth();
}

// ───────────────────────── S3：旧素材包兜底 ─────────────────────────

/** 按旧提取规则（corner-zero：四角 4 连通泛洪，RGB555 0x0000 = RGB 0,0,0 → 透明）抠图 */
function cornerZero(buf) {
  const png = PNG.sync.read(buf);
  const { width: w, height: h, data } = png;
  const zero = (p) => data[p * 4] === 0 && data[p * 4 + 1] === 0 && data[p * 4 + 2] === 0;
  const clear = new Uint8Array(w * h);
  const stack = [];
  for (const p of [0, w - 1, (h - 1) * w, w * h - 1]) {
    if (zero(p) && !clear[p]) {
      clear[p] = 1;
      stack.push(p);
    }
  }
  while (stack.length > 0) {
    const p = stack.pop();
    const x = p % w;
    for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p >= w ? p - w : -1, p + w < w * h ? p + w : -1]) {
      if (q >= 0 && !clear[q] && zero(q)) {
        clear[q] = 1;
        stack.push(q);
      }
    }
  }
  let n = 0;
  for (let p = 0; p < w * h; p++) {
    if (clear[p]) {
      data[p * 4 + 3] = 0;
      n++;
    }
  }
  return { buf: PNG.sync.write(png), cleared: n };
}

function pngDiff(a, b) {
  const x = PNG.sync.read(a);
  const y = PNG.sync.read(b);
  if (x.width !== y.width || x.height !== y.height) return { sameSize: false };
  let diff = 0;
  let maxDelta = 0;
  // 外缘 1 像素：插画左上角落在半像素上（138×2.25 = 310.5），这一圈与背后还在动画的棋盘混色，两页不会相同
  let interior = 0;
  const w = x.width;
  const h = x.height;
  for (let i = 0; i < x.data.length; i += 4) {
    const d = Math.max(
      Math.abs(x.data[i] - y.data[i]),
      Math.abs(x.data[i + 1] - y.data[i + 1]),
      Math.abs(x.data[i + 2] - y.data[i + 2]),
    );
    const p = i / 4;
    const px = p % w;
    const py = Math.floor(p / w);
    if (d > 0) {
      diff++;
      if (px > 0 && py > 0 && px < w - 1 && py < h - 1) interior++;
    }
    if (d > maxDelta) maxDelta = d;
  }
  return { sameSize: true, w, h, diffPixels: diff, interiorDiffPixels: interior, maxDelta };
}

/** 观战页注入一个亮卡弹窗（经典舞台里的同一个 CardCast 组件），等它以原版画面显示、插画加载完 */
async function injectCast(page, card, variant = 'cast') {
  for (let i = 0; i < 40; i++) {
    const ok = await page.evaluate(
      async ({ card, variant }) => {
        const { usePopupStore } = await import('/src/ui/popups/popupStore.ts');
        const s = usePopupStore.getState();
        if (s.current) s.close(s.current.popupId);
        s.open(
          {
            kind: 'cardCast',
            player: { seat: 1, character: 9, name: '測試乙' },
            card,
            cardName: `卡${card}`,
            desc: '',
            title: '',
            targetText: null,
            variant,
          },
          600_000,
          600_000,
        );
        await new Promise((r) => setTimeout(r, 400));
        const art = document.querySelector('[data-classic="true"] [data-testid="card-cast-art"]');
        if (!art || !art.style.backgroundImage) return false;
        const src = /url\("?(.*?)"?\)$/.exec(art.style.backgroundImage)[1];
        const img = new Image();
        img.src = src;
        await img.decode();
        return true;
      },
      { card, variant },
    );
    if (ok) {
      await page.waitForTimeout(300);
      return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function closeCast(page) {
  await page.evaluate(async () => {
    const { usePopupStore } = await import('/src/ui/popups/popupStore.ts');
    const s = usePopupStore.getState();
    if (s.current) s.close(s.current.popupId);
  });
}

async function s3(code) {
  log('S3 旧素材包兜底');
  const cards = [10, 18];
  const old = {};
  for (const k of cards) {
    const e = manifest.entries[`card.${k}`];
    const path = manifest.files[e.file].path;
    const src = readFileSync(`rich4-assets/${path}`);
    const { buf, cleared } = cornerZero(src);
    writeFileSync(`${OUT}/oldpack/card.${k}.png`, buf);
    old[k] = { path, buf, cleared };
    log(`card.${k}（${path}）按旧规则抠掉 ${cleared} 像素`);
  }
  const watch = async (name, route) => {
    const { ctx, page } = await newPage(name, { viewport: DESK, deviceScaleFactor: 1 });
    if (route) {
      await page.route('**/pack/**', async (r) => {
        const p = decodeURIComponent(new URL(r.request().url()).pathname.slice('/pack/'.length));
        const hit = cards.find((k) => old[k].path === p);
        if (hit !== undefined) return r.fulfill({ status: 200, contentType: 'image/png', body: old[hit].buf });
        return r.fallback();
      });
    }
    await page.goto(`${BASE}/r/${code}?test=1&watch=1`);
    await page.getByTestId('classic-stage').waitFor({ timeout: 90_000 });
    await page.waitForFunction(() => window.__rich4?.store?.game?.getState().view != null, undefined, {
      timeout: 60_000,
    });
    await page.waitForFunction(() => window.__rich4.eventPlayer.idle === true, undefined, { timeout: 60_000 });
    return { ctx, page };
  };
  const oldW = await watch('W-oldpack', true);
  const newW = await watch('W-newpack', false);
  result.s3.cards = {};
  for (const k of cards) {
    const r = { cleared: old[k].cleared };
    for (const [tag, w] of [
      ['old', oldW.page],
      ['new', newW.page],
    ]) {
      const ok = await injectCast(w, k);
      r[`${tag}Classic`] = ok;
      const art = w.locator('[data-classic="true"] [data-testid="card-cast-art"]');
      r[`${tag}Bg`] = await art.evaluate((el) => getComputedStyle(el).backgroundColor);
      r[`${tag}Buf`] = await art.screenshot();
      writeFileSync(`${SHOTS}/s3-card${k}-art-${tag}pack.png`, r[`${tag}Buf`]);
      await w.screenshot({
        path: `${SHOTS}/s3-card${k}-stage-${tag}pack.png`,
        clip: await w.evaluate(() => {
          const st = document.querySelector('[data-testid="classic-stage"]');
          const [sx, sy] = (st.getAttribute('data-stage') ?? '0,0').split(',').map(Number);
          const kk = Number(st.getAttribute('data-scale'));
          const b = st.getBoundingClientRect();
          return { x: b.left + sx, y: b.top + sy, width: 640 * kk, height: 480 * kk };
        }),
      });
    }
    // 修复前的样子：旧包图、去掉黑底
    const style = await oldW.page.addStyleTag({
      content: '[data-testid="card-cast-art"]{background-color:transparent !important}',
    });
    await oldW.page.waitForTimeout(200);
    const art = oldW.page.locator('[data-classic="true"] [data-testid="card-cast-art"]');
    r.noUnderlayBuf = await art.screenshot();
    writeFileSync(`${SHOTS}/s3-card${k}-art-oldpack-no-underlay.png`, r.noUnderlayBuf);
    await style.evaluate((el) => el.remove());
    r.oldVsNew = pngDiff(r.oldBuf, r.newBuf);
    r.noUnderlayVsNew = pngDiff(r.noUnderlayBuf, r.newBuf);
    for (const key of ['oldBuf', 'newBuf', 'noUnderlayBuf']) delete r[key];
    result.s3.cards[k] = r;
    log(`S3 card.${k}`, r);
    await closeCast(oldW.page);
    await closeCast(newW.page);
  }
  await oldW.ctx.close();
  await newW.ctx.close();
  save();
}

// ───────────────────────── S1：被动卡（复仇）───────────────────────────

async function s1(seats) {
  log('S1 被动卡：P1 对 P2 出梦游卡，P2 的复仇卡生效');
  const before = { P1: await A.evaluate(() => performance.now()), P2: await B.evaluate(() => performance.now()) };
  await castViaUi(A, 16, `target-actor-seat-${seats.P2}`);
  const shots = [];
  // 出卡亮卡（CARD_USED）
  await Promise.all([waitCastDom(A), waitCastDom(B)]);
  await A.waitForTimeout(400);
  shots.push(await shot(A, 's1-card16-cast-t400'), await shot(B, 's1-card16-cast-t400'));
  // 等被动卡亮卡（PASSIVE：复仇）
  await B.waitForFunction(
    () => document.querySelector('[data-testid="card-cast-popup"]')?.getAttribute('data-variant') === 'passive',
    undefined,
    { timeout: 20_000 },
  );
  await B.waitForTimeout(400);
  shots.push(await shot(B, 's1-card18-passive-t400'), await shot(A, 's1-card18-passive-t400'));
  const domToastsDuringPassive = await B.evaluate(() => document.querySelectorAll('[data-testid="toast"]').length);
  const storeToastsDuringPassive = await B.evaluate(() => window.__rich4.store.ui.getState().toasts.map((x) => x.text));
  await B.getByTestId('card-cast-popup').waitFor({ state: 'detached', timeout: 10_000 });
  await B.waitForTimeout(300);
  shots.push(await shot(B, 's1-after-passive-t300'));
  const domToastsAfter = await B.evaluate(() =>
    [...document.querySelectorAll('[data-testid="toast"]')].map((x) => x.textContent),
  );
  await A.waitForTimeout(2500);
  const recA = await recOf(A);
  const recB = await recOf(B);
  const la = await audioLog(A);
  const lb = await audioLog(B);
  const pick = (l, from) =>
    (l?.log ?? [])
      .filter((e) => e.t >= from)
      .filter((e) => (e.kind === 'sfx' && /sfx\.062|zzfx\.magic/.test(e.key ?? '')) || e.kind === 'voice')
      .map((e) => ({ t: e.t, kind: e.kind, op: e.op, key: e.key, detail: e.detail }));
  result.s1 = {
    domToastsDuringPassive,
    storeToastsDuringPassive,
    domToastsAfter,
    audioState: { P1: la?.state, P2: lb?.state },
    P1: { opens: recA.opens, closes: recA.closes, audio: pick(la, before.P1) },
    P2: { opens: recB.opens, closes: recB.closes, audio: pick(lb, before.P2) },
    rowsP2: recB.rows.slice(-40),
    shots,
  };
  log('S1', {
    domToastsDuringPassive,
    storeToastsDuringPassive,
    domToastsAfter,
    audioState: result.s1.audioState,
  });
  save();
}

// ───────────────────────── 主流程 ─────────────────────────

try {
  const code = await setupRoom();
  const seats = await A.evaluate(() => {
    const v = window.__rich4.store.game.getState().view;
    const me = window.__rich4.store.room.getState().room;
    return { players: v.players.map((p) => ({ seat: p.seat, name: p.name })), room: me?.code };
  });
  const P1 = seats.players.find((p) => p.name === '測試甲')?.seat ?? 0;
  const P2 = seats.players.find((p) => p.name === '測試乙')?.seat ?? 1;
  result.seats = { P1, P2 };
  log('seats', result.seats);
  for (const p of [A, B]) await installRecorder(p);
  await waitTurnMenu(A);
  await debug(A, { op: 'clearBoard' });
  await debug(A, { op: 'teleport', seat: P1, node: 40, prev: 39 });
  await debug(A, { op: 'teleport', seat: P2, node: 42, prev: 41 });
  await debug(A, { op: 'give', seat: P1, cards: [1, 16], items: [] });
  await debug(A, { op: 'give', seat: P2, cards: [18], items: [] });
  await idleBoth();
  await waitTurnMenu(A);
  await s2();
  await waitTurnMenu(A);
  await s3(code);
  await waitTurnMenu(A);
  await s1({ P1, P2 });
} catch (e) {
  log('失败', String(e?.stack ?? e).slice(0, 2000));
  result.failure = String(e?.message ?? e);
  await shot(A, 'failure').catch(() => {});
  await shot(B, 'failure').catch(() => {});
} finally {
  save();
  await browser.close();
}
