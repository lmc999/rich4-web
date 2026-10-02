// 调试脚本（原版另外 3 张图接入的审查修复）：对着本机服务（客户端 5818 → 服务端 3818，RICH4_DATA_DIR=rich4-data、
// RICH4_ASSETS_DIR=rich4-assets、免门禁）用本机 Chrome 核对开局设置 / 选人大厅的关卡行：
// - 桌面 1280×800：竖栏在舞台 (445,10)、关卡行点击区 (457,31+32k)、勾 (595,30+32k)；点关卡行播的界面音是 sfx.001（click），
//   地图下拉播 sfx.002（move）；另存一张把关卡行点击区描边的截图，看点击区与竖栏图里的行色带是否对齐；
// - 手机横屏 812×375：开局设置与房主的选人大厅里关卡行只读（不是按钮），用面板里的地图下拉换图。
// 截图与记录写到 .cache/maps/fix/setup/。
// 用法：node test/maps-fix-setup.mjs [--base http://localhost:5818]
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const BASE = arg('--base', 'http://localhost:5818');
const OUT = '.cache/maps/fix/setup';
mkdirSync(OUT, { recursive: true });

const report = [];
let failed = false;
const log = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  report.push(line);
  console.log(line);
};
const expectEq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed = true;
  log(`${ok ? '✅' : '❌'} ${label}：${JSON.stringify(got)}${ok ? '' : `（期望 ${JSON.stringify(want)}）`}`);
};

const tid = (page, id) => page.locator(`[data-testid="${id}"]`);

