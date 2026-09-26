import { hexVa, type PeFile } from '../../pe/scan';
import type { Check, DefaultIndex, LocateContext, TableId } from '../types';
import { chk, type TableSpec, u32SeqSignature } from './common';

/**
 * 开局三张表（u32 × 6）：总资金、游戏期限（天，0 = 无限）、胜利财富倍率（0 = 无）。
 * 默认档位：表的代码引用附近读写的全局下标变量（`mov eax,[idx]` / `mov [idx],ebx`），
 * 再看代码中 `mov dword [idx], imm32` 写入的立即数（新开局时的初始化）与变量的静态初值。
 * @source nurockplayer calendar-and-setup.md；v3.11 开局界面 0x404504、初始化 0x406de7
 */

export const SETUP_LEN = 6;
export type SetupKey = 'funds' | 'days' | 'wealthMultipliers';
export const SETUP_TABLES: Record<SetupKey, TableId> = {
  funds: 'setupFunds',
  days: 'setupDays',
  wealthMultipliers: 'setupWealth',
};

export function parseU32x6(file: PeFile, va: number): number[] {
  return Array.from({ length: SETUP_LEN }, (_, i) => file.u32(va + i * 4));
}

function decreasing(v: readonly number[]): boolean {
  return v.every((x, i) => i === 0 || x < v[i - 1]!);
}

export function validateSetup(file: PeFile, va: number, key: SetupKey): Check[] {
  if (file.kindOfVa(va) !== 'data' || file.tryVaToOff(va + SETUP_LEN * 4 - 1) === null) {
    return [chk(`setup.${key}.mapped`, 'error', false, `${hexVa(va)} 不在数据节`)];
  }
  const v = parseU32x6(file, va);
  const ok =
    key === 'funds'
      ? decreasing(v) && v[SETUP_LEN - 1]! > 0
      : v[0] === 0 && decreasing(v.slice(1)) && v[SETUP_LEN - 1]! > 0;
  return [
    chk(
      `setup.${key}.shape`,
      'error',
      ok,
      `[${v.join(',')}]（${key === 'funds' ? '严格递减、正数' : '首项 0 表示无限，其余严格递减'}）`,
    ),
  ];
}

const MODRM_ABS = new Set([0x05, 0x0d, 0x15, 0x1d, 0x25, 0x2d, 0x35, 0x3d]);

/**
 * 表引用点附近（前 24、后 16 字节）出现的「绝对地址内存操作数」（mov eax,[m] / mov [m],eax / mov r32,[m] / mov [m],r32），
 * 按距离加权计分（32 − 字节距离）：下标变量总是紧挨着表引用（`mov eax,[idx]; mov ecx,[eax*4+表]` 或循环后的 `mov [idx],ebx`）。
 */
function nearbyGlobals(file: PeFile, tableVa: number): Map<number, number> {
  const scores = new Map<number, number>();
  for (const ref of file.findU32InRange(tableVa, tableVa + 1, 'code')) {
    const off = file.vaToOff(ref.at);
    const from = Math.max(0, off - 24);
    const to = Math.min(file.bytes.length - 6, off + 16);
    const seen = new Set<number>();
    for (let i = from; i < to; i++) {
      const op = file.bytes[i]!;
      let dispAt = -1;
      if (op === 0xa1 || op === 0xa3) dispAt = i + 1;
      else if ((op === 0x8b || op === 0x89) && MODRM_ABS.has(file.bytes[i + 1]!)) dispAt = i + 2;
      if (dispAt < 0 || dispAt === off) continue;
      const m = file.reader.u32(dispAt);
      if (m === tableVa || file.kindOfVa(m) !== 'data' || seen.has(m)) continue;
      seen.add(m);
      scores.set(m, (scores.get(m) ?? 0) + Math.max(1, 32 - Math.abs(dispAt - off)));
    }
  }
  return scores;
}

/** `c7 05 <var> imm32` 的全部立即数 */
function immWrites(file: PeFile, va: number): number[] {
  const pat = new Uint8Array(6);
  pat[0] = 0xc7;
  pat[1] = 0x05;
  new DataView(pat.buffer).setUint32(2, va, true);
  const hits = file.findPattern({ bytes: pat, mask: new Uint8Array(6).fill(1) }, 'code');
  return [...new Set(hits.map((h) => file.u32(h + 6)))].sort((a, b) => a - b);
}

export function findDefaultIndex(file: PeFile, tableVa: number, values: readonly number[]): DefaultIndex {
  const scores = nearbyGlobals(file, tableVa);
  // 被引用次数最多、且其值落在 0..5 的变量（下标）
  const cands = [...scores.entries()]
    .filter(([m]) => {
      const off = file.tryVaToOff(m);
      return off !== null && file.reader.u32(off) < SETUP_LEN;
    })
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  if (cands.length === 0) {
    return { var: null, staticValue: null, immWrites: [], index: null, value: null, detail: '引用点附近没有下标变量' };
  }
  const [va, n] = cands[0]!;
  const tie = cands.length > 1 && cands[1]![1] === n;
  const staticValue = file.u32(va);
  const writes = immWrites(file, va);
  const index = writes.length === 1 ? writes[0]! : writes.length === 0 ? staticValue : null;
  const detail =
    `下标变量 ${hexVa(va)}（距离加权得分 ${n}${tie ? '，与其他变量并列' : ''}）；` +
    `静态初值 ${staticValue}；立即数写入 [${writes.join(',')}]`;
  return {
    var: hexVa(va),
    staticValue,
    immWrites: writes,
    index: tie ? null : index,
    value: tie || index === null ? null : (values[index] ?? null),
    detail,
  };
}

function setupSpec(key: SetupKey): TableSpec<number[]> {
  return {
    id: SETUP_TABLES[key],
    xrefSpan: SETUP_LEN * 4,
    hint: (ctx: LocateContext) => {
      if (ctx.edition === 'unknown') return null;
      const h = ctx.anchors.tables.setup.hint[ctx.edition];
      return h ? Number.parseInt(h[key], 16) : null;
    },
    signature: (ctx) => u32SeqSignature(ctx.file, ctx.anchors.tables.setup[key]),
    validate: (file, va) => validateSetup(file, va, key),
    parse: (file, va) => parseU32x6(file, va),
    byteLength: () => SETUP_LEN * 4,
  };
}

export const setupFundsSpec = setupSpec('funds');
export const setupDaysSpec = setupSpec('days');
export const setupWealthSpec = setupSpec('wealthMultipliers');
