// SUBSCRIBE_SHARES 的原版场景（original-skin.md §4.2 通用：计算器数字输入 Panel#21 + 命中掩膜 Panel#22）：
// 本人讲话头像 + 云形气泡（「认购股票」、公司与股票名），右侧计算器输入认购股数（MAX = 本次最多、↵ = 认购），
// 左下宝石消息框列认购价、公司保留股、本次最多、现金与合计（合计 = 认购价 × 股数）。
// YES（认购 N 股）→ SUBSCRIBE{shares}、NO / Esc（不认购）→ SKIP；股数上限取 min(本次最多, 现金够买的股数)，与程序化的
// SubscribeDialog 相同；testid 同名（subscribe-confirm / subscribe-skip / subscribe-total），计算器前缀 subscribe-shares。
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMoney } from '../../../presentation/names';
import { useGameText } from '../../components/names';
import type { DecisionProps } from '../../decisions/types';
import { useDecision } from '../../decisions/useDecision';
import { Calculator } from '../common/Calculator';
import { DecisionStage } from '../common/DecisionStage';
import { NUMPAD_MASK, NUMPAD_SHEET } from '../common/numpad';
import { speakerSheet } from '../common/SpeakerBubble';
import { TEXT } from '../common/textStyles';
import { YESNO_SHEET, YesNoBox } from '../common/YesNoBox';
import type { RequiredKeys } from '../decisions/scene';
import { REGION } from '../layout';
import { COMMON_SHEET, characterOf, Money } from './parts';

export const requiredKeys: RequiredKeys<'SUBSCRIBE_SHARES'> = (p) => [
  YESNO_SHEET,
  COMMON_SHEET,
  NUMPAD_SHEET,
  NUMPAD_MASK,
  speakerSheet(characterOf(p.view, p.decision.seat)),
];

/** 计算器左上角（棋盘视窗右侧）、讲话头像与消息框的画点 */
export const SUBSCRIBE_LAYOUT = {
  calc: { x: REGION.board.x + 290, y: REGION.board.y + 160 },
  head: { x: 80, y: 110 },
  box: { x: 120, y: 333 },
} as const;

/** 本次可认购的上限：min(本次最多, 现金够买的股数)（与程序化对话框同算法） */
export function subscribeMax(o: { unitPrice: number; cash: number; max: number }): number {
  const affordable = o.unitPrice > 0 ? Math.trunc(o.cash / o.unitPrice) : o.max;
  return Math.max(0, Math.min(o.max, affordable));
}

export default function SubscribeScene(props: DecisionProps<'SUBSCRIBE_SHARES'>): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine, decision: d0 } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d0.options;
  const max = subscribeMax(o);
  const min = max > 0 ? 1 : 0;
  const [shares, setShares] = useState(() => Math.min(max, 100) || max);
  // 液晶屏、消息框与 YES 提交的是同一个数：计算器可以清到 0（C / 退格），0 股时 YES 与 ↵ 都不可按（不认购请按 NO），
  // 不再「屏上 0、YES 却认购 1 股」
  const n = Math.max(0, Math.min(Math.trunc(shares), max));
  const total = o.unitPrice * n;
  const character = characterOf(view, d0.seat);
  const submit = (v: number): void => {
    if (v >= 1) ctl.send({ type: 'SUBSCRIBE', shares: v });
  };

  return (
    <DecisionStage
      ctl={ctl}
      decision={d0}
      view={view}
      map={map}
      isMine={isMine}
      label={`${t('dlg.subscribe.title')} ${text.lot(o.company)}`}
      onClose={() => ctl.send({ type: 'SKIP' })}
      closeButton={false}
      countdownAt={{ x: REGION.board.x + REGION.board.w - 38, y: REGION.board.y + 6 }}
      attrs={{ 'data-shares': String(n) }}
    >
      <Calculator
        value={n}
        onChange={setShares}
        min={min}
        max={max}
        step={1}
        onEnter={(v) => submit(v)}
        enterDisabled={n < 1}
        x={SUBSCRIBE_LAYOUT.calc.x}
        y={SUBSCRIBE_LAYOUT.calc.y}
        label={t('dlg.subscribe.shares')}
        disabled={!ctl.interactive || max < 1}
        testId="subscribe-shares"
      />
      <YesNoBox
        x={SUBSCRIBE_LAYOUT.box.x}
        y={SUBSCRIBE_LAYOUT.box.y}
        lines={8}
        onYes={() => submit(n)}
        onNo={() => ctl.send({ type: 'SKIP' })}
        yesDisabled={n < 1}
        yesLabel={t('dlg.subscribe.confirm', { n })}
        noLabel={t('dlg.subscribe.skip')}
        yesTestId="subscribe-confirm"
        noTestId="subscribe-skip"
        testId="classic-subscribe-box"
        speaker={{
          character,
          expression: 0,
          x: SUBSCRIBE_LAYOUT.head.x,
          y: SUBSCRIBE_LAYOUT.head.y,
          testId: 'classic-subscribe-speaker',
          children: (
            <>
              <p style={TEXT.title}>{t('dlg.subscribe.title')}</p>
              <p>{text.lot(o.company)}</p>
              <p>{text.stock(o.stock)}</p>
            </>
          ),
        }}
      >
        <p>
          {t('dlg.subscribe.unitPrice')}：<Money value={o.unitPrice} />
        </p>
        <p>
          {t('dlg.subscribe.reserved')}：{formatMoney(o.reserved)} {t('cmp.unit.shares')}
        </p>
        <p>
          {t('dlg.subscribe.max')}：{formatMoney(o.max)} {t('cmp.unit.shares')}
        </p>
        <p>
          {t('dlg.common.cash')}：<Money value={o.cash} />
        </p>
        <p style={TEXT.number}>
          {t('dlg.subscribe.shares')}：{formatMoney(n)} {t('cmp.unit.shares')}
        </p>
        <p>
          {t('dlg.subscribe.total')}：<Money value={total} testId="subscribe-total" />
        </p>
        {max < 1 && (
          <p role="alert" style={TEXT.warn}>
            {t('dlg.common.notEnoughCash')}
          </p>
        )}
      </YesNoBox>
    </DecisionStage>
  );
}
