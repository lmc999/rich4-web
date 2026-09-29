// 掷骰修正的整体验证（原版皮肤 + 真实素材包；一个真人 + 一个电脑）：步行 / 机车 / 汽车各由本人掷一次（forceNext 强制点数），
// 每次本人掷完后接着看电脑的回合。页面里常驻一个追踪器（只记变化）：各座位棋子的姿态库 / 帧号 / 是否行走、行动者、
// 骰子覆盖层（滚动 / 点数面、颗数、点数、是否真 FLC）；另外每 100 ms 把 AudioEngine 的日志累积下来（环形缓冲只留 500 条）。
// 每次掷骰检查：掷骰前静止、GO 竖槽小骰子个数、持骰动作 → 骰子 FLC → 两声 sfx.010（第 30 帧 / 播完）→ 点数面 → 停留 → 起步的
// 顺序与时刻、颗数 = 交通工具、显示的点数 = 事件的点数（= 强制值）、点数和 = 步数 = 实际走的格数。
// 截图、追踪与音频日志写到 .cache/dice/verify/<名字>/（含原版素材，不入库）。
// 先起本机服务（本机例外：未设门禁的素材包，只监听回环；端口 3931 / 5931）：
//   (apps/server) PORT=3931 HOST=127.0.0.1 PUBLIC_URL=http://localhost:5931 TRUST_PROXY=0 NODE_ENV=development \
//     RICH4_ASSETS_DIR=<repo>/rich4-assets RICH4_DATA_DIR=<repo>/rich4-data RICH4_ASSETS_ALLOW_UNGATED=1 RICH4_TEST_MODE=1 \
//     DATA_DIR=<repo>/.cache/dice/verify/data npx tsx src/main.ts
//   (apps/client) RICH4_API_TARGET=http://127.0.0.1:3931 npx vite --port 5931 --strictPort
// 用法：node test/dice-verify-shots.mjs [宽x高=1920x1080] [--mobile] [--name=desktop] [--pacing=original|compact]
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.DICE_BASE ?? 'http://localhost:5931';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1920x1080').split('x').map(Number);
const MOBILE = args.includes('--mobile');
const PACING = args.find((a) => a.startsWith('--pacing='))?.slice('--pacing='.length) ?? 'original';
const NAME = args.find((a) => a.startsWith('--name='))?.slice('--name='.length) ?? `${size[0]}x${size[1]}`;
const OUT = `.cache/dice/verify/${NAME}`;
mkdirSync(OUT, { recursive: true });

// 原版时序（shared/view/pacing 的 DICE_TIMING）：持骰每帧、FLC 每帧、落定停留
const TIMING = PACING === 'original' ? { tick: 80, frame: 30, hold: 500 } : { tick: 40, frame: 20, hold: 300 };
const KNOCK1 = 29 * TIMING.frame;
const FLIC = 36 * TIMING.frame;

const LOG = [];
const report = { size, mobile: MOBILE, pacing: PACING, rolls: [], checks: [] };
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${s}`;
  console.log(line);
  LOG.push(line);
};
const check = (roll, name, ok, detail) => {
  report.checks.push({ roll, name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} [${roll}] ${name} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
};

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
  if (m.type() === 'error') errors.push(`console.error: ${m.text().slice(0, 300)}`);
  if (m.type() === 'warning' && /未结束|超预算|handler 出错|骰子/.test(m.text())) errors.push(`warn: ${m.text().slice(0, 300)}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

async function state() {
  return page.evaluate(() => {
    const h = window.__rich4;
    const g = h?.store?.game?.getState();
    const room = h?.store?.room?.getState().room;
    const d = g?.decision;
    const cur = g?.view?.clock?.cursor;
    return {
      seq: g?.seq ?? 0,
      idle: h?.eventPlayer?.idle ?? false,
      seat: room?.you?.seat ?? null,
      cursor: cur?.t === 'seat' ? cur.seat : null,
      decision: d ? { kind: d.kind, id: d.decisionId, dice: d.options?.dice ?? null } : null,
      submitting: g?.submitting ?? null,
      players: (g?.view?.players ?? []).map((p) => ({
        seat: p.seat,
        character: p.character,
        vehicle: p.vehicle,
        diceCount: p.diceCount,
        node: p.node,
      })),
    };
  });
}

