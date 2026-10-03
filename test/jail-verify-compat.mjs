// 整体验证（获释位置，ENGINE_VERSION 0.4.0 → 0.5.0 的兼容）：对着本机验证服务（客户端 6121 → 服务端 4121，免门禁、RICH4_TEST_MODE=1）
// - oldsave：从早先会话留下的 0.4.0 服务器数据库里取一份存档（只读），按导出格式 R4S1.<b64url(blob)>.<sig> 导入新版本，
//   新建房间读档（认领一个真人座位，其余交给电脑）、开局、托管；监听 WebSocket 里的 game:batch，记录存档里在押的人
//   获释（RELEASED / RETURNED）的落点和之后第一次移动的第一步，并继续玩到读档后第 N 天；
// - restore：服务器启动时已按 rulesVersion 恢复了 0.4.0 的进行中房间（快照来自早先会话的数据库副本，座位令牌哈希换成本脚本的
//   测试令牌，见 test/jail-verify-restore-db.mjs）；用该令牌回到房间、托管，同样记录在押者获释的落点并继续玩。
// 截图与记录写到 .cache/jail/verify/compat/<label>/（含原版素材，不入库）。
// 用法：node test/jail-verify-compat.mjs oldsave --db <0.4.0 的 rich4.db> --id <saveId> --label <名> [--days 4]
//       node test/jail-verify-compat.mjs restore --code <房间号> --token <测试令牌> --label <名> [--days 4]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const MODE = process.argv[2];
const BASE = arg('--base', 'http://localhost:6121');
const LABEL = arg('--label', MODE);
const DAYS = Number(arg('--days', '4'));
const OUT = `.cache/jail/verify/compat/${LABEL}`;
mkdirSync(OUT, { recursive: true });
const report = { mode: MODE, label: LABEL, lines: [], seats: {} };
const log = (...a) => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  report.lines.push(line);
  console.log(line);
};
const tid = (page, id) => page.locator(`[data-testid="${id}"]`);
const sleep = (page, ms) => page.waitForTimeout(ms);

