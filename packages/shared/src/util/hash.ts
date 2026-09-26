import { toBytes } from './utf8';

/** 字符串输入一律先按 UTF-8 编码 */
export type HashInput = string | Uint8Array;

const FNV32_OFFSET = 0x811c9dc5;
const FNV32_PRIME = 0x01000193;
const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;

export function fnv1a32(input: HashInput): number {
  const bytes = toBytes(input);
  let h = FNV32_OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    h = Math.imul(h ^ bytes[i]!, FNV32_PRIME);
  }
  return h >>> 0;
}

export function hex32(x: number): string {
  return (x >>> 0).toString(16).padStart(8, '0');
}

export function fnv1a32Hex(input: HashInput): string {
  return hex32(fnv1a32(input));
}

/** FNV-1a 64，返回 16 位小写 hex（BigInt 实现） */
export function fnv1a64(input: HashInput): string {
  const bytes = toBytes(input);
  let h = FNV64_OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    h = BigInt.asUintN(64, (h ^ BigInt(bytes[i]!)) * FNV64_PRIME);
  }
  return h.toString(16).padStart(16, '0');
}

/** murmur3 fmix32：uint32 上的双射 */
export function fmix32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * 把种子与若干整数键混合成一个 uint32（顺序敏感）。
 * mix32(x) 等于 fmix32(x)；AI 派生种子用 mix32(aiSeed, seat, …)，字符串键先做 fnv1a32。
 */
export function mix32(seed: number, ...keys: number[]): number {
  let h = fmix32(seed);
  for (const k of keys) {
    h = fmix32((Math.imul(h, 0x9e3779b1) ^ fmix32((k >>> 0) + 0x7f4a7c15)) >>> 0);
  }
  return h;
}

export const SPLITMIX32_GAMMA = 0x9e3779b9;

/** splitmix32 的输出函数（uint32 上的双射） */
export function splitmix32Mix(z: number): number {
  let t = z >>> 0;
  t ^= t >>> 16;
  t = Math.imul(t, 0x21f0aaad);
  t ^= t >>> 15;
  t = Math.imul(t, 0x735a2d97);
  t ^= t >>> 15;
  return t >>> 0;
}

/** 以 seed 为初始状态展开 count 个 uint32：第 i 个 = mix(seed + (i+1)·gamma) */
export function splitmix32(seed: number, count: number): number[] {
  const out: number[] = [];
  let s = seed >>> 0;
  for (let i = 0; i < count; i++) {
    s = (s + SPLITMIX32_GAMMA) >>> 0;
    out.push(splitmix32Mix(s));
  }
  return out;
}
