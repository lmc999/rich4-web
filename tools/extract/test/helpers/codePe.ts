import { buildPe } from './buildPe';

/**
 * 测试专用：把一段代码与一段数据放进最小 PE32（代码节 AUTO 在 0x401000，数据节 DGROUP 紧随其后按 0x1000 对齐）。
 */

export const TEXT_VA = 0x401000;

export interface CodePeLayout {
  textVa: number;
  dataVa: number;
}

/** 数据节的 VA（代码长度 → 对齐后的数据节起点），供先写数据再写代码时预算 */
export function dataVaFor(textSize: number): number {
  return TEXT_VA + Math.ceil(Math.max(textSize, 1) / 0x1000) * 0x1000;
}

export function codePe(text: Uint8Array, data: Uint8Array, textSize = Math.max(text.length, 0x1000)): Uint8Array {
  const tSize = Math.ceil(textSize / 0x1000) * 0x1000;
  const dSize = Math.ceil(Math.max(data.length, 1) / 0x200) * 0x200;
  const textRaw = 0x400;
  const dataRaw = textRaw + tSize;
  const pe = buildPe(
    [
      {
        name: 'AUTO',
        virtualAddress: 0x1000,
        virtualSize: tSize,
        rawSize: tSize,
        rawPointer: textRaw,
        characteristics: 0x60000020,
      },
      {
        name: 'DGROUP',
        virtualAddress: 0x1000 + tSize,
        virtualSize: dSize,
        rawSize: dSize,
        rawPointer: dataRaw,
        characteristics: 0xc0000040,
      },
    ],
    { imageBase: 0x400000 },
  );
  // 代码节剩余部分用 int3 填充，避免 0 字节被解成 add [eax], al 与真实指令混在一起
  pe.fill(0xcc, textRaw, textRaw + tSize);
  pe.set(text, textRaw);
  pe.set(data, dataRaw);
  return pe;
}

/** 数据节写入器：按 VA 放置 u32 / 字节 / Big5 串 */
export class DataBuilder {
  readonly base: number;
  private readonly buf: number[] = [];

  constructor(base: number) {
    this.base = base;
  }

  get va(): number {
    return this.base + this.buf.length;
  }

  u8(...v: number[]): this {
    for (const x of v) this.buf.push(x & 0xff);
    return this;
  }

  u32(...v: number[]): this {
    for (const x of v) this.u8(x, x >>> 8, x >>> 16, x >>> 24);
    return this;
  }

  f64(v: number): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    return this.u8(...b);
  }

  f32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    return this.u8(...b);
  }

  bytes(b: ArrayLike<number>): this {
    for (let i = 0; i < b.length; i++) this.buf.push(b[i]!);
    return this;
  }

  align(n: number): this {
    while (this.buf.length % n !== 0) this.buf.push(0);
    return this;
  }

  /** 在 VA 处回填 u32 */
  patch32(va: number, v: number): this {
    const o = va - this.base;
    for (let k = 0; k < 4; k++) this.buf[o + k] = (v >>> (8 * k)) & 0xff;
    return this;
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}
