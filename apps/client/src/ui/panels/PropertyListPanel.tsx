// PropertyListPanel：全部地产一览（住宅、设施、企业），按地主筛选；显示等级、地价、对观察者的过路费（shared 的 calcToll）、
// 涨价 / 查封标记与地契到期日。点一行可让棋盘定位（onLocate）。
import type { MapIndex } from '@rich4/shared/data';
import { calcToll, type FacilityType, type LotId, type SeatIndex } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SeatMark } from '../components/Avatar';
import { formatDateShort, formatInt } from '../components/format';
import { useGameText } from '../components/names';
import s from './panels.module.css';

export type OwnerFilter = 'all' | 'none' | SeatIndex;

export interface PropertyRow {
  id: LotId;
  kind: 'land' | 'facility' | 'company';
  owner: SeatIndex | null;
  level: number;
  landPrice: number | null;
  mark: 'raise' | 'seal' | null;
  tenure: number;
  facility: FacilityType | null;
}

/** 地产行（纯函数） */
export function propertyRows(view: GameView): PropertyRow[] {
  const out: PropertyRow[] = [];
  for (const l of view.lands) {
    out.push({
      id: l.id,
      kind: 'land',
      owner: l.owner,
      level: l.level,
      landPrice: l.landPrice,
      mark: l.mark?.kind ?? null,
      tenure: l.tenure,
      facility: null,
    });
  }
  for (const f of view.facilities) {
    out.push({
      id: f.id,
      kind: 'facility',
      owner: f.owner,
      level: f.level,
      landPrice: f.landPrice,
      mark: f.mark?.kind ?? null,
      tenure: f.tenure,
      facility: f.level > 0 ? f.type : null,
    });
  }
  for (const c of view.companies) {
    const st = view.stocks[c.stock];
    out.push({
      id: c.id,
      kind: 'company',
      owner: st?.chairman ?? null,
      level: 0,
      landPrice: null,
      mark: null,
      tenure: 0,
      facility: null,
    });
  }
  return out;
}

export function filterRows(rows: PropertyRow[], f: OwnerFilter): PropertyRow[] {
  if (f === 'all') return rows;
  if (f === 'none') return rows.filter((r) => r.owner === null);
  return rows.filter((r) => r.owner === f);
}

export interface PropertyListPanelProps {
  view: GameView;
  map: MapIndex;
  /** 观察者座位：用来算「我停上去要付的过路费」；观战为 null */
  viewer: SeatIndex | null;
  initialFilter?: OwnerFilter;
  onLocate?(lot: LotId): void;
}

export function PropertyListPanel({
  view,
  map,
  viewer,
  initialFilter = 'all',
  onLocate,
}: PropertyListPanelProps): ReactNode {
  const { t } = useTranslation();
  const text = useGameText(view, map);
  const [filter, setFilter] = useState<OwnerFilter>(initialFilter);
  const rows = filterRows(propertyRows(view), filter);
  const toll = (r: PropertyRow): number | null => {
    if (viewer === null || r.owner === null || r.owner === viewer || r.kind !== 'land') return null;
    try {
      return calcToll(view, map, r.id, viewer);
    } catch {
      return null;
    }
  };
  const kindLabel = (r: PropertyRow): string =>
    r.kind === 'land'
      ? text.t('tiles:lot.land')
      : r.kind === 'company'
        ? text.t('tiles:lot.company')
        : r.facility
          ? text.facility(r.facility)
          : text.t('tiles:lot.facility');

  return (
    <section className={s.panel} aria-label={t('pnl.property.title')} data-testid="property-list">
      <div className={s.filter}>
        <label htmlFor="property-filter">{t('pnl.property.filter')}</label>
        <select
          id="property-filter"
          className="select"
          value={String(filter)}
          onChange={(e) => {
            const v = e.target.value;
            setFilter(v === 'all' || v === 'none' ? v : (Number(v) as SeatIndex));
          }}
        >
          <option value="all">{t('pnl.property.all')}</option>
          <option value="none">{t('pnl.property.unowned')}</option>
          {view.players.map((p) => (
            <option key={p.seat} value={p.seat}>
              {text.player(p.seat)}
            </option>
          ))}
        </select>
        <span className={s.muted}>{t('pnl.property.count', { n: rows.length })}</span>
      </div>
      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th>{t('pnl.property.name')}</th>
              <th>{t('pnl.property.kind')}</th>
              <th className={s.num}>{t('pnl.property.level')}</th>
              <th>{t('pnl.property.owner')}</th>
              <th className={s.num}>{t('pnl.property.landPrice')}</th>
              <th className={s.num}>{t('pnl.property.toll')}</th>
              <th>{t('pnl.property.mark')}</th>
              <th>{t('pnl.property.tenure')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const tl = toll(r);
              return (
                <tr key={r.id} data-testid={`property-${r.id}`}>
                  <td>
                    {onLocate ? (
                      <button
                        type="button"
                        className="btn btn--sm btn--cream"
                        style={{ minHeight: 26 }}
                        onClick={() => onLocate(r.id)}
                      >
                        {text.lot(r.id)}
                      </button>
                    ) : (
                      text.lot(r.id)
                    )}
                  </td>
                  <td>{kindLabel(r)}</td>
                  <td className={s.num}>{r.kind === 'company' ? '—' : r.level}</td>
                  <td>
                    {r.owner === null ? (
                      <span className={s.muted}>{t('pnl.property.unowned')}</span>
                    ) : (
                      <>
                        <SeatMark seat={r.owner} /> {text.player(r.owner)}
                      </>
                    )}
                  </td>
                  <td className={s.num}>{r.landPrice === null ? '—' : formatInt(r.landPrice)}</td>
                  <td className={s.num} data-testid={`property-toll-${r.id}`}>
                    {tl === null ? '—' : formatInt(tl)}
                  </td>
                  <td>
                    {r.mark === 'raise' && (
                      <span className={`${s.mark} ${s.markRaise}`}>{t('pnl.property.markRaise')}</span>
                    )}
                    {r.mark === 'seal' && (
                      <span className={`${s.mark} ${s.markSeal}`}>{t('pnl.property.markSeal')}</span>
                    )}
                  </td>
                  <td>{r.tenure ? formatDateShort(r.tenure) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
