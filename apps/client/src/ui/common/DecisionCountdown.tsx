// 画面中央的决策倒计时（本人的决策、有截止时间时；数据与提示音见 useDecisionCountdown）：
// - 大号描边数字，剩余整秒；最后 10 秒变红、放大、每秒脉动一下（prefers-reduced-motion 时不动），同时每秒一声「嘀」；
// - 只是提示：pointer-events: none、不可聚焦，不拦点击、不抢焦点；
// - 位置（data-place）：
//   center 没有决策框时（回合菜单收起、等掷骰）在棋盘区域中线偏上——镜头跟着行动者，正中是自己的角色，数字放在角色头顶上方；
//          回合横幅（「轮到你了」，与决策同时出现、再停留约 1 秒）也在这一带，横幅显示期间数字先隐去（data-yield）；
//   top    决策框 / 原版场景在棋盘中央时避让，字号缩小、垫一块小牌：原版布局在棋盘视窗上缘的中线（工具列下方）；
//          程序化布局摆在决策对话框的正上方（顶栏下方的中线有拍卖横幅与 toast，data-anchor="dialog"）；对话框上方放不下时
//          （手机横屏，决策层只有两百多像素高）叠到对话框标题栏里圆环的左边（data-anchor="ring"）；连圆环也找不到才隐去
//          （data-anchor="none"）；
//   stage  原版布局里有登记了小牌位置的铺满舞台的场景（银行、拍卖…，common/sceneCover）开着时，摆到场景指定的位置
//          （缺省舞台顶端中线——场景状态条的位置；顶栏有内容的场景自己挑空处，例如股市放到自己的圆环左边）；
// - 两种皮肤各一个挂载点：程序化布局（variant hud）叠在棋盘区域上，定位跟随 HUD 的 --right-w / --top-h；
//   左侧的日志 / 聊天停靠栏打开时（data-dock），center 的数字不越过停靠栏右缘（手机横屏时中线正好压在停靠栏上）；
//   原版布局（variant classic）由 ui/classic/ClassicCountdown 经 portal 挂到经典舞台容器上，按 640×480 逻辑坐标摆在
//   棋盘视窗 (0,40) 440×440 里，与原版场景同一缩放、层级在场景之上（场景铺满棋盘视窗时仍看得到），低于侧栏抽屉；
// - 读屏：role="timer" + aria-label（剩余秒数，计时器不主动播报）；另有一个常驻的 aria-live 区域，
//   只在进入最后 10 秒时写一次「只剩 N 秒」，不每秒打扰。
import type { RoomView } from '@rich4/shared/net';
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useTx } from '../../i18n/tx';
import { useSettingsStore } from '../../store/settingsStore';
import { useUiStore } from '../../store/uiStore';
import type { StageBadgeAt } from '../classic/common/sceneCover';
import s from './countdown.module.css';
import {
  type DecisionCountdownState,
  type UseDecisionCountdownOptions,
  useDecisionCountdown,
} from './useDecisionCountdown';

export type CountdownVariant = 'hud' | 'classic';

export type CountdownPlace = 'center' | 'top' | 'stage';

export interface DecisionCountdownProps {
  room: RoomView;
  variant: CountdownVariant;
  /** 原版布局：开着的铺满舞台的场景登记的小牌位置（ui/classic/common/sceneCover；场景坐标，小牌上缘中点）；没有为 null */
  stageAt?: StageBadgeAt | null;
  /** 测试注入（时钟、提示音） */
  options?: UseDecisionCountdownOptions;
}

/**
 * 倒计时摆在哪：铺满舞台的场景开着 → stage；决策框占着中央（非 TURN_MENU 的决策都有对话框 / 原版场景，TURN_MENU 只有展开
 * 回合菜单 uiStore.panel === 'menu' 时才有）→ top；否则 center
 */
export function countdownPlace(kind: string, panel: string | null, stageCovered: boolean): CountdownPlace {
  if (stageCovered) return 'stage';
  return kind !== 'TURN_MENU' || panel === 'menu' ? 'top' : 'center';
}

