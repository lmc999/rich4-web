// 调研（随机事件卡片插图，只读）：把一组截图裁出同一块区域、横向 / 网格拼成一张，方便逐帧目视核对。
// 用法：node test/evcard-montage.mjs <输出.png> <列数> <x,y,w,h | full> <缩放> <图1.png> <图2.png> ...
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const [out, colsS, rectS, scaleS, ...files] = process.argv.slice(2);
const cols = Number(colsS);
const k = Number(scaleS);
const imgs = files.map((f) => PNG.sync.read(readFileSync(f)));
const rect =
  rectS === 'full' ? { x: 0, y: 0, w: imgs[0].width, h: imgs[0].height } : (() => {
    const [x, y, w, h] = rectS.split(',').map(Number);
    return { x, y, w, h };
  })();
const cw = Math.floor(rect.w * k);
const ch = Math.floor(rect.h * k);
const G = 4;
const rows = Math.ceil(imgs.length / cols);
const o = new PNG({ width: cols * (cw + G) + G, height: rows * (ch + G) + G });
for (let i = 0; i < o.data.length; i += 4) o.data.set([40, 40, 40, 255], i);
imgs.forEach((img, n) => {
  const ox = G + (n % cols) * (cw + G);
  const oy = G + Math.floor(n / cols) * (ch + G);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const sx = rect.x + Math.floor(x / k);
      const sy = rect.y + Math.floor(y / k);
      if (sx >= img.width || sy >= img.height) continue;
      const si = (sy * img.width + sx) * 4;
      const di = ((oy + y) * o.width + ox + x) * 4;
      o.data.set(img.data.subarray(si, si + 4), di);
      o.data[di + 3] = 255;
    }
});
writeFileSync(out, PNG.sync.write(o));
console.log(out, o.width, o.height);
