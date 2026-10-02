// 调试脚本（地图接入集成阶段，VERIFY V-M7 的我们这边现状）：在集成服务（5815 → 3815，真实数据包与素材包）上把本人
// 用命运送进环路上的关押格（大陆医院 63、日本医院 55、美国医院 85 / 监狱 118；另测台湾医院作对照），被关后房主暂停，
// 截图被关棋子；再把另一名玩家传送到同一格截图（两个棋子怎么摆）；恢复后托管，逐 150ms 读棋子所在格，记录获释后走的第一格。
// 截图写到 .cache/maps/final/confine/。用法：node test/maps-final-confine.mjs [china:12,japan:12,usa:12,usa:33,taiwan:12]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.FINAL_BASE ?? 'http://localhost:5815';
const OUT = '.cache/maps/final/confine';
mkdirSync(OUT, { recursive: true });
const CASES = (process.argv[2] ?? 'china:12,japan:12,usa:12,usa:33,taiwan:12').split(',').map((c) => {
  const [map, fate] = c.split(':');
  return { map, fate: Number(fate) };
});
const STAGE = { taiwan: 0, china: 1, japan: 2, usa: 3 };
const report = [];
const log = (s) => {
  report.push(s);
  console.log(s);
};

function approach(def, target) {
  for (const t of def.tiles) {
    const outs = t.links.filter((l) => !l.blocked).map((l) => l.to);
    if (outs.length !== 2 || !outs.includes(target)) continue;
    const prev = outs.find((x) => x !== target);
    if (['jail', 'hospital'].includes(def.tiles.find((x) => x.id === prev)?.kind)) continue;
    return { node: t.id, prev };
  }
  return null;
}

async function one(browser, { map, fate }) {
  const def = JSON.parse(readFileSync(`rich4-data/maps/${map}.map.json`, 'utf8'));
  const tag = `${map}-fate${fate}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    localStorage.setItem('rich4.introSeen', '1');
    localStorage.setItem('rich4.settings', JSON.stringify({ state: { nickname: '关押巡检', skin: 'original' }, version: 2 }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const tid = (id) => page.locator(`[data-testid="${id}"]`);
  const ev = (fn, a) => page.evaluate(fn, a);
  try {
    await page.goto(`${BASE}/?audio=off&test=1`);
    await tid('home-create').click();
    await tid(`setup-stage-${STAGE[map]}`).click();
    await tid('set-timer').selectOption('off');
    await tid('set-ai-count').selectOption('3');
    await tid('set-pacing').selectOption('compact');
    await tid('create-submit').click();
    await page.waitForURL(/\/r\/\d{6}/);
    await tid('char-3').click();
    await page.waitForTimeout(500);
    await tid('room-start').click();
    await tid('fly').waitFor();
    await tid('fly-skip').click();
    await tid('screen-game').waitFor();
    const menu = () =>
      page.waitForFunction(
        () => {
          const h = window.__rich4;
          return h?.store?.game?.getState().decision?.kind === 'TURN_MENU' && h.eventPlayer.idle;
        },
        undefined,
        { timeout: 120_000 },
      );
    await menu();
    const dbg = async (op) => {
      const r = await ev((o) => window.__rich4.client.debug(o), op);
      if (!r?.ok) throw new Error(`debug ${op.op}: ${JSON.stringify(r)}`);
      await page.waitForTimeout(500);
    };
    const fates = def.tiles.filter((t) => t.kind === 'fate').map((t) => t.id);
    let path = null;
    for (const f of fates) if (!path) path = approach(def, f);
    await dbg({ op: 'stackDeck', deck: 'fate', ids: [fate] });
    await dbg({ op: 'teleport', seat: 0, node: path.node, prev: path.prev });
    await dbg({ op: 'forceNext', purpose: 'dice', values: [1] });
    await menu();
    const n0 = await ev(() => window.__rich4.store.game.getState().log.length);
    await ev(() => {
      const h = window.__rich4;
      return h.client.act({ type: 'ROLL' }, h.store.game.getState().decision.decisionId);
    });
    let conf = null;
    for (let i = 0; i < 200 && !conf; i++) {
      conf = await ev((n) => window.__rich4.store.game.getState().log.slice(n).find((l) => l.type === 'CONFINED')?.text ?? null, n0);
      if (!conf) await page.waitForTimeout(150);
    }
    const paused = await ev(() => window.__rich4.client.pause(true));
    await page.waitForTimeout(3000);
    const me = await ev(() => window.__rich4.store.game.getState().latest.players[0]);
    const hold = def.tiles.find((t) => t.id === me.node);
    const pan = async (tile) => {
      await ev(async (t) => {
        const r = window.__rich4.renderer;
        r.camera.onUserGesture();
        await r.camera.panTo(r.anchorPos({ tile: t }), 0);
      }, tile);
      await page.waitForTimeout(800);
    };
    await pan(me.node);
    await page.screenshot({ path: `${OUT}/${tag}-1-confined.png` });
    let tp = 'ok';
    try {
      await dbg({ op: 'teleport', seat: 1, node: me.node });
    } catch (e) {
      tp = e.message;
    }
    await page.waitForTimeout(1500);
    await pan(me.node);
    await page.screenshot({ path: `${OUT}/${tag}-2-shared.png` });
    const actors = await ev(() =>
      window.__rich4.renderer.board.allActors().map((a) => ({ seat: a.seat, tile: a.tile, confined: a.currentStatus?.confined ?? null })),
    );
    log(
      `[${tag}] ${conf}；暂停 ${JSON.stringify(paused)}；关押格 ${me.node}（${hold?.kind}，邻格 ${hold?.links.map((l) => l.to + (l.blocked ? 'x' : '')).join('/')}），st ${JSON.stringify(me.st)}，savedPrevNode ${me.savedPrevNode}；同格传送 ${tp}；棋子 ${JSON.stringify(actors.slice(0, 2))}`,
    );
    await ev(() => window.__rich4.client.pause(false));
    await ev(() => window.__rich4.client.autopilot(true));
    const t0 = Date.now();
    let first = null;
    const holdNode = me.node;
    while (Date.now() - t0 < 300_000 && first === null) {
      const cur = await ev(() => window.__rich4.renderer?.board.actor(0)?.tile ?? null);
      if (cur !== null && cur !== holdNode) first = cur;
      else await page.waitForTimeout(150);
    }
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${tag}-3-released.png` });
    log(`[${tag}] 获释后第一格：${first}（${Math.round((Date.now() - t0) / 1000)} 秒）`);
    await ev(() => window.__rich4.client.autopilot(false));
  } catch (e) {
    log(`[${tag}] 失败：${e.message}`);
    await page.screenshot({ path: `${OUT}/${tag}-zz-fail.png` }).catch(() => {});
  } finally {
    const errs = errors.filter((e) => !/favicon|WebGL|GPU stall/i.test(e));
    log(`[${tag}] 控制台错误 ${errs.length} 条${errs.length ? `：${errs.slice(0, 4).join(' | ')}` : ''}`);
    await context.close();
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const c of CASES) await one(browser, c);
} finally {
  await browser.close();
  writeFileSync(`${OUT}/report.txt`, `${report.join('\n')}\n`);
}
