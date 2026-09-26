/** 测试专用：合成最小 PE32（只有头与节表，节内容为 0）。 */
export interface PeSectionSpec {
  name: string;
  virtualAddress: number;
  virtualSize: number;
  rawSize: number;
  rawPointer: number;
  /** 节属性（默认 0）：代码 0x60000020、已初始化数据 0xc0000040 */
  characteristics?: number;
}

export function buildPe(
  sections: readonly PeSectionSpec[],
  opts: { imageBase?: number; entryRva?: number } = {},
): Uint8Array {
  const peOff = 0x80;
  const optSize = 224;
  const secTable = peOff + 24 + optSize;
  const end = Math.max(secTable + sections.length * 40, ...sections.map((s) => s.rawPointer + s.rawSize));
  const out = new Uint8Array(end);
  const dv = new DataView(out.buffer);
  out[0] = 0x4d;
  out[1] = 0x5a;
  dv.setUint32(0x3c, peOff, true);
  dv.setUint32(peOff, 0x00004550, true);
  dv.setUint16(peOff + 4, 0x14c, true);
  dv.setUint16(peOff + 6, sections.length, true);
  dv.setUint16(peOff + 20, optSize, true);
  const opt = peOff + 24;
  dv.setUint16(opt, 0x10b, true);
  dv.setUint32(opt + 16, opts.entryRva ?? 0x1000, true);
  dv.setUint32(opt + 28, opts.imageBase ?? 0x400000, true);
  sections.forEach((s, i) => {
    const o = secTable + i * 40;
    for (let k = 0; k < Math.min(8, s.name.length); k++) out[o + k] = s.name.charCodeAt(k);
    dv.setUint32(o + 8, s.virtualSize, true);
    dv.setUint32(o + 12, s.virtualAddress, true);
    dv.setUint32(o + 16, s.rawSize, true);
    dv.setUint32(o + 20, s.rawPointer, true);
    dv.setUint32(o + 36, s.characteristics ?? 0, true);
  });
  return out;
}
