/**
 * 全量不变量校验（调试脚本）：对每个 MKF 的每个资源（压缩的先解压）检查
 *  - SPR：gsize == w*h（8 位索引），imgOff == start_offset，imgSize == 512（调色板）
 *  - SMP：gsize == 2*w*h（16 位直彩），imgOff == start_offset，imgOff+imgSize == raw
 *  - GND：imgOff == 16，imgSize == 512；w*h == n；raw == 16+512+2n+1024n
 *  - RAW16：imgOff == 4 且 imgOff+imgSize == raw
 *  - imgSize>0 的区域内所有 u16 的 bit15 == 0（RGB555 的必要条件；错误解压约 50% 会置位）
 *  - FLIC：遍历帧块链恰好到达文件尾，帧块数 == frames+1
 *  - WAVE：统计格式
 * 输出 .cache/assets-research/mkf-index/_validate.json
 */
import { writeFileSync } from 'node:fs';
import { Mkf, u16 } from './mkf-lib.ts';

const FILES = [
  'Game/Data.mkf', 'Game/Panel.mkf', 'Game/Speaking.mkf', 'Game/Effect.mkf', 'Game/jump.mkf',
  'Game/help.mkf', 'Game/map.mkf', 'Game/MapDat.MKF', 'MultiverseJourney/map.mkf',
];
const report: Record<string, unknown> = {};
for (const rel of FILES) {
  const m = new Mkf(rel);
  const agg = {
    count: m.n,
    bit15: { regions: 0, words: 0, set: 0, compressedRegions: 0, compressedWords: 0, compressedSet: 0 },
    spr: { n: 0, chunks: 0, bad: [] as string[] },
    smp: { n: 0, chunks: 0, bad: [] as string[] },
    gnd: { n: 0, bad: [] as string[] },
    raw16: { n: 0, bad: [] as string[], sizes: {} as Record<string, number> },
    flic: { n: 0, bad: [] as string[], frames: 0, dims: {} as Record<string, number>, subTypes: {} as Record<string, number> },
    wave: { n: 0, formats: {} as Record<string, number>, durationSec: 0 },
    other: {} as Record<string, number>,
  };
  for (let i = 0; i < m.n; i++) {
    const r = m.get(i);
    const p = r.payload;
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    if (r.imgSize > 0) {
      let set = 0;
      const words = r.imgSize >> 1;
      for (let k = 0; k < words; k++) if (p[r.imgOff + 2 * k + 1]! & 0x80) set++;
      agg.bit15.regions++; agg.bit15.words += words; agg.bit15.set += set;
      if (r.compressed) { agg.bit15.compressedRegions++; agg.bit15.compressedWords += words; agg.bit15.compressedSet += set; }
    }
    const tag = p.length >= 4 ? Buffer.from(p.subarray(0, 4)).toString('latin1') : '';
    if (tag === 'SPR\0' || tag === 'SMP\0') {
      const spr = tag === 'SPR\0';
      const a = spr ? agg.spr : agg.smp;
      a.n++;
      const n = dv.getUint32(4, true), start = dv.getUint32(8, true);
      if (start !== 12 + 12 * n) a.bad.push(`#${i} start=${start}!=12+12n`);
      if (r.imgOff !== start) a.bad.push(`#${i} imgOff=${r.imgOff}!=start`);
      if (spr && r.imgSize !== 512) a.bad.push(`#${i} imgSize=${r.imgSize}!=512`);
      if (!spr && r.imgOff + r.imgSize !== r.raw) a.bad.push(`#${i} img!=tail`);
      for (let k = 0; k < n; k++) {
        const o = 12 + 12 * k;
        const w = dv.getInt16(o, true), h = dv.getInt16(o + 2, true), g = dv.getUint32(o + 8, true);
        a.chunks++;
        if (g !== w * h * (spr ? 1 : 2)) a.bad.push(`#${i}.${k} ${w}x${h} gsize=${g}`);
      }
    } else if (tag === 'GND\0') {
      agg.gnd.n++;
      const w = dv.getUint16(4, true), h = dv.getUint16(6, true), n = dv.getUint32(8, true);
      if (r.imgOff !== 16 || r.imgSize !== 512 || w * h !== n || r.raw !== 16 + 512 + 2 * n + 1024 * n)
        agg.gnd.bad.push(`#${i} imgOff=${r.imgOff} imgSize=${r.imgSize} ${w}x${h} n=${n} raw=${r.raw}`);
    } else if (p.length >= 16 && (dv.getUint16(4, true) === 0xaf12 || dv.getUint16(4, true) === 0xaf11)) {
      agg.flic.n++;
      const size = dv.getUint32(0, true), nf = dv.getUint16(6, true), W = dv.getUint16(8, true), H = dv.getUint16(10, true);
      agg.flic.dims[`${W}x${H}x${dv.getUint16(12, true)}`] = (agg.flic.dims[`${W}x${H}x${dv.getUint16(12, true)}`] ?? 0) + 1;
      let pos = dv.getUint32(80, true) || 128, frames = 0, ok = size === p.length && r.imgSize === 0;
      while (pos < size) {
        const cs = dv.getUint32(pos, true), ct = dv.getUint16(pos + 4, true);
        if (cs < 6 || pos + cs > size) { ok = false; break; }
        if (ct === 0xf1fa) {
          frames++;
          const nsub = dv.getUint16(pos + 6, true);
          let sp = pos + 16;
          for (let s = 0; s < nsub; s++) {
            const ss = dv.getUint32(sp, true), st = dv.getUint16(sp + 4, true);
            agg.flic.subTypes[st] = (agg.flic.subTypes[st] ?? 0) + 1;
            sp += ss;
          }
          if (sp !== pos + cs) ok = false;
        } else agg.flic.subTypes[`top_0x${ct.toString(16)}`] = (agg.flic.subTypes[`top_0x${ct.toString(16)}`] ?? 0) + 1;
        pos += cs;
      }
      if (!ok || pos !== size || frames !== nf + 1) agg.flic.bad.push(`#${i} frames=${frames} hdr=${nf} pos=${pos} size=${size}`);
      agg.flic.frames += frames;
    } else if (tag === 'RIFF') {
      agg.wave.n++;
      const k = `fmt${dv.getUint16(20, true)} ${dv.getUint16(22, true)}ch ${dv.getUint32(24, true)}Hz ${dv.getUint16(34, true)}bit`;
      agg.wave.formats[k] = (agg.wave.formats[k] ?? 0) + 1;
      // 找 data 块
      let q = 12;
      while (q + 8 <= p.length) {
        const id = Buffer.from(p.subarray(q, q + 4)).toString('latin1'), sz = dv.getUint32(q + 4, true);
        if (id === 'data') { agg.wave.durationSec += sz / dv.getUint32(28, true); break; }
        q += 8 + sz + (sz & 1);
      }
    } else if (r.imgSize > 0) {
      agg.raw16.n++;
      agg.raw16.sizes[r.raw] = (agg.raw16.sizes[r.raw] ?? 0) + 1;
      if (r.imgOff !== 4 || r.imgOff + r.imgSize !== r.raw) agg.raw16.bad.push(`#${i} imgOff=${r.imgOff} imgSize=${r.imgSize} raw=${r.raw}`);
    } else {
      const k = p.length === 0 ? 'EMPTY' : `DATA(${r.compressed ? 'C' : 'U'})`;
      agg.other[k] = (agg.other[k] ?? 0) + 1;
    }
  }
  agg.wave.durationSec = Math.round(agg.wave.durationSec);
  report[rel] = agg;
  console.log(rel, JSON.stringify(agg));
}
writeFileSync('./.cache/assets-research/mkf-index/_validate.json', JSON.stringify(report, null, 1));
void u16;
