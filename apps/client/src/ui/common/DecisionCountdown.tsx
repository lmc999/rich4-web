// 画面正中央的决策倒计时（本人的决策、有截止时间时；数据与提示音见 useDecisionCountdown）：
// - 位置：始终在画面正中央，不避让（用户要求先按这个试，有调整再提）——等掷骰、决策对话框、原版铺满舞台的场所、回合菜单
//   展开、手机横屏、日志 / 聊天停靠栏开着时位置都一样、大小都一样；
//   程序化布局（variant hud）：棋盘视口（右栏以外、顶栏以下、底栏——等待条 + 行动区——以上，与镜头的有效可视区同一块）
//   的正中。顶栏与底栏的高度用 GameScreen 给镜头量的同一组实测值（hudInsets）：行动区在 1024–1279 宽时会折成两行，
//   等待条出现时底栏也会变高，写死一行的高度会让数字偏离镜头中心。整层经 portal 挂到 document.body：对局页 .game
//   （position: fixed）自成层叠上下文，radix 模态面板（回合菜单的卡片 / 股票 / 公布栏子页、PanelHost）挂在 body 上，
//   留在 .game 里盖不过它们；系统界面（系统菜单、设置、托管设置，Modal layer="system"）的层级更高，盖在数字之上（同原版）；
//   原版布局（variant classic）：由 ui/classic/ClassicCountdown 经 portal 挂到经典舞台容器上，640×480 舞台的正中 (320,240)，
//   随舞台等比缩放，层级在原版场景之上；
// - 层级在决策对话框、原版场景与回合横幅（「轮到你了」）之上：横幅显示期间数字照常显示，重叠时数字在上；
// - 大号描边数字，剩余整秒；最后 10 秒变红、每秒脉动一下（prefers-reduced-motion 时不动），同时每秒一声「嘀」；
// - 只是提示：pointer-events: none、不可聚焦，不拦点击、不抢焦点；
// - 读屏：role="timer" + aria-label（剩余秒数，计时器不主动播报）；另有一个常驻的 aria-live 区域，
//   只在进入最后 10 秒时写一次「只剩 N 秒」，不每秒打扰。
import type { RoomView } from '@rich4/shared/net';
import clsx from 'clsx';
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTx } from '../../i18n/tx';
import { useSettingsStore } from '../../store/settingsStore';
import h from '../hud/hud.module.css';
import s from './countdown.module.css';
import {
  type DecisionCountdownState,
  type UseDecisionCountdownOptions,
  useDecisionCountdown,
} from './useDecisionCountdown';

export type CountdownVariant = 'hud' | 'classic';

/** 程序化布局：顶栏、底栏（等待条 + 行动区）的实际高度（CSS 像素；GameScreen 给镜头算 insets 的同一组测量值） */
export interface HudBars {
  top: number;
  bottom: number;
}

export interface DecisionCountdownProps {
  room: RoomView;
  variant: CountdownVariant;
  /** 程序化布局：实测的顶栏 / 底栏高度；缺省（或还没量到）时按 CSS 里一行行动区的高度 */
  hudBars?: HudBars | null;
  /** 测试注入（时钟、提示音） */
  options?: UseDecisionCountdownOptions;
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

function CountdownFace({ cd, variant }: { cd: DecisionCountdownState; variant: CountdownVariant }): ReactNode {
  const t = useTx();
  return (
    <div
      className={s.countdown}
      role="timer"
      aria-label={t('hud:countdown.aria', { n: cd.secs })}
      data-testid="decision-countdown"
      data-variant={variant}
      data-urgent={cd.urgent ? 'true' : 'false'}
      data-final={cd.final ? 'true' : 'false'}
      data-kind={cd.target.kind}
      data-decision={cd.target.decisionId}
      data-secs={cd.secs}
    >
      {/* 最后 10 秒每秒换 key：重新挂载数字，脉动动画从头播一次 */}
      <span key={cd.urgent ? cd.secs : 'calm'} className={s.num} aria-hidden="true">
        {cd.secs}
      </span>
    </div>
  );
}

/** 实测的顶栏 / 底栏高度 → 倒计时层的上下缘（内联，覆盖 CSS 的缺省值）；还没量到时不给 */
export function hudLayerStyle(bars: HudBars | null | undefined): CSSProperties | undefined {
  if (!bars || bars.bottom <= 0) return undefined;
  return { top: bars.top, bottom: bars.bottom };
}

export function DecisionCountdown({ room, variant, hudBars, options }: DecisionCountdownProps): ReactNode {
  const cd = useDecisionCountdown(room, options);
  const leftHanded = useSettingsStore((st) => st.leftHanded);
  const announce = useHurryAnnouncement(cd);
  const face = cd && <CountdownFace cd={cd} variant={variant} />;
  const live = (
    <span className={s.srOnly} aria-live="polite" data-testid="decision-countdown-live">
      {announce}
    </span>
  );
  // 原版布局由 ui/classic/ClassicCountdown 包一层 640×480 逻辑坐标的舞台层
  if (variant === 'classic') {
    return (
      <>
        {face}
        {live}
      </>
    );
  }
  // 程序化布局：铺在棋盘视口上的一层（右栏宽沿用 HUD 的尺寸变量 hud.module.css .hudGeom；上下缘用实测的顶栏 / 底栏高度），
  // 挂到 body 上
  return createPortal(
    <div
      className={clsx(s.hudLayer, h.hudGeom)}
      style={hudLayerStyle(hudBars)}
      data-testid="decision-countdown-layer"
      data-left={leftHanded ? 'true' : 'false'}
    >
      {face}
      {live}
    </div>,
    document.body,
  );
}
