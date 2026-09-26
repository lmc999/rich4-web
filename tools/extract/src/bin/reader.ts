import { ExtractError } from '../context';

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex))
    throw new ExtractError('E_HEX', `非法 hex 串（长度 ${hex.length}）`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 小端、按绝对偏移读取、带越界检查的只读视图。 */
export class BinReader {
  readonly bytes: Uint8Array;
  readonly label: string;
  private readonly view: DataView;

  constructor(bytes: Uint8Array, label = 'buffer') {
    this.bytes = bytes;
    this.label = label;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  inRange(off: number, size: number): boolean {
    return Number.isInteger(off) && Number.isInteger(size) && off >= 0 && size >= 0 && off + size <= this.length;
  }

  private check(off: number, size: number): void {
    if (!this.inRange(off, size)) {
      throw new ExtractError('E_OUT_OF_BOUNDS', `${this.label}: 读取 [${off}, +${size}) 越界（长度 ${this.length}）`);
    }
  }

  u8(off: number): number {
    this.check(off, 1);
    return this.view.getUint8(off);
  }

  i8(off: number): number {
    this.check(off, 1);
    return this.view.getInt8(off);
  }

  u16(off: number): number {
    this.check(off, 2);
    return this.view.getUint16(off, true);
  }

  i16(off: number): number {
    this.check(off, 2);
    return this.view.getInt16(off, true);
  }

  u32(off: number): number {
    this.check(off, 4);
    return this.view.getUint32(off, true);
  }

  i32(off: number): number {
    this.check(off, 4);
    return this.view.getInt32(off, true);
  }

  u8Array(off: number, n: number): number[] {
    this.check(off, n);
    return Array.from(this.bytes.subarray(off, off + n));
  }

  u16Array(off: number, n: number): number[] {
    this.check(off, n * 2);
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(this.view.getUint16(off + i * 2, true));
    return out;
  }

  /** 零拷贝子视图。 */
  slice(off: number, len: number): Uint8Array {
    this.check(off, len);
    return this.bytes.subarray(off, off + len);
  }

  hex(off: number, len: number): string {
    return toHex(this.slice(off, len));
  }

  isZero(off: number, len: number): boolean {
    return this.slice(off, len).every((b) => b === 0);
  }
}
