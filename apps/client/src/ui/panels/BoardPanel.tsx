// 公布栏（TURN_MENU 的 board options）：列出挂牌（卖家、资产、价格），买别人的、撤下自己的；
// canList 时可挂牌出售自己的地产（价格不超过 lotCaps）、股票、卡片或道具。规则校验由引擎完成，这里只做显示与输入。
import type { MapIndex } from '@rich4/shared/data';
import {
  CARD_IDS,
  type CardId,
  ITEM_IDS,
  type ItemId,
  type ListingAsset,
  type ListingView,
  type LotId,
  type SeatIndex,
  type TurnMenuOptions,
} from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SeatMark } from '../components/Avatar';
import { Button } from '../components/Button';
import { clampInt, formatInt } from '../components/format';
import { Money } from '../components/Money';
import { type GameText, useGameText } from '../components/names';
import s from './panels.module.css';

export type BoardIntent =
  | { type: 'BOARD_BUY'; listingId: number }
  | { type: 'BOARD_DELIST'; listingId: number }
  | { type: 'BOARD_LIST'; asset: ListingAsset; price: number };

export interface BoardPanelProps {
  view: GameView;
  map: MapIndex;
  seat: SeatIndex;
  board: TurnMenuOptions['board'];
  onAct?(intent: BoardIntent): void;
  disabled?: boolean;
}

export function assetLabel(text: GameText, a: ListingAsset): string {
  switch (a.t) {
    case 'lot':
      return text.lot(a.lot);
    case 'stock':
      return `${text.stock(a.stock)} × ${formatInt(a.shares)}`;
    case 'card':
      return text.card(a.card);
    case 'item':
      return `${text.item(a.item)} × ${a.qty}`;
  }
}

type ListKind = ListingAsset['t'];

