// 原版框的九宫格 / 三宫格规格（ui.md §5 路线 B「9-slice 实测」、design-draft §4.2 通用框）：
// - 带边框的框（绿边羊皮纸、蓝钮）拉伸效果良好 → stretch；
// - 中间是十字花图案的框要平铺 → border-image-repeat: round（NineSlice 用抽出的单帧位图做 border-image）；
// - 宝石消息框顶部饰件居中，只能三宫格：宽度固定，只在纵向拉伸中段（mode 'three-y'）。
// 切边宽度按素材目视取值（visual，test/w3-atlas-ascii.mjs 逐像素看过边框与花纹的交界）。
import type { Rect } from '../layout';

export interface SliceInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type SliceRepeat = 'stretch' | 'round' | 'repeat';

/** nine：四向可伸缩；three-y：宽度固定、纵向拉伸中段；three-x：高度固定、横向拉伸中段 */
export type SliceMode = 'nine' | 'three-y' | 'three-x';

export interface FrameSpec {
  sheet: string;
  frame: number;
  /** 原版帧尺寸 */
  w: number;
  h: number;
  slice: SliceInsets;
  repeat: SliceRepeat;
  mode: SliceMode;
  /** 资源号（ui.md 编号） */
  source: string;
}

const all = (n: number): SliceInsets => ({ top: n, right: n, bottom: n, left: n });

export const CLASSIC_FRAMES = {
  /** 宝石消息框（YES/NO 框）：顶部皇冠饰带 38px、底边 12px；宽 195 固定 */
  messageBox: {
    sheet: 'ui.common',
    frame: 5,
    w: 195,
    h: 133,
    slice: { top: 38, right: 0, bottom: 12, left: 0 },
    repeat: 'stretch',
    mode: 'three-y',
    source: 'Data#476 图5',
  },
  /** 绿边羊皮纸（月结颁奖）：四角 16px */
  parchment: {
    sheet: 'venue.monthly.screen',
    frame: 2,
    w: 278,
    h: 98,
    slice: all(16),
    repeat: 'stretch',
    mode: 'nine',
    source: 'Panel#25 图2',
  },
  /** 蓝边十字花纹框（拍卖）：圆角 16px，中间花纹平铺 */
  crossPanel: {
    sheet: 'venue.auction.screen',
    frame: 2,
    w: 244,
    h: 100,
    slice: all(16),
    repeat: 'round',
    mode: 'nine',
    source: 'Panel#26 图2',
  },
  /** 银行柜员的讲话框：边 12px；右下角的尾巴（x 190..240、底部 34 行）整个留在角块里不拉伸 */
  bankBalloon: {
    sheet: 'venue.bank.screen',
    frame: 22,
    w: 250,
    h: 110,
    slice: { top: 12, right: 62, bottom: 34, left: 12 },
    repeat: 'stretch',
    mode: 'nine',
    source: 'Panel#23 图22',
  },
  /** 蓝色长钮（资产表）：边 6px */
  blueButton: {
    sheet: 'venue.assets.screen',
    frame: 12,
    w: 97,
    h: 40,
    slice: all(6),
    repeat: 'stretch',
    mode: 'nine',
    source: 'Panel#9 图12',
  },
} as const satisfies Record<string, FrameSpec>;

export type ClassicFrameName = keyof typeof CLASSIC_FRAMES;

export interface SlicePart {
  /** 位置名（tl/t/tr/l/c/r/bl/b/br） */
  name: string;
  /** 源帧内的矩形 */
  src: Rect;
  /** 目标矩形（相对框左上角） */
  dst: Rect;
}

const ROWS = ['t', 'm', 'b'] as const;
const COLS = ['l', 'c', 'r'] as const;

/** 三宫格 / 九宫格的实际尺寸：three-y 宽度固定为源宽，three-x 高度固定为源高 */
export function sliceSize(spec: Pick<FrameSpec, 'w' | 'h' | 'mode'>, w: number, h: number): { w: number; h: number } {
  return {
    w: spec.mode === 'three-y' ? spec.w : Math.max(0, w),
    h: spec.mode === 'three-x' ? spec.h : Math.max(0, h),
  };
}

/** 把源帧按切边切成最多 9 块，映射到 w×h 的目标框（尺寸为 0 的块不出现） */
export function sliceParts(fw: number, fh: number, slice: SliceInsets, w: number, h: number): SlicePart[] {
  const L = Math.min(slice.left, fw);
  const R = Math.min(slice.right, fw - L);
  const T = Math.min(slice.top, fh);
  const B = Math.min(slice.bottom, fh - T);
  const sx = [0, L, fw - R, fw];
  const sy = [0, T, fh - B, fh];
  // 目标框比两边切边之和还小时，两边按比例缩小
  const kx = L + R > w && L + R > 0 ? w / (L + R) : 1;
  const ky = T + B > h && T + B > 0 ? h / (T + B) : 1;
  const dx = [0, L * kx, w - R * kx, w];
  const dy = [0, T * ky, h - B * ky, h];
  const out: SlicePart[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const src = { x: sx[c]!, y: sy[r]!, w: sx[c + 1]! - sx[c]!, h: sy[r + 1]! - sy[r]! };
      const dst = { x: dx[c]!, y: dy[r]!, w: dx[c + 1]! - dx[c]!, h: dy[r + 1]! - dy[r]! };
      if (src.w <= 0 || src.h <= 0 || dst.w <= 0 || dst.h <= 0) continue;
      out.push({ name: `${ROWS[r]}${COLS[c]}`, src, dst });
    }
  }
  return out;
}
