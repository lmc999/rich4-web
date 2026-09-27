// 调试（venues/b）：把本机素材包某资源的若干帧按锚点对齐横排成一条（2 倍），写到 .cache/w3b/（不入库）
// 用法：node test/w3-venueb-strip.mjs panel/26 30 77 [scale]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const [, , res, a, b, sc = '2'] = process.argv;
const S = Number(sc);
const pack = 'rich4-assets';
const m = JSON.parse(readFileSync(`${pack}/manifest.json`, 'utf8'));
const atlasPath = m.files[`sprites/${res}.json`].path;
const atlas = JSON.parse(readFileSync(`${pack}/${atlasPath}`, 'utf8'));
const dir = atlasPath.slice(0, atlasPath.lastIndexOf('/') + 1);
const img = PNG.sync.read(readFileSync(`${pack}/${dir}${atlas.meta.image}`));
const names = Object.keys(atlas.frames);
const list = [];
for (let i = Number(a); i <= Number(b); i++) list.push(atlas.frames[names.find((n) => n.endsWith(`/${i}`))]);
const W = list.reduce((s, f) => s + f.frame.w + 4, 0) * S;
const H = Math.max(...list.map((f) => f.frame.h)) * S + 2;
const out = new PNG({ width: W, height: H });
for (let i = 0; i < out.data.length; i += 4) out.data.set([40, 40, 60, 255], i);
let x0 = 0;
for (const f of list) {
  for (let y = 0; y < f.frame.h * S; y++)
    for (let x = 0; x < f.frame.w * S; x++) {
      const si = ((f.frame.y + Math.floor(y / S)) * img.width + f.frame.x + Math.floor(x / S)) * 4;
      if (img.data[si + 3] < 128) continue;
      const di = (y * W + x0 + x) * 4;
      out.data.set(img.data.subarray(si, si + 4), di);
    }
  x0 += (f.frame.w + 4) * S;
}
mkdirSync('.cache/w3b', { recursive: true });
const file = `.cache/w3b/strip-${res.replace('/', '-')}-${a}-${b}.png`;
writeFileSync(file, PNG.sync.write(out));
console.log(file, W, H);
