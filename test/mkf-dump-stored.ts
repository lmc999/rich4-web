// 导出某资源的原始 stored 字节与本实现的解压结果，供 radare2 ESIL 仿真原版解压函数做逐字节对照（调试脚本）
// 用法：node test/mkf-dump-stored.ts Game/Panel.mkf 13 <outdir>
import { writeFileSync } from 'node:fs';
import { Mkf } from './mkf-lib.ts';
const [rel, idx, out] = process.argv.slice(2);
const m = new Mkf(rel!);
const i = Number(idx);
const off = m.starts[i]!;
const stored = m.dv.getUint32(off + 4, true);
const body = m.file.subarray(off + 16, off + 16 + stored);
const r = m.get(i);
const tag = `${rel!.replace(/[/.]/g, '_')}_${i}`;
writeFileSync(`${out}/${tag}.stored.bin`, body);
writeFileSync(`${out}/${tag}.ours.bin`, r.payload);
console.log(tag, 'stored', stored, 'raw', r.raw);
