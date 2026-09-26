/** IEEE-754 单精度位型工具（exe 里的股价、波动系数都是 f32）。 */

const buf = new DataView(new ArrayBuffer(4));

/** u32 位型 → f32 数值（以 JS double 表示，精确） */
export function f32FromBits(bits: number): number {
  buf.setUint32(0, bits >>> 0);
  return buf.getFloat32(0);
}

/** 数值 → f32 位型（先按 f32 舍入） */
export function f32Bits(x: number): number {
  buf.setFloat32(0, x);
  return buf.getUint32(0);
}

/** 8 位小写 hex（与 MapDef.StockDef.volatilityF32 同格式） */
export function f32BitsHex(bits: number): string {
  return (bits >>> 0).toString(16).padStart(8, '0');
}

/**
 * f32 的最短十进制表示：从 1 位有效数字起逐位加，直到按 f32 舍入后回到同一位型。
 * 例：0x3f19999a（0.6000000238…）→ 0.6。结果再经 f32 舍入必得原位型。
 */
export function f32Shortest(bits: number): number {
  const exact = f32FromBits(bits);
  if (!Number.isFinite(exact) || exact === 0) return exact;
  for (let p = 1; p <= 9; p++) {
    const v = Number(exact.toPrecision(p));
    if (f32Bits(v) === bits >>> 0) return v;
  }
  return exact;
}
