// 调试脚本（卡片取证）：直接从原版 Data.mkf 解出卡片相关资源到 .cache/card/orig/，并生成带帧号的拼图 HTML。
// 用法：npx tsx test/card-orig-dump.ts
// 只读原版文件；输出只放 .cache/（已 gitignore），不要复制进仓库。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { MkfArchive } from '../tools/extract/src/mkf/container';
import { decodeRaw16 } from '../tools/extract/src/gfx/raw16';
import { encodePngRgba } from '../tools/extract/src/gfx/png';

const OUT = '.cache/card/orig';
mkdirSync(OUT, { recursive: true });
const data = MkfArchive.open(readFileSync('original/Game/Data.mkf'), 'Data');

// 1) 邻近区段的资源类型 / 大小，确认卡片区段边界
const rows: string[] = [];
for (let i = 520; i < data.count; i++) {
  const e = data.entry(i);
  rows.push(
    `#${i} kind=${e.kind} raw=${e.rawSize} stored=${e.storedSize} imgOff=${e.imageOffset} imgSize=${e.imageSize} compressed=${e.compressed}`,
  );
}
writeFileSync(`${OUT}/data-520-560-index.txt`, `${rows.join('\n')}\n`);
console.log(rows.join('\n'));

// 2) 530..559 解成 PNG（不透明原样 + 四角 0 泛洪透明），并统计四角 0 值像素数
const stats: string[] = [];
for (let i = 530; i <= 559; i++) {
  const bytes = data.read(i);
  const opaque = decodeRaw16(bytes, { transparency: 'opaque' }, `Data#${i}`);
  const corner = decodeRaw16(bytes, { transparency: 'corner-zero' }, `Data#${i}`);
  writeFileSync(`${OUT}/data${i}-opaque.png`, encodePngRgba(opaque.w, opaque.h, opaque.rgba));
  writeFileSync(`${OUT}/data${i}-corner.png`, encodePngRgba(corner.w, corner.h, corner.rgba));
  let zeros = 0;
  let cleared = 0;
  for (let p = 0; p < opaque.w * opaque.h; p++) {
    if ((bytes[2 * p]! | (bytes[2 * p + 1]! << 8)) === 0) zeros++;
    if (corner.rgba[p * 4 + 3] === 0) cleared++;
  }
  // 第 0 行、最后一行前 8 像素的原值，看圆角形状
  const row = (y: number) =>
    Array.from({ length: 8 }, (_, x) => (bytes[2 * (y * 165 + x)]! | (bytes[2 * (y * 165 + x) + 1]! << 8)).toString(16));
  stats.push(`Data#${i} card=${i - 529} ${opaque.w}x${opaque.h} zero=${zeros} cornerCleared=${cleared} row0=${row(0)} row3=${row(3)}`);
}
writeFileSync(`${OUT}/data530-559-stats.txt`, `${stats.join('\n')}\n`);
console.log(stats.join('\n'));

// 3) 拼图 HTML（6 列 × 5 行，带 Data 号与卡号），交给 Playwright 截图
const names = [
  '均富', '均貧', '購地', '換地', '換屋', '轉向', '改建', '拍賣', '天使', '惡魔',
  '怪獸', '拆除', '搶奪', '停留', '冬眠', '夢遊', '陷害', '復仇', '嫁禍', '免費',
  '免罪', '送神符', '請神符', '紅卡', '黑卡', '查稅', '漲價', '查封', '同盟', '烏龜',
];
const cells = names
  .map((n, k) => {
    const res = 530 + k;
    return `<figure><img src="data${res}-corner.png"><figcaption>Data#${res} · k=${k + 1} · 我们:${n}</figcaption></figure>`;
  })
  .join('');
writeFileSync(
  `${OUT}/sheet.html`,
  `<!doctype html><meta charset="utf-8"><style>body{margin:8px;background:#f0f;font:12px sans-serif}
main{display:grid;grid-template-columns:repeat(6,175px);gap:6px}figure{margin:0;background:#333;color:#fff;padding:4px;text-align:center}
img{display:block;width:165px;height:256px;image-rendering:pixelated}</style><main>${cells}</main>`,
);
