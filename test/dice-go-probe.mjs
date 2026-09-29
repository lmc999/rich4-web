// 调研：GO 钮 Panel#7 图0–11 与原版骰子数小图的摆法（exe v2.06 fcn.004169f6）。只读 original/，输出 .cache/dice/。
// 摆法（相对 GO 钮左上 (X,Y)）：
//   步行：图7（停留卡时图6）画在 (7,26)/(8,26)
//   机车：i=0..1，第 i 颗已选（i < 骰子数且非停留）画图 2i+7 于 (7, 16+19i)，否则图 2i+6 于 (8, 16+19i)
//   汽车：i=0..2，同上，y = 9+16i
// 精灵落点 = 画点 − (f.x, f.y)（fcn.00454905 与 fcn.00454c9e 同一约定，待核）。
// 用法：node test/dice-go-probe.mjs
import { blit, canvas, contactSheet, decodeFrame, openMkf, parseSheet, savePng, upscale } from './ui-lib.mjs';

const ROOT = '.';
const OUT = `${ROOT}/.cache/dice`;
const m = openMkf(`${ROOT}/original/Game/Panel.mkf`);
const raw = m.read(7);
const sheet = parseSheet(raw);
const fr = sheet.frames.map((_, i) => decodeFrame(sheet, raw, i));
sheet.frames.forEach((f, i) => console.log(`Panel#7 图${i} ${f.w}×${f.h} f.x=${f.x} f.y=${f.y}`));
savePng(`${OUT}/panel7-frames.png`, contactSheet(fr.map((im, i) => Object.assign(upscale(im, 3), { label: `f${i}` })), { maxW: 1200 }));

function go(vehicle, count, stay) {
  const c = canvas(72, 67, [60, 90, 60, 255]);
  const put = (i, x, y) => {
    const f = sheet.frames[i];
    blit(c, fr[i], x - f.x, y - f.y);
  };
  put(stay ? 2 : 0, 0, 0);
  if (vehicle === 0) put(stay ? 6 : 7, stay ? 8 : 7, 26);
  const n = vehicle === 1 ? 2 : vehicle === 2 ? 3 : 0;
  for (let i = 0; i < n; i++) {
    const y = vehicle === 1 ? 16 + 19 * i : 9 + 16 * i;
    if (i <= count - 1 && !stay) put(2 * i + 7, 7, y);
    else put(2 * i + 6, 8, y);
  }
  return Object.assign(upscale(c, 3), { label: `${['walk', 'moto', 'car'][vehicle]} n${count}${stay ? ' stay' : ''}` });
}
const shots = [go(0, 1, false), go(1, 2, false), go(1, 1, false), go(2, 3, false), go(2, 2, false), go(2, 1, false), go(2, 3, true)];
savePng(`${OUT}/go-dice-slots.png`, contactSheet(shots, { maxW: 1600 }));
console.log('输出', `${OUT}/panel7-frames.png`, `${OUT}/go-dice-slots.png`);
