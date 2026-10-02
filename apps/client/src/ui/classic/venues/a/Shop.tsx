// SHOP 的原版场景（original-skin.md §4.2 场所屏：百货 Panel#10）：两页——卡片店（图0 底图、女巫店员图2、蓝色讲话框图15、
// CARD 货架图1）与道具店（图16 底图、店员女孩图18、粉色讲话框图34、ITEM 货架图17）；右上角翻页角（图13/14 锤子 → 道具店，
// 图29/30 CARD → 卡片店）；左下 EXIT（图35/36）与点数底板（图37）。
// 货架每行一颗热区（卡片 15 行 × 26、道具 8 行 × 48，道具行画 Panel#74 小图标，缺素材时只写字）；选中后店员在讲话框里介绍，
// 左下详情区显示卡图（Data#530–559，可选）、价格与「买下 / 卖出」钮。买 / 卖用页签切换。
// 道具按原版：货架只写名称与价格，不显示库存（@source v2.06 0x42e011..0x42e0a6 每行只画名称与 "$%d"），
// 只列进店时有库存的道具（options.items[].listed，行压紧）；一次买 1 个，买过的那一行变灰、本次进店不能再选
// （@source v2.06 0x42d869 call fcn.0042c64b 无数量参数、0x42d89c 灰色 0xa0a0a0 重画、0x42d9cf 货架行清零）；
// 卖道具也是一次 1 个（@source v2.06 0x42d4e6 push 1），可以一直卖。没有数量钮。
// 每笔交易都是非终结 intent（服务器以新 decisionId 重发 SHOP，场景保持打开）；EXIT / Esc 提交 LEAVE。
// 逻辑与程序化 ShopDialog 相同（货架、价格、能不能买全部来自 options；卖回价公式同引擎）；
// data-testid 沿用程序化对话框（shop-shelf-<idx>、shop-buy-card、shop-item-<item>、shop-buy-item、shop-sell-card-<slot>、
// shop-sell-card、shop-sell-item-<item>、shop-sell-item、shop-leave、shop-points）。
// 手机横屏：货架行太密（26 / 48 逻辑像素），另给一个原生下拉框（系统选择器）选商品；买卖钮、页签、翻页、EXIT 热区 ≥44px。
// 货架一页放不下时（卖道具：持有的道具种类可达 13 种，一页只有 8 行）货架分页：页首左侧一颗翻页钮（shop-rows-page）；
// 原生下拉框列出全部商品，选到别页的商品时货架翻到那一页。
import { ECON, itemDef } from '@rich4/shared/data';
import type { CardId, ItemId } from '@rich4/shared/engine';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type LooseT, useGameText } from '../../../components/names';
import type { DecisionProps } from '../../../decisions/types';
import { useDecision } from '../../../decisions/useDecision';
import { ensureClassicImage, useClassicAssets } from '../../assets';
import { ClassicButton } from '../../common/ClassicButton';
import { DecisionStage } from '../../common/DecisionStage';
import { type HotspotSpec, Hotspots } from '../../common/Hotspots';
import { SceneLayer } from '../../common/Stage4x3';
import { useEnsureSceneSprites } from '../../common/sceneAssets';
import { classicText, TEXT } from '../../common/textStyles';
import type { RequiredKeys } from '../../decisions/scene';
import { CARD_ART_UNDERLAY } from '../../dialogs/parts';
import { ensureClassicI18n } from '../../i18n';
import { Sprite, useSpriteFrame } from '../../Sprite';
import { SHOP, type ShopPage, shopRowRect, VENUE_KEYS } from './layout';
import { Amount, PlateButton, SceneText, useBlink, useTalk } from './parts';
import v from './venues.module.css';

export const requiredKeys: RequiredKeys<'SHOP'> = [VENUE_KEYS.shop];

type Mode = 'buy' | 'sell';

/** 卖回价 = trunc(标价 × 数量 × 0.9)，与引擎 rules/inventory.sellValue 同一公式 */
export function sellItemValue(item: ItemId, qty: number): number {
  return Math.trunc((itemDef(item).price * qty * ECON.SELL_RATE_NUM) / ECON.SELL_RATE_DEN);
}

