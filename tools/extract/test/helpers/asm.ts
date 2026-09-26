/**
 * 测试专用：极简 x86-32 汇编器（只覆盖合成 exe 需要的指令），支持标签与 rel32 回填。
 * 生成的全是本项目自拟的代码，与原版无关。
 */

export const REG = { eax: 0, ecx: 1, edx: 2, ebx: 3, esp: 4, ebp: 5, esi: 6, edi: 7 } as const;
export type Reg = keyof typeof REG;

type Target = string | number;

export class Asm {
  readonly base: number;
  private readonly out: number[] = [];
  private readonly labels = new Map<string, number>();
  private readonly fixups: { at: number; target: Target }[] = [];

  constructor(base: number) {
    this.base = base;
  }

  get va(): number {
    return this.base + this.out.length;
  }

  label(name: string): this {
    this.labels.set(name, this.va);
    return this;
  }

  addr(name: string): number {
    const v = this.labels.get(name);
    if (v === undefined) throw new Error(`未定义标签 ${name}`);
    return v;
  }

  bytes(...b: number[]): this {
    for (const x of b) this.out.push(x & 0xff);
    return this;
  }

  u32(v: number): this {
    return this.bytes(v, v >>> 8, v >>> 16, v >>> 24);
  }

  private rel32(target: Target): this {
    this.fixups.push({ at: this.out.length, target });
    return this.u32(0);
  }

  // ── 指令
  pushImm(v: number): this {
    return v >= -128 && v <= 127 ? this.bytes(0x6a, v) : this.bytes(0x68).u32(v);
  }
  pushReg(r: Reg): this {
    return this.bytes(0x50 + REG[r]);
  }
  popReg(r: Reg): this {
    return this.bytes(0x58 + REG[r]);
  }
  movRegImm(r: Reg, v: number): this {
    return this.bytes(0xb8 + REG[r]).u32(v);
  }
  movRegMem(r: Reg, addr: number): this {
    return this.bytes(0x8b, (REG[r] << 3) | 5).u32(addr);
  }
  movMemReg(addr: number, r: Reg): this {
    return this.bytes(0x89, (REG[r] << 3) | 5).u32(addr);
  }
  movRegReg(dst: Reg, src: Reg): this {
    return this.bytes(0x89, 0xc0 | (REG[src] << 3) | REG[dst]);
  }
  /** mov r, dword [base + disp32]（base ≠ esp） */
  movRegBaseDisp(r: Reg, base: Reg, disp: number): this {
    return this.bytes(0x8b, 0x80 | (REG[r] << 3) | REG[base]).u32(disp);
  }
  /** mov al, byte [base + disp32] */
  movAlBaseDisp(base: Reg, disp: number): this {
    return this.bytes(0x8a, 0x80 | REG[base]).u32(disp);
  }
  andAlImm(v: number): this {
    return this.bytes(0x24, v);
  }
  cmpAlImm(v: number): this {
    return this.bytes(0x3c, v);
  }
  shl(r: Reg, n: number): this {
    return this.bytes(0xc1, 0xe0 | REG[r], n);
  }
  addRegReg(dst: Reg, src: Reg): this {
    return this.bytes(0x01, 0xc0 | (REG[src] << 3) | REG[dst]);
  }
  subRegReg(dst: Reg, src: Reg): this {
    return this.bytes(0x29, 0xc0 | (REG[src] << 3) | REG[dst]);
  }
  cmpRegImm(r: Reg, v: number): this {
    return this.bytes(0x83, 0xf8 | REG[r], v);
  }
  subEsp(n: number): this {
    return this.bytes(0x81, 0xec).u32(n);
  }
  addEsp(n: number): this {
    return this.bytes(0x81, 0xc4).u32(n);
  }
  /** cmp dword [esp + off], 0（off < 0x80 用 disp8，否则 disp32：两版栈帧不同会改变编码长度） */
  cmpArg0(off: number): this {
    return off < 0x80 ? this.bytes(0x83, 0x7c, 0x24, off, 0) : this.bytes(0x83, 0xbc, 0x24).u32(off).bytes(0);
  }
  fmulQword(addr: number): this {
    return this.bytes(0xdc, 0x0d).u32(addr);
  }
  /** jmp dword [reg*4 + table] */
  jmpTable(r: Reg, table: number): this {
    return this.bytes(0xff, 0x24, 0x85 | (REG[r] << 3)).u32(table);
  }
  call(t: Target): this {
    return this.bytes(0xe8).rel32(t);
  }
  jmp(t: Target): this {
    return this.bytes(0xe9).rel32(t);
  }
  /** jcc rel32：cc 为条件码 0..15（5 = ne，7 = a） */
  jcc(cc: number, t: Target): this {
    return this.bytes(0x0f, 0x80 + cc).rel32(t);
  }
  ret(): this {
    return this.bytes(0xc3);
  }
  nop(n = 1): this {
    for (let i = 0; i < n; i++) this.bytes(0x90);
    return this;
  }
  /** 对齐填充（int3） */
  align(n: number): this {
    while (this.out.length % n !== 0) this.bytes(0xcc);
    return this;
  }

  finish(): Uint8Array {
    const buf = Uint8Array.from(this.out);
    const dv = new DataView(buf.buffer);
    for (const f of this.fixups) {
      const t = typeof f.target === 'number' ? f.target : this.addr(f.target);
      dv.setInt32(f.at, t - (this.base + f.at + 4), true);
    }
    return buf;
  }
}
