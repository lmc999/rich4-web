// 调试脚本（事件卡片取证，只读）：按 v2.06 exe 的命运插图表 0x473dd8 与命运处理函数表 0x473d14，
// 把 49 个表项（k 0–32 + 33–36 × 4 张图）对应的插图、语音编号与 exe 文案拼成带编号的对照页，
// 并按 exe 版式（fcn.0044c4a0 / 各处理函数参数 0 分支）重建几块命运板，截图到 .cache/evcard/orig/。
// 用法：node test/evcard-fate-montage.mjs
// 读：original/Game/rich4.exe、rich4-assets/（本机素材包）；写：.cache/evcard/orig/（gitignore）。不进仓库任何原版内容。
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const OUT = '.cache/evcard/orig';
mkdirSync(OUT, { recursive: true });
const exe = readFileSync('original/Game/rich4.exe');
const manifest = JSON.parse(readFileSync('rich4-assets/manifest.json', 'utf8'));

// ── PE：VA → 文件偏移 ──
const pe = exe.readUInt32LE(0x3c);
const nsec = exe.readUInt16LE(pe + 6);
const optSize = exe.readUInt16LE(pe + 20);
const base = exe.readUInt32LE(pe + 24 + 28);
const secs = [];
for (let i = 0; i < nsec; i++) {
  const o = pe + 24 + optSize + 40 * i;
  secs.push({ va: exe.readUInt32LE(o + 12) + base, size: Math.max(exe.readUInt32LE(o + 8), exe.readUInt32LE(o + 16)), raw: exe.readUInt32LE(o + 20) });
}
const off = (va) => {
  const s = secs.find((s) => va >= s.va && va < s.va + s.size);
  if (!s) throw new Error(`VA ${va.toString(16)}`);
  return s.raw + (va - s.va);
};
const big5 = new TextDecoder('big5');
const cstr = (va) => {
  const o = off(va);
  let e = o;
  while (exe[e] !== 0) e++;
  return big5.decode(exe.subarray(o, e));
};
const u16s = (va, n) => Array.from({ length: n }, (_, i) => exe.readUInt16LE(off(va) + 2 * i));

// 0x473dd8 u16[49]：命运插图资源号；0x473d14 ptr[49]：命运处理函数
const ART = u16s(0x473dd8, 49);
// 各表项参数 0 分支压栈的文案 VA（r2 逐个处理函数读出，见 .cache/evcard/orig/fate_handlers.txt）
const TEXT_VA = [
  0x463979, 0x46398f, 0x4639a5, 0x4639bd, 0x4639de, 0x463a08, 0x463a3c, 0x463a52, 0x463a68, 0x463a8c, 0x463aa2,
  0x463ab4, 0x463aca, 0x463ae0, 0x463af8, 0x463b12, 0x463b31, 0x463b47, 0x463b64, 0x463b7a, 0x463b99, 0x463bad,
  0x463bc1, 0x463bd5, 0x463beb, 0x463c01, 0x463c17, 0x463c2b, 0x463c3d, 0x463c4f, 0x463c61, 0x463c73, 0x463c87,
  0x463c9d, 0x463cb7, 0x463ccd, 0x463ce3, 0x463cfb, 0x463d15, 0x463d2f, 0x463d49, 0x463d5f, 0x463d7b, 0x463d91,
  0x463da7, 0x463dbd, 0x463dd7, 0x463ded, 0x463e07,
];
// 各表项画在 (390,344) 的表情帧（k20、k27 经 0x44bc6b 跳到 0x44bd80，用图1）（map#15+角色 的图号；+0x18 = 图1、+0x24 = 图2、+0x30 = 图3、+0x3c = 图4）
const FACE = [
  2, 2, 3, 3, 1, 4, 2, 3, 3, 2, 3, 3, 3, 3, 2, 2, 2, 3, 3, 2, 1, 4, 4, 2, 3, 4, 3, 1, 4, 4, 2, 4, 2, 3, 3, 3, 3, 3, 3,
  3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
];
const GM = ['台湾', '大陆', '日本', '美国'];
const label = (i) => (i < 33 ? `k${i}` : `k${33 + ((i - 33) % 4)}@gm${Math.trunc((i - 33) / 4)}（${GM[Math.trunc((i - 33) / 4)]}）`);

