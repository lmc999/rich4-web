import { hexVa, normalizeText, type PeFile } from '../../pe/scan';
import type { Check, LocateContext, ToolRow } from '../types';
import { CARD_COUNT, CARD_STRIDE } from './cards';
import { chk, hintOf, namePtr, pointerPairSignature, recordHex, type TableSpec } from './common';

/**
 * 道具表 13×8（紧随卡表，v3.11 VA 0x47fee2）：{ u32 名称指针, u8 共享库存, u8 点券价, u8 f6, u8 f7 }，编号 = 下标 + 1。
 * 前 8 种库存 10（商店有售），后 5 种（研究所产出）为 0。
 * @source mytbk asm/rich4_tool_table.c；docs/research/r_items.md
 */

export const TOOL_COUNT = 13;
export const TOOL_STRIDE = 8;
export const POOL_TOOLS = 8;
export const POOL_STOCK = 10;

export function parseTools(file: PeFile, va: number): ToolRow[] {
  const rows: ToolRow[] = [];
  for (let i = 0; i < TOOL_COUNT; i++) {
    const at = va + i * TOOL_STRIDE;
    rows.push({
      id: i + 1,
      name: namePtr(file, at) ?? '',
      stock: file.u8(at + 4),
      price: file.u8(at + 5),
      f6: file.u8(at + 6),
      f7: file.u8(at + 7),
      hex: recordHex(file, at, TOOL_STRIDE),
    });
  }
  return rows;
}

export function validateTools(file: PeFile, va: number, names: readonly string[]): Check[] {
  if (file.tryVaToOff(va) === null || file.tryVaToOff(va + TOOL_COUNT * TOOL_STRIDE - 1) === null) {
    return [chk('tools.mapped', 'error', false, `${hexVa(va)} 起 104 字节不在已映射的节内`)];
  }
  const rows = parseTools(file, va);
  const out: Check[] = [];
  const unnamed = rows.filter((r) => r.name === '');
  out.push(
    chk(
      'tools.names',
      'error',
      unnamed.length === 0,
      unnamed.length === 0 ? '13 个名称指针都能解码' : `无法解码：${unnamed.map((r) => `#${r.id}`).join('、')}`,
    ),
  );
  const first = rows.slice(0, 2).map((r) => normalizeText(r.name));
  out.push(
    chk('tools.signature', 'error', first[0] === names[0] && first[1] === names[1], `前两项「${first.join('」「')}」`),
  );
  const stocks = rows.map((r) => r.stock);
  const poolOk = stocks.every((s, i) => s === (i < POOL_TOOLS ? POOL_STOCK : 0));
  out.push(
    chk(
      'tools.stock',
      'error',
      poolOk,
      `库存 [${stocks.join(',')}]（期望前 ${POOL_TOOLS} 种为 ${POOL_STOCK}、其余 0）`,
    ),
  );
  return out;
}

export const toolsSpec: TableSpec<ToolRow[]> = {
  id: 'tools',
  xrefSpan: TOOL_COUNT * TOOL_STRIDE,
  hint: (ctx) => hintOf(ctx, ctx.anchors.tables.tools.hint),
  signature: (ctx: LocateContext) => {
    const cards = ctx.located.cards;
    if (cards !== undefined) {
      return { va: cards + CARD_COUNT * CARD_STRIDE, detail: `紧随卡表（${hexVa(cards)} + 240）` };
    }
    return pointerPairSignature(ctx, ctx.anchors.tables.tools.names, TOOL_STRIDE);
  },
  validate: (file, va, ctx) => validateTools(file, va, ctx.anchors.tables.tools.names),
  parse: (file, va) => parseTools(file, va),
  byteLength: () => TOOL_COUNT * TOOL_STRIDE,
};
