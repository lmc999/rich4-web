// SHOP（百货公司）：用点券买卖卡片与道具。每次买卖都是一个非终结 intent，服务器会以新 decisionId 重发 SHOP，
// 所以对话框保持打开；LEAVE 结束。货架、价格、库存、可买上限全部来自 options。
import { ECON, itemDef } from '@rich4/shared/data';
import type { ItemId } from '@rich4/shared/engine';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/Button';
import { CardTile, ItemTile, TileGrid } from '../components/CardTile';
import { Money } from '../components/Money';
import { useGameText } from '../components/names';
import { Badge } from '../components/Panel';
import { Stepper } from '../components/Stepper';
import { Tabs } from '../components/Tabs';
import { DecisionFrame } from './DecisionFrame';
import s from './decisions.module.css';
import type { DecisionProps } from './types';
import { useDecision } from './useDecision';

type ShopTab = 'buyCard' | 'buyItem' | 'sellCard' | 'sellItem';

/** 卖回价 = trunc(标价 × 数量 × 0.9)，与引擎 rules/inventory.sellValue 同一公式（多个一起卖时不等于单价 × 数量） */
function sellItemValue(item: ItemId, qty: number): number {
  return Math.trunc((itemDef(item).price * qty * ECON.SELL_RATE_NUM) / ECON.SELL_RATE_DEN);
}