/** 货架上的一行（四种列表统一成这个形状） */
interface Row {
  id: string;
  testId: string;
  kind: 'card' | 'item';
  card: CardId | null;
  item: ItemId | null;
  name: string;
  /** 右侧数字：价格或卖回价 */
  points: number;
  /** 卖道具：持有数（×n）；买道具页不写（原版货架行只有名称与价格） */
  note: string | null;
  /** 不能买卖的原因（null 可以） */
  reason: string | null;
  /** 本次进店已经买过的道具行：原版灰色重画、点了没反应（热区与下拉框项都禁用） */
  off: boolean;
}

/**
 * 本次进店买过的道具行：原版用灰字 0xa0a0a0、边框色 0x101010、样式 3（描边 + 粗体）重画这一行
 * （@source v2.06 0x42d893..0x42d8a3 push 0 / 3 / 0x101010 / 0xa0a0a0 / 0x14 → fcn.0044e200）
 */
const SOLD_TEXT = classicText({ size: 12, color: '#a0a0a0', outline: '#101010', bold: true });

/** 卡图（Data#530–559 = card.<k>，165×256；可选：不可用时画卡名框） */
function CardArt({ card, name, x, y }: { card: CardId; name: string; x: number; y: number }): ReactNode {
  const key = `card.${card}`;
  const img = useClassicAssets((s) => s.images[key]);
  useEffect(() => ensureClassicImage(key), [key]);
  const w = 83;
  const h = 128;
  return img ? (
    <img
      src={img.url}
      alt=""
      width={w}
      height={h}
      className={v.abs}
      style={{ left: x, top: y, imageRendering: 'auto', backgroundColor: CARD_ART_UNDERLAY }}
      data-testid="shop-card-art"
    />
  ) : (
    <span
      className={v.abs}
      style={{
        left: x,
        top: y,
        width: w,
        height: h,
        display: 'grid',
        placeItems: 'center',
        border: '2px solid #f6c64a',
        borderRadius: 6,
        background: '#6a1a1a',
        ...TEXT.title,
        fontSize: 15,
        textAlign: 'center',
      }}
      aria-hidden="true"
      data-testid="shop-card-art-fallback"
    >
      {name}
    </span>
  );
}

