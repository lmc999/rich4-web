// 原版皮肤的标题 / 开局 / 大厅画面（A14）的文案命名空间 classicScreens：zh-CN 与 zh-TW（scripts/gen-zh-tw.ts 生成）
// 两份随画面模块一起加载，首次渲染前登记到 i18next；同时登记经典外壳的 classic 命名空间（侧栏标签等）。
import i18next from 'i18next';
import zhCN from '../../../i18n/locales/zh-CN/classicScreens.json';
import zhTW from '../../../i18n/locales/zh-TW/classicScreens.json';
import { ensureClassicI18n } from '../i18n';

export const SCREENS_NS = 'classicScreens';

/** 登记 classicScreens 与 classic 命名空间（幂等；i18next 未初始化时跳过，之后的调用补上） */
export function ensureScreensI18n(): void {
  ensureClassicI18n();
  if (!i18next.isInitialized) return;
  if (!i18next.hasResourceBundle('zh-CN', SCREENS_NS)) i18next.addResourceBundle('zh-CN', SCREENS_NS, zhCN, true, true);
  if (!i18next.hasResourceBundle('zh-TW', SCREENS_NS)) i18next.addResourceBundle('zh-TW', SCREENS_NS, zhTW, true, true);
}

export const SCREENS_BUNDLES = { 'zh-CN': zhCN, 'zh-TW': zhTW } as const;
