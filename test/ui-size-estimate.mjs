// 临时调试：估算 UI 子集转为 PNG（带 alpha）后的体积
import { openMkf, parseSheet, decodeFrame, decodeRaw555, decodeFlc, encodePng } from './ui-lib.mjs';
const G = './original/Game/';
const sets = {
  'Panel 全部 SPR/SMP': ['Panel', null],
  'Data UI（0–3,399,476–479,560）': ['Data', [0, 1, 2, 3, 399, 476, 477, 478, 479]],
  'Data 卡片 530–559': ['Data', 'card'],
  'Data 新闻命运 400–475': ['Data', 'news'],
  'Data 节日 4–86': ['Data', 'holiday'],
  'jump 0–4,41': ['jump', [0, 1, 2, 3, 4, 41]],
  'map 8–26': ['map', [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26]],
};
let grand = 0;
for (const [name, [nm, sel]] of Object.entries(sets)) {
  const m = openMkf(G + nm + '.mkf');
  let bytes = 0, n = 0, px = 0;
  const idx = sel === null ? m.entries.map(e => e.index) : sel === 'card' ? Array.from({ length: 30 }, (_, i) => 530 + i) : sel === 'news' ? Array.from({ length: 76 }, (_, i) => 400 + i) : sel === 'holiday' ? Array.from({ length: 83 }, (_, i) => 4 + i) : sel;
  for (const i of idx) {
    const d = m.read(i);
    const sh = parseSheet(d);
    let imgs = [];
    if (sh) imgs = sh.frames.map((_, k) => decodeFrame(sh, d, k));
    else if (sel === 'card') imgs = [decodeRaw555(d, 165, 256)];
    else if (sel === 'news') imgs = [decodeRaw555(d, 388, 251)];
    else if (sel === 'holiday') imgs = [decodeRaw555(d, 200, 200)];
    else if (d.length === 614400) imgs = [decodeRaw555(d, 640, 480)];
    for (const im of imgs) { bytes += encodePng(im.w, im.h, im.rgba).length; n++; px += im.w * im.h; }
  }
  grand += bytes;
  console.log(name.padEnd(28), 'frames', String(n).padStart(4), 'Mpx', (px / 1e6).toFixed(2), 'PNG', (bytes / 1048576).toFixed(1), 'MiB');
}
console.log('合计 PNG', (grand / 1048576).toFixed(1), 'MiB');
