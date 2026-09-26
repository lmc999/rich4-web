// BUILD_FACILITY（0 级设施首建，付费，可放弃）/ FACILITY_TYPE（免费首建，只选类型）：
// 五选一（公园 / 旅馆 / 购物中心 / 加油站 / 研究所），每项显示等级上限与收费预览（options.types）。
import type { FacilityType } from '@rich4/shared/engine';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/Button';
import { Money } from '../components/Money';
import { type LooseT, useGameText } from '../components/names';
import { KeyValues } from '../components/Panel';
import { DecisionFrame } from './DecisionFrame';
import s from './decisions.module.css';
import { FACILITY_ICON } from './helpers';
import { type DecisionProps, narrowDecision } from './types';
import { useDecision } from './useDecision';

export default function FacilityBuildDialog(props: DecisionProps<'BUILD_FACILITY' | 'FACILITY_TYPE'>): ReactNode {
  const { t } = useTranslation();
  const lt = t as unknown as LooseT;
  const { view, map, isMine } = props;
  const d = narrowDecision(props.decision);
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const [pick, setPick] = useState<FacilityType | null>(null);
  const types = d.options.types;
  const paid = d.kind === 'BUILD_FACILITY';
  const short = d.kind === 'BUILD_FACILITY' && d.options.cost > d.options.cash;

  const confirm = (): void => {
    if (pick === null) return;
    ctl.send(paid ? { type: 'BUILD_FACILITY', facility: pick } : { type: 'CHOOSE_FACILITY_TYPE', facility: pick });
  };

  return (
    <DecisionFrame
      ctl={ctl}
      kind={d.kind}
      seat={d.seat}
      view={view}
      isMine={isMine}
      title={t(paid ? 'dlg.facility.titleBuild' : 'dlg.facility.titleFree')}
      subtitle={text.lot(d.options.lot)}
      icon="🏗️"
      tone="orange"
      size="lg"
      actions={
        <>
          {paid ? (
            <Button variant="cream" onClick={() => ctl.send({ type: 'DECLINE' })} data-testid="facility-decline">
              {t('dlg.facility.decline')}
            </Button>
          ) : (
            <span />
          )}
          <Button onClick={confirm} disabled={pick === null || short} data-testid="facility-confirm">
            {pick === null
              ? t('dlg.facility.pickFirst')
              : t(paid ? 'dlg.facility.build' : 'dlg.facility.choose', { name: text.facility(pick) })}
          </Button>
        </>
      }
    >
      <div className={s.stack}>
        {d.kind === 'BUILD_FACILITY' ? (
          <KeyValues
            rows={[
              [t('dlg.facility.cost'), <Money key="c" value={d.options.cost} testId="facility-cost" />],
              [t('dlg.common.cash'), <Money key="h" value={d.options.cash} />],
            ]}
          />
        ) : (
          <p className={s.note}>🎁 {t('dlg.facility.freeNote')}</p>
        )}
        {short && (
          <p className={s.warn} role="alert">
            {t('dlg.common.notEnoughCash')}
          </p>
        )}
        <ul className={s.choices} aria-label={t('dlg.facility.types')}>
          {types.map((row) => (
            <li key={row.type}>
              <button
                type="button"
                className={`${s.choice} ${s.typeCard}`}
                aria-pressed={pick === row.type}
                onClick={() => setPick(row.type)}
                data-testid={`facility-type-${row.type}`}
              >
                <span className={s.row}>
                  <span className={s.typeIcon} aria-hidden="true">
                    {FACILITY_ICON[row.type]}
                  </span>
                  <strong>{text.facility(row.type)}</strong>
                </span>
                <small>{lt(`dlg.facility.desc.${row.type}`)}</small>
                <small>
                  {t('dlg.facility.cap', { n: row.cap })} · {t('dlg.facility.fee')} <Money value={row.feePreview} />
                </small>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </DecisionFrame>
  );
}