export default function ShopDialog(props: DecisionProps<'SHOP'>): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine, decision: d } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d.options;
  const [tab, setTab] = useState<ShopTab>('buyCard');
  const [cardPick, setCardPick] = useState<number | null>(null);
  const [sellCardPick, setSellCardPick] = useState<number | null>(null);
  const [itemPick, setItemPick] = useState<ItemId | null>(null);
  const [sellPick, setSellPick] = useState<ItemId | null>(null);
  const [qty, setQty] = useState(1);
  const handFull = o.handCount >= o.handMax;
  /** 本次进店的交易次数用完，只能离开 */
  const tradesLeft = o.visit.remaining > 0;

  const shelfRow = o.shelf.find((x) => x.idx === cardPick) ?? null;
  const sellCardRow = o.sell.cards.find((x) => x.slot === sellCardPick) ?? null;
  const buyItemRow = o.items.find((x) => x.item === itemPick) ?? null;
  const sellItemRow = o.sell.items.find((x) => x.item === sellPick) ?? null;
  const buyQtyMax = buyItemRow ? Math.max(0, buyItemRow.maxQty) : 0;
  const sellQtyMax = sellItemRow ? sellItemRow.count : 0;

  const buyCards = (
    <div className={s.stack}>
      {handFull && <p className={s.warn}>{t('dlg.shop.handFull', { max: o.handMax })}</p>}
      {o.fullDeck && <p className={s.muted}>{t('dlg.shop.fullDeck')}</p>}
      {o.shelf.length === 0 ? (
        <p className={s.muted}>{t('dlg.shop.emptyShelf')}</p>
      ) : (
        <TileGrid label={t('dlg.shop.shelf')}>
          {o.shelf.map((row) => {
            const reason = row.buyable
              ? null
              : handFull
                ? text.reason('handFull')
                : row.price > o.points
                  ? text.reason('notEnoughPoints')
                  : text.reason('poolEmpty');
            return (
              <CardTile
                key={row.idx}
                card={row.card}
                name={text.card(row.card)}
                description={text.cardDesc(row.card)}
                price={row.price}
                disabled={reason !== null}
                reason={reason}
                selected={cardPick === row.idx}
                onClick={() => setCardPick(row.idx)}
                testId={`shop-shelf-${row.idx}`}
              />
            );
          })}
        </TileGrid>
      )}
      {shelfRow && (
        <div className={s.between}>
          <span>{text.card(shelfRow.card)}</span>
          <Button
            variant="green"
            disabled={!shelfRow.buyable || !tradesLeft}
            onClick={() => ctl.send({ type: 'SHOP_BUY_CARD', shelfIdx: shelfRow.idx })}
            data-testid="shop-buy-card"
          >
            {t('dlg.shop.buyFor')} <Money value={shelfRow.price} unit="points" />
          </Button>
        </div>
      )}
    </div>
  );

  const buyItems = (
    <div className={s.stack}>
      <TileGrid label={t('dlg.shop.items')}>
        {o.items.map((row) => {
          const reason =
            row.maxQty > 0
              ? null
              : row.pool <= 0
                ? text.reason('poolEmpty')
                : row.own >= 9
                  ? text.reason('itemFull')
                  : text.reason('notEnoughPoints');
          return (
            <ItemTile
              key={row.item}
              item={row.item}
              name={text.item(row.item)}
              description={text.itemDesc(row.item)}
              price={row.price}
              count={row.own > 0 ? row.own : null}
              disabled={reason !== null}
              reason={reason}
              selected={itemPick === row.item}
              caption={<small className={s.muted}>{t('dlg.shop.stock', { n: row.pool })}</small>}
              onClick={() => {
                setItemPick(row.item);
                setQty(1);
              }}
              testId={`shop-item-${row.item}`}
            />
          );
        })}
      </TileGrid>
      {buyItemRow && (
        <div className={s.between} data-testid="shop-buy-item-panel">
          <Stepper
            value={Math.min(qty, Math.max(1, buyQtyMax))}
            onChange={setQty}
            min={1}
            max={Math.max(1, buyQtyMax)}
            label={t('dlg.shop.qty')}
            disabled={buyQtyMax < 1}
          />
          <Button
            variant="green"
            disabled={buyQtyMax < 1 || !tradesLeft}
            onClick={() =>
              ctl.send({ type: 'SHOP_BUY_ITEM', item: buyItemRow.item, qty: Math.min(Math.max(1, qty), buyQtyMax) })
            }
            data-testid="shop-buy-item"
          >
            {t('dlg.shop.buyFor')}{' '}
            <Money value={buyItemRow.price * Math.min(Math.max(1, qty), Math.max(1, buyQtyMax))} unit="points" />
          </Button>
        </div>
      )}
    </div>
  );

  const sellCards =
    o.sell.cards.length === 0 ? (
      <p className={s.muted}>{t('dlg.shop.noCards')}</p>
    ) : (
      <div className={s.stack}>
        <TileGrid label={t('dlg.shop.sellCards')}>
          {o.sell.cards.map((row) => (
            <CardTile
              key={row.slot}
              card={row.card}
              name={text.card(row.card)}
              description={text.cardDesc(row.card)}
              selected={sellCardPick === row.slot}
              caption={
                <small>
                  {t('dlg.shop.sellValue')} <Money value={row.value} unit="points" />
                </small>
              }
              onClick={() => setSellCardPick(row.slot)}
              testId={`shop-sell-card-${row.slot}`}
            />
          ))}
        </TileGrid>
        {sellCardRow && (
          <div className={s.between}>
            <span>{text.card(sellCardRow.card)}</span>
            <Button
              variant="blue"
              disabled={!tradesLeft}
              onClick={() => ctl.send({ type: 'SHOP_SELL_CARD', slot: sellCardRow.slot })}
              data-testid="shop-sell-card"
            >
              {t('dlg.shop.sellFor')} <Money value={sellCardRow.value} unit="points" />
            </Button>
          </div>
        )}
      </div>
    );

  const sellItems =
    o.sell.items.length === 0 ? (
      <p className={s.muted}>{t('dlg.shop.noItems')}</p>
    ) : (
      <div className={s.stack}>
        <TileGrid label={t('dlg.shop.sellItems')}>
          {o.sell.items.map((row) => (
            <ItemTile
              key={row.item}
              item={row.item}
              name={text.item(row.item)}
              count={row.count}
              selected={sellPick === row.item}
              caption={
                <small>
                  {t('dlg.shop.unitValue')} <Money value={row.unitValue} unit="points" />
                </small>
              }
              onClick={() => {
                setSellPick(row.item);
                setQty(1);
              }}
              testId={`shop-sell-item-${row.item}`}
            />
          ))}
        </TileGrid>
        {sellItemRow && (
          <div className={s.between}>
            <Stepper
              value={Math.min(qty, sellQtyMax)}
              onChange={setQty}
              min={1}
              max={sellQtyMax}
              label={t('dlg.shop.qty')}
            />
            <Button
              variant="blue"
              disabled={!tradesLeft}
              onClick={() =>
                ctl.send({
                  type: 'SHOP_SELL_ITEM',
                  item: sellItemRow.item,
                  qty: Math.min(Math.max(1, qty), sellQtyMax),
                })
              }
              data-testid="shop-sell-item"
            >
              {t('dlg.shop.sellFor')}{' '}
              <Money value={sellItemValue(sellItemRow.item, Math.min(Math.max(1, qty), sellQtyMax))} unit="points" />
            </Button>
          </div>
        )}
      </div>
    );

  return (
    <DecisionFrame
      ctl={ctl}
      kind={d.kind}
      seat={d.seat}
      view={view}
      isMine={isMine}
      title={t('dlg.shop.title')}
      icon="🛍️"
      tone="pink"
      size="lg"
      actions={
        <Button variant="cream" onClick={() => ctl.send({ type: 'LEAVE' })} data-testid="shop-leave">
          {t('dlg.shop.leave')}
        </Button>
      }
    >
      <div className={s.stack}>
        <div className={s.row}>
          <Badge>
            {t('dlg.common.points')} <Money value={o.points} unit="points" testId="shop-points" />
          </Badge>
          <Badge>{t('dlg.shop.hand', { n: o.handCount, max: o.handMax })}</Badge>
        </div>
        {!tradesLeft && <p className={s.warn}>{t('dlg.shop.tradeLimit')}</p>}
        <Tabs<ShopTab>
          label={t('dlg.shop.title')}
          value={tab}
          onValueChange={setTab}
          tabs={[
            { value: 'buyCard', label: t('dlg.shop.tabBuyCard'), content: buyCards },
            { value: 'buyItem', label: t('dlg.shop.tabBuyItem'), content: buyItems },
            { value: 'sellCard', label: t('dlg.shop.tabSellCard'), content: sellCards },
            { value: 'sellItem', label: t('dlg.shop.tabSellItem'), content: sellItems },
          ]}
        />
      </div>
    </DecisionFrame>
  );
}
