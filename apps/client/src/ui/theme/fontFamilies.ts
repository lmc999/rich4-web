// 字体族常量与字形预载（不含 CSS 副作用，渲染代码只依赖这里；字体 CSS 由 fonts.ts 在入口加载）
export const FONT_TITLE = '"ZCOOL KuaiLe", "PingFang SC", "Microsoft YaHei", sans-serif';
export const FONT_NUM = '"Fredoka", "ZCOOL KuaiLe", sans-serif';

/** 预载指定文字的字形分片；画布里的中文 Text 创建前调用（design/client.md §6.1） */
export async function loadFontGlyphs(text: string, family = 'ZCOOL KuaiLe', px = 32): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  try {
    await document.fonts.load(`${px}px "${family}"`, text);
  } catch {
    // 字体失败时回退系统字体，不阻塞渲染
  }
}
