import { hexVa, normalizeText, type PeFile } from '../../pe/scan';
import type { CharacterRow, Check } from '../types';
import { chk, hintOf, namePtr, pointerPairSignature, recordHex, type TableSpec } from './common';

/**
 * 12 人角色模板表（v3.11 VA 0x47e80c），每项 0x68 字节 = 玩家结构体模板：
 * +0x00 u32 名称指针、+0x04 u32 颜色、+0x12 u8、+0x13 u8 编号 0..11、+0x14 u8 性别（1 男）、+0x15 u8、
 * +0x16 u8 能力位、+0x17 性格、+0x18 借贷比例、+0x19 现金比例、+0x1a 炒股比例；其余为 0（运行期字段）。
 * @source mytbk asm/rich4_player.h（玩家结构 0x68）；nurockplayer calendar-and-setup.md
 */

export const CHARACTER_COUNT = 12;
export const CHARACTER_STRIDE = 0x68;

function restZero(file: PeFile, at: number): boolean {
  const rec = file.slice(at, CHARACTER_STRIDE);
  for (let i = 0x08; i < CHARACTER_STRIDE; i++) {
    if (i >= 0x12 && i <= 0x1a) continue;
    if (rec[i] !== 0) return false;
  }
  return true;
}

export function parseCharacters(file: PeFile, va: number): CharacterRow[] {
  const rows: CharacterRow[] = [];
  for (let i = 0; i < CHARACTER_COUNT; i++) {
    const at = va + i * CHARACTER_STRIDE;
    const name = namePtr(file, at) ?? '';
    rows.push({
      id: file.u8(at + 0x13),
      name,
      nameNorm: normalizeText(name),
      color: `0x${file
        .u32(at + 4)
        .toString(16)
        .padStart(6, '0')}`,
      b12: file.u8(at + 0x12),
      gender: file.u8(at + 0x14),
      b15: file.u8(at + 0x15),
      abilities: file.u8(at + 0x16),
      personality: file.u8(at + 0x17),
      loanRatio: file.u8(at + 0x18),
      cashRatio: file.u8(at + 0x19),
      stockRatio: file.u8(at + 0x1a),
      restZero: restZero(file, at),
      hex: recordHex(file, at, CHARACTER_STRIDE),
    });
  }
  return rows;
}

export function validateCharacters(file: PeFile, va: number, names: readonly string[]): Check[] {
  if (file.tryVaToOff(va) === null || file.tryVaToOff(va + CHARACTER_COUNT * CHARACTER_STRIDE - 1) === null) {
    return [chk('characters.mapped', 'error', false, `${hexVa(va)} 起 12×0x68 字节不在已映射的节内`)];
  }
  const rows = parseCharacters(file, va);
  const out: Check[] = [];
  out.push(
    chk(
      'characters.signature',
      'error',
      rows[0]!.nameNorm === normalizeText(names[0]!) && rows[1]!.nameNorm === normalizeText(names[1]!),
      `前两项「${rows[0]!.name}」「${rows[1]!.name}」`,
    ),
  );
  const ids = rows.map((r) => r.id);
  out.push(
    chk(
      'characters.ids',
      'error',
      ids.every((v, i) => v === i),
      `+0x13 = [${ids.join(',')}]（期望 0..11）`,
    ),
  );
  const cash = rows.map((r) => r.cashRatio);
  out.push(
    chk(
      'characters.cashRange',
      'error',
      cash.every((c) => c >= 40 && c <= 80),
      `+0x19 现金比例 [${cash.join(',')}]`,
    ),
  );
  const pers = rows.map((r) => r.personality);
  out.push(
    chk(
      'characters.personality',
      'error',
      pers.every((p) => p <= 2),
      `+0x17 性格 [${pers.join(',')}]`,
    ),
  );
  const nonzero = rows.filter((r) => !r.restZero).map((r) => r.id);
  out.push(
    chk(
      'characters.restZero',
      'warn',
      nonzero.length === 0,
      nonzero.length === 0 ? '其余字节全为 0' : `角色 ${nonzero.join(',')} 的其余字节非 0`,
    ),
  );
  return out;
}

export const charactersSpec: TableSpec<CharacterRow[]> = {
  id: 'characters',
  xrefSpan: CHARACTER_STRIDE,
  hint: (ctx) => hintOf(ctx, ctx.anchors.tables.characters.hint),
  signature: (ctx) => pointerPairSignature(ctx, ctx.anchors.tables.characters.names, CHARACTER_STRIDE),
  validate: (file, va, ctx) => validateCharacters(file, va, ctx.anchors.tables.characters.names),
  parse: (file, va) => parseCharacters(file, va),
  byteLength: () => CHARACTER_COUNT * CHARACTER_STRIDE,
};
