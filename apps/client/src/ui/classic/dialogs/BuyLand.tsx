// BUY_LAND 的原版场景（original-skin.md §4.2 通用：YES/NO；公共组件的示例）：YesNoBox 带本人讲话头像 + 云形气泡
// （「购买土地」、地名与等级；现金不足时换表情），宝石消息框里列地价、购买后现金、买下后的过路费（福神加成 / 现金不足
// 另起一行），下面是 YES/NO。
// 逻辑与提交和程序化的 BuyLotDialog 相同：useDecision 的提交锁与倒计时，YES → CONFIRM、NO / Esc → DECLINE；
// 现金不足时 YES 禁用。data-testid 与程序化对话框同名（decision-BUY_LAND、buy-confirm、buy-decline、buy-price…），E2E 共用。
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMoney } from '../../../presentation/names';
import { useGameText } from '../../components/names';
import type { DecisionProps } from '../../decisions/types';
import { useDecision } from '../../decisions/useDecision';
import s from '../common/common.module.css';
import { DecisionStage } from '../common/DecisionStage';
import { speakerSheet } from '../common/SpeakerBubble';
import { TEXT } from '../common/textStyles';
import { YESNO_SHEET, YesNoBox } from '../common/YesNoBox';
import type { RequiredKeys } from '../decisions/scene';
import { REGION } from '../layout';

function characterOf(p: Pick<DecisionProps<'BUY_LAND'>, 'view' | 'decision'>): number {
  return p.view.players.find((x) => x.seat === p.decision.seat)?.character ?? 0;
}

/** 依赖的素材：YES/NO、消息框与云形气泡（ui.common）、本人的讲话头像 */
export const requiredKeys: RequiredKeys<'BUY_LAND'> = (p) => [YESNO_SHEET, 'ui.common', speakerSheet(characterOf(p))];

export default function BuyLandScene(props: DecisionProps<'BUY_LAND'>): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine, decision: d } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d.options;
  const short = o.price > o.cash;
  const character = characterOf(props);
  const yuan = t('cmp.unit.yuan');
  const money = (n: number, testId?: string): ReactNode => (
    <span data-testid={testId} data-value={n}>
      {formatMoney(n)}
      {yuan}
    </span>
  );
  const rows: [string, ReactNode][] = [
    [t('dlg.buyLot.price'), money(o.price, 'buy-price')],
    [t('dlg.buyLot.cashAfter'), money(o.cash - o.price, 'buy-cash-after')],
    [t('dlg.buyLot.tollAfter'), money(o.tollAfter, 'buy-toll-after')],
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
      label={`${t('dlg.buyLot.titleLand')} ${text.lot(o.lot)}`}
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
              <p style={TEXT.title}>{t('dlg.buyLot.titleLand')}</p>
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
      {/* 同街地产（原版画面不显示；读屏可读） */}
      {d.options.street.lots.length > 1 && (
        <ul className={s.srOnly} data-testid="buy-street">
          {d.options.street.lots.map((lot, i) => {
            const owner = d.options.street.owners[i] ?? null;
            return (
              <li key={lot}>
                {text.lot(lot)}：{owner === null ? t('dlg.common.unowned') : text.player(owner)}
              </li>
            );
          })}
        </ul>
      )}
    </DecisionStage>
  );
}
