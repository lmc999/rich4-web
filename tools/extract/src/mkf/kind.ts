/**
 * MKF 资源类型判定（按魔数与大小规则；规格见 docs/research/original-assets/containers.md §2/§4.2/§5、sprites.md §0）。
 * 移植自 test/mkf-survey.ts 的 classify（本项目调研原型），判定顺序与调研统计一致。
 */

export type MkfKind = 'SPR' | 'SMP' | 'GND' | 'FLIC' | 'WAVE' | 'RAW16' | 'TEXT' | 'DATA' | 'EMPTY' | 'UNKNOWN';

export const MKF_KINDS: readonly MkfKind[] = [
  'SPR',
  'SMP',
  'GND',
  'FLIC',
  'WAVE',
  'RAW16',
  'TEXT',
  'DATA',
  'EMPTY',
  'UNKNOWN',
];

/** 判定所需的资源头之后前几个字节（解压后）；FLIC 需要 6 字节，WAVE 需要 12 字节 */
export const KIND_SNIFF_BYTES = 16;

/** FLC（Animator Pro）与 FLI 的魔数，位于 +4 */
export const FLC_MAGIC = 0xaf12;
export const FLI_MAGIC = 0xaf11;

/** RAW16（无头 RGB555）的 imageOffset：打包工具的怪癖，前 2 个像素不做格式转换 */
export const RAW16_IMAGE_OFFSET = 4;

export interface KindInput {
  rawSize: number;
  imageOffset: number;
  imageSize: number;
  /** 解压后内容的前缀（≥ KIND_SNIFF_BYTES 字节，或整个资源） */
  head: Uint8Array;
  /**
   * 解压后的完整内容；只在前缀无法判定、且可能是 TEXT 时才需要。
   * 传函数则按需调用；返回 null 表示拿不到（压缩流损坏），此时判为 UNKNOWN。
   */
  body?: Uint8Array | (() => Uint8Array | null);
}

function ascii4(b: Uint8Array, off: number): string {
  if (b.length < off + 4) return '';
  return String.fromCharCode(b[off]!, b[off + 1]!, b[off + 2]!, b[off + 3]!);
}

function u16(b: Uint8Array, off: number): number {
  return b[off]! | (b[off + 1]! << 8);
}

function u32(b: Uint8Array, off: number): number {
  return (b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24)) >>> 0;
}

const big5Strict = new TextDecoder('big5', { fatal: true });

/**
 * help.mkf 的 Big5 文本：没有 \t\n\r 与 NUL 以外的控制字节，至少有一个高位字节，且能严格解码。
 * 地图结构数据与区域图含大量小整数控制字节，不会误判。
 */
export function isBig5Text(p: Uint8Array): boolean {
  if (p.length === 0) return false;
  let hi = 0;
  for (const b of p) {
    if (b >= 0x80) hi++;
    else if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0) return false;
  }
  if (hi === 0) return false;
  try {
    big5Strict.decode(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 判定顺序：
 * 1. rawSize==0 → EMPTY（Effect #64–79）
 * 2. 'SPR\0' / 'SMP\0' / 'GND\0' 魔数
 * 3. +4 为 0xAF12/0xAF11 且 u32@0 == rawSize → FLIC
 * 4. 'RIFF'…'WAVE' → WAVE
 * 5. imageOffset==4 且 imageOffset+imageSize==rawSize（整段 16 位像素，无头）→ RAW16
 * 6. imageOffset==imageSize==0：Big5 文本 → TEXT，否则 DATA（地图结构、区域图）
 * 7. 其余 → UNKNOWN
 */
export function classifyMkfResource(input: KindInput): MkfKind {
  const { rawSize, imageOffset, imageSize, head } = input;
  if (rawSize === 0) return 'EMPTY';
  const tag = ascii4(head, 0);
  if (tag === 'SPR\0') return 'SPR';
  if (tag === 'SMP\0') return 'SMP';
  if (tag === 'GND\0') return 'GND';
  if (head.length >= 6) {
    const magic = u16(head, 4);
    if ((magic === FLC_MAGIC || magic === FLI_MAGIC) && u32(head, 0) === rawSize) return 'FLIC';
  }
  if (tag === 'RIFF' && ascii4(head, 8) === 'WAVE') return 'WAVE';
  if (imageSize > 0 && imageOffset === RAW16_IMAGE_OFFSET && imageOffset + imageSize === rawSize) return 'RAW16';
  if (imageOffset === 0 && imageSize === 0) {
    const body =
      typeof input.body === 'function' ? input.body() : (input.body ?? (head.length === rawSize ? head : null));
    if (body === null) return 'UNKNOWN';
    return isBig5Text(body) ? 'TEXT' : 'DATA';
  }
  return 'UNKNOWN';
}
