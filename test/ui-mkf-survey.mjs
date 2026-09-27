// 临时调试：MKF 资源概览（资源数、压缩、签名、image 字段）
import fs from 'node:fs';
const files = process.argv.slice(2);
for (const f of files) {
  const b = fs.readFileSync(f);
  const X = b.readUInt32LE(0);
  const n = (b.length - X) / 4;
  const starts = []; for (let i = 0; i < n; i++) starts.push(b.readUInt32LE(X + 4 * i));
  const sentinel = starts[n - 1] === X;
  const count = sentinel ? n - 1 : n;
  let comp = 0, img = 0; const sig = {};
  const rows = [];
  for (let i = 0; i < count; i++) {
    const o = starts[i];
    const raw = b.readUInt32LE(o), st = b.readUInt32LE(o + 4), io = b.readUInt32LE(o + 8), is = b.readUInt32LE(o + 12);
    const c = raw !== st; if (c) comp++; if (io || is) img++;
    const m = c ? '(comp)' : b.subarray(o + 16, o + 20).toString('latin1').replace(/[^\x20-\x7e]/g, '.');
    sig[m] = (sig[m] || 0) + 1;
    rows.push([i, raw, st, io, is, m]);
  }
  console.log(`== ${f}: size=${b.length} X=${X} n=${n} sentinel=${sentinel} count=${count} compressed=${comp} withImage=${img}`);
  console.log('  signatures:', JSON.stringify(Object.entries(sig).sort((a,b)=>b[1]-a[1]).slice(0,15)));
  if (process.env.ROWS) for (const r of rows.slice(0, +process.env.ROWS)) console.log('  ', r.join('\t'));
}
