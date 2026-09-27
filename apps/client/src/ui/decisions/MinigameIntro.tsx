// MINIGAME：小游戏开场说明 + 开局倒计时 + 「不玩了」（MINIGAME_DECLINE 是唯一允许的客户端 intent，只能在开局前；
// 房间设置 allowMinigameDecline=false 时不显示该按钮，服务器也会拒绝）。
// 决策一出现就在后台创建小游戏宿主（minigames/MiniGameHost，加载模块与 Pixi），倒计时到 0（服务器时间到 startsAt）才显示全屏遮罩；
// 结束后显示得分 2 秒并回棋盘，决策随服务器结算（MINIGAME_ENDED）消失。托管或只读时不开宿主（服务器由 AI 代答跳过）。
import { isMinigameTicket } from '@rich4/shared/minigames';
import { type ReactNode, useContext, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ClientContext, getGameClient } from '../../app/services';
import { abandonPlayerMinigame, startPlayerMinigame } from '../../minigames';
import { useRoomStore } from '../../store/roomStore';
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
  const provided = useContext(ClientContext);
  const ticket = isMinigameTicket(d.minigame) ? d.minigame : null;
  const startsAt = ticketStartsAt(d.minigame);
  const start = useRemainingMs(startsAt, now, `${d.decisionId}:start`);
  const o = d.options;
  const started = start.remainingMs !== null && start.remainingMs <= 0;
  const sessionId = ticket?.sessionId ?? null;
  const allowDecline = useRoomStore((st) => st.room?.settings.allowMinigameDecline ?? true);

  // 宿主：同一会话只开一次（到 startsAt 才显示；刷新后重进时按服务器补发的帧续玩）。
  // ticket 只在 sessionId 变化时换新（暂停恢复换新窗口），其余字段不变，所以按 sessionId 触发
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只按会话触发
  useEffect(() => {
    if (!isMine || !ticket || ctl.locked) return;
    startPlayerMinigame(provided ?? getGameClient(), ticket);
  }, [isMine, sessionId, provided, ctl.locked]);

  // 服务器确认后才放弃宿主：被拒（例如房间不允许跳过）时宿主保留，照常开局
  const decline = (): void => {
    ctl.send({ type: 'MINIGAME_DECLINE' }, (ok) => {
      if (ok && sessionId) abandonPlayerMinigame(sessionId);
    });
  };

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
          {allowDecline && (
            <Button variant="cream" disabled={started} onClick={decline} data-testid="minigame-decline">
              {t('dlg.minigame.decline')}
            </Button>
          )}
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
