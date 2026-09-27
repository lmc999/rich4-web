// 验证按规则生成的 LZHUF 表与用户自有 rich4.exe 中的原表逐字节一致（调试脚本）。
import { readFileSync } from 'node:fs';
import { buildDistanceTables, buildInitialTree } from './lzhuf-proto.ts';

const ROOT = './original';
const { DLEN, DHI } = buildDistanceTables();
const { freq, son2, prnt2 } = buildInitialTree();
// 原版内存布局：freq[642] | son[641] | prnt[641] | prnt_leaf[322]
const tree = new Uint8Array((642 + 641 + 963) * 2);
const dv = new DataView(tree.buffer);
let o = 0;
for (const arr of [freq, son2, prnt2]) for (const v of arr) { dv.setUint16(o, v, true); o += 2; }

function findAll(hay: Uint8Array, needle: Uint8Array): number[] {
  const r: number[] = [];
  const b = Buffer.from(hay.buffer, hay.byteOffset, hay.byteLength);
  let i = b.indexOf(Buffer.from(needle));
  while (i >= 0) { r.push(i); i = b.indexOf(Buffer.from(needle), i + 1); }
  return r;
}
function peSecs(exe: Uint8Array) {
  const d = new DataView(exe.buffer, exe.byteOffset);
  const pe = d.getUint32(0x3c, true);
  const n = d.getUint16(pe + 6, true);
  const optSize = d.getUint16(pe + 20, true);
  const imageBase = d.getUint32(pe + 24 + 28, true);
  const secs = [] as { name: string; va: number; vsize: number; raw: number; rsize: number }[];
  for (let i = 0; i < n; i++) {
    const s = pe + 24 + optSize + i * 40;
    secs.push({
      name: Buffer.from(exe.subarray(s, s + 8)).toString('latin1').replace(/\0+$/, ''),
      vsize: d.getUint32(s + 8, true), va: d.getUint32(s + 12, true) + imageBase,
      rsize: d.getUint32(s + 16, true), raw: d.getUint32(s + 20, true),
    });
  }
  return secs;
}
function off2va(secs: ReturnType<typeof peSecs>, off: number) {
  for (const s of secs) if (off >= s.raw && off < s.raw + s.rsize) return '0x' + (s.va + off - s.raw).toString(16) + ` (${s.name})`;
  return '?';
}
for (const ed of ['Game', 'MultiverseJourney']) {
  const exe = new Uint8Array(readFileSync(`${ROOT}/${ed}/rich4.exe`));
  const secs = peSecs(exe);
  const a = findAll(exe, DHI), b = findAll(exe, DLEN), c = findAll(exe, tree);
  console.log(ed, 'DHI@', a.map((x) => `file 0x${x.toString(16)} VA ${off2va(secs, x)}`),
    'DLEN@', b.map((x) => `file 0x${x.toString(16)} VA ${off2va(secs, x)}`),
    'tree(4492B)@', c.map((x) => `file 0x${x.toString(16)} VA ${off2va(secs, x)}`));
}
