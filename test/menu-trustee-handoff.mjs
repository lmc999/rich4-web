// 调试：系统菜单 →「托管设置」在两种皮肤下的叠放（真实素材包、台湾图）。
// 原版皮肤：原版托管画面（经典舞台里的 Stage4x3）接管时系统菜单应收起，画面可见、可点、焦点在画面里、Esc 关闭；
// 程序化皮肤：托管设置对话框照旧叠在系统菜单之上，Esc 关掉对话框后回到菜单。
// 先起本机服务（本机例外：未设门禁的素材包、只监听回环；端口 3371 / 5371）：
//   PORT=3371 HOST=127.0.0.1 PUBLIC_URL=http://localhost:5371 TRUST_PROXY=0 RICH4_ASSETS_ALLOW_UNGATED=1 \
//   RICH4_ASSETS_DIR=./rich4-assets RICH4_DATA_DIR=./rich4-data RICH4_TEST_MODE=1 DATA_DIR=.cache/cs/handoff/data \
//   npx tsx apps/server/src/main.ts
//   （apps/client）npx vite build --outDir ../../.cache/cs/handoff/dist && RICH4_API_TARGET=http://127.0.0.1:3371 \
//   npx vite preview --outDir ../../.cache/cs/handoff/dist --port 5371 --strictPort
// 用法：node test/menu-trustee-handoff.mjs [宽x高=1920x1080] [--skin=original|procedural]
// 截图与记录写到 .cache/cs/handoff/<皮肤>-<宽x高>/（含原版素材，不入库）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.HANDOFF_BASE ?? 'http://localhost:5371';
const args = process.argv.slice(2);
const size = (args.find((a) => /^\d+x\d+$/.test(a)) ?? '1920x1080').split('x').map(Number);
const SKIN = args.find((a) => a.startsWith('--skin='))?.slice(7) ?? 'original';
const TAG = `${SKIN}-${size[0]}x${size[1]}`;
const OUT = `.cache/cs/handoff/${TAG}`;
mkdirSync(OUT, { recursive: true });
const LOG = [];
const report = { size, skin: SKIN, steps: [], problems: [] };
const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${s}`;
  console.log(line);
  LOG.push(line);
};
const problem = (s) => {
  report.problems.push(s);
  log(`!! ${s}`);
};
const mobile = size[0] < 1000;
const browser = await chromium.launch({ channel: 'chrome', headless: true });

const ctx = await browser.newContext({
  viewport: { width: size[0], height: size[1] },
  deviceScaleFactor: 1,
  ...(mobile ? { hasTouch: true } : {}),
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

let shotN = 0;
async function shot(name, wait = 300) {
  shotN++;
  if (wait) await page.waitForTimeout(wait);
  const file = `${OUT}/${String(shotN).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file });
  log(`shot ${file}`);
  return file;
}

async function openSystemMenu() {
  const btn = page.getByTestId('top-menu').first();
  if (await btn.isVisible().catch(() => false)) await btn.click();
  else {
    await page.getByTestId('tool-more').click();
    await page.getByTestId('top-menu').last().click();
  }
  await page.getByTestId('system-menu').waitFor({ timeout: 5000 });
  await page.waitForTimeout(400);
}

/** 当前叠放：菜单 / 托管对话框各几个、托管对话框是不是原版、焦点在哪、对话框里某个钮中心处最上层是谁 */
async function probe(target) {
  return page.evaluate((tid) => {
    const dlgs = [...document.querySelectorAll('[data-testid="trustee-dialog"]')];
    const dlg = dlgs[0] ?? null;
    const el = tid ? document.querySelector(`[data-testid="trustee-dialog"] [data-testid="${tid}"]`) : dlg;
    let hit = null;
    if (el) {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const top = document.elementFromPoint(x, y);
      hit = {
        at: [Math.round(x), Math.round(y)],
        top: `${top?.tagName ?? 'null'}[${top?.closest('[data-testid]')?.getAttribute('data-testid') ?? ''}]`,
        insideDialog: !!top && !!dlg && dlg.contains(top),
        insideMenu: !!top?.closest('[data-testid="system-menu"]'),
      };
    }
    const active = document.activeElement;
    return {
      menus: document.querySelectorAll('[data-testid="system-menu"]').length,
      dialogs: dlgs.length,
      classic: dlg?.getAttribute('data-classic') ?? null,
      inStage: !!dlg?.closest('[data-testid="classic-stage"]'),
      bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
      focus: `${active?.tagName ?? 'null'}[${active?.closest('[data-testid]')?.getAttribute('data-testid') ?? ''}]`,
      focusInDialog: !!dlg && !!active && dlg.contains(active),
      hit,
    };
  }, target ?? null);
}