async function newPage(browser, viewport, extra = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, ...extra });
  await context.addInitScript(() => {
    localStorage.setItem('rich4.introSeen', '1');
    if (!localStorage.getItem('rich4.settings')) {
      localStorage.setItem(
        'rich4.settings',
        JSON.stringify({ state: { nickname: '修复巡检', skin: 'original' }, version: 2 }),
      );
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return { context, page, errors };
}

/** 元素在 640×480 舞台里的坐标 */
async function stageBox(page, id, inner) {
  return page.evaluate(
    ([i, sel]) => {
      const st = document.querySelector('[data-testid="classic-stage-inner"]');
      let el = document.querySelector(`[data-testid="${i}"]`);
      if (el && sel) el = el.querySelector(sel);
      if (!st || !el) return null;
      const s = st.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const k = s.width / 640;
      return {
        x: Math.round((r.left - s.left) / k),
        y: Math.round((r.top - s.top) / k),
        w: Math.round(r.width / k),
        h: Math.round(r.height / k),
        cssH: Math.round(r.height),
      };
    },
    [id, inner ?? null],
  );
}

async function sfxKeys(page) {
  return page.evaluate(() =>
    (window.__rich4?.audio?.log ?? []).filter((e) => e.kind === 'sfx' && e.key).map((e) => e.key),
  );
}
async function clearAudio(page) {
  await page.evaluate(() => window.__rich4?.audio?.clearLog());
}

async function desktop(browser) {
  const { context, page, errors } = await newPage(browser, { width: 1280, height: 800 });
  try {
    await page.goto(`${BASE}/?test=1`);
    await page.waitForFunction(() => document.querySelector('[data-testid="screen-home"]')?.dataset.screen === 'title');
    await tid(page, 'home-create').click();
    await tid(page, 'screen-setup').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="setup-stage-1"]')?.tagName === 'BUTTON');
    const col = await stageBox(page, 'setup-column');
    expectEq('竖栏（舞台）', [col.x, col.y, col.w, col.h], [445, 10, 192, 461]);
    // 界面音 click / move 在素材包里的置信度是 guess：缺省（guessOriginal=false）两者都回退 ZzFX 的 click，听不出区别。
    // 开发服务器下直接取同一个音频模块实例，打开「guess 音效也用原版」（AudioLab 同一开关），才能从日志看出播的是 sfx.001 还是 sfx.002
    await page.evaluate(() => document.body.click());
    await page.waitForFunction(() => !!window.__rich4?.audio, undefined, { timeout: 20_000 });
    const guess = await page.evaluate(async () => {
      const m = await import('/src/app/audioWiring.ts');
      const sys = m.wiredAudio();
      if (!sys) return null;
      sys.director.setOptions({ guessOriginal: true });
      return sys.director.options.guessOriginal;
    });
    log(`   打开 guessOriginal：${guess}`);
    for (const [map, k] of [
      ['china', 1],
      ['japan', 2],
      ['usa', 3],
      ['taiwan', 0],
    ]) {
      await clearAudio(page);
      await tid(page, `setup-stage-${k}`).click();
      await page.waitForFunction(
        (kk) => document.querySelector(`[data-testid="setup-stage-${kk}"]`)?.dataset.selected === 'true',
        k,
      );
      await page.waitForTimeout(700);
      const row = await stageBox(page, `setup-stage-${k}`);
      const check = await stageBox(page, `setup-stage-${k}`, '[data-sprite="title.setup.ui/8"]');
      expectEq(`${map} 关卡行点击区`, [row.x, row.y, row.w, row.h], [457, 31 + 32 * k, 169, 32]);
      expectEq(`${map} 勾`, [check.x, check.y], [595, 30 + 32 * k]);
      expectEq(`${map} 地图下拉`, await tid(page, 'set-map').inputValue(), map);
      log(`   ${map} 背景 ${await tid(page, 'setup-bg').getAttribute('data-image')}`);
      expectEq(`${map} 点关卡行的界面音`, await sfxKeys(page), ['sfx.001']);
      await page.screenshot({ path: `${OUT}/desktop-${map}-setup.png` });
    }
    // 地图下拉：move（sfx.002），与关卡行的 click 区分
    await clearAudio(page);
    await tid(page, 'set-map').selectOption('japan');
    await page.waitForTimeout(500);
    expectEq('地图下拉的界面音', await sfxKeys(page), ['sfx.002']);
    // 点击区描边：看点击区与竖栏图里的行色带是否对齐（只截竖栏一带）
    await page.addStyleTag({
      content: '[data-testid^="setup-stage-"]{outline:1px solid #f0f !important;outline-offset:-1px}',
    });
    const st = await page.locator('[data-testid="classic-stage-inner"]').boundingBox();
    const k = st.width / 640;
    await page.screenshot({
      path: `${OUT}/desktop-setup-hit-overlay.png`,
      clip: { x: st.x + 430 * k, y: st.y, width: 210 * k, height: 240 * k },
    });

    // 建房（日本）→ 选人大厅：房主点关卡行改房间地图，播 sfx.001
    await tid(page, 'set-timer').selectOption('off');
    await tid(page, 'set-ai-count').selectOption('3');
    await tid(page, 'create-submit').click();
    await page.waitForURL(/\/r\/\d{6}/);
    await page.waitForFunction(() => document.querySelector('[data-testid="screen-room"]')?.dataset.screen === 'select');
    await page.waitForFunction(() => document.querySelector('[data-testid="setup-stage-3"]')?.tagName === 'BUTTON');
    await clearAudio(page);
    await tid(page, 'setup-stage-3').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="setup-stage-3"]')?.dataset.selected === 'true');
    await page.waitForTimeout(800);
    expectEq('大厅：点关卡行的界面音', await sfxKeys(page), ['sfx.001']);
    expectEq('大厅：背景', await tid(page, 'setup-bg').getAttribute('data-image'), 'title.setup.bg.usa');
    const lcheck = await stageBox(page, 'setup-stage-3', '[data-sprite="title.setup.ui/8"]');
    expectEq('大厅：勾', [lcheck.x, lcheck.y], [595, 126]);
    await page.screenshot({ path: `${OUT}/desktop-lobby-usa.png` });
    expectEq('桌面控制台错误', errors, []);
  } finally {
    await context.close();
  }
}

