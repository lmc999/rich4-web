// 原版框的九宫格 / 三宫格（design-draft §4.2 通用框）：
// - 拉伸（stretch）：同步画法——最多 9 块 <span>，各自用图集背景图的 background-position / background-size 把源帧子矩形
//   映射到目标矩形（不需要抽帧，首帧即可画出，jsdom 里也一样）；
// - 平铺（round / repeat，十字花纹）：把四边与中间各抽成独立位图，边用单向、中间用双向的 background-repeat（round 即
//   border-image-repeat: round 的语义：平铺整数块、按块数微调块宽），角原样；抽帧完成前先用拉伸画法顶上。
//   （不直接用一个 border-image：舞台按 2.25 这类非整数倍缩放时，Chromium 的九块之间会出现半像素接缝；分块画可以互相叠压。）
// - 相邻的块在内侧各多画 0.5 逻辑像素、互相叠压（贴图照原位对齐），缩放到半像素边界时不露接缝；
// - three-y（宝石消息框）宽度固定为源宽、只在纵向拉伸中段；three-x 反之。
// 精灵不可用时画 fallback（缺省为木框金边的 CSS 画法）。子元素叠在框上（inset 0）。
import clsx from 'clsx';
import type { CSSProperties, ReactNode } from 'react';
import type { SpriteFrame } from '../assets';
import { useSheetStatus, useSpriteFrame } from '../Sprite';
import s from './common.module.css';
import { useFrameParts } from './frameImage';
import {
  CLASSIC_FRAMES,
  type ClassicFrameName,
  type FrameSpec,
  type SlicePart,
  type SliceRepeat,
  sliceParts,
  sliceSize,
} from './frames';
import { useEnsureSceneSprites } from './sceneAssets';

/** 相邻块互相叠压的宽度（逻辑像素，每侧） */
export const SLICE_OVERLAP = 0.5;

export interface NineSliceProps {
  /** 框的规格（或 CLASSIC_FRAMES 里的名字） */
  spec: FrameSpec | ClassicFrameName;
  /** 位置（场景坐标；省略时由父元素排版，需自己给定位样式） */
  x?: number;
  y?: number;
  /** 目标尺寸（three-y 的宽度、three-x 的高度忽略，固定为源尺寸） */
  w: number;
  h: number;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  testId?: string;
  /** 精灵不可用时的回退画法 */
  fallback?: ReactNode;
}

/** 块的外扩量：只在朝向相邻块的内侧外扩 */
function grow(p: SlicePart, W: number, H: number): { l: number; t: number; r: number; b: number } {
  const o = SLICE_OVERLAP;
  return {
    l: p.dst.x > 0 ? o : 0,
    t: p.dst.y > 0 ? o : 0,
    r: p.dst.x + p.dst.w < W ? o : 0,
    b: p.dst.y + p.dst.h < H ? o : 0,
  };
}

function boxOf(p: SlicePart, g: { l: number; t: number; r: number; b: number }): CSSProperties {
  return { left: p.dst.x - g.l, top: p.dst.y - g.t, width: p.dst.w + g.l + g.r, height: p.dst.h + g.t + g.b };
}

/** 拉伸画法：图集背景图按块缩放、定位 */
export function stretchPartStyle(f: SpriteFrame, p: SlicePart, W: number, H: number): CSSProperties {
  const kx = p.dst.w / p.src.w;
  const ky = p.dst.h / p.src.h;
  const g = grow(p, W, H);
  return {
    ...boxOf(p, g),
    backgroundImage: `url("${f.url}")`,
    backgroundSize: `${f.sheetW * kx}px ${f.sheetH * ky}px`,
    backgroundPosition: `${-(f.x + p.src.x) * kx + g.l}px ${-(f.y + p.src.y) * ky + g.t}px`,
  };
}

/** 平铺画法：块自己的位图，边单向平铺、中间双向平铺、角原样 */
export function tilePartStyle(url: string, p: SlicePart, repeat: SliceRepeat, W: number, H: number): CSSProperties {
  const g = grow(p, W, H);
  const row = p.name[0];
  const col = p.name[1];
  const tileX = col === 'c' ? repeat : 'no-repeat';
  const tileY = row === 'm' ? repeat : 'no-repeat';
  const sw = col === 'c' ? p.src.w : p.dst.w;
  const sh = row === 'm' ? p.src.h : p.dst.h;
  return {
    ...boxOf(p, g),
    backgroundImage: `url("${url}")`,
    backgroundRepeat: `${tileX} ${tileY}`,
    backgroundSize: `${sw}px ${sh}px`,
    backgroundPosition: `${g.l}px ${g.t}px`,
  };
}

export function NineSlice({
  spec: specOrName,
  x,
  y,
  w,
  h,
  children,
  className,
  style,
  testId,
  fallback,
}: NineSliceProps): ReactNode {
  const spec: FrameSpec = typeof specOrName === 'string' ? CLASSIC_FRAMES[specOrName] : specOrName;
  useEnsureSceneSprites([spec.sheet]);
  const f = useSpriteFrame(spec.sheet, spec.frame);
  const status = useSheetStatus(spec.sheet);
  const size = sliceSize(spec, w, h);
  const parts = f ? sliceParts(f.w, f.h, spec.slice, size.w, size.h) : [];
  const tiled = spec.repeat !== 'stretch';
  const urls = useFrameParts(
    f,
    parts.map((p) => p.src),
    tiled,
  );
  const box: CSSProperties = {
    ...(x !== undefined && y !== undefined ? { left: x, top: y } : null),
    width: size.w,
    height: size.h,
    ...style,
  };
  let art: ReactNode;
  let mode: 'parts' | 'tiles' | 'fallback' | 'loading';
  if (!f) {
    mode = status === 'loading' ? 'loading' : 'fallback';
    art = mode === 'loading' ? null : (fallback ?? <span className={s.nineFallback} aria-hidden="true" />);
  } else if (tiled && urls?.every((u) => u !== null)) {
    mode = 'tiles';
    art = parts.map((p, i) => (
      <span
        key={p.name}
        className={s.ninePart}
        style={tilePartStyle(urls[i]!, p, spec.repeat, size.w, size.h)}
        aria-hidden="true"
        data-part={p.name}
      />
    ));
  } else {
    mode = 'parts';
    const frame = f;
    art = parts.map((p) => (
      <span
        key={p.name}
        className={s.ninePart}
        style={stretchPartStyle(frame, p, size.w, size.h)}
        aria-hidden="true"
        data-part={p.name}
      />
    ));
  }
  return (
    <div
      className={clsx(s.nine, className)}
      style={box}
      data-testid={testId}
      data-frame={`${spec.sheet}/${spec.frame}`}
      data-slice={mode}
    >
      {art}
      {children !== undefined && <div className={s.nineContent}>{children}</div>}
    </div>
  );
}
