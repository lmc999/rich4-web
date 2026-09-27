// 调试（A13）：打印三张底图 y=375..405 每行的平均颜色与行内方差，找 HUD 条上沿（不输出像素文件）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPng } from '../tools/extract/src/assets/pngRead';

const root = 'rich4-assets';
const m = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
function frame0(lp: string) {
  const f = m.files[lp];
  if (lp.endsWith('.png')) {
    const img = readPng(readFileSync(join(root, f.path)));
    return { img, ox: 0, oy: 0 };
  }
  const atlas = JSON.parse(readFileSync(join(root, f.path), 'utf8'));
  const img = readPng(readFileSync(join(root, f.path.slice(0, f.path.lastIndexOf('/') + 1) + atlas.meta.image)));
  const fr = atlas.frames[Object.keys(atlas.frames).find((n) => n.endsWith('/0'))!].frame;
  return { img, ox: fr.x, oy: fr.y };
}
for (const lp of ['sprites/panel/80.json', 'sprites/panel/91.json', 'images/panel/92.png']) {
  const { img, ox, oy } = frame0(lp);
  console.log(lp);
  for (let y = 378; y < 404; y++) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let x = 200; x < 440; x++) {
      const i = ((oy + y) * img.w + ox + x) * 4;
      r += img.rgba[i]!;
      g += img.rgba[i + 1]!;
      b += img.rgba[i + 2]!;
    }
    const n = 240;
    console.log(' ', y, Math.round(r / n), Math.round(g / n), Math.round(b / n));
  }
}
