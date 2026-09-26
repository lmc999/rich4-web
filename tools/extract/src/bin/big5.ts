import { toHex } from './reader';

/** 原版名称字段：原始字节 hex（到第一个 NUL 为止）、严格解码文本、能否回编码成原字节。 */
export interface RawName {
  hex: string;
  text: string | null;
  roundtrip: boolean;
}

/** 定长名称字段的附加观察（不进 RawName，供结构检查用）。 */
export interface NameFieldInfo {
  name: RawName;
  /** 字段内找到了 NUL */
  terminated: boolean;
  /** NUL 之后仍有非 0 字节 */
  trailingGarbage: boolean;
}

const strictDecoder = new TextDecoder('big5', { fatal: true });

/** 严格解码；含非法序列时返回 null。 */
export function decodeBig5Strict(bytes: Uint8Array): string | null {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return null;
  }
}

/** WHATWG Big5 编码器：HKSCS 段（pointer < 5024）不参与编码。 */
const HKSCS_POINTER_LIMIT = (0xa1 - 0x81) * 157;
/** WHATWG 规定这几个码点取最后一个 pointer，其余取第一个。 */
const LAST_POINTER_CODEPOINTS = new Set([0x2550, 0x255e, 0x2561, 0x256a, 0x5341, 0x5345]);

let encodeTable: Map<number, number> | null = null;

/** 枚举全部双字节码建反向表：码点 → (lead << 8 | trail)。 */
function getEncodeTable(): Map<number, number> {
  if (encodeTable) return encodeTable;
  const table = new Map<number, number>();
  const pair = new Uint8Array(2);
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail > 0x7e && trail < 0xa1) continue;
      const pointer = (lead - 0x81) * 157 + (trail < 0x7f ? trail - 0x40 : trail - 0x62);
      if (pointer < HKSCS_POINTER_LIMIT) continue;
      pair[0] = lead;
      pair[1] = trail;
      const s = decodeBig5Strict(pair);
      if (s === null || s.length === 0) continue;
      const cp = s.codePointAt(0);
      if (cp === undefined || String.fromCodePoint(cp) !== s) continue;
      const code = (lead << 8) | trail;
      if (!table.has(cp) || LAST_POINTER_CODEPOINTS.has(cp)) table.set(cp, code);
    }
  }
  encodeTable = table;
  return table;
}

/** 按 WHATWG 规则回编码；有无法编码的字符时返回 null。 */
export function encodeBig5(text: string): Uint8Array | null {
  const table = getEncodeTable();
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x80) {
      out.push(cp);
      continue;
    }
    const code = table.get(cp);
    if (code === undefined) return null;
    out.push(code >> 8, code & 0xff);
  }
  return Uint8Array.from(out);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** 解码后再编码能否得到原字节（能发现 HKSCS/CP950 歧义字、重码字）。 */
export function big5Roundtrip(bytes: Uint8Array): boolean {
  const text = decodeBig5Strict(bytes);
  if (text === null) return false;
  const back = encodeBig5(text);
  return back !== null && sameBytes(back, bytes);
}

export function rawNameFromBytes(bytes: Uint8Array): RawName {
  const text = decodeBig5Strict(bytes);
  const back = text === null ? null : encodeBig5(text);
  return { hex: toHex(bytes), text, roundtrip: back !== null && sameBytes(back, bytes) };
}

/** 解析定长 C 字符串字段。 */
export function readNameField(field: Uint8Array): NameFieldInfo {
  const nul = field.indexOf(0);
  const terminated = nul >= 0;
  const end = terminated ? nul : field.length;
  const trailingGarbage = terminated && field.subarray(nul + 1).some((b) => b !== 0);
  return { name: rawNameFromBytes(field.subarray(0, end)), terminated, trailingGarbage };
}
