// 审查（原版忠实度，只读）：在整页截图（1920×1080，舞台倍率 2.25、舞台左上 (240,0)）里找卡片插画与消息框的实际像素位置，
// 与 exe 画点（卡 (138,200)、框 (123,48)）换算出的位置对比；并把截图里的插画区域缩回 165×256 与素材包 PNG 比较平均色差。
// 用法：node test/card-review-fid-probe.mjs <截图> <卡号>
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const [shot, k] = process.argv.slice(2);
const img = PNG.sync.read(readFileSync(shot));
const man = JSON.parse(readFileSync('rich4-assets/manifest.json', 'utf8'));
const card = PNG.sync.read(readFileSync(`rich4-assets/${man.files[man.entries[`card.${k}`].file].path}`));
const S = 2.25;
const OX = 240;
const OY = 0;
const px = (x, y) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
// 在期望位置附近 ±12 逻辑像素搜索：插画缩放后与截图的平均绝对差最小的偏移
function score(dx, dy) {
  let sum = 0;
  let n = 0;
  for (let y = 4; y < 252; y += 3) {
    for (let x = 4; x < 161; x += 3) {
      const sx = Math.round(OX + (138 + dx + x + 0.5) * S - 0.5);
      const sy = Math.round(OY + (200 + dy + y + 0.5) * S - 0.5);
      const [r, g, b] = px(sx, sy);
      const i = (y * 165 + x) * 4;
      sum += Math.abs(r - card.data[i]) + Math.abs(g - card.data[i + 1]) + Math.abs(b - card.data[i + 2]);
      n++;
    }
  }
  return sum / n / 3;
}
let best = null;
for (let dy = -12; dy <= 12; dy++) for (let dx = -6; dx <= 6; dx++) {
  const s = score(dx, dy);
  if (!best || s < best.s) best = { dx, dy, s };
}
console.log(JSON.stringify({ shot, k, best, atZero: score(0, 0) }));