const fileUrl = (rel) => `file://${resolve('rich4-assets', rel)}`;
// manifest.entries[].file 是逻辑路径，实际文件名带内容哈希（manifest.files[逻辑路径].path）
const artUrl = (res) => fileUrl(manifest.files[manifest.entries[`illustration.fate.${res - 436}`].file].path);
const atlas = (dir, n) => {
  const json = readdirSync(`rich4-assets/sprites/${dir}`).find((f) => f.startsWith(`${n}.`) && f.endsWith('.json'));
  const j = JSON.parse(readFileSync(`rich4-assets/sprites/${dir}/${json}`, 'utf8'));
  return { j, url: fileUrl(`sprites/${dir}/${j.meta.image}`) };
};
const board = atlas('panel', 66);
const spriteCss = (a, key, x, y) => {
  const f = a.j.frames[key].frame;
  const [ax, ay] = a.j.meta.r4.anchorsPx[key];
  return `position:absolute;left:${x - ax}px;top:${y - ay}px;width:${f.w}px;height:${f.h}px;background:url('${a.url}') -${f.x}px -${f.y}px`;
};
const voiceOf = (s) => (s.match(/#(\d{4})/) ?? [])[1] ?? '';
const shown = (s) => s.replace(/^.*?#\d{4}/, '').replace(/%d/g, '1000');

// ── 1) 49 表项对照 ──
const cells = ART.map((res, i) => {
  const t = cstr(TEXT_VA[i]);
  return `<figure><img src="${artUrl(res)}"><figcaption><b>#${i} ${label(i)}</b> → Data#${res}（illustration.fate.${res - 436}）<br>语音 ${voiceOf(t)}｜表情图 ${FACE[i]}<br>${shown(t).replace(/\n/g, '⏎')}</figcaption></figure>`;
});
const css = `body{margin:0;background:#222;color:#eee;font:13px/1.35 "PingFang TC",sans-serif}
.grid{display:grid;grid-template-columns:repeat(7,200px);gap:6px;padding:8px}
figure{margin:0;background:#333;padding:4px}figure img{width:192px;height:124px;display:block;image-rendering:pixelated}
figcaption{margin-top:3px}h2{margin:8px}`;
writeFileSync(
  `${OUT}/fate-table.html`,
  `<!doctype html><meta charset="utf-8"><style>${css}</style><h2>v2.06 命运插图表 0x473dd8 × 处理函数表 0x473d14（49 项）</h2><div class="grid">${cells.join('')}</div>`,
);

// ── 2) 40 张插图按资源号（每张写被哪些表项引用） ──
const users = new Map();
ART.forEach((r, i) => users.set(r, [...(users.get(r) ?? []), label(i)]));
const cells2 = [];
for (let r = 436; r <= 475; r++) {
  cells2.push(`<figure><img src="${artUrl(r)}"><figcaption><b>Data#${r}</b> illustration.fate.${r - 436}<br>${(users.get(r) ?? ['（未引用）']).join('、')}</figcaption></figure>`);
}
writeFileSync(
  `${OUT}/fate-art.html`,
  `<!doctype html><meta charset="utf-8"><style>${css}</style><h2>命运插图 Data#436–475（40 张）与引用它的表项</h2><div class="grid">${cells2.join('')}</div>`,
);

// ── 3) 按 exe 版式重建命运板：Panel#66 图1 贴 (0,0)；插图 (25,44)；文字 (24,330) 左上对齐 28px 粗体 #F0F0F0、
//      #101010 (1,1) 阴影、字距 −1；表情图（map#15+角色 图 f，锚点对齐）画在 (390,344)。外面画出 640×480 舞台的 440 宽视窗。
const recon = (i, character) => {
  const sp = atlas('map', 15 + character);
  const t = shown(cstr(TEXT_VA[i]));
  return `<div class="stage"><div style="${spriteCss(board, 'Panel#66/1', 0, 0)}"></div>
<img src="${artUrl(ART[i])}" style="position:absolute;left:25px;top:44px;width:388px;height:251px">
<div style="position:absolute;left:24px;top:330px;white-space:pre;font:700 28px/30px 'MingLiU','PMingLiU','LiSong Pro','Songti TC',serif;letter-spacing:-1px;color:#f0f0f0;text-shadow:1px 1px 0 #101010">${t}</div>
<div style="${spriteCss(sp, `map#${15 + character}/${FACE[i]}`, 390, 344)}"></div>
<div class="cap">#${i} ${label(i)}｜角色 ${character}｜表情图 ${FACE[i]}</div></div>`;
};
const boards = [
  [0, 9],
  [2, 9],
  [4, 0],
  [5, 3],
  [20, 9],
  [33, 6],
  [39, 9],
  [45, 1],
].map(([i, c]) => recon(i, c));
writeFileSync(
  `${OUT}/fate-board-recon.html`,
  `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#111;color:#eee;font:13px sans-serif}
.wrap{display:flex;flex-wrap:wrap;gap:10px;padding:10px}.stage{position:relative;width:440px;height:500px;background:#000;overflow:hidden}
.cap{position:absolute;left:0;top:482px;width:440px}</style><div class="wrap">${boards.join('')}</div>`,
);

// 本机 Playwright 浏览器缓存版本可能落后于 npm 包：有 PW_CHROMIUM 时用它（例如 ~/Library/Caches/ms-playwright/chromium_headless_shell-1228/...）
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
for (const name of ['fate-table', 'fate-art', 'fate-board-recon']) {
  await page.goto(`file://${resolve(OUT, `${name}.html`)}`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log(`${OUT}/${name}.png`);
}
await browser.close();
