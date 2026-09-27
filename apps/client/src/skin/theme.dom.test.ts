// 皮肤主题与界面语言（original-skin.md U5）：<html lang> 在语言真正切换之后才改；zh-TW 语言包加载失败时回滚记录、
// lang 保持实际语言，之后再次应用会重试（不会因为「已应用」的幂等判断永远停在简体）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setUiLanguage, setZhTwImporterForTest, uiLanguage } from '../i18n';
import { appliedSkin, applySkinTheme, DOC_TITLES, resetSkinThemeForTest } from './theme';

afterEach(async () => {
  setZhTwImporterForTest(null);
  resetSkinThemeForTest();
  await setUiLanguage('zh-CN');
  delete document.documentElement.dataset.skin;
  document.documentElement.lang = 'zh-CN';
});

describe('applySkinTheme', () => {
  it('zh-TW 语言包加载失败：回滚 applied，lang 保持 zh-CN；再次应用时重试并成功', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setZhTwImporterForTest(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module')));
    await applySkinTheme('original');
    expect(appliedSkin()).toBeNull();
    expect(uiLanguage()).toBe('zh-CN');
    expect(document.documentElement.lang).toBe('zh-CN');
    // 主题（字体）照样生效
    expect(document.documentElement.dataset.skin).toBe('original');
    expect(warn).toHaveBeenCalled();

    setZhTwImporterForTest(null);
    await applySkinTheme('original');
    expect(appliedSkin()).toBe('original');
    expect(uiLanguage()).toBe('zh-TW');
    expect(document.documentElement.lang).toBe('zh-TW');
    expect(document.title).toBe(DOC_TITLES['zh-TW']);
    warn.mockRestore();
  });

  it('<html lang> 等语言包就绪、真正切到繁体后才改为 zh-TW；进行中的重复调用返回同一个 Promise', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    setZhTwImporterForTest(async () => {
      await gate;
      return import('../i18n/locales/zh-TW/index');
    });
    const p = applySkinTheme('original');
    expect(applySkinTheme('original')).toBe(p);
    expect(document.documentElement.dataset.skin).toBe('original');
    expect(document.documentElement.lang).not.toBe('zh-TW');
    release();
    await p;
    expect(uiLanguage()).toBe('zh-TW');
    expect(document.documentElement.lang).toBe('zh-TW');
    // 回到程序化：简体
    await applySkinTheme('procedural');
    expect(document.documentElement.dataset.skin).toBeUndefined();
    expect(document.documentElement.lang).toBe('zh-CN');
  });
});
