// UPGRADE_LAND / UPGRADE_FACILITY：当前 → 下一级外观预览（建筑生成器出图）、费用、新过路费（或等级上限）
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { BuildingPreview } from '../components/BuildingPreview';
import { Button } from '../components/Button';
import { Money } from '../components/Money';
import { useGameText } from '../components/names';
import { KeyValues } from '../components/Panel';
import { DecisionFrame } from './DecisionFrame';
import s from './decisions.module.css';
import { lotStatus } from './helpers';
import { type DecisionProps, narrowDecision } from './types';
import { useDecision } from './useDecision';

export default function UpgradeDialog(props: DecisionProps<'UPGRADE_LAND' | 'UPGRADE_FACILITY'>): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine } = props;
  const d = narrowDecision(props.decision);
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d.options;
  const short = o.cost > o.cash;
  const isLand = d.kind === 'UPGRADE_LAND';
  const chain = isLand ? (lotStatus(view, o.lot)?.chain ?? false) : false;
  const kind =
    d.kind === 'UPGRADE_LAND' ? ({ t: 'house', chain } as const) : { t: 'facility' as const, type: d.options.type };

  const rows: [ReactNode, ReactNode][] = [
    [t('dlg.upgrade.cost'), <Money key="c" value={o.cost} testId="upgrade-cost" />],
    [t('dlg.common.cash'), <Money key="h" value={o.cash} />],
    [t('dlg.upgrade.cashAfter'), <Money key="a" value={o.cash - o.cost} tone />],
  ];
  if (d.kind === 'UPGRADE_LAND') {
    rows.push([
      t('dlg.upgrade.toll'),
      <span key="t" className={s.row} style={{ justifyContent: 'flex-end' }} data-testid="upgrade-toll">
        <Money value={d.options.tollBefore} />
        <span className={s.arrow}>→</span>
        <Money value={d.options.tollAfter} />
      </span>,
    ]);
  } else {
    rows.push([t('dlg.upgrade.facility'), text.facility(d.options.type)]);
    rows.push([t('dlg.upgrade.cap'), t('dlg.common.levelN', { n: d.options.cap })]);
  }

  return (
    <DecisionFrame
      ctl={ctl}
      kind={d.kind}
      seat={d.seat}
      view={view}
      isMine={isMine}
      title={t('dlg.upgrade.title')}
      subtitle={text.lot(o.lot)}
      icon="🔨"
      tone="orange"
      actions={
        <>
          <Button variant="cream" onClick={() => ctl.send({ type: 'DECLINE' })} data-testid="upgrade-decline">
            {t('dlg.upgrade.decline')}
          </Button>
          <Button onClick={() => ctl.send({ type: 'CONFIRM' })} disabled={short} data-testid="upgrade-confirm">
            {t('dlg.upgrade.confirm')} <Money value={o.cost} />
          </Button>
        </>
      }
    >
      <div className={s.stack}>
        <div className={s.row} style={{ justifyContent: 'center' }} data-testid="upgrade-levels">
          <div style={{ textAlign: 'center' }}>
            <BuildingPreview kind={kind} level={o.fromLevel} owner={d.seat} label={t('dlg.upgrade.now')} size={96} />
            <div className={s.muted}>{t('dlg.common.levelN', { n: o.fromLevel })}</div>
          </div>
          <span className={s.arrow} aria-hidden="true">
            ➜
          </span>
          <div style={{ textAlign: 'center' }}>
            <BuildingPreview kind={kind} level={o.toLevel} owner={d.seat} label={t('dlg.upgrade.next')} size={96} />
            <div>
              <strong>{t('dlg.common.levelN', { n: o.toLevel })}</strong>
            </div>
          </div>
        </div>
        {o.toLevel - o.fromLevel > 1 && <p className={s.note}>🍀 {t('dlg.upgrade.bonus')}</p>}
        <KeyValues rows={rows} />
        {short && (
          <p className={s.warn} role="alert">
            {t('dlg.common.notEnoughCash')}
          </p>
        )}
      </div>
    </DecisionFrame>
  );
}
