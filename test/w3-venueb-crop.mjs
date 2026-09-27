// 调试（venues/b）：从本机素材包图集中裁出若干帧，写到 .cache/w3b/（只在本机查看，不入库）
// 用法：node test/w3-venueb-crop.mjs <mkf/资源号，如 panel/18> <帧号...>   | 帧号 all 表示全部
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const [, , res, ...frames] = process.argv;
const pack = 'rich4-assets';
const m = JSON.parse(readFileSync(`${pack}/manifest.json`, 'utf8'));
const atlasPath = m.files[`sprites/${res}.json`].path;
const atlas = JSON.parse(readFileSync(`${pack}/${atlasPath}`, 'utf8'));
const imgName = atlas.meta.image;
const dir = atlasPath.slice(0, atlasPath.lastIndexOf('/') + 1);
const img = PNG.sync.read(readFileSync(`${pack}/${dir}${imgName}`));
mkdirSync('.cache/w3b', { recursive: true });
const names = Object.keys(atlas.frames);
const want = frames[0] === 'all' ? names : frames.map((f) => names.find((n) => n.endsWith(`/${f}`)));
for (const n of want) {
  const f = atlas.frames[n].frame;
  const out = new PNG({ width: f.w, height: f.h });
  for (let y = 0; y < f.h; y++)
    for (let x = 0; x < f.w; x++) {
      const si = ((f.y + y) * img.width + f.x + x) * 4;
      const di = (y * f.w + x) * 4;
      for (let k = 0; k < 4; k++) out.data[di + k] = img.data[si + k];
    }
  const file = `.cache/w3b/${res.replace('/', '-')}-${n.split('/').pop()}.png`;
  writeFileSync(file, PNG.sync.write(out));
  const a = atlas.frames[n].anchor;
  console.log(file, f.w, f.h, 'anchor', Math.round(a.x * f.w), Math.round(a.y * f.h));
}
