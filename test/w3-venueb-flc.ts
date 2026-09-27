// 调试（venues/b）：解码本机素材包的魔法屋施法 FLC（Panel#20），导出几帧 PNG 到 .cache/w3b/（不入库），并在首帧里找女巫施法帧的位置
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { FlcDecoder, parseFlc } from '../apps/client/src/skin/flic/FlcDecoder';

const pack = 'rich4-assets';
const m = JSON.parse(readFileSync(`${pack}/manifest.json`, 'utf8'));
const file = m.files['flic/panel/20.flc'].path;
const flc = parseFlc(readFileSync(`${pack}/${file}`));
const dec = new FlcDecoder(flc);
mkdirSync('.cache/w3b', { recursive: true });
const rgba = new Uint8Array(640 * 480 * 4);
const frames: Uint8Array[] = [];
for (let i = 0; i < flc.frames; i++) {
  dec.next();
  dec.toRgba(rgba, true);
  frames.push(rgba.slice());
  if ([0, 12, 24].includes(i)) {
    const png = new PNG({ width: 640, height: 480 });
    png.data.set(rgba);
    writeFileSync(`.cache/w3b/flc20-${i}.png`, PNG.sync.write(png));
  }
}
console.log("frames", flc.frames);
// 找施法女巫（Panel#18 图2）在首帧里的位置
const atlasPath = m.files['sprites/panel/18.json'].path;
const atlas = JSON.parse(readFileSync(`${pack}/${atlasPath}`, 'utf8'));
const img = PNG.sync.read(readFileSync(`${pack}/${atlasPath.slice(0, atlasPath.lastIndexOf('/') + 1)}${atlas.meta.image}`));
for (const idx of [2, 1]) {
  const f = atlas.frames[`Panel#18/${idx}`].frame;
  const base = frames[0]!;
  let best: { x: number; y: number; d: number } | null = null;
  for (let oy = 100; oy < 300; oy++)
    for (let ox = 150; ox < 300; ox++) {
      let d = 0;
      let n = 0;
      for (let y = 0; y < f.h; y += 3)
        for (let x = 0; x < f.w; x += 3) {
          const si = ((f.y + y) * img.width + f.x + x) * 4;
          if (img.data[si + 3]! < 128) continue;
          const bx = ox + x;
          const by = oy + y;
          if (bx >= 640 || by >= 480) {
            d += 300;
            n++;
            continue;
          }
          const bi = (by * 640 + bx) * 4;
          d += Math.abs(img.data[si]! - base[bi]!) + Math.abs(img.data[si + 1]! - base[bi + 1]!) + Math.abs(img.data[si + 2]! - base[bi + 2]!);
          n++;
        }
      const s = d / Math.max(1, n);
      if (!best || s < best.d) best = { x: ox, y: oy, d: s };
    }
  console.log('witch frame', idx, best);
}
