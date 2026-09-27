// 场所屏第二组的共用小件：YES/NO 一对（ui.yesno 三帧，不带消息框）、文字钮（原版没有钮图的地方）、按座位取角色、
// 场景内 FLC 播放（魔法屋施法）。
import type { SeatIndex } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import clsx from 'clsx';
import { type CSSProperties, type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { ClientContext, getGameClient } from '../../../../app/services';
import type { FlicPlayer } from '../../../../skin/flic';
import { useClassicAssets } from '../../assets';
import s from '../../common/common.module.css';
import { Hotspots } from '../../common/Hotspots';
import { YESNO, YESNO_SHEET } from '../../common/YesNoBox';
import { Sprite, useSpriteFrame } from '../../Sprite';
import v from './venues.module.css';

/** 座位的角色号（找不到时 0） */
export function characterOf(view: Pick<GameView, 'players'>, seat: SeatIndex | null | undefined): number {
  if (seat === null || seat === undefined) return 0;
  return view.players.find((p) => p.seat === seat)?.character ?? 0;
}

export interface YesNoPairProps {
  /** 左上角（场景坐标） */
  x: number;
  y: number;
  onYes: () => void;
  onNo: () => void;
  yesDisabled?: boolean;
  noDisabled?: boolean;
  yesLabel: string;
  noLabel: string;
  yesTestId?: string;
  noTestId?: string;
  testId?: string;
}

/** YES/NO（Data#399 = ui.yesno：常态 / YES 亮 / NO 亮）：左半 YES、右半 NO 各一颗透明按钮；手机上向两侧补热区 */
export function YesNoPair({
  x,
  y,
  onYes,
  onNo,
  yesDisabled = false,
  noDisabled = false,
  yesLabel,
  noLabel,
  yesTestId,
  noTestId,
  testId,
}: YesNoPairProps): ReactNode {
  const [hot, setHot] = useState<string | null>(null);
  const art = useSpriteFrame(YESNO_SHEET, 0);
  const frame = hot === 'yes' && !yesDisabled ? YESNO.frames.yes : hot === 'no' && !noDisabled ? YESNO.frames.no : 0;
  const half = YESNO.w / 2;
  return (
    <div className={s.yesno} style={{ left: 0, top: 0 }} data-testid={testId} data-hot={hot ?? ''}>
      {art ? (
        <Sprite sheet={YESNO_SHEET} frame={frame} x={x} y={y} origin="topLeft" />
      ) : (
        <span
          className={s.yesnoFallback}
          style={{ left: x, top: y, width: YESNO.w, height: YESNO.h }}
          aria-hidden="true"
        >
          <span>YES</span>
          <span>NO</span>
        </span>
      )}
      {yesDisabled && (
        <span className={s.yesMask} style={{ left: x, top: y, width: half, height: YESNO.h }} aria-hidden="true" />
      )}
      {noDisabled && (
        <span
          className={s.yesMask}
          style={{ left: x + half, top: y, width: half, height: YESNO.h }}
          aria-hidden="true"
        />
      )}
      <Hotspots
        x={x}
        y={y}
        w={YESNO.w}
        h={YESNO.h}
        mask={null}
        onHotChange={setHot}
        spots={[
          {
            id: 'yes',
            rect: { x: 0, y: 0, w: half, h: YESNO.h },
            label: yesLabel,
            disabled: yesDisabled,
            testId: yesTestId,
            hit: 'left',
            onActivate: onYes,
          },
          {
            id: 'no',
            rect: { x: half, y: 0, w: half, h: YESNO.h },
            label: noLabel,
            disabled: noDisabled,
            testId: noTestId,
            hit: 'right',
            onActivate: onNo,
          },
        ]}
      />
    </div>
  );
}

export interface TextButtonProps {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'parchment' | 'blue' | 'red';
  testId?: string;
  title?: string;
  children?: ReactNode;
  pressed?: boolean;
  style?: CSSProperties;
}

/** 文字钮：原版这一处没有钮图（例如监狱的「离开」），按该场所讲话框的配色画 */
export function TextButton({
  x,
  y,
  w,
  h,
  label,
  onClick,
  disabled = false,
  tone = 'parchment',
  testId,
  title,
  children,
  pressed,
  style,
}: TextButtonProps): ReactNode {
  return (
    <button
      type="button"
      className={v.textBtn}
      style={{ left: x, top: y, width: w, height: h, ...style }}
      data-tone={tone === 'parchment' ? undefined : tone}
      aria-label={children ? label : undefined}
      aria-pressed={pressed}
      title={title}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
    >
      {children ?? label}
    </button>
  );
}

/** 场景里画一段 FLC（整幅或局部）：start 为 true 时加载并播放一遍，结束（或不可用、被中止）后调 onDone。 */
export interface SceneFlicProps {
  flicKey: string;
  /** 开始播放 */
  start: boolean;
  onDone: (played: boolean) => void;
  x?: number;
  y?: number;
  w: number;
  h: number;
  testId?: string;
}

export function SceneFlic({ flicKey, start, onDone, x = 0, y = 0, w, h, testId }: SceneFlicProps): ReactNode {
  const loadFlic = useClassicAssets((st) => st.loadFlic);
  const client = useContext(ClientContext);
  const host = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!start) return;
    if (!loadFlic) {
      done.current(false);
      return;
    }
    const ac = new AbortController();
    let player: FlicPlayer | null = null;
    let finished = false;
    const finish = (played: boolean): void => {
      if (finished) return;
      finished = true;
      done.current(played);
    };
    void (async () => {
      const clock = (client ?? getGameClient()).anim;
      player = await loadFlic(flicKey, clock);
      const el = host.current;
      if (!player || !el || ac.signal.aborted) {
        finish(false);
        return;
      }
      const canvas = player.canvas;
      if (canvas instanceof HTMLCanvasElement) el.replaceChildren(canvas);
      setOn(true);
      await player.play({ signal: ac.signal });
      finish(true);
    })().catch((e: unknown) => {
      console.warn(`[classic] FLC ${flicKey} 播放失败`, e);
      finish(false);
    });
    return () => {
      // 卸载或重新开始：不再回调（卸载时决策已经换了，不能再提交）
      finished = true;
      ac.abort();
      player?.destroy();
      host.current?.replaceChildren();
      setOn(false);
    };
  }, [start, loadFlic, flicKey, client]);

  return (
    <div
      ref={host}
      className={clsx(v.flic)}
      style={{ left: x, top: y, width: w, height: h, display: on ? undefined : 'none' }}
      data-testid={testId}
      data-playing={on ? 'true' : 'false'}
      aria-hidden="true"
    />
  );
}
