// StockPanel（design/client.md §5.4）：名称、现价、涨跌幅（红涨绿跌）、30 天走势、持股、均价、盈亏、董事长；
// 本人回合（传入 TURN_MENU 的 stock options）可买卖：Stepper 选股数，显示金额（= trunc(价 × 股数 / 100)，无手续费）与交易后存款。
import type { MapIndex } from '@rich4/shared/data';
import type { SeatIndex, StockRow, TurnMenuOptions } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { ToggleGroup } from 'radix-ui';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SeatMark } from '../components/Avatar';
import { Button } from '../components/Button';
import { clampInt, formatCents, formatInt, formatPct10, formatSigned, stockAmount } from '../components/format';
import { Money } from '../components/Money';
import { type LooseT, useGameText } from '../components/names';
import { Sparkline } from '../components/Sparkline';
import { Stepper } from '../components/Stepper';
import s from './panels.module.css';

export const SPARK_DAYS = 30;

export type StockTradeIntent = { type: 'STOCK_BUY' | 'STOCK_SELL'; stock: number; shares: number };

export interface StockPanelProps {
  view: GameView;
  map: MapIndex;
  /** 观察者座位（显示持股与盈亏）；观战为 null */
  seat: SeatIndex | null;
  /** TURN_MENU 的 stock options；缺省为只读行情 */
  market?: TurnMenuOptions['stock'] | null;
  onTrade?(intent: StockTradeIntent): void;
  disabled?: boolean;
}

/** 没有 market options 时由 view 推出只读行情行（涨跌幅按前日收盘价，与引擎 TURN_MENU 同式） */
export function viewStockRows(view: GameView, seat: SeatIndex | null): StockRow[] {
  const p = seat === null ? null : view.players.find((x) => x.seat === seat);
  return view.stocks.map((st, i) => ({
    idx: st.idx,
    priceCents: st.priceCents,
    changePct10: st.prevCents > 0 ? Math.trunc(((st.priceCents - st.prevCents) * 1000) / st.prevCents) : 0,
    quota: p?.quota[i] ?? 0,
    float: st.float,
    limitUp: false,
    limitDown: false,
    suspended: st.suspend > 0,
    shares: p?.holdings[i]?.shares ?? 0,
    costCents: p?.holdings[i]?.costCents ?? 0,
    maxBuy: 0,
    maxSell: 0,
    chairman: st.chairman,
  }));
}

/** 持股市值、成本（元）与盈亏 */
export function holdingValue(row: Pick<StockRow, 'priceCents' | 'shares' | 'costCents'>): {
  value: number;
  cost: number;
  pnl: number;
} {
  const value = stockAmount(row.priceCents, row.shares);
  const cost = Math.trunc(row.costCents / 100);
  return { value, cost, pnl: value - cost };
}