/** 各图关押格 / 保释格（数据包本机读取，不入库） */
function mapInfo(mapId) {
  const d = JSON.parse(readFileSync(`rich4-data/maps/${mapId}.map.json`, 'utf8'));
  const def = d.def ?? d;
  const hold = (k) => def.landmarks.find((l) => l.kind === k).holdTile;
  const gate = (c) => Math.min(...def.tiles.filter((t) => t.landingCode === c).map((t) => t.id));
  return { jail: { hold: hold('jail'), gate: gate(4) }, hospital: { hold: hold('hospital'), gate: gate(5) } };
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await context.addInitScript(() => {
  localStorage.setItem('rich4.introSeen', '1');
});
if (MODE === 'restore') {
  await context.addInitScript((t) => localStorage.setItem('rich4.token', t), arg('--token', ''));
}
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 300)}`);
  if (m.type() === 'warning' && /handler 出错/.test(m.text())) errors.push(`warn: ${m.text().slice(0, 300)}`);
});

// ── WebSocket：解析 socket.io 的 game:batch，收集事件 ──
const events = [];
page.on('websocket', (ws) => {
  ws.on('framereceived', (f) => {
    const s = typeof f.payload === 'string' ? f.payload : '';
    if (!s.startsWith('42')) return;
    try {
      const [name, msg] = JSON.parse(s.slice(2));
      if (name === 'game:batch' && Array.isArray(msg?.events)) {
        for (const e of msg.events) events.push({ seq: msg.seq, date: msg.view?.clock?.date, ...e });
      }
    } catch {}
  });
});

async function waitAttr(id, name, value, timeout = 30_000) {
  await page.waitForFunction(
    ([i, n, v]) => document.querySelector(`[data-testid="${i}"]`)?.getAttribute(n) === v,
    [id, name, value],
    { timeout },
  );
}
async function waitIdle(timeout = 60_000) {
  await page.waitForFunction(
    () => {
      const h = window.__rich4;
      return !!h?.store?.game && h.store.game.getState().view !== null && h.eventPlayer.idle;
    },
    undefined,
    { timeout },
  );
}
const view = () => page.evaluate(() => window.__rich4?.store?.game?.getState().latest ?? null);
const seatOf = (e) => (e.actor?.t === 'seat' ? e.actor.seat : e.seat);

async function frameShot(name, tile) {
  await page.evaluate(async (t) => {
    const r = window.__rich4.renderer;
    if (!r) return;
    r.camera.onUserGesture?.();
    const c = r.anchorPos({ tile: t });
    if (c) await r.camera.panTo(c, 0);
  }, tile);
  await sleep(page, 700);
  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file });
  log(`shot ${file}`);
  return file;
}

/** 当前 view 里在押（jail / hospital > 0）的座位 */
function confinedSeats(v) {
  return v.players
    .filter((p) => p.st.jail > 0 || p.st.hospital > 0)
    .map((p) => ({ seat: p.seat, where: p.st.jail > 0 ? 'jail' : 'hospital', node: p.node, counter: p.st.jail || p.st.hospital }));
}

/** 托管直到这些座位都已获释并走出第一步、且读档后过了 DAYS 天（或结束） */
async function watch(targets, info, startDay) {
  const shotDone = new Set();
  await page.evaluate(() => window.__rich4.client.autopilot(true));
  const t0 = Date.now();
  let cursor = 0;
  while (Date.now() - t0 < 900_000) {
    await sleep(page, 400);
    for (; cursor < events.length; cursor++) {
      const e = events[cursor];
      const s = seatOf(e);
      const t = report.seats[s];
      if (!t) continue;
      if (e.type === 'RELEASED') t.released = { from: e.from, date: e.date, seq: e.seq };
      else if (e.type === 'RETURNED' && t.released && !t.returned) {
        t.returned = { node: e.node, date: e.date, seq: e.seq, expectHold: info[t.where].hold, gate: info[t.where].gate };
        log(`seat ${s} RETURNED node ${e.node}（${t.where} 关押格 ${info[t.where].hold}，保释 / 出院格 ${info[t.where].gate}）`);
      } else if (e.type === 'MOVE_SEGMENT' && t.returned && !t.firstMove) {
        t.firstMove = { path: e.path, date: e.date, seq: e.seq };
        log(`seat ${s} 获释后第一次移动 path ${JSON.stringify(e.path)}`);
      } else if (e.type === 'CONFINED' && t.returned && !t.firstMove) {
        t.reconfinedBeforeMove = true;
      }
    }
    // 获释后（view 里还在关押格、计数为 0）截一张
    const v = await view();
    if (!v) continue;
    for (const [s, t] of Object.entries(report.seats)) {
      const p = v.players.find((x) => x.seat === Number(s));
      if (t.returned && !t.firstMove && !shotDone.has(s) && p && p.st.jail === 0 && p.st.hospital === 0) {
        shotDone.add(s);
        await page.evaluate(() => window.__rich4.client.autopilot(false));
        await waitIdle(90_000).catch(() => {});
        const v2 = await view();
        const p2 = v2.players.find((x) => x.seat === Number(s));
        const actor = await page.evaluate((seat) => {
          const a = window.__rich4.renderer?.board?.allActors?.().find((x) => x.seat === seat);
          const c = a?.currentStatus?.confined ?? null;
          return a ? { tile: a.tile, visible: a.root.visible, confined: c ? (typeof c === 'string' ? c : c.where) : null } : null;
        }, Number(s));
        t.afterReturn = { node: p2.node, prevNode: p2.prevNode, actor };
        log(`seat ${s} 获释后 view node ${p2.node} prevNode ${p2.prevNode}，棋盘 ${JSON.stringify(actor)}`);
        await frameShot(`seat${s}-released-at-${p2.node}`, p2.node);
        await page.evaluate(() => window.__rich4.client.autopilot(true));
      }
    }
    const done = Object.values(report.seats).every((t) => t.firstMove || t.reconfinedBeforeMove);
    const over = await page.evaluate(() => window.__rich4.store.game.getState().over !== null);
    if (over || (done && v.clock.elapsedDays >= startDay + DAYS)) break;
  }
  await page.evaluate(() => window.__rich4.client.autopilot(false));
  await waitIdle(90_000).catch(() => {});
}

async function newRoomWithSave(saveId) {
  await page.goto(`${BASE}/?audio=off&test=1&anim=instant`);
  await waitAttr('screen-home', 'data-screen', 'title');
  await tid(page, 'home-create').click();
  await tid(page, 'screen-setup').waitFor();
  await tid(page, 'set-timer').selectOption('off');
  await tid(page, 'create-submit').click();
  await page.waitForURL(/\/r\/\d{6}/);
  await waitAttr('screen-room', 'data-screen', 'select');
  await page.evaluate(() => window.__rich4?.client?.updateSettings?.({ aiPace: 'fast' }));
  const loaded = await page.evaluate((id) => window.__rich4.client.loadSave(id), saveId);
  log(`读档 ${saveId}：${JSON.stringify(loaded).slice(0, 200)}`);
  await sleep(page, 1200);
  const room = await page.evaluate(() => window.__rich4.store.room.getState().room);
  for (const s of room?.seats ?? []) {
    if (s.occupant !== null || !s.savedSeat) continue;
    const r2 = await page.evaluate(() => window.__rich4.store.room.getState().room);
    const mine = r2?.you?.role === 'player';
    const res = mine
      ? await page.evaluate((i) => window.__rich4.client.setSeatAi(i, { preset: 'character' }), s.index)
      : await page.evaluate((i) => window.__rich4.client.claimSeat(i), s.index);
    log(`座位 ${s.index}（wasHuman=${s.savedSeat.wasHuman}）${mine ? '交给电脑' : '由本人认领'}：${JSON.stringify(res)}`);
    await sleep(page, 400);
  }
  await sleep(page, 800);
  await tid(page, 'room-start').click();
  const fly = await tid(page, 'fly')
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (fly) {
    await tid(page, 'fly-skip').click().catch(() => {});
    await tid(page, 'fly').waitFor({ state: 'detached' }).catch(() => {});
  }
  await tid(page, 'screen-game').waitFor({ timeout: 30_000 });
  await waitIdle();
}

try {
  if (MODE === 'oldsave') {
    const db = new DatabaseSync(arg('--db'), { readOnly: true });
    const row = db.prepare('select id, engine_version, map_id, game_day, blob, sig from saves where id = ?').get(arg('--id'));
    if (!row) throw new Error('save not found');
    const file = JSON.parse(gunzipSync(Buffer.from(row.blob)).toString());
    log(`源存档 ${row.id}：engine ${row.engine_version}，${row.map_id} 第 ${row.game_day} 天；state.engine ${file.game.engine}`);
    const b64url = (u8) => Buffer.from(u8).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    const text = `R4S1.${b64url(row.blob)}.${row.sig}`;
    writeFileSync(`${OUT}/source.r4save`, text);
    await page.goto(`${BASE}/?audio=off&test=1`);
    await waitAttr('screen-home', 'data-screen', 'title');
    if (!(await page.evaluate(() => localStorage.getItem('rich4.token')))) {
      await page.evaluate(() => {
        const b = crypto.getRandomValues(new Uint8Array(16));
        localStorage.setItem('rich4.token', btoa(String.fromCharCode(...b)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''));
      });
      await page.reload();
      await waitAttr('screen-home', 'data-screen', 'title');
    }
    const imp = await page.evaluate(async (t) => {
      const r = await fetch('/api/saves/import', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'x-player-token': localStorage.getItem('rich4.token') ?? '' },
        body: t,
      });
      return { status: r.status, body: await r.json() };
    }, text);
    log(`导入：${JSON.stringify(imp).slice(0, 300)}`);
    report.import = imp;
    const saveId = imp?.body?.data?.saveId;
    if (!saveId) throw new Error('import failed');
    await newRoomWithSave(saveId);
  } else if (MODE === 'restore') {
    const code = arg('--code');
    await page.goto(`${BASE}/r/${code}?audio=off&test=1&anim=instant`);
    await tid(page, 'screen-game').waitFor({ timeout: 60_000 });
    await waitIdle(90_000);
    const room = await page.evaluate(() => window.__rich4.store.room.getState().room);
    log(`回到房间 ${code}：phase ${room?.phase}，你是座位 ${room?.you?.seat}（${room?.you?.role}）`);
  } else throw new Error('用法：oldsave | restore');

  const v0 = await view();
  const info = mapInfo(v0.dataRef.mapId);
  report.map = v0.dataRef.mapId;
  report.engine = v0.engine;
  report.start = { date: v0.clock.date, elapsed: v0.clock.elapsedDays };
  const conf = confinedSeats(v0);
  log(`开局 view：${v0.dataRef.mapId} 第 ${v0.clock.elapsedDays} 天，state.engine ${v0.engine}；在押 ${JSON.stringify(conf)}；关押格 ${JSON.stringify(info)}`);
  for (const c of conf) report.seats[c.seat] = { ...c };
  for (const c of conf) await frameShot(`seat${c.seat}-confined-at-${c.node}`, c.node);
  await watch(conf, info, v0.clock.elapsedDays);
  const v1 = await view();
  report.end = { date: v1.clock.date, elapsed: v1.clock.elapsedDays, status: v1.status ?? null };
  await frameShot('zz-end', v1.players[0].node);
  const ok = Object.values(report.seats).every(
    (t) => t.reconfinedBeforeMove || (t.returned?.node === t.returned?.expectHold && t.afterReturn?.actor?.tile === t.returned?.expectHold),
  );
  report.ok = ok && Object.keys(report.seats).length > 0;
  log(`结束：第 ${v1.clock.elapsedDays} 天（读档 / 恢复时第 ${v0.clock.elapsedDays} 天）；获释都在关押格 ${report.ok}`);
} catch (e) {
  log(`FAILED ${e?.stack ?? e}`);
  report.failed = String(e);
  await page.screenshot({ path: `${OUT}/fail.png` }).catch(() => {});
} finally {
  report.errors = errors;
  log(`控制台错误 ${errors.length} 条${errors.length ? `：${errors.slice(0, 5).join(' | ')}` : ''}`);
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
