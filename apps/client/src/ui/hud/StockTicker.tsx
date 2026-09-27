// 股市跑马灯（design/client.md §4.5 MARKET_TICK / §5.1）：红涨绿跌，读显示态刷新
import type { MapIndex } from '@rich4/shared/data';
import type { GameView } from '@rich4/shared/view';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { uiLanguage } from '../../i18n';
import { useTx } from '../../i18n/tx';
import { pickMapString } from '../../presentation/names';
import h from './hud.module.css';

export function formatCentsShort(c: number): string {
  const v = Math.trunc(c);
  return `${Math.trunc(v / 100)}.${String(Math.abs(v % 100)).padStart(2, '0')}`;
}

export function StockTicker({ view, map }: { view: GameView; map: MapIndex | null }): ReactNode {
  const t = useTx();
  if (view.stocks.length === 0) return <div className={h.ticker} />;
  const name = (idx: number): string => {
    const def = map?.def.stocks.find((s) => s.index === idx);
    return (def && pickMapString(map?.def.strings, def.nameKey, uiLanguage())) ?? `#${idx + 1}`;
  };
  const items = view.stocks.map((s) => {
    const d = s.priceCents - s.prevCents;
    return (
      <span key={s.idx} className={clsx(h.tick, d > 0 && h.up, d < 0 && h.down)} data-testid={`tick-${s.idx}`}>
        {d > 0 ? '▲' : d < 0 ? '▼' : '■'}
        {name(s.idx)} <span className="num">{formatCentsShort(s.priceCents)}</span>
        {s.suspend > 0 && <small>{t('hud:top.suspended')}</small>}
      </span>
    );
  });
  return (
    <div
      className={h.ticker}
      role="marquee"
      aria-label={t('hud:top.market')}
      data-market={view.clock.marketOpen ? 'open' : 'closed'}
    >
      <div className={h.tickerTrack}>
        {items}
        <span aria-hidden="true">{items}</span>
      </div>
    </div>
  );
}
