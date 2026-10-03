// 原版描边字（ui.md §4 字体结论）：原版用 GDI 的「細明體」逐字 TextOutA。按 DrawText 路径 fcn.0044e2e3 的反汇编
// （0x44e458–0x44e4f6）：样式位 bit0 = 先在 (1,1) 用边框色画一遍（右下阴影）、正文在原位，bit1 粗体，bit2 = 绕 (1,1) 的
// 4 方向描边、正文偏移 (1,1)（早先这里把 bit0 / bit2 写反了；TextOut 路径 fcn.0044e0f6 未逐字核对）。网页里用 8 方向 1px 的
// text-shadow 模拟描边、1px 右下阴影模拟阴影，
// 字体栈与原版主题同一份（skin/theme 的 ORIGINAL_FONT_STACK：local 細明體 → Noto Serif TC…）。
// 字号以舞台逻辑像素计（场景整体随舞台缩放），常用档位取原版调用分布里最多的几档：12 / 15 / 16 / 20 px。
import type { CSSProperties } from 'react';
import { ORIGINAL_FONT_STACK } from '../../../skin/theme';

/** 原版对话框文字的字体栈（经典布局根元素上有 --classic-font 时用它） */
export const CLASSIC_FONT = `var(--classic-font, ${ORIGINAL_FONT_STACK})`;

/** GDI 字高档位（舞台逻辑像素） */
export const CLASSIC_FONT_SIZES = [12, 15, 16, 20, 24, 28] as const;
export type ClassicFontSize = (typeof CLASSIC_FONT_SIZES)[number];

/** 8 方向描边：(±w, 0)、(0, ±w)、(±w, ±w) 各一层，模拟 GDI 的描边（样式 bit2） */
export function outlineShadow(color = '#000', w = 1): string {
  const out: string[] = [];
  for (const dy of [-w, 0, w]) {
    for (const dx of [-w, 0, w]) {
      if (dx === 0 && dy === 0) continue;
      out.push(`${dx}px ${dy}px 0 ${color}`);
    }
  }
  return out.join(', ');
}

/** 右下 1px 的阴影（样式 bit0：先在 (1,1) 画一遍边框色） */
export function dropShadow(color = '#000', d = 1): string {
  return `${d}px ${d}px 0 ${color}`;
}

export interface ClassicTextOptions {
  size?: ClassicFontSize | number;
  color?: string;
  /** 描边色（null 不描边） */
  outline?: string | null;
  /** 右下阴影色（null 不加） */
  shadow?: string | null;
  bold?: boolean;
  align?: CSSProperties['textAlign'];
  /** 行高（逻辑像素；缺省字号 + 3） */
  lineHeight?: number;
}

/** 原版风格文字的内联样式（组件自己决定定位） */
export function classicText(o: ClassicTextOptions = {}): CSSProperties {
  const size = o.size ?? 12;
  const shadows: string[] = [];
  if (o.outline !== null) shadows.push(outlineShadow(o.outline ?? '#000'));
  if (o.shadow) shadows.push(dropShadow(o.shadow));
  return {
    fontFamily: CLASSIC_FONT,
    fontSize: size,
    lineHeight: `${o.lineHeight ?? size + 3}px`,
    fontWeight: o.bold ? 700 : 400,
    color: o.color ?? '#fff',
    textShadow: shadows.length > 0 ? shadows.join(', ') : 'none',
    textAlign: o.align,
    // 点阵字不做次像素平滑以外的处理；字距与原版等宽中文一致
    letterSpacing: 0,
    fontKerning: 'none',
  };
}

/** 常用预设：对话框正文（白字黑边 12px）、标题（黄字黑边粗体 16px）、数字（白字黑边 15px） */
export const TEXT = {
  body: classicText({ size: 12 }),
  bodyDark: classicText({ size: 12, color: '#2b1a0c', outline: null }),
  title: classicText({ size: 16, color: '#ffe060', bold: true }),
  number: classicText({ size: 15, color: '#fff' }),
  warn: classicText({ size: 12, color: '#ff9a8a' }),
  small: classicText({ size: 12, color: '#fff', outline: '#000', lineHeight: 14 }),
} as const satisfies Record<string, CSSProperties>;
