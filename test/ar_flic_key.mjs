// 调研：检查 FLIC 的背景是否为调色板索引 0（疑似透明色键）以及该色的 RGB。只读原版。
import { openMkf, decodeFlc } from './ui-lib.mjs';
const ROOT = '.';
const sets = { 'Data.mkf': [375, 386, 395, 482, 483, 484, 485, 486, 487, 488, 489, 490, 491, 492, 493, 494, 495, 496, 497, 498, 499, 503, 507, 510, 511, 512, 513, 514, 515, 516, 517, 518, 529], 'Panel.mkf': [4, 14, 16, 17, 20, 78], 'jump.mkf': [42, 43, 55, 62] };
for (const [f, ids] of Object.entries(sets)) {
  const m = openMkf(`${ROOT}/original/Game/${f}`);
  for (const i of ids) {
    const d = m.read(i);
    const a = decodeFlc(d, { transparentIndex: 0 });
    const b = decodeFlc(d, {});
    const fr = a.frames[Math.floor(a.frames.length / 2)], fb = b.frames[Math.floor(b.frames.length / 2)];
    let t = 0; for (let p = 3; p < fr.rgba.length; p += 4) if (fr.rgba[p] === 0) t++;
    const corner = [fb.rgba[0], fb.rgba[1], fb.rgba[2]];
    console.log(`${f}#${i} ${a.w}x${a.h} idx0-transparent=${(100 * t / (a.w * a.h)).toFixed(1)}% cornerAlphaWithKey0=${fr.rgba[3]} cornerRGB=${corner}`);
  }
}