export default function ShopScene(props: DecisionProps<'SHOP'>): ReactNode {
  ensureClassicI18n();
  const { t } = useTranslation();
  const lt = t as unknown as LooseT;
  const { view, map, isMine, decision: d } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d.options;
  useEnsureSceneSprites([VENUE_KEYS.itemIcons]);
  const [page, setPage] = useState<ShopPage>('card');
  const [mode, setMode] = useState<Mode>('buy');
  const [pick, setPick] = useState<string | null>(null);
  const [shelfPage, setShelfPage] = useState(0);
  const handFull = o.handCount >= o.handMax;
  const tradesLeft = o.visit.remaining > 0;
  const blink = useBlink();
  const talk = useTalk(`${page}:${mode}:${pick ?? ''}`, 2);
  const iconsReady = useSpriteFrame(VENUE_KEYS.itemIcons, 0) !== null;

  // 列表
  let rows: Row[];
  if (page === 'card' && mode === 'buy') {
    rows = o.shelf.map((r) => ({
      id: `shelf-${r.idx}`,
      testId: `shop-shelf-${r.idx}`,
      kind: 'card',
      card: r.card,
      item: null,
      name: text.card(r.card),
      points: r.price,
      note: null,
      reason: r.buyable
        ? null
        : handFull
          ? text.reason('handFull')
          : r.price > o.points
            ? text.reason('notEnoughPoints')
            : text.reason('poolEmpty'),
      off: false,
    }));
  } else if (page === 'card') {
    rows = o.sell.cards.map((r) => ({
      id: `sellc-${r.slot}`,
      testId: `shop-sell-card-${r.slot}`,
      kind: 'card',
      card: r.card,
      item: null,
      name: text.card(r.card),
      points: r.value,
      note: null,
      reason: null,
      off: false,
    }));
  } else if (mode === 'buy') {
    // 进店时卖完的不上架（旧存档的 options 没有 listed：照常列出）；货架行只写名称与价格：不显示库存，也不显示持有数
    // （原版持有数只在下方自己的持有格里 '×%d'，fcn.0044681f；货架上的「×n」容易被看成「剩 n 个」。持有数在卖道具页与资产屏）
    rows = o.items
      .filter((r) => r.listed !== false)
      .map((r) => ({
        id: `item-${r.item}`,
        testId: `shop-item-${r.item}`,
        kind: 'item',
        card: null,
        item: r.item,
        name: text.item(r.item),
        points: r.price,
        note: null,
        reason:
          r.bought === true
            ? text.reason('boughtThisVisit')
            : r.maxQty > 0
              ? null
              : r.pool <= 0
                ? text.reason('poolEmpty')
                : r.own >= 9
                  ? text.reason('itemFull')
                  : r.price > o.points
                    ? text.reason('notEnoughPoints')
                    : null,
        off: r.bought === true,
      }));
  } else {
    rows = o.sell.items.map((r) => ({
      id: `selli-${r.item}`,
      testId: `shop-sell-item-${r.item}`,
      kind: 'item',
      card: null,
      item: r.item,
      name: text.item(r.item),
      points: r.unitValue,
      note: `×${r.count}`,
      reason: null,
      off: false,
    }));
  }
  const limit = page === 'card' ? SHOP.cardRows.count : SHOP.itemRows.count;
  const pages = Math.max(1, Math.ceil(rows.length / limit));
  const curPage = Math.min(shelfPage, pages - 1);
  const shown = rows.slice(curPage * limit, curPage * limit + limit);
  // 刚买下的道具行变灰（off）后不再算选中：详情区收起，和原版买后该行作废一样
  const sel = rows.find((r) => r.id === pick && !r.off) ?? null;
  const selId = sel?.id ?? null;
  const pickRow = (id: string | null): void => {
    setPick(id);
    const i = id === null ? -1 : rows.findIndex((r) => r.id === id);
    if (i >= 0) setShelfPage(Math.floor(i / limit));
  };

  // 道具：一次 1 个
  const buyRow =
    page === 'item' && mode === 'buy' && sel?.item != null ? o.items.find((r) => r.item === sel.item) : null;
  const sellRow =
    page === 'item' && mode === 'sell' && sel?.item != null ? o.sell.items.find((r) => r.item === sel.item) : null;

  const switchPage = (p: ShopPage): void => {
    setPage(p);
    setMode('buy');
    setPick(null);
    setShelfPage(0);
  };
  const switchMode = (m: Mode): void => {
    setMode(m);
    setPick(null);
    setShelfPage(0);
  };

  // 交易
  let action: { label: string; testId: string; points: number; run: () => void; disabled: boolean } | null = null;
  if (sel) {
    if (page === 'card' && mode === 'buy') {
      const idx = Number(sel.id.slice('shelf-'.length));
      action = {
        label: t('dlg.shop.buyFor'),
        testId: 'shop-buy-card',
        points: sel.points,
        disabled: sel.reason !== null || !tradesLeft,
        run: () => ctl.send({ type: 'SHOP_BUY_CARD', shelfIdx: idx }),
      };
    } else if (page === 'card') {
      const slot = Number(sel.id.slice('sellc-'.length));
      action = {
        label: t('dlg.shop.sellFor'),
        testId: 'shop-sell-card',
        points: sel.points,
        disabled: !tradesLeft,
        run: () => ctl.send({ type: 'SHOP_SELL_CARD', slot }),
      };
    } else if (mode === 'buy' && buyRow) {
      action = {
        label: t('dlg.shop.buyFor'),
        testId: 'shop-buy-item',
        points: buyRow.price,
        disabled: buyRow.maxQty < 1 || !tradesLeft,
        run: () => ctl.send({ type: 'SHOP_BUY_ITEM', item: buyRow.item, qty: 1 }),
      };
    } else if (sellRow) {
      action = {
        label: t('dlg.shop.sellFor'),
        testId: 'shop-sell-item',
        points: sellItemValue(sellRow.item, 1),
        disabled: sellRow.count < 1 || !tradesLeft,
        run: () => ctl.send({ type: 'SHOP_SELL_ITEM', item: sellRow.item, qty: 1 }),
      };
    }
  }

  // 店员说的话：选中时介绍商品；否则提示（交易次数用完 / 手牌满 / 货架空 / 电脑座位）
  const warn = !tradesLeft
    ? t('dlg.shop.tradeLimit')
    : page === 'card' && mode === 'buy' && handFull
      ? t('dlg.shop.handFull', { max: o.handMax })
      : null;
  let lines: ReactNode[];
  if (sel) {
    lines = [
      <p key="n" style={{ ...TEXT.title, fontSize: 15 }}>
        {sel.name}
      </p>,
      <p key="d">{sel.card !== null ? text.cardDesc(sel.card) : sel.item !== null ? text.itemDesc(sel.item) : ''}</p>,
    ];
    if (sel.reason)
      lines.push(
        <p key="r" style={TEXT.warn}>
          {sel.reason}
        </p>,
      );
  } else {
    lines = [
      <p key="t" style={{ ...TEXT.title, fontSize: 15 }}>
        {t('dlg.shop.title')}
      </p>,
    ];
    if (shown.length === 0)
      lines.push(
        <p key="e">
          {page === 'card'
            ? mode === 'buy'
              ? t('dlg.shop.emptyShelf')
              : t('dlg.shop.noCards')
            : mode === 'buy'
              ? t('dlg.shop.items')
              : t('dlg.shop.noItems')}
        </p>,
      );
    if (page === 'card' && mode === 'buy' && o.fullDeck) lines.push(<p key="f">{t('dlg.shop.fullDeck')}</p>);
  }
  if (page === 'card')
    lines.push(
      <p key="h" data-testid="shop-hand" data-value={o.handCount}>
        {t('dlg.shop.hand', { n: o.handCount, max: o.handMax })}
      </p>,
    );
  if (warn)
    lines.push(
      <p key="w" style={TEXT.warn} role="alert" data-testid="shop-warn">
        {warn}
      </p>,
    );

  const clerk = SHOP.clerk[page];
  const left = SHOP.clerk.at.x - clerk.ax;
  const top = SHOP.clerk.at.y - clerk.ay;
  const cross = warn !== null || sel?.reason != null;
  const balloon = SHOP.balloon[page];
  const corner = page === 'card' ? SHOP.corner.toItem : SHOP.corner.toCard;
  const shelfX = SHOP.shelf.x;
  const shelfY = SHOP.shelf.y;

  const spots: HotspotSpec[] = shown.map((r, i) => {
    const rect = shopRowRect(page, i);
    return {
      id: r.id,
      rect: { x: rect.x - shelfX, y: rect.y - shelfY, w: rect.w, h: rect.h },
      label: `${r.name} ${r.points}`,
      title: r.reason ?? undefined,
      pressed: selId === r.id,
      disabled: r.off || (r.reason !== null && mode === 'buy' && page === 'card'),
      hit: 'none',
      testId: r.testId,
      onActivate: () => pickRow(r.id),
    };
  });

  const tabLabels: Record<ShopPage, Record<Mode, string>> = {
    card: { buy: t('dlg.shop.tabBuyCard'), sell: t('dlg.shop.tabSellCard') },
    item: { buy: t('dlg.shop.tabBuyItem'), sell: t('dlg.shop.tabSellItem') },
  };

  return (
    <DecisionStage
      ctl={ctl}
      decision={d}
      view={view}
      map={map}
      isMine={isMine}
      label={t('dlg.shop.title')}
      onClose={() => ctl.send({ type: 'LEAVE' })}
      closeButton={false}
      backdrop="opaque"
      attrs={{ 'data-page': page, 'data-mode': mode }}
    >
      <Sprite sheet={VENUE_KEYS.shop} frame={SHOP.bg[page]} x={0} y={0} origin="topLeft" />
      {/* 店员与表情 */}
      <Sprite sheet={VENUE_KEYS.shop} frame={clerk.frame} x={SHOP.clerk.at.x} y={SHOP.clerk.at.y} testId="shop-clerk" />
      {cross ? (
        <Sprite
          sheet={VENUE_KEYS.shop}
          frame={clerk.cross.frame}
          x={left + clerk.cross.dx}
          y={top + clerk.cross.dy}
          origin="topLeft"
        />
      ) : (
        <>
          {blink && (
            <Sprite
              sheet={VENUE_KEYS.shop}
              frame={clerk.eyes.closed}
              x={left + clerk.eyes.dx}
              y={top + clerk.eyes.dy}
              origin="topLeft"
            />
          )}
          {talk >= 0 && (
            <Sprite
              sheet={VENUE_KEYS.shop}
              frame={clerk.mouth.talk[talk % clerk.mouth.talk.length]!}
              x={left + clerk.mouth.dx}
              y={top + clerk.mouth.dy}
              origin="topLeft"
            />
          )}
        </>
      )}

      {/* 讲话框 */}
      <SceneLayer x={balloon.x} y={balloon.y} testId="shop-balloon">
        <Sprite sheet={VENUE_KEYS.shop} frame={balloon.frame} x={0} y={0} origin="topLeft" />
        <SceneText
          rect={balloon.text}
          style={{ ...TEXT.bodyDark, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2 }}
        >
          {lines}
        </SceneText>
      </SceneLayer>

      {/* 货架 */}
      <SceneLayer x={shelfX} y={shelfY} w={SHOP.shelf.w} h={SHOP.shelf.h} testId="shop-shelf">
        <Sprite sheet={VENUE_KEYS.shop} frame={SHOP.shelf[page]} x={0} y={0} origin="topLeft" />
        {shown.map((r, i) => {
          const rect = shopRowRect(page, i);
          const x = rect.x - shelfX;
          const y = rect.y - shelfY;
          const icon = r.item !== null && iconsReady;
          return (
            <div key={r.id} className={r.reason && !r.off ? v.rowOff : undefined} data-sold={r.off || undefined}>
              {selId === r.id && (
                <span className={v.rowHi} style={{ left: x, top: y, width: rect.w, height: rect.h }} />
              )}
              {r.item !== null && (
                <Sprite
                  sheet={VENUE_KEYS.itemIcons}
                  frame={r.item - 1}
                  x={x + 8}
                  y={y + (rect.h - 20) / 2}
                  origin="topLeft"
                  className={r.off ? v.rowOff : undefined}
                />
              )}
              <span
                className={v.cellText}
                style={{
                  ...(r.off ? SOLD_TEXT : TEXT.bodyDark),
                  left: x + (page === 'card' ? 36 : icon ? 38 : 10),
                  top: y,
                  width: 110,
                  height: page === 'card' ? rect.h : 26,
                }}
              >
                {r.name}
              </span>
              {r.note && (
                <span
                  className={v.cellText}
                  style={{
                    ...(r.off ? SOLD_TEXT : TEXT.bodyDark),
                    left: x + (icon ? 38 : 10),
                    top: y + 24,
                    width: 110,
                    height: 20,
                  }}
                >
                  {r.note}
                </span>
              )}
              <span
                className={`${v.cellText} ${v.num}`}
                style={{
                  ...(r.off ? SOLD_TEXT : TEXT.bodyDark),
                  left: x + 140,
                  top: y,
                  width: rect.w - 140,
                  height: rect.h,
                }}
              >
                {r.points}
                {t('cmp.unit.points')}
              </span>
            </div>
          );
        })}
        <Hotspots
          x={0}
          y={0}
          w={SHOP.shelf.w}
          h={SHOP.shelf.h}
          spots={spots}
          disabled={!ctl.interactive}
          label={tabLabels[page][mode]}
          testId="shop-rows"
        />
        {pages > 1 && (
          <PlateButton
            x={SHOP.pager.x}
            y={SHOP.pager.y}
            w={SHOP.pager.w}
            h={SHOP.pager.h}
            label={lt('classic:shelf.page', { page: curPage + 1, pages })}
            disabled={!ctl.interactive}
            onClick={() => setShelfPage((curPage + 1) % pages)}
            testId="shop-rows-page"
            textStyle={{ fontSize: 15, lineHeight: '18px', fontWeight: 700 }}
          >
            {curPage + 1}/{pages} ▼
          </PlateButton>
        )}
      </SceneLayer>
      {/* 手机与读屏：原生下拉框选商品 */}
      <select
        className={v.picker}
        style={{ left: SHOP.picker.x, top: SHOP.picker.y, width: SHOP.picker.w }}
        aria-label={tabLabels[page][mode]}
        value={selId ?? ''}
        disabled={!ctl.interactive}
        onChange={(e) => pickRow(e.currentTarget.value || null)}
        data-testid="shop-picker"
      >
        <option value="">—</option>
        {rows.map((r) => (
          <option key={r.id} value={r.id} disabled={r.off || (r.reason !== null && mode === 'buy' && page === 'card')}>
            {r.name} {r.points}
            {t('cmp.unit.points')}
          </option>
        ))}
      </select>

      {/* 详情与交易 */}
      {sel && (
        <SceneLayer x={SHOP.detail.x} y={SHOP.detail.y} w={SHOP.detail.w} h={SHOP.detail.h} testId="shop-detail">
          {sel.card !== null ? (
            <CardArt card={sel.card} name={sel.name} x={0} y={4} />
          ) : sel.item !== null ? (
            <Sprite sheet={VENUE_KEYS.itemIcons} frame={sel.item - 1} x={30} y={40} origin="topLeft" />
          ) : null}
          <SceneText rect={{ x: 92, y: 4, w: 170, h: 40 }}>
            <p style={{ ...TEXT.title, fontSize: 15 }}>{sel.name}</p>
            <p>
              {mode === 'buy' ? t('dlg.shop.buyFor') : t('dlg.shop.sellValue')}{' '}
              <Amount value={sel.points} unit={t('cmp.unit.points')} testId="shop-price" />
            </p>
          </SceneText>
          {action && (
            <PlateButton
              x={92}
              y={104}
              w={170}
              h={44}
              label={`${action.label} ${action.points}`}
              disabled={action.disabled}
              onClick={action.run}
              testId={action.testId}
              textStyle={{ fontSize: 15, lineHeight: '18px', fontWeight: 700 }}
            >
              {action.label} <Amount value={action.points} unit={t('cmp.unit.points')} />
            </PlateButton>
          )}
        </SceneLayer>
      )}

      {/* 买 / 卖页签 */}
      <div role="tablist" aria-label={t('dlg.shop.title')} className={v.abs} style={{ left: 0, top: 0 }}>
        {(['buy', 'sell'] as const).map((m, i) => (
          <PlateButton
            key={m}
            x={SHOP.tabs.xs[i]!}
            y={SHOP.tabs.y}
            w={SHOP.tabs.w}
            h={SHOP.tabs.h}
            label={tabLabels[page][m]}
            tab={{ selected: mode === m }}
            onClick={() => switchMode(m)}
            testId={`shop-tab-${m}`}
          />
        ))}
      </div>

      {/* 翻页角、EXIT、点数 */}
      <ClassicButton
        sheet={VENUE_KEYS.shop}
        frames={{ normal: corner[0]!, hover: corner[1]! }}
        x={SHOP.corner.x}
        y={SHOP.corner.y}
        w={SHOP.corner.w}
        h={SHOP.corner.h}
        label={page === 'card' ? t('dlg.shop.tabBuyItem') : t('dlg.shop.tabBuyCard')}
        onClick={() => switchPage(page === 'card' ? 'item' : 'card')}
        testId={page === 'card' ? 'shop-page-item' : 'shop-page-card'}
      />
      <ClassicButton
        sheet={VENUE_KEYS.shop}
        frames={{ normal: SHOP.exit.normal, hover: SHOP.exit.hover }}
        x={SHOP.exit.x}
        y={SHOP.exit.y}
        w={80}
        h={40}
        label={t('dlg.shop.leave')}
        onClick={() => ctl.send({ type: 'LEAVE' })}
        testId="shop-leave"
      />
      <SceneLayer x={SHOP.points.x} y={SHOP.points.y} w={90} h={40}>
        <Sprite sheet={VENUE_KEYS.shop} frame={SHOP.points.frame} x={0} y={0} origin="topLeft" />
        <SceneText
          rect={SHOP.points.text}
          style={{ ...TEXT.number, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 4 }}
        >
          <span title={t('dlg.common.points')}>
            <Amount value={o.points} testId="shop-points" />
          </span>
        </SceneText>
      </SceneLayer>
    </DecisionStage>
  );
}
