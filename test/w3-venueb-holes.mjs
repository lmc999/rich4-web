// 调试（venues/b）：统计本机素材包某帧的透明孔（连通域包围盒），只输出数字
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const [, , res, frame] = process.argv;
const pack = 'rich4-assets';
const m = JSON.parse(readFileSync(`${pack}/manifest.json`, 'utf8'));
const atlasPath = m.files[`sprites/${res}.json`].path;
const atlas = JSON.parse(readFileSync(`${pack}/${atlasPath}`, 'utf8'));
const dir = atlasPath.slice(0, atlasPath.lastIndexOf('/') + 1);
const img = PNG.sync.read(readFileSync(`${pack}/${dir}${atlas.meta.image}`));
const name = Object.keys(atlas.frames).find((n) => n.endsWith(`/${frame}`));
const f = atlas.frames[name].frame;
const W = f.w, H = f.h;
const tr = new Uint8Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) tr[y * W + x] = img.data[((f.y + y) * img.width + f.x + x) * 4 + 3] < 128 ? 1 : 0;
const seen = new Uint8Array(W * H);
const boxes = [];
for (let i = 0; i < W * H; i++) {
  if (!tr[i] || seen[i]) continue;
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
  const st = [i]; seen[i] = 1;
  while (st.length) { const j = st.pop(); const x = j % W, y = (j / W) | 0; n++;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    for (const k of [j - 1, j + 1, j - W, j + W]) { if (k < 0 || k >= W * H) continue; if (Math.abs((k % W) - x) > 1) continue; if (tr[k] && !seen[k]) { seen[k] = 1; st.push(k); } } }
  if (n > 50) boxes.push({ x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, n });
}
console.log(W, H, boxes);
