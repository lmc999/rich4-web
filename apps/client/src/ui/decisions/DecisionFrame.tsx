// 决策对话框外框：标题、倒计时圆环、状态条（等待他人 / 已提交 / 已超时），
// 内容与底部按钮放在 <fieldset disabled> 里——锁定、超时或只读时一次性禁用全部控件。
import type { DecisionKind, SeatIndex } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { motion, useReducedMotion } from 'motion/react';
import { type CSSProperties, type ReactNode, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { CountdownRing } from '../components/Countdown';
import { useGameText } from '../components/names';
import s from './decisions.module.css';
import type { DecisionController } from './useDecision';

export type FrameTone = 'sun' | 'blue' | 'green' | 'purple' | 'red' | 'orange' | 'pink';

const TONE_VAR: Record<FrameTone, string> = {
  sun: 'var(--c-sun)',
  blue: '#9fd0ff',
  green: '#a8e6a1',
  purple: '#cbb6ff',
  red: '#ffb3b3',
  orange: '#ffc98f',
  pink: '#ffc4e1',
};

export interface DecisionFrameProps {
  ctl: DecisionController;
  kind: DecisionKind;
  seat: SeatIndex;
  view: GameView;
  isMine: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: string;
  tone?: FrameTone;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  children?: ReactNode;
  /** 底部按钮区（同样随锁定禁用） */
  actions?: ReactNode;
  className?: string;
}

export function DecisionFrame({
  ctl,
  kind,
  seat,
  view,
  isMine,
  title,
  subtitle,
  icon,
  tone = 'sun',
  size = 'md',
  children,
  actions,
  className,
}: DecisionFrameProps): ReactNode {
  const { t } = useTranslation();
  const text = useGameText(view, null);
  const reduce = useReducedMotion();
  const titleId = useId();
  const status: { tone: string; text: string } | null = !isMine
    ? { tone: 'wait', text: t('dlg.common.waiting', { name: text.player(seat) }) }
    : ctl.locked
      ? { tone: 'sent', text: t('dlg.common.sent') }
      : ctl.expired
        ? { tone: 'expired', text: t('dlg.common.expired') }
        : null;
  const style = { '--accent': TONE_VAR[tone] } as CSSProperties;
  return (
    <motion.section
      role="dialog"
      aria-labelledby={titleId}
      className={[s.frame, className].filter(Boolean).join(' ')}
      style={style}
      data-size={size}
      data-testid={`decision-${kind}`}
      data-kind={kind}
      data-locked={ctl.locked ? 'true' : 'false'}
      data-expired={ctl.expired ? 'true' : 'false'}
      data-readonly={isMine ? 'false' : 'true'}
      initial={reduce ? false : { opacity: 0, y: 16, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 420, damping: 30 }}
    >
      <header className={s.head}>
        {icon && (
          <span className={s.icon} aria-hidden="true">
            {icon}
          </span>
        )}
        <div className={s.titles}>
          <h2 id={titleId} className={s.title}>
            {title}
          </h2>
          {subtitle !== undefined && <p className={s.subtitle}>{subtitle}</p>}
        </div>
        <CountdownRing remainingMs={ctl.remainingMs} totalMs={ctl.totalMs} />
      </header>
      {status && (
        <p className={s.status} data-tone={status.tone} role="status">
          {status.text}
        </p>
      )}
      <fieldset className={`${s.fieldset} ${s.body}`} disabled={!ctl.interactive}>
        {children}
      </fieldset>
      {actions !== undefined && (
        <fieldset className={`${s.fieldset} ${s.foot}`} disabled={!ctl.interactive}>
          {actions}
        </fieldset>
      )}
    </motion.section>
  );
}
