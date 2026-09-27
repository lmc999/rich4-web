// BUY_FACILITY 的原版场景（original-skin.md §4.2 通用：YES/NO + 讲话头像）：与 BUY_LAND 同一套画面——本人讲话头像 + 云形气泡
// （「购买设施地」、地名与等级），宝石消息框里列地价、购买后现金、设施种类；福神加成 / 现金不足另起一行。
// 逻辑与提交同程序化的 BuyLotDialog：YES → CONFIRM、NO / Esc → DECLINE；现金不足时 YES 禁用。testid 与程序化对话框相同。
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useGameText } from '../../components/names';
import type { DecisionProps } from '../../decisions/types';
import { useDecision } from '../../decisions/useDecision';
import { DecisionStage } from '../common/DecisionStage';
import { speakerSheet } from '../common/SpeakerBubble';
import { TEXT } from '../common/textStyles';
import { YESNO_SHEET, YesNoBox } from '../common/YesNoBox';
import type { RequiredKeys } from '../decisions/scene';
import { REGION } from '../layout';
import { COMMON_SHEET, characterOf, Money } from './parts';

export const requiredKeys: RequiredKeys<'BUY_FACILITY'> = (p) => [
  YESNO_SHEET,
  COMMON_SHEET,
  speakerSheet(characterOf(p.view, p.decision.seat)),
];

export default function BuyFacilityScene(props: DecisionProps<'BUY_FACILITY'>): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine, decision: d } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d.options;
  const short = o.price > o.cash;
  const character = characterOf(view, d.seat);
  const rows: [string, ReactNode][] = [
    [t('dlg.buyLot.price'), <Money key="p" value={o.price} testId="buy-price" />],
    [t('dlg.buyLot.cashAfter'), <Money key="a" value={o.cash - o.price} testId="buy-cash-after" />],
    [t('dlg.buyLot.facilityType'), <span key="f">{text.facility(o.type)}</span>],
  ];
  const notes: ReactNode[] = [];
  if (o.fortuneBonus) notes.push(<p key="fortune">{t('dlg.buyLot.fortuneBonus')}</p>);
  if (short)
    notes.push(
      <p key="short" role="alert" style={TEXT.warn}>
        {t('dlg.common.notEnoughCash')}
      </p>,
    );

  return (
    <DecisionStage
      ctl={ctl}
      decision={d}
      view={view}
      map={map}
      isMine={isMine}
      label={`${t('dlg.buyLot.titleFacility')} ${text.lot(o.lot)}`}
      onClose={() => ctl.send({ type: 'DECLINE' })}
      closeButton={false}
      countdownAt={{ x: REGION.board.x + REGION.board.w - 38, y: REGION.board.y + 6 }}
      attrs={{ 'data-character': String(character) }}
    >
      <YesNoBox
        lines={rows.length + notes.length}
        onYes={() => ctl.send({ type: 'CONFIRM' })}
        onNo={() => ctl.send({ type: 'DECLINE' })}
        yesDisabled={short}
        yesLabel={t('dlg.buyLot.confirm')}
        noLabel={t('dlg.buyLot.decline')}
        yesTestId="buy-confirm"
        noTestId="buy-decline"
        testId="classic-buy-box"
        speaker={{
          character,
          expression: short ? 3 : null,
          testId: 'classic-buy-speaker',
          children: (
            <>
              <p style={TEXT.title}>{t('dlg.buyLot.titleFacility')}</p>
              <p>{text.lot(o.lot)}</p>
              <p>{t('dlg.common.levelN', { n: o.level })}</p>
            </>
          ),
        }}
      >
        {rows.map(([k, v]) => (
          <p key={k}>
            {k}：{v}
          </p>
        ))}
        {notes}
      </YesNoBox>
    </DecisionStage>
  );
}
