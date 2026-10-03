// 调试（命运 / 新闻原文）：从原版 rich4.exe v2.06 读命运处理函数表 0x473d14（49 项）、新闻处理函数表 0x473c48（36 项）
// 里各处理函数参数 0 分支 push 的格式串（开头 #NNNN 是语音号），新闻分类名表 0x473cfc 与逐人行的格式串；
// 把 %d / %s 按位置换成 i18n 占位符，用 opencc（tw → cn，与 tools/extract 地图文案同一种做法）生成 zh-CN，
// 再用 scripts/gen-zh-tw 的同一套转换（cn → twp + 词汇覆盖表）转回繁体，核对是否与原文一致。
// 用法：npx tsx test/fatenews-orig-text.ts [--json | --check-locales]   （需要 original/Game/rich4.exe；只读）
//   --json：把 { fate, news } 的 zh-CN / zh-TW 原文表打印成 JSON（写语言包时对照）
//   --check-locales：入库的 zh-TW fate.json / news.json 与原文逐条比对（不一致时退出码 1）
import { existsSync, readFileSync } from 'node:fs';
import { Converter as Cn2t } from 'opencc-js/cn2t';
import { Converter as T2cn } from 'opencc-js/t2cn';
import { convertText } from '../apps/client/src/i18n/zhTw';
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
const u8 = (va: number): number => bytes[off(va)]!;
const big5 = new TextDecoder('big5');
const hex = (v: number): string => `0x${v.toString(16)}`;

function cstr(va: number, max = 120): string | null {
  const o = vaToOffset(pe, va);
  if (o === null) return null;
  let e = o;
  while (e < bytes.length && bytes[e] !== 0 && e - o < max) e++;
  if (e === o || e - o >= max) return null;
  return big5.decode(bytes.subarray(o, e));
}

