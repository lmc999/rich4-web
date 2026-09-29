// 调研：原版掷骰 FLIC（Panel#4/5/6）与定格点数（Panel#3）的帧、锚点与落点。只读 original/，产物放 .cache/dice/（不入库）。
// 依据 exe v2.06 掷骰函数 fcn.00418d0b：FLIC 画在 (x0,y0)，点数面 Panel#3 帧 = 6·i + 点数 − 1，画在 (x0+0x55, y0+0x91)，
// 精灵落点 = 画点 − (f.x, f.y)（fcn.00454c9e）。
// 用法：node test/dice-probe.mjs
import fs from 'node:fs';
import { blit, canvas, contactSheet, decodeFlc, decodeFrame, label, openMkf, parseSheet, rect, savePng, upscale } from './ui-lib.mjs';

const ROOT = '.';
const OUT = `${ROOT}/.cache/dice`;
fs.mkdirSync(OUT, { recursive: true });
const m = openMkf(`${ROOT}/original/Game/Panel.mkf`);

// ── Panel#3：点数面 18 帧
const facesRaw = m.read(3);
const sheet = parseSheet(facesRaw);
const faces = sheet.frames.map((_, i) => decodeFrame(sheet, facesRaw, i));
console.log('Panel#3', sheet.kind, 'frames', sheet.frames.length);
for (let i = 0; i < faces.length; i++) {
  const f = sheet.frames[i];
  const die = Math.floor(i / 6);
  console.log(
    `  帧 ${String(i).padStart(2)}：第 ${die} 颗 点数 ${(i % 6) + 1}  ${f.w}×${f.h}  f.x=${f.x} f.y=${f.y}` +
      `  → 相对 FLIC 左上 (${0x55 - f.x}, ${0x91 - f.y})–(${0x55 - f.x + f.w}, ${0x91 - f.y + f.h})`,
  );
}
const faceImgs = faces.map((im, i) => Object.assign(upscale(im, 2), { label: `f${i}` }));
savePng(`${OUT}/panel3-faces.png`, contactSheet(faceImgs, { maxW: 900 }));

// ── Panel#4/5/6：滚骰 FLIC
const flics = {};
for (const id of [4, 5, 6]) {
  const raw = m.read(id);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const hdr = { frames: dv.getUint16(6, true), w: dv.getUint16(8, true), h: dv.getUint16(10, true), speed: dv.getUint32(16, true) };
  const fr = decodeFlc(raw, { transparentIndex: 0 });
  const frames = fr.frames ?? fr;
  flics[id] = frames;
  console.log(`Panel#${id} FLC ${hdr.w}×${hdr.h} 帧数 ${hdr.frames} speed ${hdr.speed}ms 解出 ${frames.length}`);
  // 每帧不透明像素的包围盒与最低点（判断骰子何时触地 / 弹起）
  const rows = [];
  for (let k = 0; k < frames.length; k++) {
    const { w, h, rgba } = frames[k];
    let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (rgba[(y * w + x) * 4 + 3]) {
          n++;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
    rows.push(`    帧 ${String(k + 1).padStart(2)}：像素 ${String(n).padStart(5)}  bbox x ${x0}..${x1}  y ${y0}..${y1}`);
  }
  console.log(rows.join('\n'));
  // 36 帧样张（棋盘色底，便于看透明）
  const imgs = frames.map((f, k) => {
    const c = canvas(f.w, f.h, [70, 110, 70, 255]);
    blit(c, f, 0, 0);
    c.label = `${id}#${k + 1}`;
    return c;
  });
  savePng(`${OUT}/panel${id}-frames.png`, contactSheet(imgs, { maxW: 1800 }));
}

// ── 合成：最后一帧 + 定格点数（点数 1..6 轮换）叠在 FLIC 框里，核对落点
const comp = [];
for (const [n, id] of [[1, 4], [2, 5], [3, 6]]) {
  const frames = flics[id];
  const last = frames[frames.length - 1];
  const c = canvas(last.w * 2 + 12, last.h, [70, 110, 70, 255]);
  blit(c, last, 0, 0);
  for (let i = 0; i < n; i++) {
    const fi = 6 * i + ((i + 3) % 6);
    const f = sheet.frames[fi];
    blit(c, faces[fi], last.w + 12 + 0x55 - f.x, 0x91 - f.y);
  }
  rect(c, last.w + 12, 0, last.w, last.h, [255, 255, 0, 255]);
  c.label = `n${n}`;
  comp.push(c);
}
savePng(`${OUT}/dice-last-vs-faces.png`, contactSheet(comp, { maxW: 1400 }));

// ── 最后一帧与点数面逐像素差异的简单度量：在点数面区域内 FLIC 最后一帧是否也有骰子
for (const [n, id] of [[1, 4], [2, 5], [3, 6]]) {
  const last = flics[id][flics[id].length - 1];
  const parts = [];
  for (let i = 0; i < n; i++) {
    const f = sheet.frames[6 * i];
    const ox = 0x55 - f.x;
    const oy = 0x91 - f.y;
    let cover = 0;
    let tot = 0;
    for (let y = 0; y < f.h; y++)
      for (let x = 0; x < f.w; x++) {
        const X = ox + x;
        const Y = oy + y;
        if (X < 0 || Y < 0 || X >= last.w || Y >= last.h) continue;
        if (faces[6 * i].rgba[(y * f.w + x) * 4 + 3]) {
          tot++;
          if (last.rgba[(Y * last.w + X) * 4 + 3]) cover++;
        }
      }
    parts.push(`第 ${i} 颗：点数面像素 ${tot}，FLIC 末帧同位置有像素 ${cover}（${((100 * cover) / Math.max(1, tot)).toFixed(1)}%）`);
  }
  console.log(`n=${n}（Panel#${id}）末帧覆盖：${parts.join('；')}`);
}
console.log('输出目录', OUT);
