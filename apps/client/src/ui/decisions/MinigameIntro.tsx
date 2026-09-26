// MINIGAME：小游戏开场说明 + 开局倒计时 + 「不玩了」（MINIGAME_DECLINE 是唯一允许的客户端 intent）。
// 实际的小游戏宿主（MiniGameHost）在 M8；这里只负责开场与放弃。票据（net 的 MinigameTicket）带 startsAt 时显示开局倒计时。
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/Button';
import { CountdownRing, useRemainingMs } from '../components/Countdown';
import { useGameText } from '../components/names';
import { KeyValues } from '../components/Panel';
import { useServerNow } from './clock';
import { DecisionFrame } from './DecisionFrame';
import s from './decisions.module.css';
import type { DecisionProps } from './types';
import { useDecision } from './useDecision';

const MINIGAME_ICON = { penguin: '🐧', balloon: '🎈', xicong: '🎁' } as const;

/** 从票据里取开局时间（票据类型由 net 注入，这里按结构读取） */
export function ticketStartsAt(ticket: unknown): number | null {
  if (typeof ticket !== 'object' || ticket === null) return null;
  const v = (ticket as { startsAt?: unknown }).startsAt;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export default function MinigameIntro(props: DecisionProps<'MINIGAME'>): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine, decision: d } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const now = useServerNow(props.now);
  const startsAt = ticketStartsAt(d.minigame);
  const start = useRemainingMs(startsAt, now, `${d.decisionId}:start`);
  const o = d.options;
  const started = start.remainingMs !== null && start.remainingMs <= 0;

  return (
    <DecisionFrame
      ctl={ctl}
      kind={d.kind}
      seat={d.seat}
      view={view}
      isMine={isMine}
      title={text.minigame(o.minigameId)}
      subtitle={t('dlg.minigame.subtitle')}
      icon={MINIGAME_ICON[o.minigameId]}
      tone="sun"
      actions={
        <>
          <span className={s.muted}>{started ? t('dlg.minigame.started') : t('dlg.minigame.ready')}</span>
          <Button
            variant="cream"
            disabled={started}
            onClick={() => ctl.send({ type: 'MINIGAME_DECLINE' })}
            data-testid="minigame-decline"
          >
            {t('dlg.minigame.decline')}
          </Button>
        </>
      }
    >
      <div className={s.stack}>
        {startsAt !== null && (
          <div className={s.row} data-testid="minigame-start">
            <CountdownRing remainingMs={start.remainingMs} totalMs={start.totalMs} size={64} />
            <span>{t('dlg.minigame.startsIn')}</span>
          </div>
        )}
        <p className={s.note}>{text.minigameHowTo(o.minigameId)}</p>
        <KeyValues
          rows={[
            [t('dlg.minigame.maxScore'), o.maxScore === null ? t('dlg.minigame.noMax') : String(o.maxScore)],
            [t('dlg.minigame.reward'), t('dlg.minigame.rewardText')],
          ]}
        />
      </div>
    </DecisionFrame>
  );
}
