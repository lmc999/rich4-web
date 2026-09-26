/**
 * IA-32（32 位保护模式）指令解码器，零依赖（data-pipeline.md §6.4 funcdiff、§6.2 常量锚点）。
 * 覆盖 Watcom C 生成代码用到的整数指令、0F 双字节表与 x87；只做「长度 + 操作数」解码，不做语义执行。
 * 用途：按指令边界构造跨版本迁移模式、读取立即数 / 内存操作数、函数级规范化比较。
 * 未知或非法编码返回 mnem = '(bad)'、len = 1，由调用方决定是否停止。
 */

export type Reg32 = 'eax' | 'ecx' | 'edx' | 'ebx' | 'esp' | 'ebp' | 'esi' | 'edi';

const R32: readonly Reg32[] = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
const R16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'] as const;
const R8 = ['al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh'] as const;
const SREG = ['es', 'cs', 'ss', 'ds', 'fs', 'gs', 'sr6', 'sr7'] as const;
const CC = ['o', 'no', 'b', 'ae', 'e', 'ne', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g'] as const;

export type RegOperand = { t: 'reg'; name: string; size: number };
export type ImmOperand = { t: 'imm'; value: number; size: number /** 立即数在指令内的字节偏移 */; off: number };
export type MemOperand = {
  t: 'mem';
  /** 访问宽度（字节）；0 = 不访问内存（lea）或未知 */
  size: number;
  base: Reg32 | null;
  index: Reg32 | null;
  scale: number;
  /** 有符号位移（disp32 按 u32 解释为映像地址时用 dispU） */
  disp: number;
  dispU: number;
  /** 位移在指令内的字节偏移与宽度；没有位移时 off = -1、size = 0 */
  dispOff: number;
  dispSize: number;
  seg: string | null;
};
export type RelOperand = { t: 'rel'; target: number; size: number; off: number };
export type Operand = RegOperand | ImmOperand | MemOperand | RelOperand;

export interface Insn {
  va: number;
  len: number;
  mnem: string;
  ops: Operand[];
  /** 指令原始字节（输入缓冲的子视图，只读） */
  bytes: Uint8Array;
}

/** 控制流类别 */
export type FlowKind = 'seq' | 'jmp' | 'jcc' | 'call' | 'ret' | 'ijmp' | 'icall' | 'stop';

// ───────────────────────── 操作数描述 ─────────────────────────
// E? = ModRM r/m，G? = ModRM reg，I? = 立即数，J? = 相对跳转，O? = moffs，M = 仅内存
// 宽度后缀：b = 8，w = 16，d = 32，v = 16/32（随 0x66），z = 16/32 立即数，p = far 指针
type Spec =
  | 'Eb'
  | 'Ew'
  | 'Ed'
  | 'Ev'
  | 'Gb'
  | 'Gw'
  | 'Gv'
  | 'Ib'
  | 'Isb'
  | 'Iw'
  | 'Iz'
  | 'Iv'
  | 'Jb'
  | 'Jz'
  | 'Ob'
  | 'Ov'
  | 'M'
  | 'Mp'
  | 'Sw'
  | 'AL'
  | 'CL'
  | 'DX'
  | 'eAX'
  | '1'
  | `r8:${number}`
  | `rv:${number}`
  | `seg:${number}`
  | 'Ap'
  | 'Cd'
  | 'Dd'
  | 'Rd';

interface Entry {
  m: string;
  ops: readonly Spec[];
}

const e = (m: string, ...ops: Spec[]): Entry => ({ m, ops });

const ONE: (Entry | null)[] = new Array(256).fill(null);
const ALU = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'] as const;
for (const [i, m] of ALU.entries()) {
  const b = i << 3;
  ONE[b] = e(m, 'Eb', 'Gb');
  ONE[b + 1] = e(m, 'Ev', 'Gv');
  ONE[b + 2] = e(m, 'Gb', 'Eb');
  ONE[b + 3] = e(m, 'Gv', 'Ev');
  ONE[b + 4] = e(m, 'AL', 'Ib');
  ONE[b + 5] = e(m, 'eAX', 'Iz');
}
ONE[0x06] = e('push', 'seg:0');
ONE[0x07] = e('pop', 'seg:0');
ONE[0x0e] = e('push', 'seg:1');
ONE[0x16] = e('push', 'seg:2');
ONE[0x17] = e('pop', 'seg:2');
ONE[0x1e] = e('push', 'seg:3');
ONE[0x1f] = e('pop', 'seg:3');
ONE[0x27] = e('daa');
ONE[0x2f] = e('das');
ONE[0x37] = e('aaa');
ONE[0x3f] = e('aas');
for (let r = 0; r < 8; r++) {
  ONE[0x40 + r] = e('inc', `rv:${r}`);
  ONE[0x48 + r] = e('dec', `rv:${r}`);
  ONE[0x50 + r] = e('push', `rv:${r}`);
  ONE[0x58 + r] = e('pop', `rv:${r}`);
  ONE[0xb0 + r] = e('mov', `r8:${r}`, 'Ib');
  ONE[0xb8 + r] = e('mov', `rv:${r}`, 'Iv');
  if (r > 0) ONE[0x90 + r] = e('xchg', 'eAX', `rv:${r}`);
}
ONE[0x60] = e('pushal');
ONE[0x61] = e('popal');
ONE[0x62] = e('bound', 'Gv', 'M');
ONE[0x63] = e('arpl', 'Ew', 'Gw');
ONE[0x68] = e('push', 'Iz');
ONE[0x69] = e('imul', 'Gv', 'Ev', 'Iz');
ONE[0x6a] = e('push', 'Isb');
ONE[0x6b] = e('imul', 'Gv', 'Ev', 'Isb');
ONE[0x6c] = e('insb');
ONE[0x6d] = e('insd');
ONE[0x6e] = e('outsb');
ONE[0x6f] = e('outsd');
for (let c = 0; c < 16; c++) ONE[0x70 + c] = e(`j${CC[c]}`, 'Jb');
ONE[0x80] = e('grp1', 'Eb', 'Ib');
ONE[0x81] = e('grp1', 'Ev', 'Iz');
ONE[0x82] = e('grp1', 'Eb', 'Ib');
ONE[0x83] = e('grp1', 'Ev', 'Isb');
ONE[0x84] = e('test', 'Eb', 'Gb');
ONE[0x85] = e('test', 'Ev', 'Gv');
ONE[0x86] = e('xchg', 'Eb', 'Gb');
ONE[0x87] = e('xchg', 'Ev', 'Gv');
ONE[0x88] = e('mov', 'Eb', 'Gb');
ONE[0x89] = e('mov', 'Ev', 'Gv');
ONE[0x8a] = e('mov', 'Gb', 'Eb');
ONE[0x8b] = e('mov', 'Gv', 'Ev');
ONE[0x8c] = e('mov', 'Ew', 'Sw');
ONE[0x8d] = e('lea', 'Gv', 'M');
ONE[0x8e] = e('mov', 'Sw', 'Ew');
ONE[0x8f] = e('pop', 'Ev');
ONE[0x90] = e('nop');
ONE[0x98] = e('cwde');
ONE[0x99] = e('cdq');
ONE[0x9a] = e('callf', 'Ap');
ONE[0x9b] = e('wait');
ONE[0x9c] = e('pushfd');
ONE[0x9d] = e('popfd');
ONE[0x9e] = e('sahf');
ONE[0x9f] = e('lahf');
ONE[0xa0] = e('mov', 'AL', 'Ob');
ONE[0xa1] = e('mov', 'eAX', 'Ov');
ONE[0xa2] = e('mov', 'Ob', 'AL');
ONE[0xa3] = e('mov', 'Ov', 'eAX');
ONE[0xa4] = e('movsb');
ONE[0xa5] = e('movsd');
ONE[0xa6] = e('cmpsb');
ONE[0xa7] = e('cmpsd');
ONE[0xa8] = e('test', 'AL', 'Ib');
ONE[0xa9] = e('test', 'eAX', 'Iz');
ONE[0xaa] = e('stosb');
ONE[0xab] = e('stosd');
ONE[0xac] = e('lodsb');
ONE[0xad] = e('lodsd');
ONE[0xae] = e('scasb');
ONE[0xaf] = e('scasd');
ONE[0xc0] = e('grp2', 'Eb', 'Ib');
ONE[0xc1] = e('grp2', 'Ev', 'Ib');
ONE[0xc2] = e('ret', 'Iw');
ONE[0xc3] = e('ret');
ONE[0xc4] = e('les', 'Gv', 'Mp');
ONE[0xc5] = e('lds', 'Gv', 'Mp');
ONE[0xc6] = e('mov', 'Eb', 'Ib');
ONE[0xc7] = e('mov', 'Ev', 'Iz');
ONE[0xc8] = e('enter', 'Iw', 'Ib');
ONE[0xc9] = e('leave');
ONE[0xca] = e('retf', 'Iw');
ONE[0xcb] = e('retf');
ONE[0xcc] = e('int3');
ONE[0xcd] = e('int', 'Ib');
ONE[0xce] = e('into');
ONE[0xcf] = e('iretd');
ONE[0xd0] = e('grp2', 'Eb', '1');
ONE[0xd1] = e('grp2', 'Ev', '1');
ONE[0xd2] = e('grp2', 'Eb', 'CL');
ONE[0xd3] = e('grp2', 'Ev', 'CL');
ONE[0xd4] = e('aam', 'Ib');
ONE[0xd5] = e('aad', 'Ib');
ONE[0xd6] = e('salc');
ONE[0xd7] = e('xlatb');
ONE[0xe0] = e('loopne', 'Jb');
ONE[0xe1] = e('loope', 'Jb');
ONE[0xe2] = e('loop', 'Jb');
ONE[0xe3] = e('jecxz', 'Jb');
ONE[0xe4] = e('in', 'AL', 'Ib');
ONE[0xe5] = e('in', 'eAX', 'Ib');
ONE[0xe6] = e('out', 'Ib', 'AL');
ONE[0xe7] = e('out', 'Ib', 'eAX');
ONE[0xe8] = e('call', 'Jz');
ONE[0xe9] = e('jmp', 'Jz');
ONE[0xea] = e('jmpf', 'Ap');
ONE[0xeb] = e('jmp', 'Jb');
ONE[0xec] = e('in', 'AL', 'DX');
ONE[0xed] = e('in', 'eAX', 'DX');
ONE[0xee] = e('out', 'DX', 'AL');
ONE[0xef] = e('out', 'DX', 'eAX');
ONE[0xf1] = e('int1');
ONE[0xf4] = e('hlt');
ONE[0xf5] = e('cmc');
ONE[0xf6] = e('grp3', 'Eb');
ONE[0xf7] = e('grp3', 'Ev');
ONE[0xf8] = e('clc');
ONE[0xf9] = e('stc');
ONE[0xfa] = e('cli');
ONE[0xfb] = e('sti');
ONE[0xfc] = e('cld');
ONE[0xfd] = e('std');
ONE[0xfe] = e('grp4', 'Eb');
ONE[0xff] = e('grp5', 'Ev');

/** 需要 ModRM 字节的操作数描述 */
const MODRM_SPECS: ReadonlySet<Spec> = new Set<Spec>([
  'Eb',
  'Ew',
  'Ed',
  'Ev',
  'Gb',
  'Gw',
  'Gv',
  'M',
  'Mp',
  'Sw',
  'Cd',
  'Dd',
  'Rd',
]);

const TWO: (Entry | null)[] = new Array(256).fill(null);
// MMX/SSE（只在代码节里的数据区出现）：统一按「ModRM 操作数」解码长度，70..73、C2、C4..C6 另带 8 位立即数
for (const r of [
  [0x10, 0x17],
  [0x28, 0x2f],
  [0x50, 0x6f],
  [0x74, 0x7f],
  [0xd0, 0xfe],
] as const) {
  for (let b = r[0]; b <= r[1]; b++) TWO[b] = e('simd', 'Gv', 'Ev');
}
for (const b of [0x70, 0x71, 0x72, 0x73, 0xc2, 0xc4, 0xc5, 0xc6]) TWO[b] = e('simd', 'Gv', 'Ev', 'Ib');
TWO[0x00] = e('grp6', 'Ew');
TWO[0x01] = e('grp7', 'M');
TWO[0x02] = e('lar', 'Gv', 'Ew');
TWO[0x03] = e('lsl', 'Gv', 'Ew');
TWO[0x06] = e('clts');
TWO[0x08] = e('invd');
TWO[0x09] = e('wbinvd');
TWO[0x0b] = e('ud2');
TWO[0x1f] = e('nop', 'Ev');
TWO[0x20] = e('mov', 'Rd', 'Cd');
TWO[0x21] = e('mov', 'Rd', 'Dd');
TWO[0x22] = e('mov', 'Cd', 'Rd');
TWO[0x23] = e('mov', 'Dd', 'Rd');
TWO[0x30] = e('wrmsr');
TWO[0x31] = e('rdtsc');
TWO[0x32] = e('rdmsr');
for (let c = 0; c < 16; c++) {
  TWO[0x40 + c] = e(`cmov${CC[c]}`, 'Gv', 'Ev');
  TWO[0x80 + c] = e(`j${CC[c]}`, 'Jz');
  TWO[0x90 + c] = e(`set${CC[c]}`, 'Eb');
}
TWO[0xa0] = e('push', 'seg:4');
TWO[0xa1] = e('pop', 'seg:4');
TWO[0xa2] = e('cpuid');
TWO[0xa3] = e('bt', 'Ev', 'Gv');
TWO[0xa4] = e('shld', 'Ev', 'Gv', 'Ib');
TWO[0xa5] = e('shld', 'Ev', 'Gv', 'CL');
TWO[0xa8] = e('push', 'seg:5');
TWO[0xa9] = e('pop', 'seg:5');
TWO[0xab] = e('bts', 'Ev', 'Gv');
TWO[0xac] = e('shrd', 'Ev', 'Gv', 'Ib');
TWO[0xad] = e('shrd', 'Ev', 'Gv', 'CL');
TWO[0xaf] = e('imul', 'Gv', 'Ev');
TWO[0xb0] = e('cmpxchg', 'Eb', 'Gb');
TWO[0xb1] = e('cmpxchg', 'Ev', 'Gv');
TWO[0xb2] = e('lss', 'Gv', 'Mp');
TWO[0xb3] = e('btr', 'Ev', 'Gv');
TWO[0xb4] = e('lfs', 'Gv', 'Mp');
TWO[0xb5] = e('lgs', 'Gv', 'Mp');
TWO[0xb6] = e('movzx', 'Gv', 'Eb');
TWO[0xb7] = e('movzx', 'Gv', 'Ew');
TWO[0xba] = e('grp8', 'Ev', 'Ib');
TWO[0xbb] = e('btc', 'Ev', 'Gv');
TWO[0xbc] = e('bsf', 'Gv', 'Ev');
TWO[0xbd] = e('bsr', 'Gv', 'Ev');
TWO[0xbe] = e('movsx', 'Gv', 'Eb');
TWO[0xbf] = e('movsx', 'Gv', 'Ew');
TWO[0xc0] = e('xadd', 'Eb', 'Gb');
TWO[0xc1] = e('xadd', 'Ev', 'Gv');
for (let r = 0; r < 8; r++) TWO[0xc8 + r] = e('bswap', `rv:${r}`);

const GRP: Record<string, readonly (string | null)[]> = {
  grp1: ALU,
  grp2: ['rol', 'ror', 'rcl', 'rcr', 'shl', 'shr', 'sal', 'sar'],
  grp3: ['test', 'test', 'not', 'neg', 'mul', 'imul', 'div', 'idiv'],
  grp4: ['inc', 'dec', null, null, null, null, null, null],
  grp5: ['inc', 'dec', 'call', 'callf', 'jmp', 'jmpf', 'push', null],
  grp6: ['sldt', 'str', 'lldt', 'ltr', 'verr', 'verw', null, null],
  grp7: ['sgdt', 'sidt', 'lgdt', 'lidt', 'smsw', null, 'lmsw', 'invlpg'],
  grp8: [null, null, null, null, 'bt', 'bts', 'btr', 'btc'],
};

// x87：[reg 字段] → 助记符；内存形式的访问宽度
const FPU_MEM: readonly (readonly [readonly (string | null)[], readonly number[]])[] = [
  [
    ['fadd', 'fmul', 'fcom', 'fcomp', 'fsub', 'fsubr', 'fdiv', 'fdivr'],
    [4, 4, 4, 4, 4, 4, 4, 4],
  ],
  [
    ['fld', null, 'fst', 'fstp', 'fldenv', 'fldcw', 'fnstenv', 'fnstcw'],
    [4, 0, 4, 4, 28, 2, 28, 2],
  ],
  [
    ['fiadd', 'fimul', 'ficom', 'ficomp', 'fisub', 'fisubr', 'fidiv', 'fidivr'],
    [4, 4, 4, 4, 4, 4, 4, 4],
  ],
  [
    ['fild', 'fisttp', 'fist', 'fistp', null, 'fld', null, 'fstp'],
    [4, 4, 4, 4, 0, 10, 0, 10],
  ],
  [
    ['fadd', 'fmul', 'fcom', 'fcomp', 'fsub', 'fsubr', 'fdiv', 'fdivr'],
    [8, 8, 8, 8, 8, 8, 8, 8],
  ],
  [
    ['fld', 'fisttp', 'fst', 'fstp', 'frstor', null, 'fnsave', 'fnstsw'],
    [8, 8, 8, 8, 108, 0, 108, 2],
  ],
  [
    ['fiadd', 'fimul', 'ficom', 'ficomp', 'fisub', 'fisubr', 'fidiv', 'fidivr'],
    [2, 2, 2, 2, 2, 2, 2, 2],
  ],
  [
    ['fild', 'fisttp', 'fist', 'fistp', 'fbld', 'fild', 'fbstp', 'fistp'],
    [2, 2, 2, 2, 10, 8, 10, 8],
  ],
];
const FPU_REG: readonly (readonly (string | null)[])[] = [
  ['fadd', 'fmul', 'fcom', 'fcomp', 'fsub', 'fsubr', 'fdiv', 'fdivr'],
  ['fld', 'fxch', null, null, null, null, null, null],
  ['fcmovb', 'fcmove', 'fcmovbe', 'fcmovu', null, null, null, null],
  ['fcmovnb', 'fcmovne', 'fcmovnbe', 'fcmovnu', null, 'fucomi', 'fcomi', null],
  ['fadd', 'fmul', 'fcom', 'fcomp', 'fsubr', 'fsub', 'fdivr', 'fdiv'],
  ['ffree', null, 'fst', 'fstp', 'fucom', 'fucomp', null, null],
  ['faddp', 'fmulp', null, null, 'fsubrp', 'fsubp', 'fdivrp', 'fdivp'],
  ['ffreep', null, null, null, null, 'fucomip', 'fcomip', null],
];
/** D9 /4../7 与 DA、DB、DE、DF 的特殊寄存器形式（完整第二字节） */
const FPU_SPECIAL: Record<number, string> = {
  55760: 'fnop',
  55776: 'fchs',
  55777: 'fabs',
  55780: 'ftst',
  55781: 'fxam',
  55784: 'fld1',
  55785: 'fldl2t',
  55786: 'fldl2e',
  55787: 'fldpi',
  55788: 'fldlg2',
  55789: 'fldln2',
  55790: 'fldz',
  55792: 'f2xm1',
  55793: 'fyl2x',
  55794: 'fptan',
  55795: 'fpatan',
  55796: 'fxtract',
  55797: 'fprem1',
  55798: 'fdecstp',
  55799: 'fincstp',
  55800: 'fprem',
  55801: 'fyl2xp1',
  55802: 'fsqrt',
  55803: 'fsincos',
  55804: 'frndint',
  55805: 'fscale',
  55806: 'fsin',
  55807: 'fcos',
  56041: 'fucompp',
  56290: 'fnclex',
  56291: 'fninit',
  57049: 'fcompp',
  57312: 'fnstsw',
};

// ───────────────────────── 解码 ─────────────────────────

const SEG_PREFIX: Record<number, string> = { 38: 'es', 46: 'cs', 54: 'ss', 62: 'ds', 100: 'fs', 101: 'gs' };

class Cursor {
  constructor(
    readonly buf: Uint8Array,
    readonly start: number,
    public pos: number,
    readonly end: number,
  ) {}
  get off(): number {
    return this.pos - this.start;
  }
  has(n: number): boolean {
    return this.pos + n <= this.end;
  }
  u8(): number {
    if (!this.has(1)) throw new RangeError('truncated');
    return this.buf[this.pos++]!;
  }
  i8(): number {
    const v = this.u8();
    return v >= 0x80 ? v - 0x100 : v;
  }
  u16(): number {
    const lo = this.u8();
    return lo | (this.u8() << 8);
  }
  u32(): number {
    const a = this.u8();
    const b = this.u8();
    const c = this.u8();
    const d = this.u8();
    return (a | (b << 8) | (c << 16) | (d << 24)) >>> 0;
  }
}

interface ModRM {
  mod: number;
  reg: number;
  rm: number;
}

function readModRM(c: Cursor): ModRM {
  const b = c.u8();
  return { mod: b >> 6, reg: (b >> 3) & 7, rm: b & 7 };
}

function memOperand(c: Cursor, m: ModRM, size: number, seg: string | null, addr16: boolean): MemOperand {
  let base: Reg32 | null = null;
  let index: Reg32 | null = null;
  let scale = 1;
  let disp = 0;
  let dispOff = -1;
  let dispSize = 0;
  if (addr16) {
    // 16 位寻址只求长度正确，寄存器组合记为 null（Watcom 32 位代码不用）
    if (m.mod === 0 && m.rm === 6) {
      dispOff = c.off;
      disp = c.u16();
      dispSize = 2;
    } else if (m.mod === 1) {
      dispOff = c.off;
      disp = c.i8();
      dispSize = 1;
    } else if (m.mod === 2) {
      dispOff = c.off;
      disp = c.u16();
      dispSize = 2;
    }
    return { t: 'mem', size, base, index, scale, disp, dispU: disp >>> 0, dispOff, dispSize, seg };
  }
  let rm = m.rm;
  if (rm === 4) {
    const sib = c.u8();
    scale = 1 << (sib >> 6);
    const idx = (sib >> 3) & 7;
    index = idx === 4 ? null : R32[idx]!;
    rm = sib & 7;
    if (rm === 5 && m.mod === 0) {
      dispOff = c.off;
      disp = c.u32() | 0;
      dispSize = 4;
    } else base = R32[rm]!;
  } else if (rm === 5 && m.mod === 0) {
    dispOff = c.off;
    disp = c.u32() | 0;
    dispSize = 4;
  } else base = R32[rm]!;
  if (m.mod === 1) {
    dispOff = c.off;
    disp = c.i8();
    dispSize = 1;
  } else if (m.mod === 2) {
    dispOff = c.off;
    disp = c.u32() | 0;
    dispSize = 4;
  }
  return { t: 'mem', size, base, index, scale, disp, dispU: disp >>> 0, dispOff, dispSize, seg };
}

const regName = (size: number, n: number): string =>
  size === 1 ? R8[n]! : size === 2 ? R16[n]! : size === 4 ? R32[n]! : `r${n}`;

/**
 * 解码 buf[pos..end) 处的一条指令；va 为该指令的虚拟地址（用于相对跳转目标）。
 * 越界或非法编码返回 mnem '(bad)'、len 1。
 */
export function decodeAt(buf: Uint8Array, pos: number, va: number, end = buf.length): Insn {
  try {
    return decodeInner(buf, pos, va, end);
  } catch {
    return { va, len: 1, mnem: '(bad)', ops: [], bytes: buf.subarray(pos, Math.min(end, pos + 1)) };
  }
}

function decodeInner(buf: Uint8Array, pos: number, va: number, end: number): Insn {
  const c = new Cursor(buf, pos, pos, end);
  let opsize = 4;
  let addr16 = false;
  let seg: string | null = null;
  let rep: string | null = null;
  let lock = false;
  let op = c.u8();
  for (let guard = 0; guard < 15; guard++) {
    if (op === 0x66) opsize = 2;
    else if (op === 0x67) addr16 = true;
    else if (op === 0xf2) rep = 'repne';
    else if (op === 0xf3) rep = 'rep';
    else if (op === 0xf0) lock = true;
    else if (SEG_PREFIX[op] !== undefined) seg = SEG_PREFIX[op]!;
    else break;
    op = c.u8();
  }
  let entry: Entry | null;
  let fpu = false;
  if (op === 0x0f) {
    const op2 = c.u8();
    entry = TWO[op2] ?? null;
  } else if (op >= 0xd8 && op <= 0xdf) {
    entry = null;
    fpu = true;
  } else entry = ONE[op] ?? null;

  const ops: Operand[] = [];
  let mnem: string;
  if (fpu) {
    const m = readModRM(c);
    const k = op - 0xd8;
    if (m.mod !== 3) {
      const [names, sizes] = FPU_MEM[k]!;
      const n = names[m.reg];
      if (n === null || n === undefined) throw new Error('bad fpu');
      mnem = n;
      ops.push(memOperand(c, m, sizes[m.reg]!, seg, addr16));
    } else {
      const special = FPU_SPECIAL[(op << 8) | (0xc0 | (m.reg << 3) | m.rm)];
      if (special) {
        mnem = special;
        if (special === 'fnstsw') ops.push({ t: 'reg', name: 'ax', size: 2 });
      } else {
        const n = FPU_REG[k]![m.reg];
        if (n === null || n === undefined) throw new Error('bad fpu');
        mnem = n;
        ops.push({ t: 'reg', name: `st(${m.rm})`, size: 10 });
      }
    }
  } else {
    if (!entry) throw new Error('bad opcode');
    mnem = entry.m;
    let modrm: ModRM | null = null;
    const needsModrm = entry.ops.some((s) => MODRM_SPECS.has(s)) || GRP[mnem] !== undefined;
    if (needsModrm) modrm = readModRM(c);
    // C6/C7（mov r/m, imm）与 8F（pop r/m）只有 /0 合法；8C/8E 的段寄存器编号只有 0..5
    if ((op === 0xc6 || op === 0xc7 || op === 0x8f) && modrm!.reg !== 0) throw new Error('bad /r');
    if ((op === 0x8c || op === 0x8e) && modrm!.reg > 5) throw new Error('bad sreg');
    if (GRP[mnem]) {
      const n = GRP[mnem]![modrm!.reg];
      if (n === null || n === undefined) throw new Error('bad group');
      const grp = mnem;
      mnem = n;
      // grp3 的 test 带立即数；grp5 的 call/jmp 为间接；grp7 的 reg 形式不支持
      if (grp === 'grp3' && modrm!.reg <= 1) entry = { m: mnem, ops: [...entry.ops, op === 0xf6 ? 'Ib' : 'Iz'] };
      if (grp === 'grp5' && (mnem === 'callf' || mnem === 'jmpf')) entry = { m: mnem, ops: ['Mp'] };
      if (grp === 'grp7' && modrm!.mod === 3) throw new Error('grp7 reg form');
    }
    const imms: { spec: Spec }[] = [];
    for (const s of entry.ops) {
      switch (s) {
        case 'Eb':
        case 'Ew':
        case 'Ed':
        case 'Ev': {
          const size = s === 'Eb' ? 1 : s === 'Ew' ? 2 : s === 'Ed' ? 4 : opsize;
          ops.push(
            modrm!.mod === 3
              ? { t: 'reg', name: regName(size, modrm!.rm), size }
              : memOperand(c, modrm!, size, seg, addr16),
          );
          break;
        }
        case 'M':
        case 'Mp': {
          if (modrm!.mod === 3) throw new Error('memory operand expected');
          ops.push(memOperand(c, modrm!, s === 'Mp' ? 6 : mnem === 'lea' ? 0 : opsize, seg, addr16));
          break;
        }
        case 'Gb':
          ops.push({ t: 'reg', name: R8[modrm!.reg]!, size: 1 });
          break;
        case 'Gw':
          ops.push({ t: 'reg', name: R16[modrm!.reg]!, size: 2 });
          break;
        case 'Gv':
          ops.push({ t: 'reg', name: regName(opsize, modrm!.reg), size: opsize });
          break;
        case 'Sw':
          ops.push({ t: 'reg', name: SREG[modrm!.reg]!, size: 2 });
          break;
        case 'Cd':
          ops.push({ t: 'reg', name: `cr${modrm!.reg}`, size: 4 });
          break;
        case 'Dd':
          ops.push({ t: 'reg', name: `dr${modrm!.reg}`, size: 4 });
          break;
        case 'Rd':
          ops.push({ t: 'reg', name: R32[modrm!.rm]!, size: 4 });
          break;
        case 'AL':
          ops.push({ t: 'reg', name: 'al', size: 1 });
          break;
        case 'CL':
          ops.push({ t: 'reg', name: 'cl', size: 1 });
          break;
        case 'DX':
          ops.push({ t: 'reg', name: 'dx', size: 2 });
          break;
        case 'eAX':
          ops.push({ t: 'reg', name: regName(opsize, 0), size: opsize });
          break;
        case '1':
          ops.push({ t: 'imm', value: 1, size: 0, off: -1 });
          break;
        case 'Ob':
        case 'Ov': {
          const dispOff = c.off;
          const a = addr16 ? c.u16() : c.u32();
          ops.push({
            t: 'mem',
            size: s === 'Ob' ? 1 : opsize,
            base: null,
            index: null,
            scale: 1,
            disp: a | 0,
            dispU: a >>> 0,
            dispOff,
            dispSize: addr16 ? 2 : 4,
            seg,
          });
          break;
        }
        case 'Ap': {
          const off = c.off;
          const a = opsize === 2 ? c.u16() : c.u32();
          c.u16();
          ops.push({ t: 'imm', value: a, size: opsize, off });
          break;
        }
        default:
          if (s.startsWith('r8:')) ops.push({ t: 'reg', name: R8[Number(s.slice(3))]!, size: 1 });
          else if (s.startsWith('rv:')) {
            const n = Number(s.slice(3));
            ops.push({ t: 'reg', name: regName(opsize, n), size: opsize });
          } else if (s.startsWith('seg:')) ops.push({ t: 'reg', name: SREG[Number(s.slice(4))]!, size: 2 });
          else imms.push({ spec: s });
      }
    }
    // 立即数与相对位移总在 ModRM/SIB/disp 之后
    for (const { spec } of imms) {
      const off = c.off;
      switch (spec) {
        case 'Ib':
          ops.push({ t: 'imm', value: c.u8(), size: 1, off });
          break;
        case 'Isb':
          ops.push({ t: 'imm', value: c.i8(), size: 1, off });
          break;
        case 'Iw':
          ops.push({ t: 'imm', value: c.u16(), size: 2, off });
          break;
        case 'Iz':
        case 'Iv':
          ops.push(
            opsize === 2 ? { t: 'imm', value: c.u16(), size: 2, off } : { t: 'imm', value: c.u32() | 0, size: 4, off },
          );
          break;
        case 'Jb': {
          const d = c.i8();
          ops.push({ t: 'rel', target: (va + (c.pos - pos) + d) >>> 0, size: 1, off });
          break;
        }
        case 'Jz': {
          const d = opsize === 2 ? (c.u16() << 16) >> 16 : c.u32() | 0;
          ops.push({ t: 'rel', target: (va + (c.pos - pos) + d) >>> 0, size: opsize, off });
          break;
        }
        default:
          throw new Error(`unhandled spec ${spec}`);
      }
    }
    // 8 位立即数按操作宽度符号扩展后以无符号 32 位保存（Isb 已是有符号值，这里统一为「可读数值」）
  }
  if (rep && /^(movs|cmps|stos|lods|scas|ins|outs)/.test(mnem)) mnem = `${rep} ${mnem}`;
  if (lock) mnem = `lock ${mnem}`;
  const len = c.pos - pos;
  return { va, len, mnem, ops, bytes: buf.subarray(pos, pos + len) };
}

// ───────────────────────── 辅助 ─────────────────────────

export function flowOf(i: Insn): FlowKind {
  const m = i.mnem;
  if (m === '(bad)' || m === 'hlt' || m === 'int3' || m === 'ud2') return 'stop';
  if (m === 'ret' || m === 'retf' || m === 'iretd') return 'ret';
  if (m === 'call') return i.ops[0]?.t === 'rel' ? 'call' : 'icall';
  if (m === 'callf') return 'icall';
  if (m === 'jmp') return i.ops[0]?.t === 'rel' ? 'jmp' : 'ijmp';
  if (m === 'jmpf') return 'ijmp';
  if (/^j/.test(m) || /^loop/.test(m)) return 'jcc';
  return 'seq';
}

export function relTarget(i: Insn): number | null {
  const o = i.ops[0];
  return o && o.t === 'rel' ? o.target : null;
}

const hex = (v: number): string => (v < 0 ? `-0x${(-v).toString(16)}` : `0x${v.toString(16)}`);
const SIZE_NAME: Record<number, string> = { 1: 'byte', 2: 'word', 4: 'dword', 6: 'fword', 8: 'qword', 10: 'tbyte' };

export function formatOperand(o: Operand): string {
  switch (o.t) {
    case 'reg':
      return o.name;
    case 'imm':
      return o.size === 4 && o.value < 0 ? hex(o.value >>> 0) : hex(o.value);
    case 'rel':
      return hex(o.target);
    case 'mem': {
      const parts: string[] = [];
      if (o.base) parts.push(o.base);
      if (o.index) parts.push(o.scale === 1 ? o.index : `${o.index}*${o.scale}`);
      let s = parts.join(' + ');
      if (o.dispSize > 0 || parts.length === 0) {
        const d = parts.length === 0 || (o.dispSize === 4 && o.disp >= 0x400000) ? hex(o.dispU) : hex(o.disp);
        s =
          parts.length === 0
            ? d
            : o.disp < 0 && !(o.dispSize === 4 && o.dispU >= 0x400000)
              ? `${s} - ${hex(-o.disp)}`
              : `${s} + ${d}`;
      }
      const sz = SIZE_NAME[o.size];
      return `${sz ? `${sz} ` : ''}${o.seg ? `${o.seg}:` : ''}[${s}]`;
    }
  }
}

/** Intel 语法文本（与 r2 输出大致相同，便于人工对照） */
export function formatInsn(i: Insn): string {
  return i.ops.length === 0 ? i.mnem : `${i.mnem} ${i.ops.map(formatOperand).join(', ')}`;
}

/** 立即数按「指令语义」读出的数值：push/mov 等 32 位立即数按有符号解释，8 位按操作数宽度符号扩展 */
export function immValue(o: ImmOperand): number {
  return o.value;
}
