// i18n 初始化（design/client.md §10.3、architecture §4「i18n」）：第一版只有 zh-CN。
// 角色名来自 characters.original.json；构建变量 VITE_NAMESET=alt 整体换成 characters.alt.json。
import i18next, { type i18n as I18n } from 'i18next';
import { initReactI18next } from 'react-i18next';
import cards from './locales/zh-CN/cards.json';
import charactersAlt from './locales/zh-CN/characters.alt.json';
import charactersOriginal from './locales/zh-CN/characters.original.json';
import events from './locales/zh-CN/events.json';
import fate from './locales/zh-CN/fate.json';
import game from './locales/zh-CN/game.json';
import gods from './locales/zh-CN/gods.json';
import items from './locales/zh-CN/items.json';
import magic from './locales/zh-CN/magic.json';
import minigames from './locales/zh-CN/minigames.json';
import news from './locales/zh-CN/news.json';
import tiles from './locales/zh-CN/tiles.json';
import ui from './locales/zh-CN/ui.json';

export type NameSet = 'original' | 'alt';
export const DEFAULT_LANG = 'zh-CN';

export const NAMESPACES = [
  'ui',
  'game',
  'cards',
  'items',
  'gods',
  'tiles',
  'events',
  'news',
  'fate',
  'magic',
  'minigames',
  'characters',
] as const;
export type Namespace = (typeof NAMESPACES)[number];

export const CHARACTER_NAMESETS = { original: charactersOriginal, alt: charactersAlt } as const;

export function zhCNResources(nameset: NameSet = 'original') {
  return {
    ui,
    game,
    cards,
    items,
    gods,
    tiles,
    events,
    news,
    fate,
    magic,
    minigames,
    characters: CHARACTER_NAMESETS[nameset],
  };
}

export type I18nResources = ReturnType<typeof zhCNResources>;

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'ui';
    resources: I18nResources;
  }
}

/** 构建期选择角色名文件（VITE_NAMESET=alt） */
export function buildNameSet(): NameSet {
  return import.meta.env.VITE_NAMESET === 'alt' ? 'alt' : 'original';
}

/** 同步初始化全局 i18next 实例（资源内联，无需异步加载）；重复调用只切换角色名集 */
export function initI18n(nameset: NameSet = buildNameSet()): I18n {
  const resources = { [DEFAULT_LANG]: zhCNResources(nameset) };
  if (i18next.isInitialized) {
    i18next.addResourceBundle(DEFAULT_LANG, 'characters', CHARACTER_NAMESETS[nameset], true, true);
    return i18next;
  }
  void i18next.use(initReactI18next).init({
    resources,
    lng: DEFAULT_LANG,
    fallbackLng: DEFAULT_LANG,
    ns: [...NAMESPACES],
    defaultNS: 'ui',
    interpolation: { escapeValue: false },
    returnNull: false,
    initAsync: false,
  });
  return i18next;
}
