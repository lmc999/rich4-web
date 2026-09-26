// InventoryPanel（design/client.md §5.4）：卡片 / 道具两个 Tab，CardTile 按类别配色。
// 本人回合传入 TURN_MENU 的 options：不可用的卡与道具置灰并显示原因（reason 来自引擎）；
// 不传 menu 时是查看模式（看自己或对手的背包；私密手牌模式下对手只显示张数）。
import type { MapIndex } from '@rich4/shared/data';
import {
  cardDef,
  ITEM_IDS,
  itemDef,
  type SeatIndex,
  type TurnMenuCardRow,
  type TurnMenuItemRow,
  type TurnMenuOptions,
} from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CardTile, ItemTile, TileGrid } from '../components/CardTile';
import { Money } from '../components/Money';
import { useGameText } from '../components/names';
import { Badge } from '../components/Panel';
import { Tabs } from '../components/Tabs';
import s from './panels.module.css';

export type InventoryTab = 'cards' | 'items';

export interface InventoryPanelProps {
  view: GameView;
  map: MapIndex;
  seat: SeatIndex;
  /** TURN_MENU options（本人回合）；null / 缺省为查看模式 */
  menu?: Pick<TurnMenuOptions, 'cards' | 'items' | 'timeMachine'> | null;
  onUseCard?(row: TurnMenuCardRow): void;
  onUseItem?(row: TurnMenuItemRow): void;
  /** 整体禁用（决策已提交或超时） */
  disabled?: boolean;
  tab?: InventoryTab;
  onTabChange?(tab: InventoryTab): void;
}

export function InventoryPanel({
  view,
  map,
  seat,
  menu = null,
  onUseCard,
  onUseItem,
  disabled = false,
  tab,
  onTabChange,
}: InventoryPanelProps): ReactNode {
  const { t } = useTranslation();
  const text = useGameText(view, map);
  const p = view.players.find((x) => x.seat === seat);
  if (!p) return null;

  let cards: ReactNode;
  if (menu) {
    cards =
      menu.cards.length === 0 ? (
        <p className={s.muted}>{t('pnl.inventory.noCards')}</p>
      ) : (
        <TileGrid label={t('pnl.inventory.cards')}>
          {menu.cards.map((row) => {
            const off = disabled || !row.usable;
            return (
              <CardTile
                key={row.slot}
                card={row.card}
                name={text.card(row.card)}
                description={text.cardDesc(row.card)}
                price={cardDef(row.card).price}
                disabled={off}
                reason={row.usable ? null : text.reason(row.reason ?? 'noTarget')}
                onClick={onUseCard ? () => onUseCard(row) : undefined}
                testId={`inv-card-${row.slot}`}
              />
            );
          })}
        </TileGrid>
      );
  } else if (p.cards === null) {
    cards = <p className={s.muted}>{t('pnl.inventory.hidden', { n: p.cardCount })}</p>;
  } else if (p.cards.length === 0) {
    cards = <p className={s.muted}>{t('pnl.inventory.noCards')}</p>;
  } else {
    cards = (
      <TileGrid label={t('pnl.inventory.cards')}>
        {p.cards.map((card, slot) => (
          <CardTile
            // biome-ignore lint/suspicious/noArrayIndexKey: 卡槽下标即身份
            key={slot}
            card={card}
            name={text.card(card)}
            description={text.cardDesc(card)}
            price={cardDef(card).price}
            testId={`inv-card-${slot}`}
          />
        ))}
      </TileGrid>
    );
  }

  const itemRows: { item: TurnMenuItemRow['item']; count: number; row: TurnMenuItemRow | null }[] = menu
    ? menu.items.map((row) => ({ item: row.item, count: row.count, row }))
    : ITEM_IDS.filter((id) => (p.items[id] ?? 0) > 0).map((id) => ({ item: id, count: p.items[id] ?? 0, row: null }));

  const items = (
    <div className={s.panel}>
      {p.vehicle !== 'walk' && (
        <p className={s.muted} data-testid="inv-vehicle">
          {t('pnl.inventory.vehicle', { name: text.vehicle(p.vehicle) })}
        </p>
      )}
      {itemRows.length === 0 ? (
        <p className={s.muted}>{t('pnl.inventory.noItems')}</p>
      ) : (
        <TileGrid label={t('pnl.inventory.items')}>
          {itemRows.map(({ item, count, row }) => {
            const off = row ? disabled || !row.usable : false;
            const caption =
              item === 10 && menu?.timeMachine.anchorTurn !== null && menu?.timeMachine.anchorTurn !== undefined ? (
                <small className={s.muted}>{t('pnl.inventory.anchor', { n: menu.timeMachine.anchorTurn })}</small>
              ) : undefined;
            return (
              <ItemTile
                key={item}
                item={item}
                name={text.item(item)}
                description={text.itemDesc(item)}
                price={itemDef(item).price}
                count={count}
                disabled={off}
                reason={row && !row.usable ? text.reason(row.reason ?? 'noTarget') : null}
                caption={caption}
                onClick={row && onUseItem ? () => onUseItem(row) : undefined}
                testId={`inv-item-${item}`}
              />
            );
          })}
        </TileGrid>
      )}
    </div>
  );

  const usableCards = menu ? menu.cards.filter((c) => c.usable).length : null;
  const usableItems = menu ? menu.items.filter((c) => c.usable).length : null;

  return (
    <section className={s.panel} aria-label={t('pnl.inventory.title')} data-testid="inventory-panel">
      <div className={s.badges}>
        <Badge>
          {t('pnl.inventory.points')} <Money value={p.points} unit="points" />
        </Badge>
        <Badge>{t('pnl.inventory.cardCount', { n: p.cardCount })}</Badge>
      </div>
      <Tabs<InventoryTab>
        label={t('pnl.inventory.title')}
        value={tab}
        defaultValue="cards"
        onValueChange={onTabChange}
        tabs={[
          {
            value: 'cards',
            label:
              usableCards === null
                ? t('pnl.inventory.cards')
                : t('pnl.inventory.cardsUsable', { n: usableCards, total: menu?.cards.length ?? 0 }),
            content: cards,
          },
          {
            value: 'items',
            label:
              usableItems === null
                ? t('pnl.inventory.items')
                : t('pnl.inventory.itemsUsable', { n: usableItems, total: menu?.items.length ?? 0 }),
            content: items,
          },
        ]}
      />
    </section>
  );
}