/** 程序化布局 top：小牌底边与对话框上缘的间距、小牌至少要的高度；叠在圆环左边时与圆环的间距（CSS 像素） */
const ANCHOR_GAP = 8;
const ANCHOR_MIN_ROOM = 40;
const RING_GAP = 8;
/** 对话框会动（进场动画、子页切换改变高度）：摆放期间每隔这么久量一次 */
const ANCHOR_POLL_MS = 250;

export interface DialogAnchor {
  /**
   * 相对倒计时层的左上角（CSS 像素）。mode=dialog：小牌底边中点（对话框正上方）；
   * mode=ring：小牌右边中点（对话框标题栏里圆环的左边）
   */
  x: number;
  y: number;
  mode: 'dialog' | 'ring';
}

/** 对话框矩形 → 对话框正上方的小牌锚点（上方放不下时为 null） */
export function anchorAboveDialog(layer: DOMRect, dialog: DOMRect): DialogAnchor | null {
  if (dialog.width <= 0 || dialog.height <= 0) return null;
  const room = dialog.top - layer.top;
  if (room < ANCHOR_MIN_ROOM + ANCHOR_GAP) return null;
  return {
    x: Math.round(dialog.left + dialog.width / 2 - layer.left),
    y: Math.round(room - ANCHOR_GAP),
    mode: 'dialog',
  };
}

/**
 * 对话框上方放不下时的兜底：叠到对话框标题栏里圆环（DecisionFrame 的 CountdownRing）的左边——标题在左、圆环在右，
 * 中间是空的；小牌与圆环同一档变红、同拍跳动（都对齐整秒）。先试正上方，再试圆环左边，都不行为 null
 */
export function dialogAnchor(layer: DOMRect, dialog: DOMRect, ring: DOMRect | null): DialogAnchor | null {
  const above = anchorAboveDialog(layer, dialog);
  if (above || dialog.width <= 0 || dialog.height <= 0) return above;
  if (!ring || ring.width <= 0 || ring.height <= 0) return null;
  return {
    x: Math.round(ring.left - RING_GAP - layer.left),
    y: Math.round(ring.top + ring.height / 2 - layer.top),
    mode: 'ring',
  };
}

/** 程序化布局：本人决策对话框（决策层里的 role=dialog）的正上方，放不下时它标题栏里圆环的左边 */
function useDialogAnchor(layerRef: RefObject<HTMLElement | null>, active: boolean): DialogAnchor | null {
  const [anchor, setAnchor] = useState<DialogAnchor | null>(null);
  useLayoutEffect(() => {
    if (!active) {
      setAnchor(null);
      return;
    }
    const measure = (): void => {
      const layer = layerRef.current;
      const dialog = document.querySelector('[data-testid="decision-layer"] [role="dialog"]');
      const ring = dialog?.querySelector('[data-testid="countdown"]') ?? null;
      const next =
        layer && dialog
          ? dialogAnchor(
              layer.getBoundingClientRect(),
              dialog.getBoundingClientRect(),
              ring ? ring.getBoundingClientRect() : null,
            )
          : null;
      setAnchor((cur) => (cur?.x === next?.x && cur?.y === next?.y && cur?.mode === next?.mode ? cur : next));
    };
    measure();
    const id = setInterval(measure, ANCHOR_POLL_MS);
    window.addEventListener('resize', measure);
    return () => {
      clearInterval(id);
      window.removeEventListener('resize', measure);
    };
  }, [active, layerRef]);
  return anchor;
}

