// 调试（T4）：从原版 rich4.exe v2.06 读命运处理函数表 0x473d14 的第 33–48 项与插图表 0x473dd8，
// 在每个处理函数里找 push imm32 指向的 Big5 字符串（标题），与 .cache/extract/tables.v206.json 的 fate.variants 对照。
// 用法：npx tsx test/maps-t4-fate-variants.ts   （需要 original/Game/rich4.exe；只读）
import { existsSync, readFileSync } from 'node:fs';
import { parsePe, vaToOffset } from '../tools/extract/src/pe/pe';

const exePath = 'original/Game/rich4.exe';
if (!existsSync(exePath)) {
  console.error(`缺少 ${exePath}`);
  process.exit(1);
}
const bytes = new Uint8Array(readFileSync(exePath));
const pe = parsePe(bytes, 'rich4.exe');
const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const off = (va: number): number => {
  const o = vaToOffset(pe, va);
  if (o === null) throw new Error(`VA 0x${va.toString(16)} 不在文件里`);
  return o;
};
const u32 = (va: number): number => dv.getUint32(off(va), true);
const u16 = (va: number): number => dv.getUint16(off(va), true);
const big5 = new TextDecoder('big5');
function cstr(va: number): string | null {
  const o = vaToOffset(pe, va);
  if (o === null) return null;
  let e = o;
  while (e < bytes.length && bytes[e] !== 0 && e - o < 80) e++;
  if (e === o || e - o >= 80) return null;
  const s = big5.decode(bytes.subarray(o, e));
  return /[一-鿿]/.test(s) ? s : null;
}

const HANDLERS = 0x473d14;
const ART = 0x473dd8;
const tables = JSON.parse(readFileSync('.cache/extract/tables.v206.json', 'utf8')) as {
  fate: { id: number; handler: string; headline: string; variants: { slot: number; handler: string; headline: string }[] }[];
};
const expected = new Map<number, { handler: string; headline: string }>();
for (const f of tables.fate) {
  expected.set(f.id, { handler: f.handler, headline: f.headline });
  for (const v of f.variants) expected.set(v.slot, { handler: v.handler, headline: v.headline });
}

let bad = 0;
for (let k = 33; k <= 48; k++) {
  const h = u32(HANDLERS + 4 * k);
  const strs: string[] = [];
  const base = off(h);
  for (let i = 0; i < 160; i++) {
    if (bytes[base + i] !== 0x68) continue;
    const imm = dv.getUint32(base + i + 1, true);
    const s = cstr(imm);
    if (s) strs.push(`${s}@0x${imm.toString(16)}`);
  }
  const art = u16(ART + 2 * k);
  const exp = expected.get(k);
  // 处理函数里第一个 push 的字符串是本条标题，前缀 #dddd 是语音号（Speaking），后面的属于相邻的处理函数
  const first = strs[0] ?? '';
  const m = /^#(\d{4})(.*)@/.exec(first);
  const voice = m ? Number(m[1]) : null;
  const title = m ? m[2] : first;
  const ok = exp !== undefined && exp.handler === `0x${h.toString(16)}` && title === exp.headline;
  if (!ok) bad++;
  console.log(
    `表项 ${k}：处理函数 0x${h.toString(16)}  语音 ${voice}  插图 Data#${art}  标题 ${title}  ${ok ? 'OK' : `≠ ${JSON.stringify(exp)}`}`,
  );
}
console.log(bad === 0 ? '全部与 tables.v206.json 一致' : `${bad} 项不一致`);
process.exit(bad === 0 ? 0 : 1);
