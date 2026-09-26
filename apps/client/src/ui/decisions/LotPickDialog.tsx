// CONSTRUCTION_PICK（建设公司）：从自己的住宅 / 设施里选一块请建设公司加盖 levels 级（工程费由 options 给出，
// 非董事长付给公司、可用存款；董事长免费）；canSkip 时可以跳过。
// 候选地块同步到棋盘高亮，棋盘点选也能选中。
import type { LotId } from '@rich4/shared/engine';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/Button';
import { formatInt } from '../components/format';
import { Money } from '../components/Money';
import { useGameText } from '../components/names';
import { DecisionFrame } from './DecisionFrame';
import s from './decisions.module.css';
import { type BoardPick, useBoardHighlight, useBoardPick } from './targeting';
import type { DecisionProps } from './types';
import { useDecision } from './useDecision';

export default function LotPickDialog(props: DecisionProps<'CONSTRUCTION_PICK'>): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine, decision: d } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d.options;
  const [pick, setPick] = useState<LotId | null>(null);
  const lots = useMemo(() => o.lots.map((l) => l.lot), [o.lots]);
  useBoardHighlight(
    ctl.interactive ? { tiles: [], lots, seats: [], objects: [], selected: pick ? { lot: pick } : null } : null,
  );
  const onBoard = useCallback(
    (p: BoardPick) => {
      if (p.lot && lots.includes(p.lot)) setPick(p.lot);
    },
    [lots],
  );
  useBoardPick(ctl.interactive ? onBoard : null);
  const row = o.lots.find((l) => l.lot === pick) ?? null;

  return (
    <DecisionFrame
      ctl={ctl}
      kind={d.kind}
      seat={d.seat}
      view={view}
      isMine={isMine}
      title={t('dlg.construction.title')}
      subtitle={text.lot(o.company)}
      icon="🏗️"
      tone="orange"
      actions={
        <>
          {o.canSkip ? (
            <Button variant="cream" onClick={() => ctl.send({ type: 'SKIP' })} data-testid="construction-skip">
              {t('dlg.construction.skip')}
            </Button>
          ) : (
            <span />
          )}
          <Button
            disabled={row === null}
            onClick={() => row && ctl.send({ type: 'PICK_LOT', lot: row.lot })}
            data-testid="construction-confirm"
          >
            {row ? t('dlg.construction.confirm', { name: text.lot(row.lot) }) : t('dlg.construction.pickFirst')}
          </Button>
        </>
      }
    >
      <div className={s.stack}>
        <p className={s.note}>
          {o.chairman
            ? `👔 ${t('dlg.construction.chairman', { n: o.levels })}`
            : t('dlg.construction.levels', { n: o.levels })}
        </p>
        {o.lots.length === 0 ? (
          <p className={s.muted}>{t('dlg.construction.none')}</p>
        ) : (
          <ul className={s.choices}>
            {o.lots.map((l) => (
              <li key={l.lot}>
                <button
                  type="button"
                  className={s.choice}
                  aria-pressed={pick === l.lot}
                  onClick={() => setPick(l.lot)}
                  data-testid={`construction-${l.lot}`}
                >
                  <span className={s.choiceMain}>
                    <strong>{text.lot(l.lot)}</strong>
                    <small>
                      {t('dlg.common.levelN', { n: l.level })}
                      {l.rent > 0 ? ` · ${t('dlg.construction.rent', { rent: formatInt(l.rent) })}` : ''}
                    </small>
                  </span>
                  {l.cost > 0 ? <Money value={l.cost} /> : <small>{t('dlg.construction.free')}</small>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </DecisionFrame>
  );
}
