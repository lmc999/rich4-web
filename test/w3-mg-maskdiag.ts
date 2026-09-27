// 调试（A13）：企鹅掩膜 Panel#81（本机素材包）与 sim 的 pickCell 逐像素对拍（只打印统计，不输出像素文件）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as penguin from '../packages/shared/src/minigames/penguin/index';
import { readPng } from '../tools/extract/src/assets/pngRead';

const root = 'rich4-assets';
const m = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const img = readPng(readFileSync(join(root, m.files['masks/panel/81.png'].path)));
console.log('mask', img.w, img.h);
const regions = new Map<number, number>();
let same = 0;
let diff = 0;
let noneMask = 0;
let noneSim = 0;
const conf = new Map<string, number>();
for (let y = 0; y < 480; y++)
  for (let x = 0; x < 640; x++) {
    const v = img.rgba[(y * img.w + x) * 4]!;
    regions.set(v, (regions.get(v) ?? 0) + 1);
    const c = penguin.pickCell(x, y);
    const mc = v === 0 ? -1 : v;
    if (mc === c) same++;
    else {
      diff++;
      if (mc < 0) noneMask++;
      else if (c < 0) noneSim++;
      const k = `${mc}->${c}`;
      conf.set(k, (conf.get(k) ?? 0) + 1);
    }
  }
console.log('regions', [...regions.keys()].sort((a, b) => a - b).join(','));
console.log({ same, diff, noneMask, noneSim });
console.log([...conf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20));
