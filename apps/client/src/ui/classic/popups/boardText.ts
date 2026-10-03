// 新闻板 / 命运板的字（exe v2.06）：fcn.0044e200(h, #F0F0F0, #101010, 3, 0)——nHeight = −h 的細明體、样式 3
// （bit1 粗体、bit0 先在 (1,1) 用 #101010 画一遍 = 右下阴影）、SetTextCharacterExtra(0 − 1)（0x44e3ba–0x44e3c9，字距 −1）；
// 新闻板的分类名与标题、命运板的整句是 28px（0x44a1eb、0x44c51e），新闻板的逐人名单是 24px（0x4487f5、0x4499af）。
// 画字走 fcn.0044e2e3：左上对齐的 DrawTextA（样式 0 时 format = 0：不自动换行，原文里的 \n 另起一行），多行的行距是字体的
// tmHeight——細明體按 −h 建字没有 internal leading，行距取字高（⚑ 推定：没有与原版实机截图逐像素对过，见 VERIFY V-U13）。
import type { CSSProperties } from 'react';
import { classicText } from '../common/textStyles';

export type BoardTextSize = 24 | 28;

/** 板上文字的内联样式（定位由调用方给）：#F0F0F0 粗体、#101010 的 (1,1) 阴影、字距 −1、行距 = 字高、不自动换行 */
export function boardText(size: BoardTextSize): CSSProperties {
  return {
    ...classicText({ size, bold: true, color: '#f0f0f0', outline: null, shadow: '#101010', lineHeight: size }),
    letterSpacing: -1,
    whiteSpace: 'pre',
  };
}