export function StockPanel({ view, map, seat, market = null, onTrade, disabled = false }: StockPanelProps): ReactNode {
  const { t } = useTranslation();
  const lt = t as unknown as LooseT;
  const text = useGameText(view, map);
  const rows = market ? market.rows : viewStockRows(view, seat);
  const [sel, setSel] = useState<number | null>(null);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [shares, setShares] = useState(100);
  const row = rows.find((r) => r.idx === sel) ?? null;
  const history = (idx: number): number[] => {
    const st = view.stocks.find((x) => x.idx === idx);
    return st ? st.history.slice(-SPARK_DAYS) : [];
  };
  const totalValue = rows.reduce((sum, r) => sum + stockAmount(r.priceCents, r.shares), 0);

  let blocked: string | null = null;
  const max = row ? (side === 'buy' ? row.maxBuy : row.maxSell) : 0;
  if (row) {
    if (!market || !onTrade) blocked = t('pnl.stock.readOnly');
    else if (!market.open) blocked = lt(`pnl.stock.closed.${market.reason ?? 'holiday'}`);
    else if (row.suspended) blocked = text.reason('suspended');
    else if (side === 'buy' && row.limitUp) blocked = text.reason('limitUp');
    else if (side === 'sell' && row.limitDown) blocked = text.reason('limitDown');
    else if (max <= 0) blocked = side === 'buy' ? t('pnl.stock.cannotBuy') : t('pnl.stock.cannotSell');
  }
  const n = clampInt(shares, max > 0 ? 1 : 0, max);
  const amount = row ? stockAmount(row.priceCents, n) : 0;
  const depositAfter = market ? market.deposit + (side === 'buy' ? -amount : amount) : null;

  return (
    <section className={s.panel} aria-label={t('pnl.stock.title')} data-testid="stock-panel">
      <div className={s.badges}>
        {market && (
          <span className={s.muted} data-testid="stock-market-state">
            {market.open ? t('pnl.stock.open') : lt(`pnl.stock.closed.${market.reason ?? 'holiday'}`)}
          </span>
        )}
        {seat !== null && (
          <span className={s.muted}>
            {t('pnl.stock.totalValue')} <Money value={totalValue} testId="stock-total-value" />
          </span>
        )}
        {market && (
          <span className={s.muted}>
            {t('pnl.stock.deposit')} <Money value={market.deposit} testId="stock-deposit" />
          </span>
        )}
      </div>
      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th>{t('pnl.stock.name')}</th>
              <th className={s.num}>{t('pnl.stock.price')}</th>
              <th className={s.num}>{t('pnl.stock.change')}</th>
              <th>{t('pnl.stock.trend', { n: SPARK_DAYS })}</th>
              {seat !== null && <th className={s.num}>{t('pnl.stock.shares')}</th>}
              {seat !== null && <th className={s.num}>{t('pnl.stock.avg')}</th>}
              {seat !== null && <th className={s.num}>{t('pnl.stock.pnl')}</th>}
              <th>{t('pnl.stock.chairman')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const hv = holdingValue(r);
              const avg = r.shares > 0 ? Math.trunc(r.costCents / r.shares) : 0;
              const dir = r.changePct10 > 0 ? s.up : r.changePct10 < 0 ? s.down : undefined;
              return (
                <tr key={r.idx} data-selected={sel === r.idx ? 'true' : 'false'} data-testid={`stock-row-${r.idx}`}>
                  <td>
                    <button
                      type="button"
                      className="btn btn--sm btn--cream"
                      style={{ minHeight: 26 }}
                      aria-pressed={sel === r.idx}
                      onClick={() => setSel(r.idx)}
                      data-testid={`stock-pick-${r.idx}`}
                    >
                      {text.stock(r.idx)}
                    </button>
                    {r.suspended && <small className={s.muted}> {text.reason('suspended')}</small>}
                  </td>
                  <td className={`${s.num} ${dir ?? ''}`}>{formatCents(r.priceCents)}</td>
                  <td className={`${s.num} ${dir ?? ''}`}>
                    {formatPct10(r.changePct10)}
                    {r.limitUp ? ' ▲' : r.limitDown ? ' ▼' : ''}
                  </td>
                  <td>
                    <Sparkline values={history(r.idx)} label={t('pnl.stock.trendOf', { name: text.stock(r.idx) })} />
                  </td>
                  {seat !== null && <td className={s.num}>{formatInt(r.shares)}</td>}
                  {seat !== null && <td className={s.num}>{r.shares > 0 ? formatCents(avg) : '—'}</td>}
                  {seat !== null && (
                    <td
                      className={`${s.num} ${hv.pnl > 0 ? s.up : hv.pnl < 0 ? s.down : ''}`}
                      data-testid={`stock-pnl-${r.idx}`}
                    >
                      {r.shares > 0 ? formatSigned(hv.pnl) : '—'}
                    </td>
                  )}
                  <td>
                    {r.chairman === null ? (
                      '—'
                    ) : (
                      <>
                        <SeatMark seat={r.chairman} /> {text.player(r.chairman)}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {row && (
        <fieldset className={s.trade} disabled={disabled} data-testid="stock-trade" style={{ margin: 0 }}>
          <div className={s.tradeRow}>
            <strong>
              {text.stock(row.idx)} · {formatCents(row.priceCents)}
            </strong>
            <ToggleGroup.Root
              type="single"
              value={side}
              onValueChange={(v) => {
                if (v === 'buy' || v === 'sell') setSide(v);
              }}
              aria-label={t('pnl.stock.side')}
              style={{ display: 'inline-flex', gap: 6 }}
            >
              <ToggleGroup.Item value="buy" className="btn btn--sm" data-testid="stock-side-buy">
                {t('pnl.stock.buy')}
              </ToggleGroup.Item>
              <ToggleGroup.Item value="sell" className="btn btn--sm btn--cream" data-testid="stock-side-sell">
                {t('pnl.stock.sell')}
              </ToggleGroup.Item>
            </ToggleGroup.Root>
          </div>
          <div className={s.tradeRow}>
            <Stepper
              value={n}
              onChange={setShares}
              min={max > 0 ? 1 : 0}
              max={max}
              bigStep={100}
              showMax
              label={t('pnl.stock.qty')}
              disabled={blocked !== null}
              testId="stock-qty"
            />
            <span className={s.muted}>
              {t(side === 'buy' ? 'pnl.stock.maxBuy' : 'pnl.stock.maxSell', { n: formatInt(Math.max(0, max)) })}
            </span>
          </div>
          <div className={s.tradeRow}>
            <span>
              {t('pnl.stock.amount')} <Money value={amount} testId="stock-amount" />
              {depositAfter !== null && (
                <>
                  {' · '}
                  {t('pnl.stock.depositAfter')} <Money value={depositAfter} tone testId="stock-deposit-after" />
                </>
              )}
            </span>
            <Button
              variant={side === 'buy' ? 'red' : 'green'}
              disabled={blocked !== null || n < 1}
              onClick={() =>
                onTrade?.({ type: side === 'buy' ? 'STOCK_BUY' : 'STOCK_SELL', stock: row.idx, shares: n })
              }
              data-testid="stock-submit"
            >
              {t(side === 'buy' ? 'pnl.stock.doBuy' : 'pnl.stock.doSell', { n: formatInt(n) })}
            </Button>
          </div>
          {blocked ? <p className={s.warn}>{blocked}</p> : <p className={s.muted}>{t('pnl.stock.noFee')}</p>}
        </fieldset>
      )}
    </section>
  );
}
