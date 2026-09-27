// 调研：扫描 MKF 中的 FLIC（FLI 0xAF11 / FLC 0xAF12）资源，统计帧数/尺寸/速度/块类型。只读原版。
// 用法：node test/ar_flic_survey.mjs  → .cache/assets-research/audio/flic.index.json
import fs from 'node:fs';
import { openMkf } from './ui-lib.mjs';
const ROOT = '.';
const OUT = `${ROOT}/.cache/assets-research/audio/flic.index.json`;
const files = process.argv.slice(2).length ? process.argv.slice(2) : ['Data.mkf', 'Panel.mkf', 'jump.mkf', 'help.mkf'];
const result = {};
for (const f of files) {
  const m = openMkf(`${ROOT}/original/Game/${f}`);
  const list = [];
  const t0 = Date.now();
  for (let i = 0; i < m.count; i++) {
    const e = m.entries[i];
    if (e.imgSize !== 0 || e.raw < 128) continue; // SPR/SMP 等图像资源跳过
    let d;
    try { d = m.read(i); } catch (err) { continue; }
    if (d.length < 128) continue;
    const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const type = dv.getUint16(4, true);
    if (type !== 0xaf11 && type !== 0xaf12) continue;
    const size = dv.getUint32(0, true);
    const frames = dv.getUint16(6, true);
    const w = dv.getUint16(8, true), h = dv.getUint16(10, true), depth = dv.getUint16(12, true);
    const speed = dv.getUint32(16, true);
    // 遍历帧块
    let off = type === 0xaf12 ? (dv.getUint32(80, true) || 128) : 128;
    const chunkTypes = {};
    let nf = 0, prefix = 0, ring = 0, maxFrameBytes = 0;
    while (off + 16 <= d.length) {
      const fsize = dv.getUint32(off, true), ftype = dv.getUint16(off + 4, true);
      if (!fsize) break;
      if (ftype === 0xf100) prefix++;
      else if (ftype === 0xf1fa) {
        nf++;
        maxFrameBytes = Math.max(maxFrameBytes, fsize);
        const nch = dv.getUint16(off + 6, true);
        let c = off + 16;
        for (let k = 0; k < nch && c + 6 <= off + fsize; k++) {
          const cs = dv.getUint32(c, true), ct = dv.getUint16(c + 4, true);
          chunkTypes[ct] = (chunkTypes[ct] || 0) + 1;
          if (!cs) break;
          c += cs;
        }
      }
      off += fsize;
    }
    if (nf > frames) ring = nf - frames;
    list.push({ i, compressed: e.raw !== e.stored, raw: e.raw, stored: e.stored, hdrSize: size, type: type.toString(16), frames, framesWalked: nf, ringFrame: ring, w, h, depth, speed, speedMs: type === 0xaf12 ? speed : Math.round(speed * 1000 / 70), chunkTypes, maxFrameBytes });
  }
  result[f] = list;
  console.log(f, 'FLIC count', list.length, 'ms', Date.now() - t0);
  for (const x of list) console.log(`  #${x.i} ${x.type} ${x.w}x${x.h}x${x.depth} frames=${x.frames}(+ring ${x.ringFrame}) speed=${x.speed}(${x.speedMs}ms) raw=${x.raw} stored=${x.stored} chunks=${JSON.stringify(x.chunkTypes)}`);
}
fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