async function phone(browser) {
  const { context, page, errors } = await newPage(browser, { width: 812, height: 375 });
  try {
    await page.goto(`${BASE}/?test=1&audio=off`);
    await page.waitForFunction(() => document.querySelector('[data-testid="screen-home"]')?.dataset.screen === 'title');
    await tid(page, 'home-create').click();
    await tid(page, 'screen-setup').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-testid="setup-stage-0"]')?.dataset.available === 'true');
    await page.waitForTimeout(500);
    expectEq('手机：舞台热区模式', await tid(page, 'classic-stage').getAttribute('data-hit'), 'wide');
    const tags = [];
    for (let k = 0; k < 4; k++) tags.push(await tid(page, `setup-stage-${k}`).evaluate((e) => e.tagName));
    expectEq('手机：开局设置关卡行只读', tags, ['DIV', 'DIV', 'DIV', 'DIV']);
    const row = await stageBox(page, 'setup-stage-1');
    log(`   手机：关卡行高 ${row.cssH} CSS 像素（只读，不可点）`);
    await tid(page, 'set-map').selectOption('china');
    await page.waitForFunction(() => document.querySelector('[data-testid="setup-stage-1"]')?.dataset.selected === 'true');
    await page.waitForTimeout(700);
    expectEq('手机：地图下拉换图后背景', await tid(page, 'setup-bg').getAttribute('data-image'), 'title.setup.bg.china');
    await page.screenshot({ path: `${OUT}/phone-china-setup.png` });
    const setMapH = (await tid(page, 'set-map').boundingBox()).height;
    log(`   手机：地图下拉高 ${Math.round(setMapH)} CSS 像素`);

    await tid(page, 'set-timer').selectOption('off');
    await tid(page, 'set-ai-count').selectOption('3');
    await tid(page, 'create-submit').click();
    await page.waitForURL(/\/r\/\d{6}/);
    await page.waitForFunction(() => document.querySelector('[data-testid="screen-room"]')?.dataset.screen === 'select');
    await page.waitForTimeout(1000);
    const ltags = [];
    for (let k = 0; k < 4; k++) ltags.push(await tid(page, `setup-stage-${k}`).evaluate((e) => e.tagName));
    expectEq('手机：房主的选人大厅关卡行只读', ltags, ['DIV', 'DIV', 'DIV', 'DIV']);
    await page.screenshot({ path: `${OUT}/phone-china-lobby.png` });
    // 房主改地图：左抽屉「房间设置」的地图下拉
    await tid(page, 'classic-drawer-left-btn').click();
    const left = tid(page, 'classic-rail-left');
    const sel = left.locator('[data-testid="set-map"]');
    await sel.scrollIntoViewIfNeeded();
    log(`   手机：左抽屉地图下拉高 ${Math.round((await sel.boundingBox()).height)} CSS 像素`);
    await sel.selectOption('japan');
    await page.waitForFunction(() => document.querySelector('[data-testid="setup-stage-2"]')?.dataset.selected === 'true');
    await page.screenshot({ path: `${OUT}/phone-lobby-drawer-japan.png` });
    await tid(page, 'classic-drawer-left-close').click();
    await page.waitForTimeout(700);
    expectEq('手机：抽屉改图后大厅背景', await tid(page, 'setup-bg').getAttribute('data-image'), 'title.setup.bg.japan');
    await page.screenshot({ path: `${OUT}/phone-japan-lobby.png` });
    expectEq('手机控制台错误', errors, []);
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
try {
  await desktop(browser);
  await phone(browser);
} catch (e) {
  failed = true;
  log(`❌ 异常：${e instanceof Error ? e.stack : String(e)}`);
} finally {
  await browser.close();
  writeFileSync(`${OUT}/report.txt`, `${report.join('\n')}\n`);
}
process.exit(failed ? 1 : 0);