try {
  await page.goto(`${BASE}/?test=1`);
  await page.getByTestId('home-nickname').fill('測試甲');
  await page.getByTestId('home-nickname').blur();
  await page.getByTestId('home-create').click();
  await page.getByTestId('set-timer').waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-testid="set-map"] option')].some((o) => o.value === 'taiwan'),
  );
  await page.getByTestId('set-map').selectOption('taiwan');
  await page.getByTestId('set-ai-count').selectOption('3');
  await page.getByTestId('create-submit').click();
  await page.waitForURL(/\/r\/\d{6}/);
  await page.getByTestId('screen-room').waitFor();
  await page.getByTestId('char-2').click();
  await page.waitForTimeout(300);
  const txt = await page.getByTestId('char-select').textContent();
  if (!/^已(选择|選擇)$/.test(txt ?? '')) await page.getByTestId('char-select').click();
  await page.waitForTimeout(400);
  await page.getByTestId('room-start').click();
  await page.getByTestId('screen-game').waitFor({ timeout: 60_000 });
  await page.waitForFunction((k) => window.__rich4?.skin?.boardInUse === k, SKIN, { timeout: 60_000 });
  // 等演出空闲、原版宿主预取完精灵
  await page.waitForFunction(() => window.__rich4?.eventPlayer?.idle === true, null, { timeout: 60_000 });
  await page.waitForTimeout(2500);

  await openSystemMenu();
  await shot('menu');
  await page.getByTestId('menu-trustee').click();
  await page.getByTestId('trustee-dialog').first().waitFor({ timeout: 8000 });
  await page.waitForTimeout(500);
  const a = await probe('trustee-personality-2');
  report.steps.push({ step: 'after-menu-trustee', ...a, file: await shot('trustee', 0) });
  log(`after menu-trustee ${JSON.stringify(a)}`);

  if (SKIN === 'original') {
    if (a.classic !== 'true' || !a.inStage) problem(`原版：没有接管成原版托管画面 ${JSON.stringify(a)}`);
    if (a.menus !== 0) problem('原版：系统菜单没有收起');
    if (a.dialogs !== 1) problem(`原版：托管对话框 ${a.dialogs} 个`);
    if (!a.focusInDialog) problem(`原版：焦点不在原版托管画面里（${a.focus}）`);
    if (!a.hit?.insideDialog) problem(`原版：原版托管画面上的钮被盖住（${a.hit?.top}）`);
    if (a.bodyPointerEvents === 'none') problem('原版：body 仍是 pointer-events: none');
    // 真的用鼠标点一下没选中的「个性」选项，再按 Esc 关闭
    let id = 'trustee-personality-0';
    for (const n of [0, 1, 2]) {
      const v = await page.locator(`[data-testid="trustee-dialog"] [data-testid="trustee-personality-${n}"]`).getAttribute('aria-pressed');
      if (v !== 'true') {
        id = `trustee-personality-${n}`;
        break;
      }
    }
    const pick = page.locator(`[data-testid="trustee-dialog"] [data-testid="${id}"]`);
    const before = await pick.getAttribute('aria-pressed');
    await pick.click({ timeout: 3000 });
    const after = await pick.getAttribute('aria-pressed');
    log(`${id} aria-pressed ${before} → ${after}`);
    if (after !== 'true') problem('原版：点个性选项没反应');
    await shot('trustee-picked', 200);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const b = await probe();
    report.steps.push({ step: 'after-escape', ...b });
    log(`after Esc ${JSON.stringify(b)}`);
    if (b.dialogs !== 0) problem('原版：Esc 没关掉原版托管画面');
    if (b.menus !== 0) problem('原版：Esc 之后系统菜单又出现了');
    await shot('closed', 0);
  } else {
    if (a.classic === 'true') problem('程序化：不该出现原版托管画面');
    if (a.menus !== 1) problem('程序化：系统菜单应该还开着（对话框叠在上面）');
    if (!a.hit?.insideDialog) problem(`程序化：托管对话框被盖住（${a.hit?.top}）`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const b = await probe();
    report.steps.push({ step: 'after-escape', ...b, file: await shot('back-to-menu', 0) });
    log(`after Esc ${JSON.stringify(b)}`);
    if (b.dialogs !== 0) problem('程序化：Esc 没关掉托管对话框');
    if (b.menus !== 1) problem('程序化：关掉托管对话框后系统菜单应仍开着');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }
} catch (e) {
  problem(`异常：${e instanceof Error ? e.message : String(e)}`);
  await page.screenshot({ path: `${OUT}/fail.png` }).catch(() => {});
}

report.errors = errors;
if (errors.length) problem(`控制台错误 ${JSON.stringify(errors.slice(0, 5))}`);
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
writeFileSync(`${OUT}/log.txt`, `${LOG.join('\n')}\n`);
log(report.problems.length ? `问题 ${report.problems.length} 个` : '全部通过');
await browser.close();
process.exit(report.problems.length ? 1 : 0);
