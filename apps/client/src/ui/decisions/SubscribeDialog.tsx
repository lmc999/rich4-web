// SUBSCRIBE_SHARES（★公司格现场认购）：用现金按认购价买公司保留股，本次最多 max 股；总额 = 认购价 × 股数。
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/Button';
import { clampInt } from '../components/format';
import { Money } from '../components/Money';
import { useGameText } from '../components/names';
import { KeyValues } from '../components/Panel';
import { Stepper } from '../components/Stepper';
import { DecisionFrame } from './DecisionFrame';
import s from './decisions.module.css';
import type { DecisionProps } from './types';
import { useDecision } from './useDecision';

export default function SubscribeDialog(props: DecisionProps<'SUBSCRIBE_SHARES'>): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine, decision: d } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d.options;
  const affordable = o.unitPrice > 0 ? Math.trunc(o.cash / o.unitPrice) : o.max;
  const max = Math.max(0, Math.min(o.max, affordable));
  const [shares, setShares] = useState(() => Math.min(max, 100) || max);
  const n = clampInt(shares, max > 0 ? 1 : 0, max);
  const total = o.unitPrice * n;

  return (
    <DecisionFrame
      ctl={ctl}
      kind={d.kind}
      seat={d.seat}
      view={view}
      isMine={isMine}
      title={t('dlg.subscribe.title')}
      subtitle={`${text.lot(o.company)} · ${text.stock(o.stock)}`}
      icon="📜"
      tone="blue"
      actions={
        <>
          <Button variant="cream" onClick={() => ctl.send({ type: 'SKIP' })} data-testid="subscribe-skip">
            {t('dlg.subscribe.skip')}
          </Button>
          <Button
            variant="blue"
            disabled={n < 1}
            onClick={() => ctl.send({ type: 'SUBSCRIBE', shares: n })}
            data-testid="subscribe-confirm"
          >
            {t('dlg.subscribe.confirm', { n })}
          </Button>
        </>
      }
    >
      <div className={s.stack}>
        <KeyValues
          rows={[
            [t('dlg.subscribe.unitPrice'), <Money key="u" value={o.unitPrice} />],
            [t('dlg.subscribe.reserved'), <Money key="r" value={o.reserved} unit="shares" />],
            [t('dlg.subscribe.max'), <Money key="m" value={o.max} unit="shares" />],
            [t('dlg.common.cash'), <Money key="c" value={o.cash} />],
          ]}
        />
        <div className={s.between}>
          <Stepper
            value={n}
            onChange={setShares}
            min={max > 0 ? 1 : 0}
            max={max}
            step={1}
            bigStep={100}
            showMax
            label={t('dlg.subscribe.shares')}
            testId="subscribe-shares"
          />
          <span>
            {t('dlg.subscribe.total')} <Money value={total} testId="subscribe-total" />
          </span>
        </div>
        {max < 1 && <p className={s.warn}>{t('dlg.common.notEnoughCash')}</p>}
        <p className={s.muted}>{t('dlg.subscribe.note')}</p>
      </div>
    </DecisionFrame>
  );
}
