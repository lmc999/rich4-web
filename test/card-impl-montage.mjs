// 验证（卡片插画不透明 + 原版亮卡版式）：把 test/card-impl-verify.mjs 的截图拼成一张图，逐张目视。
// 每张卡一格：左 = 卡片欄悬停时资料栏位置的插画（裁 (440,0) 200×280），右 = 亮卡（裁棋盘视窗 (0,40) 440×440；
// 真出卡优先，出不了的是注入同一份 spec 的截图）；格下写卡号、来源与读回的素材键。另拼电脑出卡、被动卡生效各例。
// 用法：node test/card-impl-montage.mjs [verify.json=.cache/card/impl/verify.json]（输出 montage.png / montage-extra.png）
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const OUT = '.cache/card/impl';
const r = JSON.parse(readFileSync(process.argv[2] ?? `${OUT}/verify.json`, 'utf8'));
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

/** 截图 → 裁出舞台里的一块（舞台 640×480 等比缩放后的截图，按宽度换算倍率） */
function crop(file, x, y, w, h, scale) {
  if (!file) return '<div class="none">（无）</div>';
  const url = `file://${resolve(file)}`;
  return `<div class="crop" style="width:${w * scale}px;height:${h * scale}px;background-image:url('${url}');background-size:${640 * scale}px ${480 * scale}px;background-position:-${x * scale}px -${y * scale}px"></div>`;
}

function castOf(k) {
  const recs = r.cast?.[k] ?? [];
  const rec = recs.find((x) => x.card === k && x.shotP1) ?? null;
  if (rec) return { file: rec.shotP1, src: `真出卡（座位 ${rec.seat}，${rec.variant}）`, key: rec.P1?.bgKey ?? '?' };
  const inj = r.inject?.[k];
  if (inj) return { file: inj.shot, src: '注入 spec', key: inj.bgKey ?? '?' };
  return { file: null, src: '—', key: '—' };
}

const S = 0.62;
const cells = [];
for (let k = 1; k <= 30; k++) {
  const h = r.hover?.[k];
  const c = castOf(k);
  const ok = h?.bgKey === `card.${k}` && c.key === `card.${k}`;
  cells.push(`<figure class="${ok ? 'ok' : 'bad'}">
  <div class="pair">${crop(h?.shot, 440, 0, 200, 280, S)}${crop(c.file, 0, 40, 440, 440, S)}</div>
  <figcaption><b>${k} ${NAMES[k]}卡</b> · 悬停 ${h?.bgKey ?? '—'}（${h?.page ?? '—'}）· 亮卡 ${c.key}（${c.src}）</figcaption>
</figure>`);
}

const extra = [];
for (const a of r.ai ?? []) {
  extra.push(`<figure><div class="pair">${crop(a.shotP1, 0, 40, 440, 440, S)}${crop(a.shotP2, 0, 40, 440, 440, S)}</div>
  <figcaption><b>电脑出卡</b>：座位 ${a.seat} 卡 ${a.card}（${NAMES[a.card]}）· P1 ${a.P1?.bgKey} · P2 ${a.P2?.bgKey ?? '—'}</figcaption></figure>`);
}
for (const recs of Object.values(r.cast ?? {})) {
  for (const x of recs) {
    if (x.variant === 'cast') continue;
    extra.push(`<figure><div class="pair">${crop(x.shotP1, 0, 40, 440, 440, S)}${crop(x.shotP2, 0, 40, 440, 440, S)}</div>
  <figcaption><b>被动卡 / 没有效果</b>：座位 ${x.seat} 卡 ${x.card}（${NAMES[x.card]}，${x.variant}）· P1 ${x.P1?.bgKey} · P2 ${x.P2?.bgKey ?? '—'}</figcaption></figure>`);
  }
}

const css = `body{margin:0;background:#222;color:#eee;font:14px sans-serif}
h1{font-size:18px;margin:10px 12px}
.grid{display:grid;grid-template-columns:repeat(3,max-content);gap:10px;padding:10px}
figure{margin:0;padding:6px;background:#333;border:2px solid #555}
figure.ok{border-color:#3a7}
figure.bad{border-color:#e44}
.pair{display:flex;gap:6px;align-items:flex-start}
.crop{background-repeat:no-repeat;image-rendering:pixelated}
.none{width:120px;height:120px;display:grid;place-items:center;background:#111}
figcaption{margin-top:4px;max-width:${(200 + 440) * S + 6}px}`;

const page = (title, body) =>
  `<!doctype html><meta charset="utf-8"><style>${css}</style><h1>${title}</h1><div class="grid">${body.join('\n')}</div>`;
writeFileSync(`${OUT}/montage.html`, page(`卡片插画逐张（房间 ${r.room}，素材包 ${r.skin?.packId ?? '?'}）`, cells));
writeFileSync(`${OUT}/montage-extra.html`, page('电脑出卡与被动卡生效（左 P1 页，右 P2 页）', extra));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
for (const name of ['montage', 'montage-extra']) {
  await p.goto(`file://${resolve(`${OUT}/${name}.html`)}`);
  await p.waitForLoadState('networkidle');
  await p.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log(`${OUT}/${name}.png`);
}
await browser.close();
