// 标题 / 开局 / 大厅画面的公共部件：经典舞台外壳（沿用 ClassicStage 的缩放、侧栏与抽屉、触控热区标记）、整图层、
// 原版 EXIT 钮、透明热区钮（悬停 / 按下换帧并放界面音）。
import clsx from 'clsx';
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { useTx } from '../../../i18n/tx';
import { ORIGINAL_FONT_STACK } from '../../../skin/theme';
import { ensureClassicImage, useClassicAssets } from '../assets';
import { ClassicStage, type RailRenderInfo, useClassicBox } from '../ClassicStage';
import cc from '../classic.module.css';
import { coarsePointer, wantsWideHit } from '../common/stage';
import { type Rect, regionStyle } from '../layout';
import { Sprite } from '../Sprite';
import { EXIT_FRAMES, TITLE_SHEET } from './layout';
import s from './screens.module.css';
import { playScreenCue } from './uiSound';

export interface ClassicScreenFrameProps {
  testId: string;
  label: string;
  children: ReactNode;
  left?: (info: RailRenderInfo) => ReactNode;
  right?: (info: RailRenderInfo) => ReactNode;
  /** 舞台之外的内容（模态框、片头） */
  after?: ReactNode;
  attrs?: Readonly<Record<`data-${string}`, string | undefined>>;
}

/** 这几屏的根：经典画面主题 + 640×480 舞台（没有棋盘视窗） */
export function ClassicScreenFrame({
  testId,
  label,
  children,
  left,
  right,
  after,
  attrs,
}: ClassicScreenFrameProps): ReactNode {
  const t = useTx();
  return (
    <main
      className={clsx(cc.root, s.screen)}
      style={{ '--classic-font': ORIGINAL_FONT_STACK } as CSSProperties}
      data-testid={testId}
      data-layout="classic"
      aria-label={label}
      {...attrs}
    >
      <ClassicStage
        className={s.frame}
        leftLabel={t('classic:rail.left')}
        rightLabel={t('classic:rail.right')}
        left={left}
        right={right}
      >
        {children}
      </ClassicStage>
      {after}
    </main>
  );
}

/** 舞台缩小（手机横屏）或粗指针：控件补到 ≥44 CSS 像素 */
export function useWideHit(): boolean {
  const box = useClassicBox();
  return box ? wantsWideHit(box.scale, coarsePointer()) : coarsePointer();
}

/** 整图（背景、Loading）：按需取 URL；不可用时不画 */
export function SceneImage({
  imageKey,
  x = 0,
  y = 0,
  w,
  h,
  testId,
}: {
  imageKey: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  testId?: string;
}): ReactNode {
  const packId = useClassicAssets((st) => st.packId);
  const img = useClassicAssets((st) => st.images[imageKey] ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 换素材包时重新取
  useEffect(() => {
    ensureClassicImage(imageKey);
  }, [imageKey, packId]);
  if (!img) return null;
  return (
    <img
      src={img.url}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={s.image}
      style={{ left: x, top: y, width: w ?? img.w, height: h ?? img.h }}
      data-image={imageKey}
      data-testid={testId}
    />
  );
}

/** 原版 EXIT 钮（Data#1 图7 常态 / 图8 悬停）：面板的关闭钮 */
export function ExitButton({
  onClick,
  label,
  testId,
  style,
}: {
  onClick(): void;
  label: string;
  testId: string;
  style?: CSSProperties;
}): ReactNode {
  const [hot, setHot] = useState(false);
  return (
    <button
      type="button"
      className={clsx(s.hot, s.exitBtn)}
      style={style}
      aria-label={label}
      title={label}
      data-testid={testId}
      onPointerEnter={() => setHot(true)}
      onPointerLeave={() => setHot(false)}
      onFocus={() => setHot(true)}
      onBlur={() => setHot(false)}
      onClick={() => {
        playScreenCue('back');
        onClick();
      }}
    >
      <Sprite
        sheet={TITLE_SHEET}
        frame={hot ? EXIT_FRAMES.hover : EXIT_FRAMES.normal}
        x={32}
        y={28}
        fallback={
          <span className={s.exitFallback} aria-hidden="true">
            EXIT
          </span>
        }
      />
    </button>
  );
}

export interface HotButtonProps {
  rect: Rect;
  label: string;
  testId: string;
  onPress(): void;
  disabled?: boolean;
  /** 精灵：常态帧（按下时也画它）、悬停帧，画点相对整屏；baked = 底图已烘焙常态图标，常态时不另画 */
  sprite?: { sheet: string; normal: number; hover: number; x: number; y: number; baked?: boolean };
  children?: ReactNode;
  type?: 'button' | 'submit';
  attrs?: Readonly<Record<string, string | boolean | undefined>>;
  cue?: 'click' | 'open' | 'back';
}

/** 原版图上的透明热区钮：悬停 / 键盘焦点换悬停帧，按下换常态帧；悬停与点击放界面音 */
export function HotButton({
  rect,
  label,
  testId,
  onPress,
  disabled,
  sprite,
  children,
  type = 'button',
  attrs,
  cue = 'click',
}: HotButtonProps): ReactNode {
  const [hot, setHot] = useState(false);
  const [down, setDown] = useState(false);
  const state = disabled ? 'disabled' : down ? 'pressed' : hot ? 'hover' : 'normal';
  const frame = sprite ? (state === 'hover' ? sprite.hover : sprite.normal) : null;
  const drawSprite =
    sprite !== undefined && frame !== null && !(sprite.baked && (state === 'normal' || state === 'disabled'));
  return (
    <button
      type={type}
      className={s.hot}
      style={regionStyle(rect)}
      aria-label={label}
      title={label}
      disabled={disabled}
      data-testid={testId}
      data-state={state}
      onPointerEnter={() => {
        if (disabled) return;
        setHot(true);
        playScreenCue('move');
      }}
      onPointerLeave={() => {
        setHot(false);
        setDown(false);
      }}
      onFocus={() => setHot(true)}
      onBlur={() => {
        setHot(false);
        setDown(false);
      }}
      onPointerDown={() => setDown(true)}
      onPointerUp={() => setDown(false)}
      onClick={() => {
        playScreenCue(cue);
        onPress();
      }}
      {...attrs}
    >
      {drawSprite && <Sprite sheet={sprite.sheet} frame={frame} x={sprite.x - rect.x} y={sprite.y - rect.y} />}
      {children}
    </button>
  );
}