/** 页面里常驻的追踪器（只记变化）与音频日志累积 */
async function installTracer() {
  await page.evaluate(() => {
    if (window.__trace) return;
    const trace = [];
    window.__trace = trace;
    let last = '';
    const tick = () => {
      const h = window.__rich4;
      const g = h?.store?.game?.getState();
      const cur = g?.view?.clock?.cursor;
      const a = {};
      for (const p of g?.view?.players ?? []) {
        const x = h.renderer?.board?.actor(p.seat);
        a[p.seat] = x ? `${x.poseKey ?? '?'}#${x.frameIndex ?? -1}${x.isWalking ? 'W' : ''}` : null;
      }
      const ov = document.querySelector('[data-testid="dice-overlay"]');
      const o = ov
        ? {
            st: ov.getAttribute('data-rolling') === 'true' ? 'rolling' : 'faces',
            seat: Number(ov.getAttribute('data-seat')),
            count: Number(ov.getAttribute('data-count')),
            slot: ov.getAttribute('data-slot'),
            flic: ov.getAttribute('data-flic') === 'true',
            faces: [...ov.querySelectorAll('[data-testid="dice-face"]')].map((f) => f.getAttribute('data-face')),
            frames: [...ov.querySelectorAll('[data-testid="dice-face"]')].map((f) => Number(f.getAttribute('data-frame'))),
            sprites: [...ov.querySelectorAll('[data-testid="dice-face"] [data-sprite]')].length,
          }
        : null;
      const snap = { cur: cur?.t === 'seat' ? cur.seat : null, idle: h?.eventPlayer?.idle === true, a, o };
      const k = JSON.stringify(snap);
      if (k !== last) {
        last = k;
        trace.push({ t: Math.round(performance.now()), ...snap });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const events = [];
    window.__events = events;
    window.__rich4.client.transport.on('game:batch', (p) => {
      for (const e of p.events) {
        if (['DICE_ROLLED', 'MOVE_SEGMENT', 'TURN_STARTED', 'TURN_ENDED', 'ROADBLOCK_HIT'].includes(e.type))
          {
          const { post, ...rest } = e;
          events.push({ seq: p.seq, at: Math.round(performance.now()), ...rest });
        }
      }
    });
    const seen = new WeakSet();
    const audio = [];
    window.__audioAll = audio;
    setInterval(() => {
      const l = window.__rich4?.audio?.log ?? [];
      for (const e of l) {
        if (seen.has(e)) continue;
        seen.add(e);
        if (e.kind === 'sfx' || e.kind === 'engine') audio.push({ t: Math.round(e.t), kind: e.kind, op: e.op, key: e.key ?? '', detail: e.detail ?? '' });
      }
    }, 100);
  });
}

const now = () => page.evaluate(() => Math.round(performance.now()));
const traceSince = (t) => page.evaluate((t0) => window.__trace.filter((s) => s.t >= t0), t);
const audioSince = (t) => page.evaluate((t0) => window.__audioAll.filter((s) => s.t >= t0), t);
/** 收到的事件（game:batch，按到达顺序编号） */
const eventsSince = (i) => page.evaluate((i0) => window.__events.slice(i0), i);
const eventCount = () => page.evaluate(() => window.__events.length);

let shotN = 0;
async function shot(name) {
  shotN++;
  const file = `${OUT}/${String(shotN).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file });
  const go = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="action-roll"]');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  });
  if (go && go.w > 0) {
    const pad = 16;
    await page
      .screenshot({
        path: file.replace(/\.png$/, '.go.png'),
        clip: { x: Math.max(0, go.x - pad), y: Math.max(0, go.y - pad), width: go.w + pad * 2, height: go.h + pad * 2 },
      })
      .catch(() => {});
  }
  log(`shot ${file}`);
  return file;
}

async function slotsInfo() {
  return page.evaluate(() => {
    const dc = document.querySelector('[data-testid="action-dice-count"]');
    if (!dc) return null;
    return {
      value: dc.getAttribute('data-value'),
      slots: Number(dc.getAttribute('data-slots')),
      dies: [...dc.querySelectorAll('[data-testid="dice-count-die"]')].map((e) => ({
        frame: Number(e.getAttribute('data-frame')),
        on: e.getAttribute('data-on') === 'true',
        sprite: !!e.querySelector('[data-sprite]'),
      })),
    };
  });
}

async function debug(op) {
  const s0 = (await state()).seq;
  const r = await page.evaluate((o) => window.__rich4.client.debug(o), op);
  if (!r.ok) throw new Error(`debug ${JSON.stringify(op)} → ${JSON.stringify(r)}`);
  await page.waitForFunction((s) => window.__rich4.store.game.getState().seq > s, s0, { timeout: 30_000 });
}

async function act(intent = null) {
  return page.evaluate((it) => {
    const h = window.__rich4;
    const d = h.store.game.getState().decision;
    return d ? h.client.act(it ?? d.defaultIntent, d.decisionId) : null;
  }, intent);
}

/** 等本人的 TURN_MENU（其余决策按默认应答） */
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
  await page.screenshot({ path: `${OUT}/fail-myturn.png` }).catch(() => {});
  throw new Error(`myTurn timeout ${JSON.stringify(await state())}`);
}

const near = (v, want, tol) => v !== null && v !== undefined && Math.abs(v - want) <= tol;

/** 从追踪里分析 seat 这一次掷骰（t0 之后） */
function analyse(tag, seat, tr, audio, t0) {
  const pose = (s) => s.a[seat] ?? '';
  const throwIdx = tr.findIndex((s) => s.t >= t0 && /\.dice#/.test(pose(s)));
  const throwAt = throwIdx >= 0 ? tr[throwIdx].t : null;
  // 持骰动作的帧序（到骰子 FLC 出现为止）
  const rollIdx = tr.findIndex((s) => s.t >= t0 && s.o?.st === 'rolling' && s.o.seat === seat);
  const rollAt = rollIdx >= 0 ? tr[rollIdx].t : null;
  const frames = [];
  if (throwIdx >= 0) {
    for (let i = throwIdx; i < (rollIdx >= 0 ? rollIdx + 1 : tr.length); i++) {
      const m = /\.dice#(\d+)/.exec(pose(tr[i]));
      if (m && frames[frames.length - 1]?.f !== Number(m[1])) frames.push({ t: tr[i].t, f: Number(m[1]) });
    }
  }
  const facesIdx = tr.findIndex((s) => s.t >= t0 && s.o?.st === 'faces' && s.o.seat === seat);
  const facesAt = facesIdx >= 0 ? tr[facesIdx].t : null;
  const facesSnap = facesIdx >= 0 ? tr[facesIdx].o : null;
  const rollSnap = rollIdx >= 0 ? tr[Math.min(tr.length - 1, rollIdx + 3)].o ?? tr[rollIdx].o : null;
  const flic = tr.some((s) => s.t >= t0 && s.o?.st === 'rolling' && s.o.seat === seat && s.o.flic);
  const walkIdx = tr.findIndex((s) => s.t >= (facesAt ?? t0) && pose(s).endsWith('W'));
  const walkAt = walkIdx >= 0 ? tr[walkIdx].t : null;
  const goneIdx = tr.findIndex((s) => s.t >= (facesAt ?? t0) && s.o === null);
  const goneAt = goneIdx >= 0 ? tr[goneIdx].t : null;
  const knocks = audio.filter((e) => e.t >= t0 && e.kind === 'sfx' && e.op === 'play' && (e.key === 'sfx.010' || e.key === 'zzfx.dice'));
  const lost = audio.filter((e) => e.t >= t0 && e.kind === 'sfx' && e.op !== 'play' && (e.key === 'sfx.010' || e.key === 'zzfx.dice'));
  const inRoll = knocks.filter((k) => rollAt !== null && k.t >= rollAt && k.t <= (facesAt ?? rollAt + 3000) + 300);
  const rel = (x) => (x === null || rollAt === null ? null : x - rollAt);
  const summary = {
    throwAt: rel(throwAt),
    throwFrames: frames.map((f) => `${rel(f.t)}:${f.f}`),
    rollAt: 0,
    knocks: inRoll.map((k) => `${rel(k.t)} ${k.key}`),
    lostKnocks: lost.map((k) => `${rel(k.t)} ${k.op} ${k.key}`),
    facesAt: rel(facesAt),
    goneAt: rel(goneAt),
    walkAt: rel(walkAt),
    count: rollSnap?.count ?? null,
    slot: rollSnap?.slot ?? null,
    flic,
    faces: facesSnap?.faces ?? null,
    faceFrames: facesSnap?.frames ?? null,
    faceSprites: facesSnap?.sprites ?? null,
  };
  log(`[${tag}] 时间线（相对骰子 FLC 出现）${JSON.stringify(summary)}`);
  return { summary, throwAt, rollAt, facesAt, walkAt, goneAt, knocks: inRoll, frames };
}

function verifyRoll(tag, r, ev, moved, expect) {
  const s = r.summary;
  check(tag, '持骰动作先于骰子 FLC', r.throwAt !== null && r.rollAt !== null && r.throwAt < r.rollAt, {
    throwAt: s.throwAt,
  });
  const fs = r.frames.map((f) => f.f);
  const mono = fs.every((f, i) => i === 0 || f === fs[i - 1] + 1);
  check(tag, '持骰帧逐帧前进、播一遍', r.frames.length >= 4 && mono, { frames: fs.length, perDirExpect: expect.perDir ?? '?' });
  if (r.frames.length >= 2 && r.rollAt !== null) {
    const span = r.rollAt - r.frames[0].t;
    const want = r.frames.length * TIMING.tick;
    check(tag, `持骰时长≈帧数×${TIMING.tick}ms`, near(span, want, 70), { span, want });
  }
  check(tag, '骰子为真 FLC（素材包）', s.flic === true, { flic: s.flic });
  check(tag, `颗数=${expect.count}`, s.count === expect.count && ev?.dice.length === expect.count, {
    overlay: s.count,
    event: ev?.dice,
  });
  check(tag, '恰好两声「咚」(sfx.010)', r.knocks.length === 2 && r.knocks.every((k) => k.key === 'sfx.010'), {
    knocks: s.knocks,
    lost: s.lostKnocks,
  });
  if (r.knocks.length === 2) {
    const k1 = r.knocks[0].t - r.rollAt;
    const k2 = r.knocks[1].t - r.rollAt;
    check(tag, `第一声≈FLC 第 30 帧（${KNOCK1}ms）`, near(k1, KNOCK1, 60), { k1 });
    check(tag, `第二声≈FLC 播完（${FLIC}ms）且与点数面同时`, near(k2, FLIC, 60) && near(r.knocks[1].t, r.facesAt, 40), {
      k2,
      facesAt: s.facesAt,
    });
  }
  check(tag, `点数面停留≈${TIMING.hold}ms 后起步`, r.walkAt !== null && near(r.walkAt - r.facesAt, TIMING.hold, 90), {
    hold: r.walkAt === null ? null : r.walkAt - r.facesAt,
    goneAt: s.goneAt,
  });
  const shown = (s.faces ?? []).map(Number);
  check(tag, '点数面 = 事件点数', ev && JSON.stringify(shown) === JSON.stringify(ev.dice), { shown, event: ev?.dice });
  check(tag, '点数面帧 = 6i+点数−1（Panel#3）', (s.faceFrames ?? []).every((f, i) => f === i * 6 + shown[i] - 1) && s.faceSprites === shown.length, {
    frames: s.faceFrames,
    sprites: s.faceSprites,
  });
  if (expect.forced) check(tag, '点数 = 强制值', JSON.stringify(ev?.dice) === JSON.stringify(expect.forced), { forced: expect.forced });
  const sum = shown.reduce((a, b) => a + b, 0);
  check(tag, '点数和 = 步数 = 实际走的格数', ev && sum === ev.steps && moved === ev.steps, { sum, steps: ev?.steps, moved });
}

/** DICE_ROLLED（seat，事件下标 from 之后的第一条）与随后本座位走过的格数（MOVE_SEGMENT 的 path 不含起点） */
async function diceEvent(seat, from) {
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    const evs = await eventsSince(from);
    const i = evs.findIndex((x) => x.type === 'DICE_ROLLED' && x.seat === seat);
    if (i >= 0) {
      let moved = 0;
      let done = evs[i].steps === 0;
      for (let j = i + 1; j < evs.length; j++) {
        const x = evs[j];
        if (x.type === 'MOVE_SEGMENT' && x.actor.t === 'seat' && x.actor.seat === seat) {
          moved += x.path.length;
          if (x.remaining === 0) done = true;
        }
        if (x.type === 'ROADBLOCK_HIT') done = true;
        if (x.type === 'TURN_ENDED' || x.type === 'TURN_STARTED' || x.type === 'DICE_ROLLED') {
          done = true;
          break;
        }
      }
      if (done) {
        const { seq, at, type, ...ev } = evs[i];
        return { ev, moved };
      }
    }
    await page.waitForTimeout(200);
  }
  return { ev: null, moved: null };
}


/** 本人掷骰 */
async function selfRoll(tag, forced, expectCount) {
  await myTurn();
  const me = (await state()).seat;
  await debug({ op: 'forceNext', purpose: 'dice', values: forced });
  const st = await myTurn();
  const vehicle = st.players.find((p) => p.seat === me)?.vehicle;
  log(`[${tag}] TURN_MENU options.dice ${JSON.stringify(st.decision.dice)} vehicle=${vehicle}`);
  await page.waitForTimeout(500);
  // 掷骰前 1.2 s：本人与电脑的姿态都不应变化
  const tIdle = await now();
  await page.waitForTimeout(1200);
  const idleTr = await traceSince(tIdle);
  const idleMine = [...new Set(idleTr.map((s) => s.a[me]))];
  const lastBefore = await page.evaluate(() => window.__trace.at(-1));
  const idleSet = idleMine.length > 0 ? idleMine : [lastBefore?.a?.[me]];
  check(tag, '掷骰前本人静止站姿（1.2s 内姿态帧不变）', idleSet.length === 1 && /\.stand#/.test(idleSet[0] ?? ''), {
    poses: idleSet,
  });
  const slots = await slotsInfo();
  check(tag, `GO 竖槽 ${expectCount} 个小骰子全亮`, slots?.slots === expectCount && slots.dies.length === expectCount && slots.dies.every((d) => d.on && d.sprite), slots);
  await shot(`${tag}-1-before-roll`);
  const afterId = await eventCount();
  const t0 = await now();
  await page.getByTestId('action-roll').click({ timeout: 5000 });
  await page.waitForFunction((s) => /\.dice$/.test(window.__rich4.renderer?.board?.actor(s)?.poseKey ?? ''), me, { timeout: 10_000 });
  await page.waitForTimeout(PACING === 'original' ? 180 : 90);
  await shot(`${tag}-2-throw`);
  await page.waitForFunction(() => document.querySelector('[data-testid="dice-overlay"]')?.getAttribute('data-rolling') === 'true', null, { timeout: 10_000 });
  await page.waitForTimeout(Math.round(FLIC * 0.45));
  await shot(`${tag}-3-flic`);
  await page.waitForFunction(() => document.querySelector('[data-testid="dice-overlay"]')?.getAttribute('data-rolling') === 'false', null, { timeout: 10_000 });
  await page.waitForTimeout(80);
  await shot(`${tag}-4-faces`);
  await page.waitForFunction((s) => window.__rich4.renderer?.board?.actor(s)?.isWalking === true, me, { timeout: 10_000 });
  await page.waitForTimeout(120);
  await shot(`${tag}-5-walk`);
  const { ev, moved } = await diceEvent(me, afterId);
  await page.waitForTimeout(300);
  const r = analyse(tag, me, await traceSince(t0), await audioSince(t0), t0);
  verifyRoll(tag, r, ev, moved, { count: expectCount, forced });
  const slotsAfter = await slotsInfo();
  report.rolls.push({ tag, seat: me, vehicle, idle: idleSet, slots, slotsAfter, event: ev, moved, ...r.summary });
  return me;
}

/** 电脑的回合：从行动者换成电脑起追踪，截掷骰前（事件播完、电脑在想）与各阶段 */
async function aiTurn(tag, me, aiSeat) {
  const tStart = Date.now();
  // 等行动者换成电脑（本人的其余决策按默认应答）
  while (Date.now() - tStart < 120_000) {
    const st = await state();
    if (st.cursor === aiSeat) break;
    if (st.idle && st.decision && st.submitting === null && st.decision.kind !== 'TURN_MENU') await act();
    await page.waitForTimeout(60);
  }
  const t0 = await now();
  const afterId = await eventCount();
  const ai = (await state()).players.find((p) => p.seat === aiSeat);
  log(`[${tag}] 电脑回合开始 vehicle=${ai?.vehicle} diceCount=${ai?.diceCount}`);
  // 事件播完、电脑还没掷：截一张
  const idleOk = await page
    .waitForFunction(
      (s) => {
        const h = window.__rich4;
        const p = h.renderer?.board?.actor(s)?.poseKey ?? '';
        return h.eventPlayer.idle && h.store.game.getState().view?.clock?.cursor?.seat === s && /\.stand$/.test(p);
      },
      aiSeat,
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false);
  if (idleOk) {
    await page.waitForTimeout(150);
    await shot(`${tag}-1-before-roll`);
  }
  const thrown = await page
    .waitForFunction((s) => /\.dice$/.test(window.__rich4.renderer?.board?.actor(s)?.poseKey ?? ''), aiSeat, { timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (!thrown) {
    check(tag, '电脑本回合掷骰', false, 'no throw within 20s（可能停留 / 住院 / 乌龟）');
    return;
  }
  const tThrow = await now();
  await page.waitForTimeout(PACING === 'original' ? 180 : 90);
  await shot(`${tag}-2-throw`);
  await page.waitForFunction(() => document.querySelector('[data-testid="dice-overlay"]')?.getAttribute('data-rolling') === 'true', null, { timeout: 10_000 });
  await page.waitForTimeout(Math.round(FLIC * 0.45));
  await shot(`${tag}-3-flic`);
  await page.waitForFunction(() => document.querySelector('[data-testid="dice-overlay"]')?.getAttribute('data-rolling') === 'false', null, { timeout: 10_000 });
  await page.waitForTimeout(80);
  await shot(`${tag}-4-faces`);
  await page.waitForFunction((s) => window.__rich4.renderer?.board?.actor(s)?.isWalking === true, aiSeat, { timeout: 10_000 }).catch(() => {});
  const { ev, moved } = await diceEvent(aiSeat, afterId);
  await page.waitForTimeout(300);
  const tr = await traceSince(t0);
  // 掷骰前：行动者已是电脑、事件播完之后到持骰动作之前，电脑的姿态不变。追踪只记变化，行动者换成电脑的那一条
  // 可能早于 t0（轮询的延迟），所以往前多取 3 秒，再按 cur 过滤
  const trPre = await traceSince(t0 - 3000);
  const pre = trPre.filter((s) => s.cur === aiSeat && s.idle && s.t < tThrow && !/\.dice#/.test(s.a[aiSeat] ?? ''));
  const preSet = [...new Set(pre.map((s) => s.a[aiSeat]))];
  const firstIdle = pre[0]?.t ?? null;
  const r = analyse(tag, aiSeat, tr, await audioSince(t0), t0);
  // 同一姿态库只有一个帧（掷骰前用了交通工具道具时姿态库会换一次：char.c.stand → char.c.car.stand）
  const byKey = new Map();
  for (const p of preSet) {
    const k = String(p).replace(/#.*$/, '');
    byKey.set(k, (byKey.get(k) ?? 0) + 1);
  }
  const still = preSet.length >= 1 && [...byKey.values()].every((n) => n === 1) && preSet.every((p) => /\.stand#\d+$/.test(p ?? ''));
  check(tag, '电脑掷骰前静止站姿（事件播完到持骰动作之间姿态帧不变）', still, {
    poses: preSet,
    idleWindowMs: firstIdle === null || r.throwAt === null ? null : r.throwAt - firstIdle,
  });
  // 电脑可能在本回合掷骰前用了交通工具道具：按掷完之后的交通工具与事件里的骰子数核对
  const aiAfter = (await state()).players.find((p) => p.seat === aiSeat);
  const expectCount = ev?.dice.length ?? 0;
  const vehMax = { walk: 1, moto: 2, car: 3, engineer: 1 }[aiAfter?.vehicle] ?? 1;
  check(
    tag,
    `电脑颗数 = 骰子数（${ai?.vehicle}→${aiAfter?.vehicle}，diceCount ${ev?.diceCount}，上限 ${vehMax}）`,
    ev !== null && expectCount === ev.diceCount && ev.diceCount <= vehMax,
    { count: expectCount },
  );
  verifyRoll(tag, r, ev, moved, { count: expectCount });
  report.rolls.push({ tag, seat: aiSeat, vehicle: aiAfter?.vehicle, idle: preSet, event: ev, moved, ...r.summary });
}

// ── 建房：一个真人 + 一个电脑，台湾图 ──
await page.goto(`${BASE}/?test=1`);
await page.getByTestId('home-nickname').fill('驗證甲');
await page.getByTestId('home-nickname').blur();
await page.getByTestId('home-create').click();
await page.getByTestId('set-map').selectOption('taiwan');
await page.getByTestId('set-timer').selectOption('off');
await page.getByTestId('set-ai-count').selectOption('1');
if (PACING !== 'original') await page.getByTestId('set-pacing').selectOption(PACING);
await page.getByTestId('create-submit').click();
await page.waitForURL(/\/r\/\d{6}/);
log(`room ${/\/r\/(\d{6})/.exec(page.url())[1]}`);
await page.getByTestId('char-2').click();
if ((await page.getByTestId('screen-room').getAttribute('data-screen')) !== 'select') await page.getByTestId('char-select').click();
await page.waitForTimeout(400);
await page.getByTestId('room-start').click();
await page.getByTestId('screen-game').waitFor({ timeout: 60_000 });
await page.waitForFunction(() => window.__rich4?.store?.game?.getState().view !== null && window.__rich4.eventPlayer.idle, null, { timeout: 60_000 });
const skin = await page.evaluate(() => window.__rich4.skin);
log(`skin ${JSON.stringify(skin)}`);
report.skin = skin;
await installTracer();
await debug({ op: 'clearBoard' });
const st0 = await state();
const me = st0.seat;
const aiSeat = st0.players.find((p) => p.seat !== me).seat;
log(`me=${me} ai=${aiSeat} players=${JSON.stringify(st0.players)}`);
// 给电脑一辆汽车（原版 AI 步行时每回合 1/4 概率用，exe 跳表 v311:0x4753a0）：碰上了就多验一种颗数
await debug({ op: 'give', seat: aiSeat, cards: [], items: [{ item: 6, qty: 1 }] });

await selfRoll('self-walk', [3], 1);
await aiTurn('ai-1', me, aiSeat);

// 机车（2 颗）
await myTurn();
await debug({ op: 'give', seat: me, cards: [], items: [{ item: 5, qty: 1 }] });
await myTurn();
await act({ type: 'USE_ITEM', item: 5, target: { t: 'none' } });
await page.waitForTimeout(2500);
await selfRoll('self-moto', [3, 4], 2);
await aiTurn('ai-2', me, aiSeat);

// 汽车（3 颗）
await myTurn();
await debug({ op: 'give', seat: me, cards: [], items: [{ item: 6, qty: 1 }] });
await myTurn();
await act({ type: 'USE_ITEM', item: 6, target: { t: 'none' } });
await page.waitForTimeout(2500);
await selfRoll('self-car', [2, 5, 6], 3);
await aiTurn('ai-3', me, aiSeat);

report.errors = errors;
report.audioAll = await page.evaluate(() => window.__audioAll);
const fails = report.checks.filter((c) => !c.ok);
report.pass = fails.length === 0 && errors.length === 0;
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
writeFileSync(
  `${OUT}/audio.json`,
  JSON.stringify(
    report.audioAll.filter((e) => e.kind === 'sfx'),
    null,
    1,
  ),
);
writeFileSync(`${OUT}/trace.json`, JSON.stringify(await page.evaluate(() => window.__trace), null, 0));
writeFileSync(`${OUT}/log.txt`, LOG.join('\n'));
log(`done → ${OUT}/report.json checks ${report.checks.length} fails ${fails.length} errors ${JSON.stringify(errors)}`);
await browser.close();
process.exit(report.pass ? 0 : 1);
