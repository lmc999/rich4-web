// 皮肤的界面语言与主题（original-skin.md U5 与「默认项」的字体栈）：
// - 原版皮肤：界面、日志、弹窗文字一律繁体（zh-TW，语言包懒加载；已有的日志行在语言切换时按新语言重排，见 net/client.ts）；
//   <html data-skin="original">，语言包就绪、真正切到繁体后才设 lang="zh-TW"；
//   正文与标题字体栈 local('MingLiU') / local('PMingLiU')（本机細明體，不分发）→ Noto Serif TC → 系统宋体 / 明体；
// - 程序化皮肤：zh-CN，恢复原有字体变量。
// 仓库没有安装 @fontsource 的 Noto Serif TC，只用 local() 与系统字体（装了 Noto Serif TC 的系统会命中）。
import { setUiLanguage, type UiLang, uiLanguage } from '../i18n';
import type { SkinKind } from './types';

export const ORIGINAL_FONT_FAMILY = 'Rich4 Ming';

/** 原版皮肤的字体栈（CSS font-family 值） */
export const ORIGINAL_FONT_STACK = `"${ORIGINAL_FONT_FAMILY}", "MingLiU", "PMingLiU", "Noto Serif TC", "Songti TC", "PingFang TC", serif`;

const STYLE_ID = 'rich4-skin-original';

/** @font-face 用 local() 引用本机細明體 / 新細明體（Windows 自带；其他系统落到后面的字体） */
export const ORIGINAL_SKIN_CSS = `@font-face {
  font-family: "${ORIGINAL_FONT_FAMILY}";
  src: local("MingLiU"), local("PMingLiU"), local("細明體"), local("新細明體"), local("Noto Serif TC"), local("NotoSerifTC-Regular");
  font-display: swap;
}
:root[data-skin="original"] {
  --font-body: ${ORIGINAL_FONT_STACK};
  --font-title: ${ORIGINAL_FONT_STACK};
}`;

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const el = doc.createElement('style');
  el.id = STYLE_ID;
  el.textContent = ORIGINAL_SKIN_CSS;
  doc.head.appendChild(el);
}

let applied: SkinKind | null = null;
let applying: { kind: SkinKind; p: Promise<void> } | null = null;

/** 当前应用到页面的皮肤（未应用过、或语言包加载失败而回滚时为 null） */
export function appliedSkin(): SkinKind | null {
  return applied;
}

function setDocLang(lang: UiLang): void {
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
}

/**
 * 应用皮肤的语言与主题；返回语言切换完成的 Promise（zh-TW 语言包首次使用时懒加载）。
 * - 主题（data-skin、字体）立即生效；`<html lang>` 等语言真正切换之后再改（避免 lang=zh-TW 而文字仍是简体）；
 * - zh-TW 语言包加载失败：回滚 applied（lang 保持实际语言），之后再次调用会重试；
 * - 幂等：同一皮肤重复调用不做事（进行中的返回同一个 Promise）。
 */
export function applySkinTheme(kind: SkinKind): Promise<void> {
  if (applied === kind) return applying?.kind === kind ? applying.p : Promise.resolve();
  applied = kind;
  const lang: UiLang = kind === 'original' ? 'zh-TW' : 'zh-CN';
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    if (kind === 'original') {
      ensureStyle(document);
      root.dataset.skin = 'original';
    } else {
      delete root.dataset.skin;
    }
  }
  const p = setUiLanguage(lang).then((ok) => {
    if (applied !== kind) return; // 已被之后的调用取代
    if (applying?.p === p) applying = null;
    if (!ok) {
      applied = null;
      setDocLang(uiLanguage());
      return;
    }
    setDocLang(lang);
  });
  applying = { kind, p };
  return p;
}

/** 测试：重置记录 */
export function resetSkinThemeForTest(): void {
  applied = null;
  applying = null;
}
