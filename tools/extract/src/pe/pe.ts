import { BinReader } from '../bin/reader';
import { ExtractError } from '../context';

export interface PeSection {
  name: string;
  /** RVA */
  virtualAddress: number;
  virtualSize: number;
  rawSize: number;
  rawPointer: number;
  characteristics: number;
}

export interface PeImage {
  machine: number;
  imageBase: number;
  entryRva: number;
  sections: PeSection[];
}

/** 已知的加壳/DRM 节名（SteamStub 为 .bind）。 */
export const SUSPICIOUS_SECTIONS: readonly string[] = ['.bind'];

/** 最小 PE32 解析：DOS 头 → e_lfanew → COFF → 可选头 → 节表。 */
export function parsePe(bytes: Uint8Array, label = 'pe'): PeImage {
  const r = new BinReader(bytes, label);
  if (r.length < 0x40 || r.u16(0) !== 0x5a4d) throw new ExtractError('E_PE_DOS', `${label}: 缺少 MZ 头`);
  const pe = r.u32(0x3c);
  if (!r.inRange(pe, 24) || r.u32(pe) !== 0x00004550)
    throw new ExtractError('E_PE_SIG', `${label}: 缺少 PE\\0\\0 签名`);
  const machine = r.u16(pe + 4);
  const nsec = r.u16(pe + 6);
  const optSize = r.u16(pe + 20);
  const opt = pe + 24;
  const magic = r.u16(opt);
  if (magic !== 0x10b)
    throw new ExtractError('E_PE_MAGIC', `${label}: 可选头 magic=0x${magic.toString(16)}，只支持 PE32`);
  const entryRva = r.u32(opt + 16);
  const imageBase = r.u32(opt + 28);
  const sections: PeSection[] = [];
  let s = opt + optSize;
  for (let i = 0; i < nsec; i++, s += 40) {
    const nameBytes = r.slice(s, 8);
    const nul = nameBytes.indexOf(0);
    sections.push({
      name: String.fromCharCode(...nameBytes.subarray(0, nul < 0 ? 8 : nul)),
      virtualSize: r.u32(s + 8),
      virtualAddress: r.u32(s + 12),
      rawSize: r.u32(s + 16),
      rawPointer: r.u32(s + 20),
      characteristics: r.u32(s + 36),
    });
  }
  return { machine, imageBase, entryRva, sections };
}

/** Watcom 链接的 exe 节 VirtualSize 常为 0，此时以 rawSize 为准。 */
function spanOf(s: PeSection): number {
  return s.virtualSize === 0 ? s.rawSize : s.virtualSize;
}

export function vaToOffset(pe: PeImage, va: number): number | null {
  const rva = va - pe.imageBase;
  for (const s of pe.sections) {
    if (rva >= s.virtualAddress && rva < s.virtualAddress + Math.min(spanOf(s), s.rawSize) && s.rawPointer !== 0) {
      return s.rawPointer + (rva - s.virtualAddress);
    }
  }
  return null;
}

export function offsetToVa(pe: PeImage, off: number): number | null {
  for (const s of pe.sections) {
    if (s.rawPointer !== 0 && off >= s.rawPointer && off < s.rawPointer + s.rawSize) {
      return pe.imageBase + s.virtualAddress + (off - s.rawPointer);
    }
  }
  return null;
}

export function suspiciousSections(pe: PeImage): string[] {
  return pe.sections.map((s) => s.name).filter((n) => SUSPICIOUS_SECTIONS.includes(n.toLowerCase()));
}
