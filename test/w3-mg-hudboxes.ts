// 调试（A13）：在本机素材包的小游戏底图（Panel#80 图0、#91 图0、#92）底部 HUD 条里找白色数字框的矩形，打印坐标（不输出像素文件）。
// 用法：npx tsx test/w3-mg-hudboxes.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPng } from '../tools/extract/src/assets/pngRead';

const root = 'rich4-assets';
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

function frame0(lp: string): { rgba: Uint8Array; w: number; ox: number; oy: number } {
  const f = manifest.files[lp];
  if (lp.endsWith('.png')) {
    const img = readPng(readFileSync(join(root, f.path)));
    return { rgba: img.rgba, w: img.w, ox: 0, oy: 0 };
  }
  const atlas = JSON.parse(readFileSync(join(root, f.path), 'utf8'));
  const dir = f.path.slice(0, f.path.lastIndexOf('/') + 1);
  const img = readPng(readFileSync(join(root, dir + atlas.meta.image)));
  const name = Object.keys(atlas.frames).find((n) => n.endsWith('/0'))!;
  const fr = atlas.frames[name].frame;
  return { rgba: img.rgba, w: img.w, ox: fr.x, oy: fr.y };
}

for (const lp of ['sprites/panel/80.json', 'sprites/panel/91.json', 'images/panel/92.png']) {
  const { rgba, w, ox, oy } = frame0(lp);
  const white = (x: number, y: number): boolean => {
    const i = ((oy + y) * w + ox + x) * 4;
    return rgba[i]! > 225 && rgba[i + 1]! > 225 && rgba[i + 2]! > 225;
  };
  // 按连通域找白色矩形（y ≥ 380）
  const seen = new Uint8Array(640 * 480);
  const boxes: [number, number, number, number, number][] = [];
  for (let y = 380; y < 480; y++)
    for (let x = 0; x < 640; x++) {
      if (seen[y * 640 + x] || !white(x, y)) continue;
      let x0 = x;
      let x1 = x;
      let y0 = y;
      let y1 = y;
      let n = 0;
      const st = [[x, y]];
      seen[y * 640 + x] = 1;
      while (st.length) {
        const [cx, cy] = st.pop()!;
        n++;
        x0 = Math.min(x0, cx!);
        x1 = Math.max(x1, cx!);
        y0 = Math.min(y0, cy!);
        y1 = Math.max(y1, cy!);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = cx! + dx!;
          const ny = cy! + dy!;
          if (nx < 0 || ny < 380 || nx >= 640 || ny >= 480 || seen[ny * 640 + nx] || !white(nx, ny)) continue;
          seen[ny * 640 + nx] = 1;
          st.push([nx, ny]);
        }
      }
      if (n >= 150) boxes.push([x0, y0, x1 - x0 + 1, y1 - y0 + 1, n]);
    }
  console.log(lp);
  for (const b of boxes.sort((a, c) => a[0] - c[0])) console.log('  x', b[0], 'y', b[1], 'w', b[2], 'h', b[3], 'px', b[4]);
}
