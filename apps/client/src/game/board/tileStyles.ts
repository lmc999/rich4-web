// 特殊格底板的色块与中心字符（design/client.md §3.4）：命运黄「?」、新闻蓝、乐透粉、魔法屋紫「★」、卡片绿、银行金「$」、
// 游乐园三种小游戏橙、医院白底红十字、监狱灰。字符只是美术图标，正式名称走 i18n（tiles.kind.*）。
import type { TileKind } from '@rich4/shared/data';

export interface TileStyle {
  /** 底板颜色；null 表示不画底板 */
  plate: number | null;
  glyph: string;
  glyphColor: number;
}

export const TILE_STYLES: Readonly<Record<TileKind, TileStyle>> = {
  property: { plate: 0xf4ecd8, glyph: '', glyphColor: 0x3a2a1a },
  plain: { plate: null, glyph: '', glyphColor: 0x3a2a1a },
  park: { plate: 0xa8e07f, glyph: '园', glyphColor: 0x2f6b2a },
  news: { plate: 0x3d8bfd, glyph: '新', glyphColor: 0xffffff },
  fate: { plate: 0xffd84d, glyph: '?', glyphColor: 0x3a2a1a },
  jail: { plate: 0x8a93a6, glyph: '狱', glyphColor: 0xffffff },
  hospital: { plate: 0xffffff, glyph: '✚', glyphColor: 0xe8453c },
  penguin: { plate: 0xff9f43, glyph: '企', glyphColor: 0xffffff },
  balloon: { plate: 0xff9f43, glyph: '球', glyphColor: 0xffffff },
  xicong: { plate: 0xff9f43, glyph: '喜', glyphColor: 0xffffff },
  lottery: { plate: 0xf78fb3, glyph: '彩', glyphColor: 0xffffff },
  points50: { plate: 0x2ec4b6, glyph: '50', glyphColor: 0xffffff },
  points30: { plate: 0x2ec4b6, glyph: '30', glyphColor: 0xffffff },
  points10: { plate: 0x2ec4b6, glyph: '10', glyphColor: 0xffffff },
  card: { plate: 0x27ae60, glyph: '卡', glyphColor: 0xffffff },
  bank: { plate: 0xf2b705, glyph: '$', glyphColor: 0x3a2a1a },
  shop: { plate: 0xff6f91, glyph: '购', glyphColor: 0xffffff },
  magic: { plate: 0x9b6bff, glyph: '★', glyphColor: 0xffffff },
};

/** 所有底板字符（预载字体分片用） */
export const TILE_GLYPHS = [...new Set(Object.values(TILE_STYLES).map((s) => s.glyph))].join('');
