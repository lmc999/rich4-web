// 关押期间不画棋子、获释时从景观走一步到关押格（原版皮肤，architecture §32）：真实素材包，两个真人（P2 页面 anim=instant、按默认应答）。
// 每个场景：把 P2 关进去（坐牢：两人同格，P1 对 P2 用陷害卡；住院：P1 在旁边对 P2 所在格放飞弹）→ 截图关押期间（关押格与景观上都没人）→
// P1 每回合掷 1 颗骰子，直到 P2 获释；P1 页面在 P2 的走出动画里冻结两次时钟截图：前半程（看不见）与过半刚出现后（走在景观与关押格之间）→
// 截图停在关押格。页面里另记走出的逐帧数据（是否画出、位置、朝向），写进 report.json。
// 从 test/jail-verify-shots.mjs 改写（同一套测试钩子）。产物写到 .cache/jailview/<图>-<场景>/（含原版素材，不入库）。
// 先起本机服务（本机例外：未设门禁的素材包，只监听回环；端口 4321 / 6321），在仓库根目录：
//   PORT=4321 HOST=127.0.0.1 PUBLIC_URL=http://localhost:6321 TRUST_PROXY=0 NODE_ENV=development \
//     RICH4_ASSETS_DIR=./rich4-assets RICH4_DATA_DIR=./rich4-data RICH4_ASSETS_ALLOW_UNGATED=1 RICH4_TEST_MODE=1 \
//     DATA_DIR=./.cache/jailview/data npx tsx apps/server/src/main.ts
//   (apps/client) RICH4_API_TARGET=http://127.0.0.1:4321 npx vite --port 6321 --strictPort --host 127.0.0.1
// 用法：node test/jail-walkout-shots.mjs --map=taiwan|china|japan|usa --kind=jail|hospital [--skin=procedural] [宽x高=1920x1080]
// （--skin=procedural：P1 页面改用程序化皮肤，看同一语义的程序化实现；产物目录加 -procedural）
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.JAIL_BASE ?? 'http://localhost:6321';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1920x1080').split('x').map(Number);
const MAP = args.find((a) => a.startsWith('--map='))?.slice(6) ?? 'taiwan';
const KIND = args.find((a) => a.startsWith('--kind='))?.slice(7) ?? 'jail';
const SKIN = args.find((a) => a.startsWith('--skin='))?.slice(7) ?? null;
/** apps/client/src/store/settingsStore.ts 的 SETTINGS_VERSION */
const SETTINGS_VERSION = Number(
  /SETTINGS_VERSION = (\d+)/.exec(readFileSync('apps/client/src/store/settingsStore.ts', 'utf8'))?.[1] ?? '2',
);
const OUT = `.cache/jailview/${MAP}-${KIND}${SKIN ? `-${SKIN}` : ''}`;
mkdirSync(OUT, { recursive: true });
const LOG = [];
const report = { size, map: MAP, kind: KIND, steps: [] };
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${s}`;
  console.log(line);
  LOG.push(line);
};

/** 数据包里这张图（本机读取，不入库）：关押格取地标 holdTile，保释 / 出院格取落点码 4 / 5 的最小 id */
const def = (() => {
  const d = JSON.parse(readFileSync(`rich4-data/maps/${MAP}.map.json`, 'utf8'));
  return d.def ?? d;
})();
const tileOf = (id) => def.tiles.find((t) => t.id === id);
const worldOf = (id) => tileOf(id).world;
const HOLD = def.landmarks.find((l) => l.kind === KIND).holdTile;
const GATE = Math.min(...def.tiles.filter((t) => t.landingCode === (KIND === 'jail' ? 4 : 5)).map((t) => t.id));
log(`map ${MAP} ${KIND}: hold ${HOLD}, gate ${GATE}`);

function plainSpot(avoid) {
  const far = (t) => avoid.every((a) => Math.hypot(t.world.x - worldOf(a).x, t.world.y - worldOf(a).y) > 400);
  const c = def.tiles.filter(
    (t) =>
      t.landingCode === 0 && !t.noItems && (t.kind === 'property' || t.kind === 'plain') && t.links.length === 2 && far(t),
  );
  if (c.length === 0) throw new Error('no plain spot');
  return c[Math.floor(c.length / 2)].id;
}

const SAFE = (() => {
  const plain = (t) => t.landingCode === 0 && !t.noItems && (t.kind === 'property' || t.kind === 'plain');
  const far = (t) => [HOLD, GATE].every((a) => Math.hypot(t.world.x - worldOf(a).x, t.world.y - worldOf(a).y) > 400);
  const c = def.tiles.filter(
    (t) =>
      plain(t) &&
      far(t) &&
      t.links.length === 2 &&
      t.links.every((l) => !l.blocked && plain(tileOf(l.to)) && tileOf(l.to).links.length === 2),
  );
  if (c.length === 0) throw new Error('no safe spot');
  const t = c[Math.floor(c.length / 3)];
  return { node: t.id, prev: t.links[0].to };
})();

function shooterSpot(target) {
  const w = worldOf(target);
  const ok = def.tiles
    .filter((t) => !t.noItems && t.ref?.landmark === undefined && t.id !== HOLD && t.id !== GATE)
    .map((t) => ({ id: t.id, d: Math.max(Math.abs(t.world.x - w.x), Math.abs(t.world.y - w.y)) }))
    .filter((x) => x.d >= 140 && x.d <= 190)
    .sort((a, b) => a.d - b.d || a.id - b.id);
  if (ok.length === 0) throw new Error(`no shooter spot near ${target}`);
  return ok[0].id;
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function newPage(name, query) {
  const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => localStorage.setItem('rich4.introSeen', '1'));
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return { ctx, page, errors, name, query };
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
      decision: d ? { kind: d.kind, id: d.decisionId, seat: d.seat } : null,
      submitting: g?.submitting ?? null,
      skin: h?.skin?.boardInUse ?? null,
      pacing: room?.settings?.pacing ?? null,
    };
  });
}

/** view 里 P2 的位置与关押计数；棋盘上 P2 角色的格、是否画出、是否在建筑里、画点 */
async function probe(page) {
  return page.evaluate(() => {
    const h = window.__rich4;
    const g = h.store.game.getState();
    const v = g.view;
    const r = h.renderer;
    const a = (r?.board?.allActors?.() ?? []).find((x) => x.seat === 1);
    const p = (v?.players ?? []).find((x) => x.seat === 1);
    // 原版棋子的本体容器叫 body，程序化棋子看 figure
    const body = a?.root?.getChildByLabel?.('body') ?? a?.root?.getChildByLabel?.('figure', true);
    return {
      date: v?.clock?.date ?? null,
      p2: p ? { node: p.node, prevNode: p.prevNode, jail: p.st.jail, hospital: p.st.hospital, hotel: p.st.hotel } : null,
      actor: a
        ? {
            tile: a.tile,
            rootVisible: a.root.visible,
            drawn: body ? body.visible : null,
            inside: a.insideBuilding ?? null,
            offBoard: a.offBoard ?? null,
            facing: a.facing,
            at: a.boardPos ? a.boardPos() : a.screenPos(),
          }
        : null,
    };
  });
}

/** 在画布上标出关押格与景观（不动镜头）；center 给出时先把镜头对准那一格 */
async function marks(page, center) {
  await page.evaluate(
    async ({ center, HOLD, GATE, KIND }) => {
      const r = window.__rich4.renderer;
      if (!r) return;
      if (center !== null && r.anchorPos) {
        r.camera.onUserGesture?.();
        const c = r.anchorPos({ tile: center });
        if (c) await r.camera.panTo(c, 0);
      }
      document.querySelectorAll('.jail-probe-mark').forEach((e) => e.remove());
      const canvas = document.querySelector('canvas');
      const cr = canvas?.getBoundingClientRect() ?? { left: 0, top: 0 };
      const put = (p, text, color) => {
        if (!p) return;
        const el = document.createElement('div');
        el.className = 'jail-probe-mark';
        el.textContent = text;
        el.style.cssText = `position:fixed;left:${cr.left + p.x}px;top:${cr.top + p.y + 18}px;transform:translate(-50%,0);z-index:99999;pointer-events:none;font:bold 12px sans-serif;color:#fff;background:${color};border:1px solid #000;border-radius:3px;padding:0 3px;opacity:.85`;
        document.body.appendChild(el);
      };
      put(r.tileCanvasPos(HOLD), `关押格${HOLD}`, '#c0392b');
      if (GATE !== HOLD) put(r.tileCanvasPos(GATE), `${KIND === 'jail' ? '保释' : '出院'}格${GATE}`, '#2c3e50');
      const w = r.boardView?.landmarkWorld?.(KIND);
      if (w && r.proj) put(r.camera.worldToScreen(r.proj.projectPx(w)), KIND === 'jail' ? '监狱景观' : '医院景观', '#8e44ad');
    },
    { center, HOLD, GATE, KIND },
  );
  await page.waitForTimeout(center === null ? 50 : 600);
}

