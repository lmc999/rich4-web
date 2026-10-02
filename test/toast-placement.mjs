// toast 落点实测（原版皮肤；验证阶段目视）：连本机真实素材包实例（缺省 http://localhost:5931），按几种视口各开一局台湾图
// （1 名电脑、不限时），棋盘建好后在页面里注入 toast 与原版弹窗（出卡 / 新闻 / 神明），截整页并记下 toast 列表、
// 棋盘视窗、亮卡消息框的矩形，算出重叠。输出 .cache/toast/<标签>/。
// 用法：node test/toast-placement.mjs [站点] [标签]
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.argv[2] ?? 'http://localhost:5931';
const TAG = process.argv[3] ?? 'now';
const OUT = `.cache/toast/${TAG}`;
mkdirSync(OUT, { recursive: true });

const SIZES = [
  { name: 'phone-844x390', viewport: { width: 844, height: 390 }, mobile: true },
  { name: 'phone-667x375', viewport: { width: 667, height: 375 }, mobile: true },
  { name: 'phone-932x430', viewport: { width: 932, height: 430 }, mobile: true },
  { name: 'laptop-1366x768', viewport: { width: 1366, height: 768 }, mobile: false },
  { name: 'desk-1920x1080', viewport: { width: 1920, height: 1080 }, mobile: false },
];
const TOASTS = ['忍太郎 付給 糖糖 過路費 800 元', '忍太郎 與 孫小美 的同盟破裂', '忍太郎：夢遊 5 回合'];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const report = {};

async function rects(page) {
  return page.evaluate(() => {
    const r = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)];
    };
    const q = (s) => document.querySelector(s);
    const all = (s) => [...document.querySelectorAll(s)].map(r);
    return {
      toasts: r(q('[data-testid="toasts"]')),
      toastItems: all('[data-testid="toast"]'),
      toastPlace: q('[data-testid="toasts"]')?.getAttribute('data-place') ?? null,
      board: r(q('[data-testid="classic-board-slot"]')),
      stage: q('[data-testid="classic-stage"]')?.getAttribute('data-stage') ?? null,
      scale: q('[data-testid="classic-stage"]')?.getAttribute('data-scale') ?? null,
      rails: q('[data-testid="classic-stage"]')?.getAttribute('data-rails') ?? null,
      castBox: r(q('[data-testid="card-cast-frame"]')),
      castText: r(q('[data-testid="card-cast-box"]')),
      popup: r(q('[data-testid="popup"]')),
    };
  });
}

function overlap(a, b) {
  if (!a || !b) return 0;
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

async function inject(page, spec) {
  await page.evaluate(async (s) => {
    const { usePopupStore } = await import('/src/ui/popups/popupStore.ts');
    usePopupStore.getState().clear();
    if (s) usePopupStore.getState().open(s, 60_000, 60_000, 1);
  }, spec);
  await page.waitForTimeout(500);
}

async function toasts(page) {
  await page.evaluate(async (list) => {
    const { useUiStore } = await import('/src/store/uiStore.ts');
    for (const t of list) useUiStore.getState().toast(t, 'info', 60_000);
  }, TOASTS);
  await page.waitForTimeout(300);
}

for (const size of SIZES) {
  const ctx = await browser.newContext({
    viewport: size.viewport,
    deviceScaleFactor: size.mobile ? 2 : 1,
    isMobile: size.mobile,
    hasTouch: size.mobile,
  });
  await ctx.addInitScript(() => localStorage.setItem('rich4.introSeen', '1'));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/?test=1`);
  await page.getByTestId('home-nickname').fill('測試甲');
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
  await page.getByTestId('classic-stage').waitFor({ timeout: 90_000 });
  await page.waitForFunction(() => window.__rich4?.store?.game?.getState().view != null, undefined, { timeout: 60_000 });
  // 等 Loading / 飞行动画过去
  await page.waitForTimeout(6000);
  const seat = await page.evaluate(() => window.__rich4.store.room.getState().room?.you?.seat ?? 0);
  const player = { seat, character: 2, name: '忍太郎' };
  const rec = {};
  const cases = [
    ['plain', null],
    [
      'cardCast',
      {
        kind: 'cardCast',
        player,
        card: 26,
        cardName: '查稅卡',
        desc: '',
        title: '注入',
        targetText: '孫小美',
        variant: 'cast',
      },
    ],
    [
      'news',
      {
        kind: 'news',
        id: 1,
        category: 0,
        categoryLabel: '新聞',
        headline: '注入新聞標題',
        body: '注入新聞內文第一行，注入新聞內文第二行。',
        affected: [],
      },
    ],
    [
      'god',
      {
        kind: 'god',
        god: 1,
        godName: '財神',
        player,
        title: '財神降臨',
        line: '注入台詞',
        good: true,
        slot: null,
        amountText: null,
      },
    ],
  ];
  for (const [name, spec] of cases) {
    await inject(page, spec);
    await page.evaluate(async () => {
      const { useUiStore } = await import('/src/store/uiStore.ts');
      for (const t of useUiStore.getState().toasts) useUiStore.getState().dismissToast(t.id);
    });
    await toasts(page);
    const r = await rects(page);
    r.overlapCastBox = overlap(r.toasts, r.castBox);
    r.overlapBoard = overlap(r.toasts, r.board);
    rec[name] = r;
    await page.screenshot({ path: `${OUT}/${size.name}-${name}.png` });
  }
  // 5 条长 toast：空位放不下时截掉最旧的（列表可见区里最后一条完整）
  await inject(page, null);
  await page.evaluate(async () => {
    const { useUiStore } = await import('/src/store/uiStore.ts');
    for (let i = 1; i <= 5; i++)
      useUiStore.getState().toast(`第 ${i} 條：忍太郎 付給 糖糖 過路費 800 元，另外還有一段比較長的說明文字`, 'info', 60_000);
  });
  await page.waitForTimeout(400);
  rec.many = await rects(page);
  rec.many.texts = await page.evaluate(() => [...document.querySelectorAll('[data-testid="toast"]')].map((e) => e.textContent));
  await page.screenshot({ path: `${OUT}/${size.name}-many.png` });
  rec.errors = errors;
  report[size.name] = rec;
  console.log(size.name, JSON.stringify(rec.plain), 'cast', JSON.stringify(rec.cardCast.toasts), rec.cardCast.overlapCastBox);
  await ctx.close();
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
await browser.close();