/** 处理函数入口起 span 字节内第一条 push imm32（0x68）指向的 #NNNN 串 */
function voiceString(entry: number, span = 0x240): { at: number; str: number; voice: number; text: string } | null {
  for (let a = entry; a < entry + span; a++) {
    if (u8(a) !== 0x68) continue;
    const imm = u32(a + 1);
    const s = cstr(imm);
    const m = s?.match(/^#(\d{4})([\s\S]*)$/);
    if (m) return { at: a, str: imm, voice: Number(m[1]), text: m[2]! };
  }
  return null;
}

/** %d / %s 按出现顺序换成占位符 */
function withParams(text: string, names: readonly string[]): string {
  let i = 0;
  const out = text.replace(/%[ds]/g, () => {
    const n = names[i++];
    if (!n) throw new Error(`占位符不够：${text}`);
    return `{{${n}}}`;
  });
  if (i !== names.length) throw new Error(`占位符多余：${text} ${names.join(',')}`);
  return out;
}

const FATE_PARAMS: Record<number, readonly string[]> = {
  2: ['amount'],
  4: ['pct'],
  6: ['days'],
  7: ['days'],
  8: ['pct'],
  12: ['days'],
  13: ['days'],
};
for (let k = 14; k <= 31; k++) FATE_PARAMS[k] = ['amount'];
for (let k = 33; k <= 48; k++) FATE_PARAMS[k] = ['days'];

const NEWS_PARAMS: Record<number, readonly string[]> = {
  1: ['days'],
  3: ['days'],
  5: ['lot'],
  6: ['lot'],
  7: ['lot'],
  8: ['who', 'amount'],
  9: ['who', 'amount'],
  10: ['who', 'amount'],
  14: ['lot'],
  15: ['lot'],
  18: ['lot'],
  19: ['lot'],
  20: ['lot'],
  21: ['lot'],
  27: ['stock'],
  28: ['stock'],
  29: ['company', 'who'],
};
for (let k = 30; k <= 35; k++) NEWS_PARAMS[k] = ['company'];

const t2cn = T2cn({ from: 'tw', to: 'cn' });
const cn2t = Cn2t({ from: 'cn', to: 'twp' });
/** 繁 → 简：占位符原样保留 */
const toCn = (s: string): string =>
  s
    .split(/(\{\{[^{}]*\}\})/g)
    .map((p, i) => (i % 2 === 1 ? p : t2cn(p)))
    .join('');

interface Row {
  key: string;
  handler: string | null;
  str: string;
  voice: number | null;
  tw: string;
  cn: string;
  back: string;
}
const rows: Row[] = [];
function add(key: string, handler: number | null, str: number, voice: number | null, raw: string, names: readonly string[]) {
  const tw = withParams(raw, names);
  const cn = toCn(tw);
  const back = convertText(cn, cn2t);
  rows.push({ key, handler: handler === null ? null : hex(handler), str: hex(str), voice, tw, cn, back });
}

// 命运 49 项
const FATE_TABLE = 0x473d14;
for (let slot = 0; slot < 49; slot++) {
  const h = u32(FATE_TABLE + 4 * slot);
  const v = voiceString(h);
  if (!v) throw new Error(`命运 slot ${slot} ${hex(h)} 没找到 #NNNN 串`);
  if (v.voice !== 185 + slot) console.warn(`命运 slot ${slot}：语音 ${v.voice} ≠ ${185 + slot}`);
  add(`fate.${slot}`, h, v.str, v.voice, v.text, FATE_PARAMS[slot] ?? []);
}
// 新闻 36 项
const NEWS_TABLE = 0x473c48;
for (let id = 0; id < 36; id++) {
  const h = u32(NEWS_TABLE + 4 * id);
  const v = voiceString(h, 0x300);
  if (!v) throw new Error(`新闻 ${id} ${hex(h)} 没找到 #NNNN 串`);
  if (v.voice !== 149 + id) console.warn(`新闻 ${id}：语音 ${v.voice} ≠ ${149 + id}`);
  add(`news.${id}`, h, v.str, v.voice, v.text, NEWS_PARAMS[id] ?? []);
}
// 新闻分类：字节表 0x473cd8[id] → 名称指针表 0x473cfc
const CAT_OF = 0x473cd8;
const CAT_NAMES = 0x473cfc;
const cats = new Set<number>();
for (let id = 0; id < 36; id++) cats.add(u8(CAT_OF + id));
for (const c of [...cats].sort()) {
  const p = u32(CAT_NAMES + 4 * c);
  add(`news.category.${c}`, null, p, null, cstr(p) ?? '?', []);
}
// 新闻的逐人行：税（11–13，0x4635ea）、储金红利（23，0x46377f）
add('news.row.tax', null, 0x4635ea, null, cstr(0x4635ea) ?? '?', ['who', 'amount']);
add('news.row.bonus', null, 0x46377f, null, cstr(0x46377f) ?? '?', ['who', 'amount']);
console.log(`新闻分类字节表：${Array.from({ length: 36 }, (_, i) => u8(CAT_OF + i)).join(',')}`);

/** 入库的 zh-TW 语言包与原文逐条比对（fate.<slot>：33–36 的按图变体在 byMap.<gm>；news 分类与逐人行） */
function localeOf(key: string): string | undefined {
  const tw = (ns: string) =>
    JSON.parse(readFileSync(`apps/client/src/i18n/locales/zh-TW/${ns}.json`, 'utf8')) as Record<string, never>;
  const [ns, a, b] = key.split('.') as [string, string, string | undefined];
  if (ns === 'fate') {
    const slot = Number(a);
    const f = tw('fate') as Record<string, { text: string; byMap?: Record<string, { text: string }> }>;
    if (slot < 37) return f[String(slot)]?.text;
    const id = 33 + ((slot - 33) % 4);
    const gm = Math.floor((slot - 33) / 4);
    return f[String(id)]?.byMap?.[String(gm)]?.text;
  }
  const n = tw('news') as Record<string, Record<string, string>>;
  if (a === 'category') return n.category?.[b!];
  if (a === 'row') return n[b === 'tax' ? '11' : '23']?.row;
  return n[a]?.headline;
}

if (process.argv.includes('--check-locales')) {
  let bad = 0;
  for (const r of rows) {
    const got = localeOf(r.key);
    if (got !== r.tw) {
      bad++;
      console.log(`DIFF ${r.key} 原文=${JSON.stringify(r.tw)} 语言包=${JSON.stringify(got)}`);
    }
  }
  // 逐人行 12 / 13 与 11 同一个格式串
  const n = JSON.parse(readFileSync('apps/client/src/i18n/locales/zh-TW/news.json', 'utf8')) as Record<
    string,
    { row?: string }
  >;
  for (const id of ['12', '13'])
    if (n[id]?.row !== n['11']?.row) {
      bad++;
      console.log(`DIFF news.${id}.row ≠ news.11.row`);
    }
  console.log(`zh-TW 语言包与原文比对：${rows.length} 条，不一致 ${bad} 条`);
  process.exitCode = bad === 0 ? 0 : 1;
} else if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 1));
} else {
  for (const r of rows) {
    const ok = r.back === r.tw;
    console.log(
      `${ok ? 'OK ' : 'DIFF'} ${r.key.padEnd(18)} ${String(r.handler ?? '').padEnd(9)} ${r.str} ${r.voice ?? '    '} ${JSON.stringify(r.tw)}${ok ? '' : `  cn=${JSON.stringify(r.cn)} back=${JSON.stringify(r.back)}`}`,
    );
  }
  const bad = rows.filter((r) => r.back !== r.tw);
  console.log(`共 ${rows.length} 条，往返不一致 ${bad.length} 条`);
}
