// 临时调试：对 UI 相关 MKF 做全量目录（解压 + 类型识别 + 帧尺寸），输出 JSON
import fs from 'node:fs';
import { openMkf, parseSheet } from './ui-lib.mjs';
const ROOT = '.';
const OUT = `${ROOT}/.cache/assets-research/ui`;
const names = process.argv.slice(2).length ? process.argv.slice(2) : ['Panel', 'Data', 'help', 'jump'];
const result = {};
for (const nm of names) {
  const t0 = Date.now();
  const m = openMkf(`${ROOT}/original/Game/${nm}.mkf`);
  const rows = [];
  let bad = 0;
  for (const e of m.entries) {
    let d;
    try { d = m.read(e.index); } catch (err) { rows.push({ i: e.index, err: String(err) }); bad++; continue; }
    const row = { i: e.index, raw: e.raw, stored: e.stored, comp: e.raw !== e.stored, imgOff: e.imgOff, imgSize: e.imgSize };
    if (row.comp) row.decoded = d.decodedLength;
    const sh = parseSheet(d);
    if (sh) {
      row.kind = sh.kind; row.n = sh.frames.length; row.start = sh.start;
      row.endOk = sh.end === d.length ? true : `${sh.end}/${d.length}`;
      row.frames = sh.frames.map(f => [f.w, f.h, f.x, f.y]);
      // SPR: gsize==w*h? SMP: gsize==w*h*2?
      const mult = sh.kind === 'SPR' ? 1 : 2;
      row.gsizeOk = sh.frames.every(f => f.gsize === f.w * f.h * mult);
      if (!row.gsizeOk) bad++;
      if (row.endOk !== true) bad++;
    } else {
      const magic16 = d.length >= 6 ? d[4] | (d[5] << 8) : 0;
      if (magic16 === 0xaf12 || magic16 === 0xaf11) {
        row.kind = magic16 === 0xaf12 ? 'FLC' : 'FLI';
        const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
        row.flic = { size: dv.getUint32(0, true), frames: dv.getUint16(6, true), w: dv.getUint16(8, true), h: dv.getUint16(10, true), depth: dv.getUint16(12, true), speed: dv.getUint32(16, true) };
      } else if (d.length === 80000) row.kind = 'raw555_200x200?';
      else if (d.length === 640 * 480 * 2) row.kind = 'raw555_640x480?';
      else row.kind = 'other';
      row.head = Buffer.from(d.subarray(0, 16)).toString('hex');
    }
    rows.push(row);
  }
  result[nm] = rows;
  const kinds = {};
  for (const r of rows) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
  console.log(nm, 'entries', rows.length, 'bad', bad, 'kinds', JSON.stringify(kinds), `${Date.now() - t0}ms`);
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(`${OUT}/catalog-${names.join('-')}.json`, JSON.stringify(result));
