// USE_FREE_CARD 的原版场景（original-skin.md §4.2 通用：被动卡询问）：本人讲话头像 + 云形气泡（「使用免费卡？」），
// 宝石消息框里是要付的款项与金额，资料栏位置亮出免费卡的插画（Data#549 = card.20）。
// YES（使用免费卡）→ CONFIRM、NO（照付）/ Esc → DECLINE，与程序化的 PassiveCardDialog 相同；testid 同名（free-confirm…）。
import { CARD } from '@rich4/shared/engine';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { type LooseT, useGameText } from '../../components/names';
import { passiveText } from '../../decisions/PassiveCardDialog';
import type { DecisionProps } from '../../decisions/types';
import { useDecision } from '../../decisions/useDecision';
import { DecisionStage } from '../common/DecisionStage';
import { speakerSheet } from '../common/SpeakerBubble';
import { TEXT } from '../common/textStyles';
import { YESNO_SHEET, YesNoBox } from '../common/YesNoBox';
import type { RequiredKeys } from '../decisions/scene';
import { REGION } from '../layout';
import { CardArt, COMMON_SHEET, characterOf, Money } from './parts';

export const requiredKeys: RequiredKeys<'USE_FREE_CARD'> = (p) => [
  YESNO_SHEET,
  COMMON_SHEET,
  speakerSheet(characterOf(p.view, p.decision.seat)),
];

/** 卡片插画的画点：资料栏（440,0 起 200×280）里居中 */
export const CARD_SHOW_AT = { x: REGION.profile.x + 17, y: REGION.profile.y + 12 } as const;

export default function FreeCardScene(props: DecisionProps<'USE_FREE_CARD'>): ReactNode {
  const { t } = useTranslation();
  const lt = t as unknown as LooseT;
  const { view, map, isMine, decision: d } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d.options;
  const character = characterOf(view, d.seat);
  return (
    <DecisionStage
      ctl={ctl}
      decision={d}
      view={view}
      map={map}
      isMine={isMine}
      label={t('dlg.passive.freeTitle')}
      onClose={() => ctl.send({ type: 'DECLINE' })}
      closeButton={false}
      countdownAt={{ x: REGION.board.x + REGION.board.w - 38, y: REGION.board.y + 6 }}
      attrs={{ 'data-character': String(character) }}
    >
      <CardArt card={CARD.FREE} x={CARD_SHOW_AT.x} y={CARD_SHOW_AT.y} testId="free-card-art" />
      <YesNoBox
        lines={4}
        onYes={() => ctl.send({ type: 'CONFIRM' })}
        onNo={() => ctl.send({ type: 'DECLINE' })}
        yesLabel={t('dlg.passive.useFree')}
        noLabel={t('dlg.passive.pay')}
        yesTestId="free-confirm"
        noTestId="free-decline"
        testId="classic-free-box"
        speaker={{
          character,
          expression: 2,
          testId: 'classic-free-speaker',
          children: (
            <>
              <p style={TEXT.title}>{t('dlg.passive.freeTitle')}</p>
              <p>{text.card(CARD.FREE)}</p>
            </>
          ),
        }}
      >
        <p data-testid="free-text">{passiveText(lt, o.context, o.amount, null, o.lot ? text.lot(o.lot) : null)}</p>
        <p style={TEXT.number}>
          <Money value={o.amount} testId="free-amount" />
        </p>
      </YesNoBox>
    </DecisionStage>
  );
}
