// 调试脚本（T2 地图素材）：从 v2.06 rich4.exe 按 VA 读出本轮素材目录要引用的几张表，核对调研结论
// 用法：npx tsx test/maps-t2-exe-tables.ts
//   0x473098 u16[4]  节日插画基址（资源号 = 基址 + slot）
//   0x473dd8 u16[49] 命运插图表（k<33 用表[k]，k≥33 用表[k+4gm]）
//   0x472f78 ptr[4]  FLY*.AVI 字符串指针
//   0x46ab2c u16[4]  开局设置关卡勾的 y
//   0x46aac4 13×(x0,y0,x1,y1) 开局设置点击区
import { readFileSync } from 'node:fs';
import { parsePe, vaToOffset } from '../tools/extract/src/pe/pe';

const bytes = new Uint8Array(readFileSync('original/Game/rich4.exe'));
const pe = parsePe(bytes, 'rich4.exe');
const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const off = (va: number) => {
  const o = vaToOffset(pe, va);
  if (o === null) throw new Error(`VA 0x${va.toString(16)} 不在任何节里`);
  return o;
};
const u16s = (va: number, n: number) => Array.from({ length: n }, (_, i) => dv.getUint16(off(va) + 2 * i, true));
const u32s = (va: number, n: number) => Array.from({ length: n }, (_, i) => dv.getUint32(off(va) + 4 * i, true));
const cstr = (va: number) => {
  const o = off(va);
  let e = o;
  while (bytes[e] !== 0) e++;
  return Buffer.from(bytes.subarray(o, e)).toString('latin1');
};

console.log('0x473098 节日插画基址', u16s(0x473098, 4));
const fate = u16s(0x473dd8, 49);
console.log('0x473dd8 命运插图表', fate.join(','));
for (let gm = 0; gm < 4; gm++) {
  console.log(`  gm${gm} k=33..36 →`, [0, 1, 2, 3].map((j) => fate[33 + 4 * gm + j]));
}
const used = new Map<number, string[]>();
fate.forEach((res, i) => {
  const label = i < 33 ? `k${i}` : `k${33 + ((i - 33) % 4)}@gm${Math.trunc((i - 33) / 4)}`;
  used.set(res, [...(used.get(res) ?? []), label]);
});
for (let r = 436; r <= 475; r++) console.log(`  Data#${r}: ${(used.get(r) ?? ['（未引用）']).join(' ')}`);
console.log(
  '0x472f78 FLY 表',
  u32s(0x472f78, 4).map((p) => `0x${p.toString(16)} ${cstr(p)}`),
);
console.log('0x46ab2c 关卡勾 y', u16s(0x46ab2c, 4));
const rects = u32s(0x46aac4, 13 * 4);
for (let i = 0; i < 13; i++) console.log(`  点击区 ${i}`, rects.slice(4 * i, 4 * i + 4));