/** 进入最后 10 秒时写一次的读屏播报（倒计时结束后清空，下一个决策再写） */
function useHurryAnnouncement(cd: DecisionCountdownState | null): string {
  const t = useTx();
  const [text, setText] = useState<{ key: string; text: string } | null>(null);
  const key = cd ? `${cd.target.decisionId}@${cd.target.deadlineAt}` : null;
  const urgent = cd?.urgent ?? false;
  const secs = cd?.secs ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在进入最后 10 秒（或换了决策）时写一次，秒数变化不重写
  useEffect(() => {
    if (key === null) {
      setText(null);
      return;
    }
    if (!urgent) return;
    setText((cur) => (cur?.key === key ? cur : { key, text: t('hud:countdown.hurry', { n: secs }) }));
  }, [key, urgent]);
  return text && text.key === key ? text.text : '';
}

function CountdownFace({
  cd,
  variant,
  place,
  yieldToBanner,
  anchor,
  stageAt,
}: {
  cd: DecisionCountdownState;
  variant: CountdownVariant;
  place: CountdownPlace;
  yieldToBanner: boolean;
  /** 程序化布局 top 的摆放（undefined：不适用；null：放不下） */
  anchor?: DialogAnchor | null;
  /** 原版布局 stage 的摆放（场景坐标，小牌上缘中点） */
  stageAt?: StageBadgeAt;
}): ReactNode {
  const t = useTx();
  const at = anchor ?? stageAt;
  const style: CSSProperties | undefined = at ? { left: at.x, top: at.y } : undefined;
  return (
    <div
      className={s.countdown}
      role="timer"
      aria-label={t('hud:countdown.aria', { n: cd.secs })}
      data-testid="decision-countdown"
      data-variant={variant}
      data-place={place}
      data-urgent={cd.urgent ? 'true' : 'false'}
      data-final={cd.final ? 'true' : 'false'}
      data-yield={yieldToBanner ? 'true' : 'false'}
      data-anchor={anchor === undefined ? undefined : anchor ? anchor.mode : 'none'}
      data-kind={cd.target.kind}
      data-decision={cd.target.decisionId}
      data-secs={cd.secs}
      style={style}
    >
      {/* 最后 10 秒每秒换 key：重新挂载数字，脉动动画从头播一次 */}
      <span key={cd.urgent ? cd.secs : 'calm'} className={s.num} aria-hidden="true">
        {cd.secs}
      </span>
    </div>
  );
}

export function DecisionCountdown({ room, variant, stageAt = null, options }: DecisionCountdownProps): ReactNode {
  const cd = useDecisionCountdown(room, options);
  const panel = useUiStore((st) => st.panel);
  const banner = useUiStore((st) => st.banner !== null);
  // 程序化布局左侧的日志 / 聊天停靠栏（GameScreen：chatOpen || logOpen 时渲染）
  const dock = useUiStore((st) => st.chatOpen || st.logOpen);
  const leftHanded = useSettingsStore((st) => st.leftHanded);
  const announce = useHurryAnnouncement(cd);
  const layerRef = useRef<HTMLDivElement>(null);
  const place = cd ? countdownPlace(cd.target.kind, panel, stageAt !== null) : null;
  const anchor = useDialogAnchor(layerRef, variant === 'hud' && place === 'top');
  const face = cd && place && (
    <CountdownFace
      cd={cd}
      variant={variant}
      place={place}
      yieldToBanner={banner && place === 'center'}
      anchor={variant === 'hud' && place === 'top' ? anchor : undefined}
      stageAt={variant === 'classic' && place === 'stage' && stageAt ? stageAt : undefined}
    />
  );
  const live = (
    <span className={s.srOnly} aria-live="polite" data-testid="decision-countdown-live">
      {announce}
    </span>
  );
  // 原版布局由 ui/classic/ClassicCountdown 包一层 640×480 逻辑坐标的舞台层；程序化布局直接叠在对局页上
  if (variant === 'classic') {
    return (
      <>
        {face}
        {live}
      </>
    );
  }
  return (
    <div
      ref={layerRef}
      className={s.hudLayer}
      data-left={leftHanded ? 'true' : 'false'}
      data-dock={dock ? 'true' : 'false'}
    >
      {face}
      {live}
    </div>
  );
}
