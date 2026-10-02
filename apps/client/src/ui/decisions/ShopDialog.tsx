// SHOP（百货公司）：用点券买卖卡片与道具。每次买卖都是一个非终结 intent，服务器会以新 decisionId 重发 SHOP，
// 所以对话框保持打开；LEAVE 结束。货架、价格、能不能买全部来自 options。
// 道具按原版（与原版皮肤 ui/classic/venues/a/Shop.tsx 相同）：不显示库存，只列进店时有库存的道具（listed）；
// 一次买 1 个，买过的这一种本次进店不能再买（bought，置灰）；卖道具也一次 1 个、可以一直卖。没有数量步进器。
import type { ItemId } from '@rich4/shared/engine';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/Button';
import { CardTile, ItemTile, TileGrid } from '../components/CardTile';
import { Money } from '../components/Money';
import { useGameText } from '../components/names';
import { Badge } from '../components/Panel';
import { Tabs } from '../components/Tabs';
import { DecisionFrame } from './DecisionFrame';
import s from './decisions.module.css';
import type { DecisionProps } from './types';
import { useDecision } from './useDecision';

type ShopTab = 'buyCard' | 'buyItem' | 'sellCard' | 'sellItem';

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
  const handFull = o.handCount >= o.handMax;
  /** 本次进店的交易次数用完，只能离开 */
  const tradesLeft = o.visit.remaining > 0;

  const shelfRow = o.shelf.find((x) => x.idx === cardPick) ?? null;
  const sellCardRow = o.sell.cards.find((x) => x.slot === sellCardPick) ?? null;
  // 进店时卖完的不上架（旧存档的 options 没有 listed：照常列出）
  const itemRows = o.items.filter((x) => x.listed !== false);
  // 刚买下的这一种变灰后不再算选中
  const buyItemRow = itemRows.find((x) => x.item === itemPick && x.bought !== true) ?? null;
  const sellItemRow = o.sell.items.find((x) => x.item === sellPick) ?? null;

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
        {itemRows.map((row) => {
          const reason =
            row.bought === true
              ? text.reason('boughtThisVisit')
              : row.maxQty > 0
                ? null
                : row.pool <= 0
                  ? text.reason('poolEmpty')
                  : row.own >= 9
                    ? text.reason('itemFull')
                    : row.price > o.points
                      ? text.reason('notEnoughPoints')
                      : null;
          return (
            <ItemTile
              key={row.item}
              item={row.item}
              name={text.item(row.item)}
              description={text.itemDesc(row.item)}
              price={row.price}
              count={row.own > 0 ? row.own : null}
              disabled={row.maxQty < 1}
              reason={reason}
              selected={buyItemRow?.item === row.item}
              onClick={() => setItemPick(row.item)}
              testId={`shop-item-${row.item}`}
            />
          );
        })}
      </TileGrid>
      {buyItemRow && (
        <div className={s.between} data-testid="shop-buy-item-panel">
          <span>{text.item(buyItemRow.item)}</span>
          <Button
            variant="green"
            disabled={buyItemRow.maxQty < 1 || !tradesLeft}
            onClick={() => ctl.send({ type: 'SHOP_BUY_ITEM', item: buyItemRow.item, qty: 1 })}
            data-testid="shop-buy-item"
          >
            {t('dlg.shop.buyFor')} <Money value={buyItemRow.price} unit="points" />
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
              onClick={() => setSellPick(row.item)}
              testId={`shop-sell-item-${row.item}`}
            />
          ))}
        </TileGrid>
        {sellItemRow && (
          <div className={s.between}>
            <span>{text.item(sellItemRow.item)}</span>
            <Button
              variant="blue"
              disabled={!tradesLeft}
              onClick={() => ctl.send({ type: 'SHOP_SELL_ITEM', item: sellItemRow.item, qty: 1 })}
              data-testid="shop-sell-item"
            >
              {t('dlg.shop.sellFor')} <Money value={sellItemRow.unitValue} unit="points" />
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
