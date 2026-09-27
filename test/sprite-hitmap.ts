// 临时调试脚本：把 Panel.mkf 的 8 位区域图（每像素一个区域号）渲染为伪彩色 PNG
import { join } from 'node:path';
import { Mkf, writePng, contactSheet, loadFrames } from './sprite-proto.ts';
const OUT = './.cache/assets-research/samples';
const p = Mkf.open('./original/Game/Panel.mkf');
const cells = [];
for (const [r, w, h] of [[19, 640, 480], [81, 640, 480], [22, 128, 192], [8, 72, 67]] as const) {
  const d = p.read(r);
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = d[i]!;
    px.set(v === 0 ? [0, 0, 0, 255] : [(v * 97) & 255, (v * 57 + 80) & 255, (v * 151 + 40) & 255, 255], i * 4);
  }
  const img = { w, h, px };
  writePng(join(OUT, 'Panel', `${r}_hitmap.png`), img);
  cells.push({ img, label: `P${r} MAP` });
}
for (const [r, f] of [[18, 0], [80, 0], [21, 0]] as const) cells.push({ img: loadFrames('Panel.mkf', r, String(f))[0]!.img, label: `P${r}:${f}` });
writePng(join(OUT, 'contact', 'panel-hitmaps.png'), contactSheet(cells, { maxCell: 320, cols: 4, title: 'PANEL 8BIT REGION MAPS' }));
