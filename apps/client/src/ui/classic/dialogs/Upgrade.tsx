// UPGRADE_LAND / UPGRADE_FACILITY 的原版场景（original-skin.md §4.2 通用：YES/NO + 讲话头像）：本人讲话头像 + 云形气泡
// （「加盖房屋」、地名、等级 A → B），宝石消息框里列加盖费用、加盖后现金，住宅另列过路费变化、设施另列种类与等级上限；
// 福神多盖一级、现金不足另起一行。逻辑与提交同程序化的 UpgradeDialog：YES → CONFIRM、NO / Esc → DECLINE；
// 现金不足时 YES 禁用。testid 与程序化对话框相同（upgrade-confirm / upgrade-decline / upgrade-cost / upgrade-toll…）。
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMoney } from '../../../presentation/names';
import { useGameText } from '../../components/names';
import { type DecisionProps, narrowDecision } from '../../decisions/types';
import { useDecision } from '../../decisions/useDecision';
import { DecisionStage } from '../common/DecisionStage';
import { speakerSheet } from '../common/SpeakerBubble';
import { TEXT } from '../common/textStyles';
import { YESNO_SHEET, YesNoBox } from '../common/YesNoBox';
import type { RequiredKeys } from '../decisions/scene';
import { REGION } from '../layout';
import { COMMON_SHEET, characterOf, Money } from './parts';

type UpgradeKind = 'UPGRADE_LAND' | 'UPGRADE_FACILITY';

export const requiredKeys: RequiredKeys<UpgradeKind> = (p) => [
  YESNO_SHEET,
  COMMON_SHEET,
  speakerSheet(characterOf(p.view, p.decision.seat)),
];

export default function UpgradeScene(props: DecisionProps<UpgradeKind>): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine } = props;
  const d = narrowDecision(props.decision);
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d.options;
  const short = o.cost > o.cash;
  const character = characterOf(view, d.seat);
  const rows: [string, ReactNode][] = [
    [t('dlg.upgrade.cost'), <Money key="c" value={o.cost} testId="upgrade-cost" />],
    [t('dlg.upgrade.cashAfter'), <Money key="a" value={o.cash - o.cost} />],
  ];
  if (d.kind === 'UPGRADE_LAND') {
    rows.push([
      t('dlg.upgrade.toll'),
      <span key="t" data-testid="upgrade-toll">
        {formatMoney(d.options.tollBefore)} → <Money value={d.options.tollAfter} />
      </span>,
    ]);
  } else {
    rows.push([t('dlg.upgrade.facility'), <span key="f">{text.facility(d.options.type)}</span>]);
    rows.push([t('dlg.upgrade.cap'), <span key="cap">{t('dlg.common.levelN', { n: d.options.cap })}</span>]);
  }
  // 过路费金额很长（六位数以上）时这一行会折成两行：消息框多留一行
  const extra = d.kind === 'UPGRADE_LAND' && d.options.tollAfter >= 100_000 ? 1 : 0;
  const notes: ReactNode[] = [];
  if (o.toLevel - o.fromLevel > 1) notes.push(<p key="bonus">{t('dlg.upgrade.bonus')}</p>);
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
      label={`${t('dlg.upgrade.title')} ${text.lot(o.lot)}`}
      onClose={() => ctl.send({ type: 'DECLINE' })}
      closeButton={false}
      countdownAt={{ x: REGION.board.x + REGION.board.w - 38, y: REGION.board.y + 6 }}
      attrs={{ 'data-character': String(character) }}
    >
      <YesNoBox
        lines={rows.length + notes.length + extra}
        onYes={() => ctl.send({ type: 'CONFIRM' })}
        onNo={() => ctl.send({ type: 'DECLINE' })}
        yesDisabled={short}
        yesLabel={t('dlg.upgrade.confirm')}
        noLabel={t('dlg.upgrade.decline')}
        yesTestId="upgrade-confirm"
        noTestId="upgrade-decline"
        testId="classic-upgrade-box"
        speaker={{
          character,
          expression: short ? 3 : 0,
          testId: 'classic-upgrade-speaker',
          children: (
            <>
              <p style={TEXT.title}>{t('dlg.upgrade.title')}</p>
              <p>{text.lot(o.lot)}</p>
              <p data-testid="upgrade-levels" data-from={o.fromLevel} data-to={o.toLevel}>
                {t('dlg.common.levelN', { n: o.fromLevel })} → {t('dlg.common.levelN', { n: o.toLevel })}
              </p>
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
