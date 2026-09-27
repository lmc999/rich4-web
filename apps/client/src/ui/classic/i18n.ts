// 经典画面（路线 A）的文案命名空间 classic：zh-CN 与 zh-TW（scripts/gen-zh-tw.ts 生成）两份都随本模块一起加载，
// 在 ClassicLayout 首次渲染前登记到 i18next（i18n/index.ts 的首屏命名空间表不含它：只有原版皮肤的对局页用得到）。
import i18next from 'i18next';
import zhCN from '../../i18n/locales/zh-CN/classic.json';
import zhTW from '../../i18n/locales/zh-TW/classic.json';

export const CLASSIC_NS = 'classic';

/** 登记 classic 命名空间（幂等；i18next 未初始化时跳过，初始化之后的下一次调用补上） */
export function ensureClassicI18n(): void {
  if (!i18next.isInitialized) return;
  if (!i18next.hasResourceBundle('zh-CN', CLASSIC_NS)) i18next.addResourceBundle('zh-CN', CLASSIC_NS, zhCN, true, true);
  if (!i18next.hasResourceBundle('zh-TW', CLASSIC_NS)) i18next.addResourceBundle('zh-TW', CLASSIC_NS, zhTW, true, true);
}

export const CLASSIC_BUNDLES = { 'zh-CN': zhCN, 'zh-TW': zhTW } as const;