let shotN = 0;
async function shot(page, name, center) {
  shotN++;
  const file = `${OUT}/${String(shotN).padStart(2, '0')}-${name}.png`;
  await marks(page, center);
  const p = await probe(page);
  await page.screenshot({ path: file });
  await page.evaluate(() => document.querySelectorAll('.jail-probe-mark').forEach((e) => e.remove()));
  report.steps.push({ name, file, probe: p });
  log(`shot ${file} ${JSON.stringify(p)}`);
  return p;
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

async function skipFly(page) {
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    if ((await page.getByTestId('fly').count()) > 0) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
      if ((await page.getByTestId('fly').count()) === 0) return true;
    }
    await page.waitForTimeout(200);
  }
  return false;
}

const A = await newPage('P1', 'audio=off&test=1');
const B = await newPage('P2', 'anim=instant&audio=off&test=1');
const pa = A.page;
const pb = B.page;

const driveB = async () => {
  const st = await state(pb);
  if (!st.idle || !st.decision || st.submitting !== null) return;
  await act(pb);
};

/** 走出动画里的冻结点（P1 页面）：veiled = 前半程看不见时，shown = 刚画出来之后 */
let frozenHandler = null;
async function waitP1Menu(timeout = 240_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (frozenHandler) await frozenHandler();
    await driveB();
    const s = await state(pa);
    if (s.idle && s.decision && s.submitting === null) {
      if (s.decision.kind === 'TURN_MENU' && s.decision.seat === s.seat) return s;
      await act(pa);
    }
    await pa.waitForTimeout(100);
  }
  await pa.screenshot({ path: `${OUT}/fail-menu.png` }).catch(() => {});
  throw new Error(`wait P1 menu timeout: ${JSON.stringify(await state(pa))}`);
}

