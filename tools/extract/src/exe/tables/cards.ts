import { hexVa, normalizeText, type PeFile } from '../../pe/scan';
import type { CardRow, Check, LocateContext } from '../types';
import { chk, hintOf, namePtr, pointerPairSignature, recordHex, type TableSpec } from './common';

/**
 * 卡片表 30×8（v3.11 VA 0x47fdf2）：{ u32 名称指针, u8 初始张数, u8 点券价, u8 f6, u8 f7 }，原版编号 = 下标 + 1。
 * @source mytbk asm/rich4_card_table.c；docs/research/r_cards.md
 */

export const CARD_COUNT = 30;
export const CARD_STRIDE = 8;
/** 牌堆初始张数之和 */
export const CARD_DECK_TOTAL = 100;

export function parseCards(file: PeFile, va: number): CardRow[] {
  const rows: CardRow[] = [];
  for (let i = 0; i < CARD_COUNT; i++) {
    const at = va + i * CARD_STRIDE;
    rows.push({
      id: i + 1,
      name: namePtr(file, at) ?? '',
      initCount: file.u8(at + 4),
      price: file.u8(at + 5),
      f6: file.u8(at + 6),
      f7: file.u8(at + 7),
      hex: recordHex(file, at, CARD_STRIDE),
    });
  }
  return rows;
}

export function validateCards(file: PeFile, va: number, names: readonly string[]): Check[] {
  const out: Check[] = [];
  if (file.tryVaToOff(va) === null || file.tryVaToOff(va + CARD_COUNT * CARD_STRIDE - 1) === null) {
    return [chk('cards.mapped', 'error', false, `${hexVa(va)} 起 240 字节不在已映射的节内`)];
  }
  const rows = parseCards(file, va);
  const bad = rows.filter((r) => !/[卡符]$/.test(r.name));
  out.push(
    chk(
      'cards.names',
      'error',
      bad.length === 0,
      bad.length === 0
        ? '30 个名称指针都指向以「卡」或「符」结尾的 Big5 串'
        : `名称异常：${bad.map((r) => `#${r.id}「${r.name}」`).join('、')}`,
    ),
  );
  const first = rows.slice(0, 2).map((r) => normalizeText(r.name));
  out.push(
    chk('cards.signature', 'error', first[0] === names[0] && first[1] === names[1], `前两项「${first.join('」「')}」`),
  );
  const total = rows.reduce((s, r) => s + r.initCount, 0);
  out.push(
    chk('cards.deckTotal', 'error', total === CARD_DECK_TOTAL, `初始张数之和 ${total}（期望 ${CARD_DECK_TOTAL}）`),
  );
  return out;
}

export const cardsSpec: TableSpec<CardRow[]> = {
  id: 'cards',
  xrefSpan: CARD_COUNT * CARD_STRIDE,
  hint: (ctx) => hintOf(ctx, ctx.anchors.tables.cards.hint),
  signature: (ctx) => pointerPairSignature(ctx, ctx.anchors.tables.cards.names, CARD_STRIDE),
  validate: (file, va, ctx: LocateContext) => validateCards(file, va, ctx.anchors.tables.cards.names),
  parse: (file, va) => parseCards(file, va),
  byteLength: () => CARD_COUNT * CARD_STRIDE,
};
