// 神明配色（光环、柔光、HUD 徽章）与好坏属性：纯数据，HUD 与演出 handler 直接引用，不牵连造型 SVG 代码。
import type { GodKind } from '@rich4/shared/engine';

/** 神明的配色：光环（附身时头顶、路上柔光）与 HUD 徽章 */
export interface GodPalette {
  aura: number;
  auraCss: string;
  /** 好神 / 坏神（光柱与音效的基调） */
  good: boolean;
  big: boolean;
  symbol: string;
}

export const GOD_PALETTES: Readonly<Record<GodKind, GodPalette>> = {
  1: { aura: 0xffd84d, auraCss: '#FFD84D', good: true, big: false, symbol: '财' },
  2: { aura: 0xffc21a, auraCss: '#FFC21A', good: true, big: true, symbol: '财' },
  3: { aura: 0xfff3b0, auraCss: '#FFE98A', good: true, big: false, symbol: '福' },
  4: { aura: 0xffe98a, auraCss: '#FFD95A', good: true, big: true, symbol: '福' },
  5: { aura: 0xb8bcc8, auraCss: '#B8BCC8', good: false, big: false, symbol: '穷' },
  6: { aura: 0x9aa0ae, auraCss: '#9AA0AE', good: false, big: true, symbol: '穷' },
  7: { aura: 0xb8a8d8, auraCss: '#B8A8D8', good: false, big: false, symbol: '衰' },
  8: { aura: 0x8e78c0, auraCss: '#8E78C0', good: false, big: true, symbol: '衰' },
  9: { aura: 0xbfe8ff, auraCss: '#BFE8FF', good: true, big: true, symbol: '✦' },
  10: { aura: 0xf2545b, auraCss: '#F2545B', good: false, big: true, symbol: '✖' },
  11: { aura: 0xe8c8a0, auraCss: '#E8C8A0', good: false, big: false, symbol: '犬' },
  12: { aura: 0xffe28a, auraCss: '#FFE28A', good: true, big: true, symbol: '土' },
  15: { aura: 0x9b6bff, auraCss: '#9B6BFF', good: false, big: true, symbol: '☠' },
};