/**
 * P1 页面：盯住 P2 的棋子，走出建筑时逐帧记录（是否画出、画点、朝向），在前半程过 200 ms 与刚画出来 120 ms 后各冻结一次时钟
 * （speed 0.02），等脚本截图后恢复
 */
async function armWatch() {
  await pa.evaluate(() => {
    const s = window.__rich4.renderer;
    // 程序化门面没有 clock：取底下的 GameRenderer
    const r = s.clock ? s : { clock: s.renderer.clock, board: s.board };
    const w = { phase: 'armed', frames: [], t: 0, speed: r.clock.speed, calls: [] };
    window.__jailWatch = w;
    // 记下 walkOut 的调用（起点是否在建筑里、tick）
    const a0 = r.board.allActors().find((x) => x.seat === 1);
    if (a0 && !a0.__jailWrapped) {
      a0.__jailWrapped = true;
      const orig = a0.walkOut.bind(a0);
      a0.walkOut = (to, o) => {
        w.calls.push({ to, inside: a0.insideWorld, walking: a0.isWalking, tickMs: o.tickMs, t: r.clock.now() });
        return orig(to, o);
      };
    }
    const tick = () => {
      const a = r.board.allActors().find((x) => x.seat === 1);
      if (a && (w.phase === 'armed' || w.phase.startsWith('go') || w.phase.startsWith('veiled') || w.phase === 'shown')) {
        const walking = a.isWalking;
        const drawn = (a.root.getChildByLabel('body') ?? a.root.getChildByLabel('figure', true)).visible;
        if (walking && (w.phase !== 'armed' || a.offBoard)) {
          const at = a.boardPos ? a.boardPos() : a.screenPos();
          w.frames.push({ t: Math.round(r.clock.now()), drawn, at, facing: a.facing, tile: a.tile });
        }
        if (w.phase === 'armed' && walking && a.offBoard) {
          w.phase = 'veiled';
          w.t = r.clock.now();
        } else if (w.phase === 'veiled' && r.clock.now() - w.t >= 200) {
          w.speed = r.clock.speed;
          r.clock.speed = 0.02;
          w.phase = 'freeze-veiled';
        } else if (w.phase === 'go-veiled' && walking && drawn) {
          w.phase = 'shown';
          w.t = r.clock.now();
        } else if (w.phase === 'shown' && r.clock.now() - w.t >= 120) {
          w.speed = r.clock.speed;
          r.clock.speed = 0.02;
          w.phase = 'freeze-shown';
        } else if (w.phase === 'go-shown' && !walking) {
          w.phase = 'done';
        }
      }
      if (w.phase !== 'done' && w.phase !== 'off') requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  frozenHandler = async () => {
    const phase = await pa.evaluate(() => window.__jailWatch?.phase ?? null);
    if (phase === 'freeze-veiled' || phase === 'freeze-shown') {
      const name = phase === 'freeze-veiled' ? 'walkout-1-first-half-hidden' : 'walkout-2-past-half-shown';
      await shot(pa, name, null);
      await pa.evaluate(() => {
        const w = window.__jailWatch;
        const s = window.__rich4.renderer;
        (s.clock ?? s.renderer.clock).speed = w.speed;
        w.phase = w.phase === 'freeze-veiled' ? 'go-veiled' : 'go-shown';
      });
    }
  };
}

/** P1 每回合掷 1 颗骰子，直到 P2 的计数归零（获释、走出来，又轮到 P1） */
async function untilReleased() {
  for (let round = 0; round < 20; round++) {
    await debug(pa, { op: 'teleport', seat: 0, node: SAFE.node, prev: SAFE.prev });
    await waitP1Menu();
    const p0 = await probe(pa);
    if (p0.p2[KIND] === 0x80) {
      // 下一个 P2 回合获释：先把镜头对准关押格，再盯住走出动画
      await marks(pa, HOLD);
      await pa.evaluate(() => document.querySelectorAll('.jail-probe-mark').forEach((e) => e.remove()));
      await armWatch();
    }
    await act(pa, { type: 'ROLL', dice: 1 });
    await waitP1Menu();
    const p = await probe(pa);
    log(`round ${round} ${JSON.stringify(p)}`);
    if (p.p2[KIND] === 0) return p;
  }
  throw new Error(`${KIND} not released`);
}

async function confine() {
  if (KIND === 'jail') {
    const spot = plainSpot([HOLD, GATE]);
    await debug(pa, { op: 'teleport', seat: 1, node: spot });
    await debug(pa, { op: 'teleport', seat: 0, node: spot });
    await debug(pa, { op: 'give', seat: 0, cards: [17], items: [] });
    await waitP1Menu();
    const slot = await pa.evaluate(() =>
      window.__rich4.store.game.getState().view.players.find((x) => x.seat === 0).cards.indexOf(17),
    );
    const r = await act(pa, {
      type: 'USE_CARD',
      slot,
      card: 17,
      target: { t: 'actor', actor: { t: 'seat', seat: 1 } },
    });
    log(`frame card at ${spot} → ${JSON.stringify(r)}`);
  } else {
    const target = plainSpot([HOLD, GATE]);
    await debug(pa, { op: 'give', seat: 0, cards: [], items: [{ item: 7, qty: 1 }] });
    await debug(pa, { op: 'teleport', seat: 1, node: target });
    await debug(pa, { op: 'teleport', seat: 0, node: shooterSpot(target) });
    await waitP1Menu();
    const r = await act(pa, { type: 'USE_ITEM', item: 7, target: { t: 'node', node: target } });
    log(`missile ${target} → ${JSON.stringify(r)}`);
  }
  await waitP1Menu();
  await pa.waitForTimeout(1500);
  const p = await probe(pa);
  if (p.p2[KIND] === 0) throw new Error(`P2 not confined: ${JSON.stringify(p)}`);
  return p;
}

try {
  if (SKIN) {
    // 设置存档（zustand persist 'rich4.settings'，与初始值浅合并）里只写皮肤偏好
    await A.ctx.addInitScript(
      ([skin, version]) => localStorage.setItem('rich4.settings', JSON.stringify({ state: { skin }, version })),
      [SKIN, SETTINGS_VERSION],
    );
  }
  await pa.goto(`${BASE}/?${A.query}`);
  await pa.getByTestId('home-nickname').fill('測試甲');
  await pa.getByTestId('home-nickname').blur();
  await pa.getByTestId('home-create').click();
  await pa.getByTestId('set-map').selectOption(MAP);
  await pa.getByTestId('set-timer').selectOption('slow');
  await pa.getByTestId('set-ai-count').selectOption('0');
  await pa.getByTestId('create-submit').click();
  await pa.waitForURL(/\/r\/\d{6}/);
  const code = /\/r\/(\d{6})/.exec(pa.url())[1];
  log(`room ${code} map ${MAP}`);
  await pb.goto(`${BASE}/?${B.query}`);
  await pb.getByTestId('home-nickname').fill('測試乙');
  await pb.getByTestId('home-nickname').blur();
  await pb.goto(`${BASE}/r/${code}?${B.query}`);
  await pb.getByTestId('screen-room').waitFor();
  for (const [p, c] of [
    [pa, 2],
    [pb, 9],
  ]) {
    await p.getByTestId(`char-${c}`).click();
    if ((await p.getByTestId('screen-room').getAttribute('data-screen')) !== 'select')
      await p.getByTestId('char-select').click();
  }
  await pb.getByTestId('room-ready').click();
  await pa.waitForTimeout(500);
  await pa.getByTestId('room-start').click();
  await pa.getByTestId('screen-game').waitFor({ timeout: 60_000 });
  await pb.getByTestId('screen-game').waitFor({ timeout: 60_000 });
  await Promise.all([skipFly(pa), skipFly(pb)]);
  const st0 = await state(pa);
  report.skin = st0.skin;
  report.pacing = st0.pacing;
  log(`skin ${JSON.stringify(report.skin)} pacing ${report.pacing}`);
  await waitP1Menu();
  await pa.waitForTimeout(1500);
  if ((await state(pa)).seat !== 0) throw new Error('P1 is not seat 0');
  await debug(pa, { op: 'clearBoard' });

  const c = await confine();
  report.confined = c;
  await shot(pa, `confined-nobody-at-hold${HOLD}`, HOLD);
  const rel = await untilReleased();
  report.released = rel;
  await pa.waitForTimeout(800);
  await shot(pa, `released-standing-at-hold${HOLD}`, HOLD);
  const watch = await pa.evaluate(() => window.__jailWatch ?? null);
  report.walkOut = watch;
  if (watch) {
    const firstDrawn = watch.frames.findIndex((f) => f.drawn);
    report.walkOutSummary = {
      frames: watch.frames.length,
      hiddenFrames: firstDrawn < 0 ? watch.frames.length : firstDrawn,
      firstDrawnAt: firstDrawn < 0 ? null : watch.frames[firstDrawn].at,
      start: watch.frames[0]?.at ?? null,
      end: watch.frames.at(-1)?.at ?? null,
      facings: [...new Set(watch.frames.map((f) => f.facing))],
      durationMs: watch.frames.length > 1 ? watch.frames.at(-1).t - watch.frames[0].t : null,
    };
    log(`WALKOUT ${JSON.stringify(report.walkOutSummary)}`);
  }
} catch (e) {
  log(`FAILED ${e.stack ?? e}`);
  report.failed = String(e);
  await pa.screenshot({ path: `${OUT}/fail.png` }).catch(() => {});
}
report.errors = { P1: A.errors, P2: B.errors };
log(`console errors P1 ${A.errors.length} P2 ${B.errors.length}`);
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
writeFileSync(`${OUT}/log.txt`, LOG.join('\n'));
await browser.close();
