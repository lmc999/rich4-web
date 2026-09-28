// 调试（头像映射排查）：用本机 Chrome 打开 5301 开发服（真实素材包、未设门禁的本机例外、RICH4_TEST_MODE=1），
// 走「标题 → 建房（台湾、3 电脑、资产 10 倍胜利、紧凑节奏）→ 选人」，按指定方式选角色开局，在出现角色形象的各处截图，
// 并读出服务器认定的 characterId 与页面上各处实际用到的素材帧（data-sprite / data-character / 棋盘 poseKey），
// 写到 .cache/pc/portrait/<tag>/（含原版素材，不入库）。
// 用法：node test/pc-portrait-repro.mjs [角色号=2] [tag] [--mode=click|browse|select] [--full]
//   click（缺省）：单击头像格后直接按 OK（用户的实际操作）；browse：用 ▶ 翻到该角色后直接按 OK（不点「選這個」）；
//   select：单击头像格，「選這個」可点时再点一下，然后 OK。
//   --full：开局后再看电脑座位的资料栏、触发买地 / 买设施场景（讲话头像）、资产达标终局（排名）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.PC_BASE ?? 'http://localhost:5301';
const CHAR = Number(process.argv[2] ?? 2);
const TAG = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : `c${CHAR}`;
const MODE = process.argv.find((a) => a.startsWith('--mode='))?.slice(7) ?? 'click';
const FULL = process.argv.includes('--full');
const OUT = `.cache/pc/portrait/${TAG}`;
mkdirSync(OUT, { recursive: true });
let n = 0;
const report = { character: CHAR, mode: MODE, steps: [] };

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
// 片头只在首次进入时播：事先标记已看过
await ctx.addInitScript(() => localStorage.setItem('rich4.introSeen', '1'));
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`[console.error] ${m.text().slice(0, 300)}`);
});

