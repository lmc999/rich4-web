// i18n 初始化（design/client.md §10.3、architecture §4「i18n」）：zh-CN 内联；zh-TW（原版皮肤，original-skin.md U5）
// 由 scripts/gen-zh-tw.ts 从 zh-CN 生成并入库，切到原版皮肤时懒加载（setUiLanguage），缺的键回退到 zh-CN。
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
import hud from './locales/zh-CN/hud.json';
import items from './locales/zh-CN/items.json';
import lobby from './locales/zh-CN/lobby.json';
import magic from './locales/zh-CN/magic.json';
import minigames from './locales/zh-CN/minigames.json';
import news from './locales/zh-CN/news.json';
import tiles from './locales/zh-CN/tiles.json';
import ui from './locales/zh-CN/ui.json';

export type NameSet = 'original' | 'alt';
export const DEFAULT_LANG = 'zh-CN';
/** 界面语言：程序化皮肤 zh-CN、原版皮肤 zh-TW */
export const UI_LANGS = ['zh-CN', 'zh-TW'] as const;
export type UiLang = (typeof UI_LANGS)[number];

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
  'lobby',
  'hud',
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
    lobby,
    hud,
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

let currentNameSet: NameSet = 'original';

/** 同步初始化全局 i18next 实例（资源内联，无需异步加载）；重复调用只切换角色名集 */
export function initI18n(nameset: NameSet = buildNameSet()): I18n {
  currentNameSet = nameset;
  const resources = { [DEFAULT_LANG]: zhCNResources(nameset) };
  if (i18next.isInitialized) {
    i18next.addResourceBundle(DEFAULT_LANG, 'characters', CHARACTER_NAMESETS[nameset], true, true);
    if (zhTwLoaded) void loadZhTw();
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

// ───────────────────────── zh-TW（原版皮肤） ─────────────────────────

let zhTwLoaded = false;
let zhTwLoading: Promise<void> | null = null;
let wantedLang: UiLang = DEFAULT_LANG;

type ZhTwModule = typeof import('./locales/zh-TW/index');
const importZhTw = (): Promise<ZhTwModule> => import('./locales/zh-TW/index');
let zhTwImporter: () => Promise<ZhTwModule> = importZhTw;

/** 测试：替换 zh-TW 语言包的动态 import（null 恢复），并清掉「已加载」标记 */
export function setZhTwImporterForTest(fn: (() => Promise<ZhTwModule>) | null): void {
  zhTwImporter = fn ?? importZhTw;
  zhTwLoaded = false;
  zhTwLoading = null;
}

/** 加载（或按当前角色名集刷新）zh-TW 资源包 */
export function loadZhTw(): Promise<void> {
  const nameset = currentNameSet;
  const p = zhTwImporter().then((m) => {
    const res = m.zhTWResources(nameset);
    for (const [ns, bundle] of Object.entries(res)) i18next.addResourceBundle('zh-TW', ns, bundle, true, true);
    zhTwLoaded = true;
  });
  zhTwLoading = p;
  // 成败都清掉进行中的记录（失败时下次重试）；不能用 p.finally：它派生的 Promise 会带着失败成为未处理的 rejection
  const clear = (): void => {
    if (zhTwLoading === p) zhTwLoading = null;
  };
  p.then(clear, clear);
  return p;
}

/** 当前界面语言 */
export function uiLanguage(): UiLang {
  return i18next.language === 'zh-TW' ? 'zh-TW' : 'zh-CN';
}

/**
 * 切换界面语言（原版皮肤 → zh-TW、程序化 → zh-CN）。zh-TW 首次使用时懒加载语言包；
 * 连续切换时只生效最后一次请求。i18next 未初始化时只记下请求。
 * 返回 false 表示 zh-TW 语言包加载失败（保持原语言，调用方可在下次需要时重试）；其余情况返回 true。
 */
export async function setUiLanguage(lang: UiLang): Promise<boolean> {
  wantedLang = lang;
  if (!i18next.isInitialized) return true;
  if (lang === 'zh-TW' && !zhTwLoaded) {
    try {
      await (zhTwLoading ?? loadZhTw());
    } catch (e) {
      console.warn('[i18n] zh-TW 语言包加载失败，保持简体', e);
      return false;
    }
  }
  if (wantedLang !== lang) return true;
  if (i18next.language !== lang) await i18next.changeLanguage(lang);
  return true;
}

/** 界面语言切换之后回调（事件日志据此按新语言重排已有的行）；返回撤销函数 */
export function onUiLanguageChanged(cb: (lang: UiLang) => void): () => void {
  const h = (lng: string): void => cb(lng === 'zh-TW' ? 'zh-TW' : 'zh-CN');
  i18next.on('languageChanged', h);
  return () => i18next.off('languageChanged', h);
}
