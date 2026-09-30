// 调试脚本（其余 3 张原版地图的素材调研）：从原版 map/Data/jump/Panel.mkf 解出按地图区分的资源到 .cache/maps/assets/，
// 并生成带资源号的拼图 HTML（contact.html），用于目视核对。只读原版文件；输出只放 .cache/（已 gitignore）。
// 用法：npx tsx test/maps-orig-assets-dump.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gndToRgba, parseGnd } from '../tools/extract/src/gfx/gnd';
import { encodePngRgba } from '../tools/extract/src/gfx/png';
import { decodeRaw16 } from '../tools/extract/src/gfx/raw16';
import { decodeSmpFrame, parseSmp } from '../tools/extract/src/gfx/smp';
import { decodeSprFrame, parseSpr } from '../tools/extract/src/gfx/spr';
import { MkfArchive } from '../tools/extract/src/mkf/container';

const OUT = '.cache/maps/assets';
mkdirSync(OUT, { recursive: true });
const open = (f: string, n: string) => MkfArchive.open(readFileSync(`original/Game/${f}`), n);
const map = open('map.mkf', 'map');
const data = open('Data.mkf', 'Data');
const jump = open('jump.mkf', 'jump');
const panel = open('Panel.mkf', 'Panel');

const cells: string[] = [];
const png = (name: string, w: number, h: number, rgba: Uint8Array, cap: string) => {
  writeFileSync(`${OUT}/${name}.png`, encodePngRgba(w, h, rgba));
  cells.push(`<figure><img src="${name}.png"><figcaption>${cap} ${w}×${h}</figcaption></figure>`);
};

/** 最近邻缩小（GND 2304² → 576²） */
function shrink(w: number, h: number, rgba: Uint8Array, k: number) {
  const W = Math.floor(w / k);
  const H = Math.floor(h / k);
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) out.set(rgba.subarray(((y * k) * w + x * k) * 4, ((y * k) * w + x * k) * 4 + 4), (y * W + x) * 4);
  return { w: W, h: H, rgba: out };
}

const section = (t: string) => cells.push(`<h2>${t}</h2>`);

// 1) 地面 GND：map#2gm
section('GND map#2gm（缩小 1/4）');
for (const gm of [0, 1, 2, 3]) {
  const g = gndToRgba(parseGnd(map.read(2 * gm), `map#${2 * gm}`));
  const s = shrink(g.w, g.h, g.rgba, 4);
  png(`gnd-map${2 * gm}`, s.w, s.h, s.rgba, `map#${2 * gm} gm${gm}`);
}

// 2) 小地图 map#8+gm（2 帧）
section('小地图 map#8+gm');
for (const gm of [0, 1, 2, 3]) {
  const sh = parseSmp(map.read(8 + gm), `map#${8 + gm}`);
  for (let i = 0; i < sh.count; i++) {
    const f = decodeSmpFrame(sh, i, { opaque: true });
    png(`minimap-map${8 + gm}-f${i}`, f.w, f.h, f.rgba, `map#${8 + gm} f${i}`);
  }
}

// 3) 住宅 map#27+5gm+(L−1)，帧 0
section('住宅 map#27+5gm+(L−1) 帧0');
for (let res = 27; res <= 46; res++) {
  const sh = parseSpr(map.read(res), `map#${res}`);
  const f = decodeSprFrame(sh, 0, { ownerMask: true });
  png(`house-map${res}`, f.w, f.h, f.rgba, `map#${res} gm${Math.floor((res - 27) / 5)} L${((res - 27) % 5) + 1} n=${sh.count}`);
}

// 4) 企业/景观 map#69..149 帧 0
section('企业/景观 map#69..149 帧0');
for (let res = 69; res <= 149; res++) {
  const sh = parseSpr(map.read(res), `map#${res}`);
  const f = decodeSprFrame(sh, 0, { ownerMask: true });
  png(`landmark-map${res}`, f.w, f.h, f.rgba, `map#${res} n=${sh.count} own=${sh.count ? f.ownerPixels : 0}`);
}

// 5) 节日插画 Data#4..86
section('节日插画 Data#4..86（exe 基址表 0x473098 = 4/28/47/67）');
for (let res = 4; res <= 86; res++) {
  const img = decodeRaw16(data.read(res), { transparency: 'opaque' }, `Data#${res}`);
  png(`holiday-data${res}`, img.w, img.h, img.rgba, `Data#${res}`);
}

// 6) 开局设置背景 jump#0..3 与部件 jump#4（16 帧）
section('开局设置 jump#0..3 背景、jump#4 部件');
for (let res = 0; res <= 3; res++) {
  const img = decodeRaw16(jump.read(res), { transparency: 'opaque' }, `jump#${res}`);
  png(`setup-bg-jump${res}`, img.w, img.h, img.rgba, `jump#${res}`);
}
{
  const sh = parseSmp(jump.read(4), 'jump#4');
  const anchors: string[] = [];
  for (let i = 0; i < sh.count; i++) {
    const f = decodeSmpFrame(sh, i);
    anchors.push(`f${i} ${f.w}x${f.h} a=(${f.ax},${f.ay})`);
    png(`setup-ui-jump4-f${i}`, f.w, f.h, f.rgba, `jump#4 f${i} a=(${f.ax},${f.ay})`);
  }
  writeFileSync(`${OUT}/jump4-frames.txt`, `${anchors.join('\n')}\n`);
}

// 7) LOAD/SAVE Data#479（含 4 张地图缩图 72×72）
section('LOAD/SAVE Data#479');
{
  const sh = parseSmp(data.read(479), 'Data#479');
  for (let i = 0; i < sh.count; i++) {
    const f = decodeSmpFrame(sh, i, { opaque: i < 2 });
    png(`saveload-data479-f${i}`, f.w, f.h, f.rgba, `Data#479 f${i} a=(${f.ax},${f.ay})`);
  }
}

// 8) 命运插图 Data#436..475（exe 表 0x473dd8）
section('命运插图 Data#436..475');
for (let res = 436; res <= 475; res++) {
  const img = decodeRaw16(data.read(res), { transparency: 'opaque' }, `Data#${res}`);
  png(`fate-data${res}`, img.w, img.h, img.rgba, `Data#${res}`);
}

// 9) 拍卖 Panel#26 帧 29..48（按地图的住宅缩图 29+5gm+L）与股市 Panel#75 行业图 3..11
section('拍卖 Panel#26 帧 25..52');
{
  const sh = parseSmp(panel.read(26), 'Panel#26');
  for (let i = 25; i <= Math.min(52, sh.count - 1); i++) {
    const f = decodeSmpFrame(sh, i);
    png(`auction-panel26-f${i}`, f.w, f.h, f.rgba, `Panel#26 f${i}`);
  }
}
section('股市 Panel#75 帧 3..11');
{
  const sh = parseSmp(panel.read(75), 'Panel#75');
  for (let i = 3; i < sh.count; i++) {
    const f = decodeSmpFrame(sh, i);
    png(`stock-panel75-f${i}`, f.w, f.h, f.rgba, `Panel#75 f${i}`);
  }
}

writeFileSync(
  `${OUT}/contact.html`,
  `<!doctype html><meta charset="utf-8"><style>body{margin:8px;background:#f0f;font:12px sans-serif}
figure{display:inline-block;margin:3px;background:#333;color:#fff;padding:3px;vertical-align:top}
img{display:block;max-width:600px;image-rendering:pixelated}h2{margin:10px 0 2px}</style>${cells.join('')}`,
);
console.log(`写出 ${cells.length} 项 → ${OUT}/contact.html`);
