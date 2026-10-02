// 临时调研（交通工具）：从本地原版素材图集裁出 Panel#11 的若干帧（默认 1、15、16），放大 3 倍存到 .cache/vehicle/orig/
// 用法：node test/vehicle-orig-crop.mjs [帧号...]
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { PNG } from 'pngjs';

const dir = 'rich4-assets/sprites/panel';
const json = readdirSync(dir).find((f) => /^11\.[0-9a-f]+\.json$/.test(f));
const atlas = JSON.parse(readFileSync(`${dir}/${json}`, 'utf8'));
const src = PNG.sync.read(readFileSync(`${dir}/${atlas.meta.image}`));
const frames = process.argv.slice(2).length ? process.argv.slice(2) : ['1', '15', '16'];
mkdirSync('.cache/vehicle/orig', { recursive: true });
const S = 3;
for (const k of frames) {
  const f = atlas.frames[`Panel#11/${k}`].frame;
  const out = new PNG({ width: f.w * S, height: f.h * S });
  for (let y = 0; y < f.h * S; y++)
    for (let x = 0; x < f.w * S; x++) {
      const si = ((f.y + Math.floor(y / S)) * src.width + f.x + Math.floor(x / S)) * 4;
      const di = (y * out.width + x) * 4;
      for (let c = 0; c < 4; c++) out.data[di + c] = src.data[si + c];
    }
  writeFileSync(`.cache/vehicle/orig/panel11-f${k}.png`, PNG.sync.write(out));
  console.log(k, f);
}
