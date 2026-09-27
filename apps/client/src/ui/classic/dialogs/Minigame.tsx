// MINIGAME 的原版开场入口（original-skin.md §4.2 通用、§5 A11/A13）：本人讲话头像 + 云形气泡（小游戏名、「准备好了吗？」），
// 宝石消息框写玩法、最高分、奖励与开局倒计时；房间允许时框底有一颗 NO（不玩了，只能在开局前）。
// 与程序化的 MinigameIntro 同一套行为：决策一出现就在后台创建小游戏宿主（minigames：加载模块与 Pixi；原版视图由 A13 的
// 宿主按皮肤选择），倒计时到 0（服务器时间到 startsAt）才显示全屏遮罩；托管或只读时不开宿主。
// NO → MINIGAME_DECLINE（服务器确认后才放弃宿主）；testid 同名（minigame-decline、minigame-start）。
import { isMinigameTicket } from '@rich4/shared/minigames';
import { type ReactNode, useContext, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ClientContext, getGameClient } from '../../../app/services';
import { abandonPlayerMinigame, startPlayerMinigame } from '../../../minigames';
import { useRoomStore } from '../../../store/roomStore';
import { CountdownRing, useRemainingMs } from '../../components/Countdown';
import { useGameText } from '../../components/names';
import { useServerNow } from '../../decisions/clock';
import { ticketStartsAt } from '../../decisions/MinigameIntro';
import type { DecisionProps } from '../../decisions/types';
import { useDecision } from '../../decisions/useDecision';
import { DecisionStage } from '../common/DecisionStage';
import { SpeakerBubble, speakerSheet } from '../common/SpeakerBubble';
import { TEXT } from '../common/textStyles';
import { MESSAGE_BOX, YESNO_SHEET } from '../common/YesNoBox';
import type { RequiredKeys } from '../decisions/scene';
import { REGION } from '../layout';
import d from './dialogs.module.css';
import { COMMON_SHEET, ConfirmBox, characterOf } from './parts';

export const requiredKeys: RequiredKeys<'MINIGAME'> = (p) => [
  YESNO_SHEET,
  COMMON_SHEET,
  speakerSheet(characterOf(p.view, p.decision.seat)),
];

export default function MinigameScene(props: DecisionProps<'MINIGAME'>): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine, decision: d0 } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const now = useServerNow(props.now);
  const provided = useContext(ClientContext);
  const ticket = isMinigameTicket(d0.minigame) ? d0.minigame : null;
  const startsAt = ticketStartsAt(d0.minigame);
  const start = useRemainingMs(startsAt, now, `${d0.decisionId}:start`);
  const o = d0.options;
  const started = start.remainingMs !== null && start.remainingMs <= 0;
  const sessionId = ticket?.sessionId ?? null;
  const allowDecline = useRoomStore((st) => st.room?.settings.allowMinigameDecline ?? true);
  const character = characterOf(view, d0.seat);

  // 宿主：同一会话只开一次（与 MinigameIntro 相同）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只按会话触发
  useEffect(() => {
    if (!isMine || !ticket || ctl.locked) return;
    startPlayerMinigame(provided ?? getGameClient(), ticket);
  }, [isMine, sessionId, provided, ctl.locked]);

  const decline = (): void => {
    ctl.send({ type: 'MINIGAME_DECLINE' }, (ok) => {
      if (ok && sessionId) abandonPlayerMinigame(sessionId);
    });
  };

  const body = (
    <>
      <p>{text.minigameHowTo(o.minigameId)}</p>
      <p>
        {t('dlg.minigame.maxScore')}：{o.maxScore === null ? t('dlg.minigame.noMax') : String(o.maxScore)}
      </p>
      <p>
        {t('dlg.minigame.reward')}：{t('dlg.minigame.rewardText')}
      </p>
    </>
  );
  const boxAt = MESSAGE_BOX.at;
  return (
    <DecisionStage
      ctl={ctl}
      decision={d0}
      view={view}
      map={map}
      isMine={isMine}
      label={text.minigame(o.minigameId)}
      closeButton={false}
      countdownAt={{ x: REGION.board.x + REGION.board.w - 38, y: REGION.board.y + 6 }}
      attrs={{ 'data-minigame': o.minigameId, 'data-started': started ? 'true' : 'false' }}
    >
      <SpeakerBubble character={character} expression={0} testId="classic-minigame-speaker">
        <p style={TEXT.title}>{text.minigame(o.minigameId)}</p>
        <p>{t('dlg.minigame.subtitle')}</p>
        <p>{started ? t('dlg.minigame.started') : t('dlg.minigame.ready')}</p>
      </SpeakerBubble>
      {startsAt !== null && (
        <div
          className={d.clock}
          style={{ ...TEXT.body, left: REGION.board.x + 16, top: REGION.board.y + 16 }}
          data-testid="minigame-start"
        >
          <CountdownRing remainingMs={start.remainingMs} totalMs={start.totalMs} size={44} />
          <span>{t('dlg.minigame.startsIn')}</span>
        </div>
      )}
      <ConfirmBox
        x={boxAt.x}
        y={boxAt.y}
        lines={8}
        no={
          allowDecline
            ? { label: t('dlg.minigame.decline'), onClick: decline, disabled: started, testId: 'minigame-decline' }
            : undefined
        }
        testId="classic-minigame-box"
      >
        {body}
      </ConfirmBox>
    </DecisionStage>
  );
}
