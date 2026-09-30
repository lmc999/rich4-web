// 整体验证（卡片插画不透明 + 原版亮卡）：把 test/card-verify.mjs 的截图拼成两张图，逐张目视。
// montage.png：每张卡一格，四幅小图——卡片欄悬停时资料栏位置的插画（裁舞台 (440,0) 200×280；桌面 1920×1080 与
// 844×390 各一），亮卡（裁棋盘视窗 (0,40) 440×440；P1 桌面页与 P2 手机页各一，真出卡优先，出不了的是注入同一份 spec）；
// 格下写读回的素材键与来源，四项都等于 card.<k> 时绿框，否则红框。
// montage-extra.png：电脑出卡、被动卡生效（两页并排）与注入的「没有效果」。
// 另有 verify-god.json（card-verify.mjs 的 god 模式：送神符真出卡）时把其中的亮卡并进来。
// 用法：node test/card-verify-montage.mjs [verify.json=.cache/card/verify/verify.json]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const OUT = '.cache/card/verify';
const r = JSON.parse(readFileSync(process.argv[2] ?? `${OUT}/verify.json`, 'utf8'));
if (existsSync(`${OUT}/verify-god.json`)) {
  const god = JSON.parse(readFileSync(`${OUT}/verify-god.json`, 'utf8'));
  r.casts.push(...god.casts.map((c) => ({ ...c, room: god.room })));
}
const NAMES = [
  '',
  '均富',
  '均貧',
  '購地',
  '換地',
  '換屋',
  '轉向',
  '改建',
  '拍賣',
  '天使',
  '惡魔',
  '怪獸',
  '拆除',
  '搶奪',
  '停留',
  '冬眠',
  '夢遊',
  '陷害',
  '復仇',
  '嫁禍',
  '免費',
  '免罪',
  '送神符',
  '請神符',
  '紅卡',
  '黑卡',
  '查稅',
  '漲價',
  '查封',
  '同盟',
  '烏龜',
];

/** 舞台截图 → 裁出舞台里的一块（截图按宽度缩放到 640·scale，与设备像素比无关） */
function crop(file, x, y, w, h, scale) {
  if (!file) return '<div class="none">（无）</div>';
  const url = `file://${resolve(file)}`;
  return `<div class="crop" style="width:${w * scale}px;height:${h * scale}px;background-image:url('${url}');background-size:${640 * scale}px ${480 * scale}px;background-position:-${x * scale}px -${y * scale}px"></div>`;
}

const hoverOf = (k, tag) => r.hover.find((h) => h.card === k && h.tag === tag && !h.missing) ?? null;

/** 某页上这张卡的亮卡：真出卡（出卡或被动卡生效）优先，否则注入 */
function castOf(k, page) {
  const real = r.casts.find((c) => c.card === k && c.page === page && c.probe && c.variant !== 'fizzle');
  if (real) return { file: real.shot, src: `真·${real.actor}${real.variant === 'passive' ? '·被动' : ''}`, key: real.probe.bgKey };
  const inj = r.inject.find((c) => c.card === k && c.page === page && c.variant !== 'fizzle');
  if (inj) return { file: inj.shot, src: '注入', key: inj.probe?.bgKey ?? '?' };
  return { file: null, src: '—', key: '—' };
}

const S = 0.5;
const cells = [];
let okCount = 0;
for (let k = 1; k <= 30; k++) {
  const hd = hoverOf(k, 'desk');
  const hm = hoverOf(k, 'mobile');
  const c1 = castOf(k, 'P1');
  const c2 = castOf(k, 'P2');
  const want = `card.${k}`;
  const ok = [hd?.bgKey, hm?.bgKey, c1.key, c2.key].every((x) => x === want);
  if (ok) okCount++;
  cells.push(`<figure class="${ok ? 'ok' : 'bad'}">
  <div class="pair">${crop(hd?.shot, 440, 0, 200, 280, S)}${crop(hm?.shot, 440, 0, 200, 280, S)}${crop(c1.file, 0, 40, 440, 440, S)}${crop(c2.file, 0, 40, 440, 440, S)}</div>
  <figcaption><b>${k} ${NAMES[k]}</b> · 悬停 ${hd?.viewport ?? '—'} ${hd?.bgKey ?? '—'} / ${hm?.viewport ?? '—'} ${hm?.bgKey ?? '—'} · 亮卡 P1 ${c1.key}（${c1.src}）/ P2 ${c2.key}（${c2.src}）</figcaption>
</figure>`);
}

