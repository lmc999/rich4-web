// 审查（原版忠实度，只读）：独立核对卡片插画——
// 1) 从原版 Data.mkf 取 #530–#559 原始字节，自己做 RGB555→RGB888，逐像素对比素材包 rich4-assets 的 card.<k> PNG（含 alpha）；
// 2) 从 rich4.exe v2.06 的卡表 0x47d54a+8k 读卡名指针（Big5），与客户端 zh-TW cards.json、引擎 CARD_KEYS 顺序对照；
// 3) 生成带「exe 卡名 / 客户端卡名 / Data 号」标签的拼图 HTML（6×5），交给 Playwright 截图目视。
// 用法：npx tsx test/card-review-fid-art.ts
// 只读原版文件；输出只放 .cache/card/review-fid/（已 gitignore）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { CARD_KEYS } from '../packages/shared/src/data/tables/ids';
import { MkfArchive } from '../tools/extract/src/mkf/container';

const OUT = '.cache/card/review-fid';
mkdirSync(`${OUT}/raw`, { recursive: true });

// ── exe 卡表：PE 节表自己解析，VA → 文件偏移
const exe = readFileSync('original/Game/rich4.exe');
const peOff = exe.readUInt32LE(0x3c);
const nSec = exe.readUInt16LE(peOff + 6);
const optSize = exe.readUInt16LE(peOff + 20);
const imageBase = exe.readUInt32LE(peOff + 24 + 28);
const secs: { va: number; vs: number; raw: number; rs: number }[] = [];
for (let i = 0; i < nSec; i++) {
  const s = peOff + 24 + optSize + i * 40;
  secs.push({ vs: exe.readUInt32LE(s + 8), va: exe.readUInt32LE(s + 12), rs: exe.readUInt32LE(s + 16), raw: exe.readUInt32LE(s + 20) });
}
const fileOf = (va: number): number => {
  const rva = va - imageBase;
  for (const s of secs) if (rva >= s.va && rva < s.va + Math.max(s.vs, s.rs)) return rva - s.va + s.raw;
  throw new Error(`VA 0x${va.toString(16)} 不在任何节里`);
};
const big5 = new TextDecoder('big5');
const cstr = (va: number): string => {
  const o = fileOf(va);
  let e = o;
  while (exe[e] !== 0) e++;
  return big5.decode(exe.subarray(o, e));
};

const cardsTw = JSON.parse(readFileSync('apps/client/src/i18n/locales/zh-TW/cards.json', 'utf8')) as Record<string, { name: string }>;
const manifest = JSON.parse(readFileSync('rich4-assets/manifest.json', 'utf8')) as {
  packId: string;
  entries: Record<string, { file: string; w: number; h: number; transparency: string; confidence: string; src: string[] }>;
  files: Record<string, { path: string }>;
};
const data = MkfArchive.open(readFileSync('original/Game/Data.mkf'), 'Data');
const exp5 = (x: number): number => (x << 3) | (x >> 2);

interface Row {
  k: number;
  res: number;
  exeName: string;
  ourName: string;
  key: string;
  nameMatch: boolean;
  rawBytes: number;
  pngW: number;
  pngH: number;
  alphaNot255: number;
  rgbDiff: number;
  zeroPixels: number;
  file: string;
}
const rows: Row[] = [];
for (let k = 1; k <= 30; k++) {
  const res = 529 + k;
  const ent = fileOf(0x47d54a + 8 * k);
  const exeName = cstr(exe.readUInt32LE(ent));
  const key = CARD_KEYS[k as keyof typeof CARD_KEYS];
  const ourName = cardsTw[key]!.name;
  const raw = data.read(res);
  const e = manifest.entries[`card.${k}`]!;
  const path = manifest.files[e.file]!.path;
  const png = PNG.sync.read(readFileSync(`rich4-assets/${path}`));
  let alphaNot255 = 0;
  let rgbDiff = 0;
  let zeroPixels = 0;
  const n = 165 * 256;
  const mine = new PNG({ width: 165, height: 256 });
  for (let p = 0; p < n; p++) {
    const v = raw[2 * p]! | (raw[2 * p + 1]! << 8);
    if (v === 0) zeroPixels++;
    const r = exp5((v >> 10) & 31);
    const g = exp5((v >> 5) & 31);
    const b = exp5(v & 31);
    mine.data[p * 4] = r;
    mine.data[p * 4 + 1] = g;
    mine.data[p * 4 + 2] = b;
    mine.data[p * 4 + 3] = 255;
    if (png.data[p * 4 + 3] !== 255) alphaNot255++;
    if (png.data[p * 4] !== r || png.data[p * 4 + 1] !== g || png.data[p * 4 + 2] !== b) rgbDiff++;
  }
  writeFileSync(`${OUT}/raw/data${res}.png`, PNG.sync.write(mine));
  rows.push({
    k,
    res,
    exeName,
    ourName,
    key,
    nameMatch: exeName === ourName,
    rawBytes: raw.length,
    pngW: png.width,
    pngH: png.height,
    alphaNot255,
    rgbDiff,
    zeroPixels,
    file: path,
  });
}
writeFileSync(`${OUT}/art-check.json`, JSON.stringify({ packId: manifest.packId, rows }, null, 1));
for (const r of rows) {
  console.log(
    `k=${r.k} Data#${r.res} exe=${r.exeName} ours=${r.ourName} match=${r.nameMatch} raw=${r.rawBytes} png=${r.pngW}x${r.pngH} alpha<255=${r.alphaNot255} rgbDiff=${r.rgbDiff} zero=${r.zeroPixels}`,
  );
}
const bad = rows.filter((r) => !r.nameMatch || r.alphaNot255 || r.rgbDiff || r.pngW !== 165 || r.pngH !== 256);
console.log(`packId=${manifest.packId} 不符 ${bad.length} 张`);

// 拼图：左 = 我解出的原版字节，右 = 素材包 PNG；背景洋红（透明会露出洋红）
const cells = rows
  .map(
    (r) =>
      `<figure><div class="pair"><img src="raw/data${r.res}.png"><img src="../../../rich4-assets/${r.file}"></div>` +
      `<figcaption>k=${r.k} Data#${r.res}<br>exe:${r.exeName} / 客户端:${r.ourName}</figcaption></figure>`,
  )
  .join('');
writeFileSync(
  `${OUT}/art-sheet.html`,
  `<!doctype html><meta charset="utf-8"><style>body{margin:6px;background:#f0f;font:12px sans-serif;display:grid;grid-template-columns:repeat(6,auto);gap:6px}figure{margin:0;background:#fff;padding:3px}.pair{display:flex;gap:2px}img{display:block;width:165px;height:256px}figcaption{text-align:center}</style>${cells}`,
);
