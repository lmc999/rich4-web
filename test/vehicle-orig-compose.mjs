// 临时调研（交通工具）：按 exe 坐标还原原版道具欄里「收起载具」格的样子——Panel#11 图1（道具欄底图）上
// 在 (0x145,0x75) 叠图15（机车，禁止标志）或图16（汽车）（v2.06 fcn.00446948 0x4469a7–0x4469e7），放大 2 倍存到 .cache/vehicle/orig/
// 用法：node test/vehicle-orig-compose.mjs
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { PNG } from 'pngjs';

const dir = 'rich4-assets/sprites/panel';
const json = readdirSync(dir).find((f) => /^11\.[0-9a-f]+\.json$/.test(f));
const atlas = JSON.parse(readFileSync(`${dir}/${json}`, 'utf8'));
const src = PNG.sync.read(readFileSync(`${dir}/${atlas.meta.image}`));
const fr = (k) => atlas.frames[`Panel#11/${k}`].frame;
mkdirSync('.cache/vehicle/orig', { recursive: true });
const S = 2;
for (const [name, k] of [['moto', 15], ['car', 16]]) {
  const bg = fr(1);
  const out = new PNG({ width: bg.w * S, height: bg.h * S });
  const put = (f, ox, oy) => {
    for (let y = 0; y < f.h; y++)
      for (let x = 0; x < f.w; x++) {
        const si = ((f.y + y) * src.width + f.x + x) * 4;
        if (src.data[si + 3] === 0) continue;
        for (let dy = 0; dy < S; dy++)
          for (let dx = 0; dx < S; dx++) {
            const di = (((oy + y) * S + dy) * out.width + (ox + x) * S + dx) * 4;
            for (let c = 0; c < 4; c++) out.data[di + c] = src.data[si + c];
          }
      }
  };
  put(bg, 0, 0);
  put(fr(k), 0x145, 0x75);
  writeFileSync(`.cache/vehicle/orig/itembar-with-${name}-stow.png`, PNG.sync.write(out));
  console.log(name, 'ok');
}
