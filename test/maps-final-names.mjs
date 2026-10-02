// 调试脚本（地图接入集成阶段）：长名称不溢出（verify-checklist §5.6）。在集成服务（5815 → 3815，真实数据与素材）上：
// 美国买下「拉斯維加斯」设施地并买「喬治亞人壽」股票，日本买「ＳＥＧＡ」、大陆买「王府井百貨」股票，然后打开原版资产表
// （工具列「查询」）的地产页与股票页截图，并量资产表里各行文字是否超出所在格。截图写到 .cache/maps/final/names/。
// 用法：node test/maps-final-names.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.FINAL_BASE ?? 'http://localhost:5815';
const OUT = '.cache/maps/final/names';
mkdirSync(OUT, { recursive: true });
const STAGE = { taiwan: 0, china: 1, japan: 2, usa: 3 };
/** 每张图：要买的设施 / 住宅所在格（按名称找）与要买的股票下标 */
const CASES = [
  { map: 'usa', tileName: '拉斯維加斯', stock: 1 },
  { map: 'japan', tileName: null, stock: 4 },
  { map: 'china', tileName: null, stock: 2 },
];
const report = [];
const log = (s) => {
  report.push(s);
  console.log(s);
};

async function one(browser, c) {
  const def = JSON.parse(readFileSync(`rich4-data/maps/${c.map}.map.json`, 'utf8'));
  const tw = def.strings['zh-TW'];
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    localStorage.setItem('rich4.introSeen', '1');
    localStorage.setItem('rich4.settings', JSON.stringify({ state: { nickname: '長名稱巡檢', skin: 'original' }, version: 2 }));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const tid = (id) => page.locator(`[data-testid="${id}"]`);
  const ev = (fn, a) => page.evaluate(fn, a);
  const menu = (kinds = ['TURN_MENU']) =>
    page.waitForFunction(
      (ks) => {
        const h = window.__rich4;
        const d = h?.store?.game?.getState().decision;
        return !!d && ks.includes(d.kind) && h.eventPlayer.idle;
      },
      kinds,
      { timeout: 120_000 },
    );
  const act = (intent) =>
    ev((it) => {
      const h = window.__rich4;
      return h.client.act(it, h.store.game.getState().decision.decisionId);
    }, intent);
  const dbg = async (op) => {
    const r = await ev((o) => window.__rich4.client.debug(o), op);
    if (!r?.ok) throw new Error(`debug ${op.op}: ${JSON.stringify(r)}`);
    await page.waitForTimeout(500);
  };
  try {
    await page.goto(`${BASE}/?audio=off&test=1&anim=instant`);
    await tid('home-create').click();
    await tid(`setup-stage-${STAGE[c.map]}`).click();
    await tid('set-timer').selectOption('off');
    await tid('set-ai-count').selectOption('3');
    await tid('create-submit').click();
    await page.waitForURL(/\/r\/\d{6}/);
    await tid('char-3').click();
    await page.waitForTimeout(500);
    await tid('room-start').click();
    await tid('screen-game').waitFor();
    await menu();
    // 开局日是元旦（节日休市）：改到平日，再用一次空的 give 让回合菜单按新日期重算
    await dbg({ op: 'setDate', date: 20100106 });
    await dbg({ op: 'setCash', seat: 0, cash: 900000, deposit: 900000 });
    await dbg({ op: 'give', seat: 0, cards: [], items: [] });
    await menu();
    log(`[${c.map}] 股市：${JSON.stringify(await ev(() => {
      const st = window.__rich4.store.game.getState().decision.options.stock;
      return { open: st.open, reason: st.reason };
    }))}`);
    const buy = await act({ type: 'STOCK_BUY', stock: c.stock, shares: 100 });
    log(`[${c.map}] 买股票 ${c.stock}（${tw[`map.${c.map}.stock.${c.stock}`]}）：${JSON.stringify(buy)}`);
    await menu();
    if (c.tileName) {
      const target = def.tiles.find((t) => tw[t.nameKey] === c.tileName && t.ref?.lot);
      const pre = def.tiles.find((t) => {
        const o = t.links.filter((l) => !l.blocked).map((l) => l.to);
        return o.length === 2 && o.includes(target.id);
      });
      const prev = pre.links.map((l) => l.to).find((x) => x !== target.id);
      await dbg({ op: 'teleport', seat: 0, node: pre.id, prev });
      await dbg({ op: 'forceNext', purpose: 'dice', values: [1] });
      await menu();
      await act({ type: 'ROLL' });
      const kind = await menu(['BUY_LAND', 'BUY_FACILITY', 'CHOOSE_FACILITY_TYPE', 'TURN_MENU']).then(() =>
        ev(() => window.__rich4.store.game.getState().decision.kind),
      );
      if (kind === 'CHOOSE_FACILITY_TYPE') {
        const opts = await ev(() => window.__rich4.store.game.getState().decision.options);
        await act({ type: 'CHOOSE_FACILITY_TYPE', facility: opts.types?.[0] ?? opts.facilities?.[0] ?? 'park' });
      } else if (kind !== 'TURN_MENU') await act({ type: 'CONFIRM' });
      await page.waitForTimeout(2000);
      const lot = await ev((l) => window.__rich4.store.game.getState().latest.facilities.find((f) => f.id === l) ?? window.__rich4.store.game.getState().latest.lands.find((f) => f.id === l), target.ref.lot);
      log(`[${c.map}] 踩上 ${target.id}（${c.tileName}，${target.ref.lot}）→ 决策 ${kind}，之后 ${JSON.stringify(lot)}`);
    }
    await page.waitForTimeout(1000);
    await tid('action-info').click();
    const sheet = tid('classic-assets');
    await sheet.waitFor();
    await page.waitForTimeout(600);
    for (const pg of [1, 2]) {
      if ((await tid(`assets-page-${pg}`).count()) > 0) await tid(`assets-page-${pg}`).click();
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${OUT}/${c.map}-assets-page${pg}.png` });
      const overflow = await ev(() => {
        const s = document.querySelector('[data-testid="classic-assets"]');
        const out = [];
        for (const e of s?.querySelectorAll('[data-testid^="assets-estate-"], [data-testid^="assets-stock-"]') ?? []) {
          for (const cell of e.querySelectorAll('*')) {
            if (cell.children.length > 0) continue;
            if (cell.scrollWidth > cell.clientWidth + 1 && cell.clientWidth > 0)
              out.push(`${e.getAttribute('data-testid')}:${cell.textContent} (${cell.scrollWidth}>${cell.clientWidth})`);
          }
        }
        const rows = [...(s?.querySelectorAll('[data-testid^="assets-estate-L"], [data-testid^="assets-estate-F"], [data-testid^="assets-stock-"]') ?? [])]
          .map((e) => e.textContent?.replace(/\s+/g, ' ').trim())
          .slice(0, 6);
        return { overflow: out, rows };
      });
      log(`[${c.map}] 资产表第 ${pg} 页：${JSON.stringify(overflow)}`);
    }
  } catch (e) {
    log(`[${c.map}] 失败：${e.message}`);
    await page.screenshot({ path: `${OUT}/${c.map}-zz-fail.png` }).catch(() => {});
  } finally {
    const errs = errors.filter((e) => !/favicon|WebGL|GPU stall/i.test(e));
    log(`[${c.map}] 控制台错误 ${errs.length} 条${errs.length ? `：${errs.slice(0, 4).join(' | ')}` : ''}`);
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