export function BoardPanel({ view, map, seat, board, onAct, disabled = false }: BoardPanelProps): ReactNode {
  const { t } = useTranslation();
  const text = useGameText(view, map);
  const p = view.players.find((x) => x.seat === seat);
  const [kind, setKind] = useState<ListKind>('lot');
  const [lot, setLot] = useState<LotId | ''>('');
  const [stock, setStock] = useState<number>(-1);
  const [shares, setShares] = useState(100);
  const [card, setCard] = useState<CardId | 0>(0);
  const [item, setItem] = useState<ItemId | 0>(0);
  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState(1000);

  const ownedStocks = view.stocks.filter((_, i) => (p?.holdings[i]?.shares ?? 0) > 0);
  const ownedCards = p?.cards ? CARD_IDS.filter((c) => p.cards?.includes(c)) : [];
  const ownedItems = p?.items ? ITEM_IDS.filter((i) => (p.items?.[i] ?? 0) > 0) : [];
  const cap = kind === 'lot' && lot ? (board.lotCaps.find((c) => c.lot === lot)?.cap ?? null) : null;

  let asset: ListingAsset | null = null;
  if (kind === 'lot' && lot) asset = { t: 'lot', lot };
  else if (kind === 'stock' && stock >= 0) {
    const have = p?.holdings[view.stocks.findIndex((x) => x.idx === stock)]?.shares ?? 0;
    asset = { t: 'stock', stock, shares: clampInt(shares, 1, Math.max(1, have)) };
  } else if (kind === 'card' && card) asset = { t: 'card', card };
  else if (kind === 'item' && item)
    asset = { t: 'item', item, qty: clampInt(qty, 1, Math.max(1, p?.items?.[item] ?? 1)) };
  const priceOk = price >= 1 && (cap === null || price <= cap);

  const row = (l: ListingView): ReactNode => (
    <tr key={l.id} data-testid={`listing-${l.id}`}>
      <td>
        <SeatMark seat={l.seller} /> {text.player(l.seller)}
      </td>
      <td>{assetLabel(text, l.asset)}</td>
      <td className={s.num}>
        <Money value={l.price} />
      </td>
      <td>
        {l.mine ? (
          <Button
            size="sm"
            variant="cream"
            disabled={disabled || !onAct}
            onClick={() => onAct?.({ type: 'BOARD_DELIST', listingId: l.id })}
            data-testid={`listing-delist-${l.id}`}
          >
            {t('pnl.board.delist')}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="green"
            disabled={disabled || !onAct || !l.affordable}
            onClick={() => onAct?.({ type: 'BOARD_BUY', listingId: l.id })}
            data-testid={`listing-buy-${l.id}`}
            title={l.affordable ? undefined : text.reason('notEnoughCash')}
          >
            {t('pnl.board.buy')}
          </Button>
        )}
      </td>
    </tr>
  );

  return (
    <section className={s.panel} aria-label={t('pnl.board.title')} data-testid="board-panel">
      {board.listings.length === 0 ? (
        <p className={s.muted}>{t('pnl.board.empty')}</p>
      ) : (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>{t('pnl.board.seller')}</th>
                <th>{t('pnl.board.asset')}</th>
                <th className={s.num}>{t('pnl.board.price')}</th>
                <th />
              </tr>
            </thead>
            <tbody>{board.listings.map(row)}</tbody>
          </table>
        </div>
      )}
      <fieldset className={s.trade} disabled={disabled || !board.canList || !onAct} style={{ margin: 0 }}>
        <legend>{t('pnl.board.list', { n: board.mine })}</legend>
        {!board.canList && <p className={s.muted}>{t('pnl.board.cannotList')}</p>}
        <div className={s.tradeRow}>
          <select
            className="select"
            aria-label={t('pnl.board.kind')}
            value={kind}
            onChange={(e) => setKind(e.target.value as ListKind)}
          >
            <option value="lot">{t('pnl.board.kindLot')}</option>
            <option value="stock">{t('pnl.board.kindStock')}</option>
            <option value="card">{t('pnl.board.kindCard')}</option>
            <option value="item">{t('pnl.board.kindItem')}</option>
          </select>
          {kind === 'lot' && (
            <select
              className="select"
              aria-label={t('pnl.board.kindLot')}
              value={lot}
              onChange={(e) => setLot(e.target.value as LotId)}
            >
              <option value="">—</option>
              {board.lotCaps.map((c) => (
                <option key={c.lot} value={c.lot}>
                  {text.lot(c.lot)}
                </option>
              ))}
            </select>
          )}
          {kind === 'stock' && (
            <>
              <select
                className="select"
                aria-label={t('pnl.board.kindStock')}
                value={stock}
                onChange={(e) => setStock(Number(e.target.value))}
              >
                <option value={-1}>—</option>
                {ownedStocks.map((st) => (
                  <option key={st.idx} value={st.idx}>
                    {text.stock(st.idx)}
                  </option>
                ))}
              </select>
              <input
                className="input num"
                type="number"
                min={1}
                aria-label={t('pnl.board.shares')}
                value={shares}
                onChange={(e) => setShares(Number(e.target.value))}
                style={{ width: '9ch' }}
              />
            </>
          )}
          {kind === 'card' && (
            <select
              className="select"
              aria-label={t('pnl.board.kindCard')}
              value={card}
              onChange={(e) => setCard(Number(e.target.value) as CardId | 0)}
            >
              <option value={0}>—</option>
              {ownedCards.map((c) => (
                <option key={c} value={c}>
                  {text.card(c)}
                </option>
              ))}
            </select>
          )}
          {kind === 'item' && (
            <>
              <select
                className="select"
                aria-label={t('pnl.board.kindItem')}
                value={item}
                onChange={(e) => setItem(Number(e.target.value) as ItemId | 0)}
              >
                <option value={0}>—</option>
                {ownedItems.map((i) => (
                  <option key={i} value={i}>
                    {text.item(i)}
                  </option>
                ))}
              </select>
              <input
                className="input num"
                type="number"
                min={1}
                aria-label={t('pnl.board.qty')}
                value={qty}
                onChange={(e) => setQty(Number(e.target.value))}
                style={{ width: '6ch' }}
              />
            </>
          )}
        </div>
        <div className={s.tradeRow}>
          <label>
            {t('pnl.board.price')}{' '}
            <input
              className="input num"
              type="number"
              min={1}
              max={cap ?? undefined}
              value={price}
              onChange={(e) => setPrice(Math.trunc(Number(e.target.value)))}
              style={{ width: '11ch' }}
            />
          </label>
          {cap !== null && <span className={s.muted}>{t('pnl.board.cap', { cap: formatInt(cap) })}</span>}
          <Button
            variant="blue"
            disabled={asset === null || !priceOk}
            onClick={() => asset && onAct?.({ type: 'BOARD_LIST', asset, price })}
            data-testid="board-list"
          >
            {t('pnl.board.doList')}
          </Button>
        </div>
      </fieldset>
    </section>
  );
}
