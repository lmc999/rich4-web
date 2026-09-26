// BUY_LAND / BUY_FACILITY：地价、现金、购买后现金、买后过路费、同街归属、福神加成（options 已给出全部数字）
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { SeatMark } from '../components/Avatar';
import { BuildingPreview } from '../components/BuildingPreview';
import { Button } from '../components/Button';
import { Money } from '../components/Money';
import { useGameText } from '../components/names';
import { KeyValues } from '../components/Panel';
import { DecisionFrame } from './DecisionFrame';
import s from './decisions.module.css';
import { FACILITY_ICON } from './helpers';
import { type DecisionProps, narrowDecision } from './types';
import { useDecision } from './useDecision';

export default function BuyLotDialog(props: DecisionProps<'BUY_LAND' | 'BUY_FACILITY'>): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine } = props;
  const d = narrowDecision(props.decision);
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d.options;
  const short = o.price > o.cash;
  const isLand = d.kind === 'BUY_LAND';
  const facilityType = d.kind === 'BUY_FACILITY' ? d.options.type : null;
  const rows: [ReactNode, ReactNode][] = [
    [t('dlg.buyLot.price'), <Money key="p" value={o.price} testId="buy-price" />],
    [t('dlg.common.cash'), <Money key="c" value={o.cash} />],
    [t('dlg.buyLot.cashAfter'), <Money key="a" value={o.cash - o.price} tone testId="buy-cash-after" />],
  ];
  if (d.kind === 'BUY_LAND') {
    rows.push([t('dlg.buyLot.tollAfter'), <Money key="t" value={d.options.tollAfter} testId="buy-toll-after" />]);
  } else {
    rows.push([t('dlg.buyLot.facilityType'), text.facility(d.options.type)]);
  }
  rows.push([t('dlg.buyLot.level'), t('dlg.common.levelN', { n: o.level })]);

  return (
    <DecisionFrame
      ctl={ctl}
      kind={d.kind}
      seat={d.seat}
      view={view}
      isMine={isMine}
      title={t(isLand ? 'dlg.buyLot.titleLand' : 'dlg.buyLot.titleFacility')}
      subtitle={text.lot(o.lot)}
      icon={isLand ? '🏠' : (FACILITY_ICON[facilityType ?? 'park'] ?? '🏢')}
      tone="green"
      actions={
        <>
          <Button variant="cream" onClick={() => ctl.send({ type: 'DECLINE' })} data-testid="buy-decline">
            {t('dlg.buyLot.decline')}
          </Button>
          <Button
            variant="green"
            onClick={() => ctl.send({ type: 'CONFIRM' })}
            disabled={short}
            data-testid="buy-confirm"
          >
            {t('dlg.buyLot.confirm')} <Money value={o.price} />
          </Button>
        </>
      }
    >
      <div className={s.stack}>
        <div className={s.row} style={{ alignItems: 'flex-start' }}>
          <BuildingPreview
            kind={isLand ? { t: 'house' } : { t: 'facility', type: facilityType }}
            level={o.level}
            owner={d.seat}
            label={text.lot(o.lot)}
            size={104}
          />
          <div style={{ flex: 1, minWidth: 180 }}>
            <KeyValues rows={rows} />
          </div>
        </div>
        {o.fortuneBonus && <p className={s.note}>🍀 {t('dlg.buyLot.fortuneBonus')}</p>}
        {short && (
          <p className={s.warn} role="alert">
            {t('dlg.common.notEnoughCash')}
          </p>
        )}
        {d.kind === 'BUY_LAND' && d.options.street.lots.length > 1 && (
          <div>
            <h3 className={s.muted} style={{ margin: '0 0 4px' }}>
              {t('dlg.buyLot.street')}
            </h3>
            <ul className={s.choices} data-testid="buy-street">
              {d.options.street.lots.map((lot, i) => {
                const owner = d.options.street.owners[i] ?? null;
                return (
                  <li key={lot} className={s.choice} style={{ cursor: 'default' }}>
                    <SeatMark seat={owner} />
                    <span className={s.choiceMain}>
                      {text.lot(lot)}
                      <small>{owner === null ? t('dlg.common.unowned') : text.player(owner)}</small>
                    </span>
                    {lot === o.lot && <span aria-hidden="true">📍</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </DecisionFrame>
  );
}
