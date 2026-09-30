// 调研（出卡插画，只读）：把一组截图按网格拼成一张（最近邻缩放），方便逐张目视核对。
// 用法：node test/card-montage.mjs <输出.png> <列数> <缩放> <图1.png> <图2.png> ...
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const [out, colsS, scaleS, ...files] = process.argv.slice(2);
const cols = Number(colsS);
const k = Number(scaleS);
const imgs = files.map((f) => PNG.sync.read(readFileSync(f)));
const cw = Math.ceil(Math.max(...imgs.map((i) => i.width)) * k);
const ch = Math.ceil(Math.max(...imgs.map((i) => i.height)) * k);
const G = 4;
const rows = Math.ceil(imgs.length / cols);
const o = new PNG({ width: cols * (cw + G) + G, height: rows * (ch + G) + G });
for (let i = 0; i < o.data.length; i += 4) o.data.set([40, 40, 40, 255], i);
imgs.forEach((img, n) => {
  const ox = G + (n % cols) * (cw + G);
  const oy = G + Math.floor(n / cols) * (ch + G);
  const w = Math.floor(img.width * k);
  const h = Math.floor(img.height * k);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const si = (Math.floor(y / k) * img.width + Math.floor(x / k)) * 4;
      const di = ((oy + y) * o.width + ox + x) * 4;
      o.data.set(img.data.subarray(si, si + 4), di);
      o.data[di + 3] = 255;
    }
});
writeFileSync(out, PNG.sync.write(o));
console.log(out, o.width, o.height);
