// RESEARCH：自己的研究所选研发项目（1..等级，一律 5 天、不收费，到期交付道具 8+project）
import type { ResearchProject } from '@rich4/shared/engine';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/Button';
import { ITEM_ICON } from '../components/cardVisuals';
import { useGameText } from '../components/names';
import { DecisionFrame } from './DecisionFrame';
import s from './decisions.module.css';
import type { DecisionProps } from './types';
import { useDecision } from './useDecision';

export default function ResearchDialog(props: DecisionProps<'RESEARCH'>): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine, decision: d } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d.options;
  const cur = o.current;
  const [pick, setPick] = useState<ResearchProject | null>(cur?.project ?? null);
  const curItem = cur ? o.projects.find((p) => p.project === cur.project)?.item : undefined;

  return (
    <DecisionFrame
      ctl={ctl}
      kind={d.kind}
      seat={d.seat}
      view={view}
      isMine={isMine}
      title={t('dlg.research.title')}
      subtitle={`${text.lot(o.lot)} · ${t('dlg.common.levelN', { n: o.level })}`}
      icon="🔬"
      tone="purple"
      actions={
        <>
          <Button variant="cream" onClick={() => ctl.send({ type: 'SKIP' })} data-testid="research-skip">
            {t('dlg.research.skip')}
          </Button>
          <Button
            variant="purple"
            disabled={pick === null}
            onClick={() => pick !== null && ctl.send({ type: 'RESEARCH', project: pick })}
            data-testid="research-confirm"
          >
            {t('dlg.research.confirm')}
          </Button>
        </>
      }
    >
      <div className={s.stack}>
        {cur && curItem !== undefined ? (
          <p className={s.note} data-testid="research-current">
            {t('dlg.research.current', { item: text.item(curItem), days: cur.days })}
          </p>
        ) : (
          <p className={s.muted}>{t('dlg.research.none')}</p>
        )}
        <ul className={s.choices}>
          {o.projects.map((p) => (
            <li key={p.project}>
              <button
                type="button"
                className={s.choice}
                aria-pressed={pick === p.project}
                onClick={() => setPick(p.project)}
                data-testid={`research-${p.project}`}
              >
                <span style={{ fontSize: 24 }} aria-hidden="true">
                  {ITEM_ICON[p.item]}
                </span>
                <span className={s.choiceMain}>
                  <strong>{text.item(p.item)}</strong>
                  <small>{t('dlg.research.days', { n: p.days })}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className={s.muted}>{t('dlg.research.free')}</p>
        {cur && pick !== null && pick !== cur.project && <p className={s.warn}>{t('dlg.research.switchWarn')}</p>}
      </div>
    </DecisionFrame>
  );
}
