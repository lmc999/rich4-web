// 卡片与道具的展示属性（design/client.md §6.3）：卡框按类别配色，中间图标暂用系统 emoji（Fluent Emoji 素材接入前的占位）。
// 类别是纯展示分类，不参与规则。
import type { CardId, ItemId } from '@rich4/shared/engine';

/** 攻击红、防御蓝、经济金、移动绿、神仙紫、地产橙 */
export type CardCategory = 'attack' | 'defense' | 'economy' | 'move' | 'god' | 'property';

export const CARD_CATEGORY = {
  1: 'economy',
  2: 'attack',
  3: 'property',
  4: 'property',
  5: 'property',
  6: 'move',
  7: 'property',
  8: 'property',
  9: 'property',
  10: 'attack',
  11: 'attack',
  12: 'attack',
  13: 'attack',
  14: 'move',
  15: 'attack',
  16: 'attack',
  17: 'attack',
  18: 'defense',
  19: 'defense',
  20: 'defense',
  21: 'defense',
  22: 'god',
  23: 'god',
  24: 'economy',
  25: 'economy',
  26: 'attack',
  27: 'economy',
  28: 'attack',
  29: 'defense',
  30: 'move',
} as const satisfies { readonly [C in CardId]: CardCategory };

export const CARD_ICON = {
  1: '⚖️',
  2: '\u{1F4C9}',
  3: '\u{1F3F7}️',
  4: '\u{1F504}',
  5: '\u{1F3D8}️',
  6: '↩️',
  7: '\u{1F528}',
  8: '\u{1F528}',
  9: '\u{1F607}',
  10: '\u{1F608}',
  11: '\u{1F996}',
  12: '\u{1F6A7}',
  13: '\u{1F9E4}',
  14: '✋',
  15: '\u{1F4A4}',
  16: '\u{1F319}',
  17: '\u{1F46E}',
  18: '\u{1F4A2}',
  19: '\u{1F3AD}',
  20: '\u{1F193}',
  21: '\u{1F54A}️',
  22: '\u{1F4DC}',
  23: '\u{1F64F}',
  24: '\u{1F4C8}',
  25: '\u{1F4C9}',
  26: '\u{1F9FE}',
  27: '\u{1F4B8}',
  28: '\u{1F512}',
  29: '\u{1F91D}',
  30: '\u{1F422}',
} as const satisfies { readonly [C in CardId]: string };

export const ITEM_ICON = {
  1: '\u{1F916}',
  2: '\u{1F6A7}',
  3: '\u{1F4A5}',
  4: '\u{1F4A3}',
  5: '\u{1F6F5}',
  6: '\u{1F697}',
  7: '\u{1F680}',
  8: '\u{1F3B2}',
  9: '\u{1F477}',
  10: '⏳',
  11: '\u{1F300}',
  12: '\u{1F69C}',
  13: '☢️',
} as const satisfies { readonly [I in ItemId]: string };

/** 类别 → 卡框主色（CSS 变量，见 components.module.css） */
export const CATEGORY_COLOR: Readonly<Record<CardCategory, string>> = {
  attack: 'var(--c-red)',
  defense: 'var(--c-blue)',
  economy: 'var(--c-sun)',
  move: 'var(--c-green)',
  god: 'var(--c-purple)',
  property: 'var(--c-orange)',
};

/** 道具统一用青绿色卡框，研究所产物（9..13）用紫色 */
export function itemFrameColor(item: ItemId): string {
  return item >= 9 ? 'var(--c-purple)' : 'var(--c-sky-deep)';
}

export function cardCategory(card: CardId): CardCategory {
  return CARD_CATEGORY[card];
}

/** 玩家色（与 tokens.css 的 --c-p1..4 一致）与形状标记（色弱辅助） */
export const SEAT_COLOR_VARS = ['var(--c-p1)', 'var(--c-p2)', 'var(--c-p3)', 'var(--c-p4)'] as const;
export const SEAT_MARKS = ['●', '▲', '■', '★'] as const;