async function shot(name) {
  n++;
  const f = `${OUT}/${String(n).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: f });
  return f;
}

/** 页面上所有与角色有关的精灵「表/帧」、带 data-character 的元素、服务器认定的角色与棋盘姿态库 */
async function probe(label) {
  const r = await page.evaluate(() => {
    const sprites = [...document.querySelectorAll('[data-sprite]')]
      .map((e) => e.getAttribute('data-sprite'))
      .filter((s) => /portrait|sidewalk|chibi|xicong/.test(s ?? ''));
    const chars = [...document.querySelectorAll('[data-character]')].map((e) => ({
      testid: e.getAttribute('data-testid'),
      character: e.getAttribute('data-character'),
    }));
    const h = window.__rich4;
    const room = h?.store?.room?.getState()?.room ?? null;
    const view = h?.store?.game?.getState()?.view ?? null;
    const poses = (view?.players ?? []).map((p) => ({
      seat: p.seat,
      pose: h?.renderer?.board?.actor(p.seat)?.poseKey ?? null,
    }));
    const chips = [...document.querySelectorAll('[data-testid^="chip-"]')].map((e) => ({
      testid: e.getAttribute('data-testid'),
      face: e.querySelector('[data-sprite^="portrait.face72/"]')?.getAttribute('data-sprite') ?? null,
    }));
    return {
      sprites: [...new Set(sprites)],
      chars,
      chips,
      poses,
      you: room?.you ?? null,
      seats: room?.seats?.map((s) => ({ index: s.index, characterId: s.characterId, kind: s.occupant?.kind ?? null })),
      players: view?.players?.map((p) => ({ seat: p.seat, character: p.character })) ?? null,
    };
  });
  report.steps.push({ label, ...r });
  console.log(label, JSON.stringify({ seats: r.seats?.map((s) => s.characterId), players: r.players }));
  console.log('  sprites', JSON.stringify(r.sprites));
  if (r.chars.length) console.log('  data-character', JSON.stringify(r.chars));
  if (r.chips.length) console.log('  chips', JSON.stringify(r.chips.map((c) => `${c.testid}:${c.face}`)));
  if (r.poses.length) console.log('  poses', JSON.stringify(r.poses));
  return r;
}

const state = () =>
  page.evaluate(() => {
    const h = window.__rich4;
    const g = h?.store?.game?.getState();
    return g
      ? { idle: h.eventPlayer.idle, kind: g.decision?.kind ?? null, sub: g.submitting, over: g.over !== null }
      : null;
  });

async function waitMyTurn(timeout = 240_000) {
  await page.waitForFunction(
    () => {
      const h = window.__rich4;
      const g = h?.store?.game?.getState();
      return !!g && h.eventPlayer.idle && g.decision?.kind === 'TURN_MENU' && g.submitting === null;
    },
    undefined,
    { timeout },
  );
}

async function debug(op) {
  const r = await page.evaluate((o) => window.__rich4.client.debug(o), op);
  if (!r.ok) throw new Error(`debug ${JSON.stringify(op)} 失败 ${JSON.stringify(r)}`);
}

async function actDefault() {
  await page.evaluate(() => {
    const h = window.__rich4;
    const d = h.store.game.getState().decision;
    return d ? h.client.act(d.defaultIntent, d.decisionId) : null;
  });
}

try {
  await page.goto(`${BASE}/?audio=off&test=1`);
  await page.getByTestId('screen-home').waitFor({ timeout: 30_000 });
  await page.getByTestId('home-nickname').fill('測試');
  await page.getByTestId('home-nickname').blur();
  await page.getByTestId('home-create').click();
  await page.getByTestId('set-map').selectOption('taiwan');
  await page.getByTestId('set-timer').selectOption('off');
  await page.getByTestId('set-ai-count').selectOption('3');
  await page.getByTestId('set-win').selectOption('10');
  await page.getByTestId('set-pacing').selectOption('compact');
  await page.getByTestId('create-submit').click();
  await page.waitForURL(/\/r\/\d{6}/);
  await page.getByTestId('classic-select').waitFor();
  await page.waitForTimeout(1500);
  await shot('lobby');
  await probe('lobby');
  if (MODE === 'browse') {
    for (let i = 0; i < CHAR; i++) await page.getByTestId('char-next').click();
  } else {
    await page.getByTestId(`char-${CHAR}`).click();
  }
  await page.waitForTimeout(1200);
  await shot(`lobby-${MODE}`);
  if (MODE === 'select' && (await page.getByTestId('char-select').isEnabled())) {
    await page.getByTestId('char-select').click();
    await page.waitForTimeout(800);
  }
  await probe(`lobby-${MODE}`);
  await page.getByTestId('room-start').click();
  await page
    .getByTestId('classic-loading')
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => shot('loading'))
    .catch(() => console.log('没截到 Loading'));
  await page.getByTestId('screen-game').waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => window.__rich4?.skin?.boardInUse === 'original', undefined, { timeout: 60_000 });
  await page.waitForTimeout(4000);
  await shot('game');
  await probe('game');
  await waitMyTurn();
  await page.waitForTimeout(1500);
  await shot('my-turn');
  await probe('my-turn');

  if (FULL) {
    // 看一个电脑座位的资料栏
    await page.getByTestId('chip-3').click();
    await page.waitForTimeout(600);
    await shot('inspect-seat3');
    await probe('inspect-seat3');
    await page.getByTestId('chip-3').click();

    // 讲话头像：传送到一块空地的前一格，强制掷 1 点，等买地 / 买设施场景
    const route = await page.evaluate(() => {
      const h = window.__rich4;
      const v = h.store.game.getState().view;
      const entries = Object.values(h.store.map.getState().entries);
      const def = entries.find((e) => e.def?.id === 'taiwan')?.def ?? entries.find((e) => e.def)?.def;
      const byId = new Map(def.tiles.map((t) => [t.id, t]));
      const owned = new Set([...v.lands, ...v.facilities].filter((l) => l.owner !== null).map((l) => l.id));
      const occupied = new Set(v.players.map((p) => p.tile ?? p.node));
      for (const t of def.tiles) {
        if (t.kind !== 'property' || !t.ref?.lot || owned.has(t.ref.lot) || occupied.has(t.id)) continue;
        for (const l of t.links) {
          const a = byId.get(l.to);
          if (!a || a.links.length !== 2) continue;
          const back = a.links.find((x) => x.to !== t.id);
          if (back) return { node: a.id, prev: back.to, target: t.id };
        }
      }
      return null;
    });
    console.log('买地路线', JSON.stringify(route));
    if (route) {
      await debug({ op: 'teleport', seat: 0, node: route.node, prev: route.prev });
      await debug({ op: 'forceNext', purpose: 'dice', values: [1] });
      await waitMyTurn();
      await page.getByTestId('action-roll').click();
      await page.waitForFunction(
        () => {
          const h = window.__rich4;
          const g = h.store.game.getState();
          return (
            h.eventPlayer.idle && g.submitting === null && ['BUY_LAND', 'BUY_FACILITY'].includes(g.decision?.kind)
          );
        },
        undefined,
        { timeout: 60_000 },
      );
      await page.waitForTimeout(1500);
      await shot('buy-speaker');
      await probe('buy-speaker');
      await actDefault();
    }

    // 终局：现金调到胜利条件以上，等下一天结算
    for (let i = 0; i < 6; i++) {
      const s = await state();
      if (s?.over) break;
      try {
        await waitMyTurn(240_000);
      } catch {
        const s2 = await state();
        if (s2?.over) break;
        if (s2?.kind && s2.kind !== 'TURN_MENU') {
          await actDefault();
          continue;
        }
        throw new Error('等不到自己的回合');
      }
      await debug({ op: 'setCash', seat: 0, cash: 9_000_000, deposit: null });
      await waitMyTurn();
      await page.getByTestId('action-roll').click();
      // 回答本回合的其他决策
      for (let k = 0; k < 6; k++) {
        await page.waitForTimeout(1500);
        const s3 = await state();
        if (!s3 || s3.over || !s3.kind || s3.kind === 'TURN_MENU') break;
        if (s3.idle && s3.sub === null) await actDefault();
      }
      if (
        await page
          .getByTestId('game-over-screen')
          .waitFor({ timeout: 90_000 })
          .then(() => true)
          .catch(() => false)
      )
        break;
    }
    await page.waitForTimeout(2000);
    await shot('game-over');
    await probe('game-over');
  }
} catch (e) {
  console.log('失败', e);
  await shot('FAIL');
} finally {
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
