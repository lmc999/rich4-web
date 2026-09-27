// 调试（venues/b）：在魔法屋底图（Panel#18 图0）上找 12 个效果图标（图23–34）的画点（锚点落点），只打印坐标
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const pack = 'rich4-assets';
const m = JSON.parse(readFileSync(`${pack}/manifest.json`, 'utf8'));
const res = process.argv[2] ?? 'panel/18';
const atlasPath = m.files[`sprites/${res}.json`].path;
const atlas = JSON.parse(readFileSync(`${pack}/${atlasPath}`, 'utf8'));
const img = PNG.sync.read(readFileSync(`${pack}/${atlasPath.slice(0, atlasPath.lastIndexOf('/') + 1)}${atlas.meta.image}`));
const fr = (i) => atlas.frames[Object.keys(atlas.frames).find((n) => n.endsWith(`/${i}`))];
const B = fr(Number(process.argv[3] ?? 0)).frame;
const px = (x, y) => { const i = (y * img.width + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]]; };
const est = JSON.parse(process.argv[4]);
for (const [idx, ex, ey] of est) {
  const F = fr(idx); const f = F.frame; const ax = Math.round(F.anchor.x * f.w), ay = Math.round(F.anchor.y * f.h);
  let best = null;
  for (let cy = ey - 30; cy <= ey + 30; cy++) for (let cx = ex - 30; cx <= ex + 30; cx++) {
    const ox = cx - ax, oy = cy - ay; let s = 0, n = 0;
    // 形状相关：比较亮度梯度（底图是暗版）
    for (let y = 1; y < f.h - 1; y += 1) for (let x = 1; x < f.w - 1; x += 1) {
      const p = px(f.x + x, f.y + y); if (p[3] < 128) continue;
      const bx = B.x + ox + x, by = B.y + oy + y; if (ox + x < 1 || oy + y < 1 || ox + x >= B.w - 1 || oy + y >= B.h - 1) continue;
      const L = (q) => q[0] + q[1] + q[2];
      const gp = L(px(f.x + x + 1, f.y + y)) - L(px(f.x + x - 1, f.y + y)) + L(px(f.x + x, f.y + y + 1)) - L(px(f.x + x, f.y + y - 1));
      const gb = L(px(bx + 1, by)) - L(px(bx - 1, by)) + L(px(bx, by + 1)) - L(px(bx, by - 1));
      s += gp * gb; n++;
    }
    const sc = s / Math.max(1, n); if (!best || sc > best.sc) best = { cx, cy, sc };
  }
  console.log(idx, 'draw', best.cx, best.cy, 'score', best.sc.toFixed(0));
}