const extra = [];
const byPopup = new Map();
for (const c of r.casts) {
  if (!c.probe) continue;
  if (c.actor !== 'AI' && c.variant === 'cast') continue;
  const key = `${c.phase}/${c.actor}/${c.card}/${c.variant}/${Math.round(c.seenAt / 4000)}`;
  const g = byPopup.get(key) ?? {};
  g[c.page] = c;
  byPopup.set(key, g);
}
for (const g of byPopup.values()) {
  const a = g.P1 ?? g.P2;
  extra.push(`<figure><div class="pair">${crop(g.P1?.shot, 0, 40, 440, 440, S * 1.2)}${crop(g.P2?.shot, 0, 40, 440, 440, S * 1.2)}</div>
  <figcaption><b>${a.actor === 'AI' ? '电脑出卡' : '被动卡生效'}</b>：${a.actor} 卡 ${a.card}（${NAMES[a.card]}，${a.variant}）· P1 ${g.P1?.probe?.bgKey ?? '—'} · P2 ${g.P2?.probe?.bgKey ?? '—'} · 「${(a.probe?.line ?? '').replace(/\n+/g, ' / ')}」</figcaption></figure>`);
}
for (const inj of r.inject.filter((x) => x.variant === 'fizzle')) {
  extra.push(`<figure><div class="pair">${crop(inj.shot, 0, 40, 440, 440, S * 1.2)}</div>
  <figcaption><b>没有效果（注入）</b>：${inj.page}@${inj.viewport} 卡 ${inj.card} · ${inj.probe?.bgKey} · filter ${inj.probe?.filter}</figcaption></figure>`);
}

const css = `body{margin:0;background:#222;color:#eee;font:13px sans-serif}
h1{font-size:17px;margin:10px 12px}
.grid{display:grid;grid-template-columns:repeat(2,max-content);gap:10px;padding:10px}
figure{margin:0;padding:6px;background:#333;border:2px solid #555}
figure.ok{border-color:#3a7}
figure.bad{border-color:#e44}
.pair{display:flex;gap:6px;align-items:flex-start}
.crop{background-repeat:no-repeat}
.none{width:100px;height:100px;display:grid;place-items:center;background:#111}
figcaption{margin-top:4px;max-width:${(200 * 2 + 440 * 2) * S + 18}px}`;

const page = (title, body) =>
  `<!doctype html><meta charset="utf-8"><style>${css}</style><h1>${title}</h1><div class="grid">${body.join('\n')}</div>`;
writeFileSync(
  `${OUT}/montage.html`,
  page(
    `卡片插画逐张：${okCount}/30 四项读回都是 card.&lt;k&gt;（房间 ${r.room}，素材包 ${r.packId}；每格左→右：悬停 1920×1080、悬停 844×390、亮卡 P1 桌面、亮卡 P2 手机）`,
    cells,
  ),
);
writeFileSync(`${OUT}/montage-extra.html`, page('电脑出卡与被动卡生效（左 P1 桌面页，右 P2 手机页）', extra));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
for (const name of ['montage', 'montage-extra']) {
  await p.goto(`file://${resolve(`${OUT}/${name}.html`)}`);
  await p.waitForLoadState('networkidle');
  await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log(`${OUT}/${name}.png`);
}
console.log(`四项读回一致：${okCount}/30`);
await browser.close();
