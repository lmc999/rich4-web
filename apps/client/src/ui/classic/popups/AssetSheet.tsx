// 原版资产表（original-skin.md §4.2 通用：资产表 Panel#9；工具列「查询」打开）：三页 640×480——
// 页 0 总表：左上本人头像与切换玩家的箭头、头像框里是附身的神明小像（图13–24）与剩余天数，中间与右侧各 4 行数值
//   （现金、存款、贷款、点券 / 土地、房屋、股票市值、总资产），下方道具 5×3（Panel#74 小图标 + 持有数）与卡片 5×3（卡名；
//   私密手牌只显示张数）；
// 页 1 地产表（名称、种类、等级、地价、标记，翻页箭头）；页 2 持股表（股票、持股、市值）。
// 左侧三颗蓝钮切页（Panel#9 图12），右上 EXIT（图5/6）关闭，Esc 同样关闭。数值全部由 view 与地图算出（profileStats、
// PropertyListPanel、StockPanel 的纯函数），与资料栏四页一致。data-testid：classic-assets、assets-page-N、assets-exit、
// assets-prev / assets-next、assets-<栏位>[data-value]、assets-item-N、assets-card-N、assets-estate-<地块>、assets-stock-N。
import type { MapIndex } from '@rich4/shared/data';
import type { CardId, ItemId, SeatIndex } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { type ReactNode, useState } from 'react';
import { useTx } from '../../../i18n/tx';
import { formatMoney } from '../../../presentation/names';
import { formatCents } from '../../components/format';
import { useGameText } from '../../components/names';
import { filterRows, propertyRows } from '../../panels/PropertyListPanel';
import { holdingValue, viewStockRows } from '../../panels/StockPanel';
import { ClassicButton } from '../common/ClassicButton';
import { Stage4x3 } from '../common/Stage4x3';
import { classicText, TEXT } from '../common/textStyles';
import { profileNumbers } from '../profileStats';
import { Sprite, spriteStyle, useSpriteFrame } from '../Sprite';
import { ASSETS, ASSETS_SHEET, FACE_SHEET, godFrame } from './layout';
import pp from './popups.module.css';

export const ITEM_ICONS_SHEET = 'ui.itemIcons';
/** 资产表依赖的素材 */
export const ASSETS_KEYS = [ASSETS_SHEET, FACE_SHEET, ITEM_ICONS_SHEET] as const;

export interface AssetSheetProps {
  view: GameView;
  map: MapIndex | null;
  /** 先显示谁 */
  seat: SeatIndex;
  onClose: () => void;
}

function Field({
  x,
  y,
  w,
  h,
  label,
  value,
  testId,
  raw,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  value: string;
  testId: string;
  raw: number | string;
}): ReactNode {
  return (
    <span
      className={pp.cell}
      style={{ ...TEXT.body, left: x, top: y, width: w, height: h, justifyContent: 'space-between', padding: '0 6px' }}
      data-testid={testId}
      data-value={raw}
    >
      <span>{label}</span>
      <span style={TEXT.number}>{value}</span>
    </span>
  );
}

/** 蓝钮（Panel#9 图12）+ 文字 */
function BlueButton({
  x,
  y,
  label,
  pressed,
  onClick,
  testId,
}: {
  x: number;
  y: number;
  label: string;
  pressed: boolean;
  onClick: () => void;
  testId: string;
}): ReactNode {
  const f = useSpriteFrame(ASSETS_SHEET, ASSETS.blueButton);
  return (
    <button
      type="button"
      className={pp.btn}
      style={{ ...classicText({ size: 15, bold: true }), left: x, top: y, width: 97, height: 40 }}
      aria-pressed={pressed}
      onClick={onClick}
      data-testid={testId}
    >
      {f && <span className={pp.btnArt} style={spriteStyle(f, 0, 0, 1, 'topLeft')} aria-hidden="true" />}
      <span className={pp.btnLabel} style={pressed ? { color: '#ffe060' } : undefined}>
        {label}
      </span>
    </button>
  );
}

export function AssetSheet({ view, map, seat: initial, onClose }: AssetSheetProps): ReactNode {
  const t = useTx();
  const text = useGameText(view, map);
  const seats = view.players.map((p) => p.seat);
  const [seat, setSeat] = useState<SeatIndex>(seats.includes(initial) ? initial : (seats[0] ?? 0));
  const [page, setPage] = useState(0);
  const [offset, setOffset] = useState(0);
  const p = view.players.find((x) => x.seat === seat) ?? null;
  const nums = profileNumbers(view, map, seat);
  const cycle = (d: number): void => {
    const i = seats.indexOf(seat);
    const next = seats[(i + d + seats.length) % seats.length];
    if (next !== undefined) {
      setSeat(next);
      setOffset(0);
    }
  };
  const god = p?.god ?? null;
  const gf = god ? godFrame(god.kind) : null;

  const pageLabels = [
    t('classic:profile.tabs.funds'),
    t('classic:profile.tabs.estate'),
    t('classic:profile.tabs.stocks'),
  ];
  const L = ASSETS.fieldsL;
  const R = ASSETS.fieldsR;
  const leftFields: [string, string, number, string][] = nums
    ? [
        ['cash', t('classic:profile.funds.cash'), nums.cash, formatMoney(nums.cash)],
        ['deposit', t('classic:profile.funds.deposit'), nums.deposit, formatMoney(nums.deposit)],
        ['loan', t('classic:profile.other.loan'), nums.loan, formatMoney(nums.loan)],
        ['points', t('classic:profile.other.points'), nums.points, formatMoney(nums.points)],
      ]
    : [];
  const rightFields: [string, string, number, string][] = nums
    ? [
        ['lots', t('classic:profile.estate.lots'), nums.lots, t('classic:profile.unitLots', { n: nums.lots })],
        [
          'houses',
          t('classic:profile.estate.houses'),
          nums.houses,
          t('classic:profile.unitHouses', { n: nums.houses }),
        ],
        ['stockValue', t('classic:profile.stocks.value'), nums.stockValue, formatMoney(nums.stockValue)],
        ['netWorth', t('classic:profile.funds.netWorth'), nums.netWorth, formatMoney(nums.netWorth)],
      ]
    : [];

  const items: { item: ItemId; count: number }[] = [];
  if (p) {
    for (let item = 1; item < p.items.length; item++) {
      const n = p.items[item] ?? 0;
      if (n > 0) items.push({ item: item as ItemId, count: n });
    }
  }
  const cards: CardId[] | null = p?.cards ?? null;

  const estate = filterRows(propertyRows(view), seat);
  const stocks = viewStockRows(view, seat).filter((r) => r.shares > 0);
  const perPage = page === 1 ? ASSETS.estate.rows - 1 : ASSETS.stocks.rows - 1;
  const total = page === 1 ? estate.length : stocks.length;
  const canUp = offset > 0;
  const canDown = offset + perPage < total;

  const table = (cols: readonly number[], y0: number, dy: number, h: number, rows: ReactNode[][], testIds: string[]) =>
    rows.map((cells, r) => (
      <div key={testIds[r] ?? r} data-testid={testIds[r]}>
        {cells.map((c, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: 栏位固定
            key={i}
            className={pp.cell}
            data-align={i === 0 ? 'left' : 'right'}
            style={{
              ...(r === 0 ? classicText({ size: 12, color: '#ffe060' }) : TEXT.body),
              left: cols[i],
              top: y0 + r * dy,
              width: (cols[i + 1] ?? cols[i]! + 90) - cols[i]! - 2,
              height: h,
            }}
          >
            {c}
          </span>
        ))}
      </div>
    ));

  let body: ReactNode = null;
  if (page === 0) {
    body = (
      <>
        {leftFields.map(([k, label, raw, v], i) => (
          <Field
            key={k}
            x={L.x}
            y={L.y0 + i * L.dy}
            w={L.w}
            h={L.h}
            label={label}
            value={v}
            raw={raw}
            testId={`assets-${k}`}
          />
        ))}
        {rightFields.map(([k, label, raw, v], i) => (
          <Field
            key={k}
            x={R.x}
            y={R.y0 + i * R.dy}
            w={R.w}
            h={R.h}
            label={label}
            value={v}
            raw={raw}
            testId={`assets-${k}`}
          />
        ))}
        <Field
          x={ASSETS.labels.x}
          y={ASSETS.labels.y0}
          w={ASSETS.labels.w}
          h={ASSETS.labels.h}
          label={t('dlg.turn.items')}
          value={String(nums?.items ?? 0)}
          raw={nums?.items ?? 0}
          testId="assets-items"
        />
        <Field
          x={ASSETS.labels.x}
          y={ASSETS.labels.y0 + 2 * ASSETS.labels.dy}
          w={ASSETS.labels.w}
          h={ASSETS.labels.h}
          label={t('dlg.turn.cards')}
          value={String(p?.cardCount ?? 0)}
          raw={p?.cardCount ?? 0}
          testId="assets-cards"
        />
        {items.slice(0, 15).map((x, i) => {
          const g = ASSETS.itemGrid;
          const cx = g.x + (i % g.cols) * g.dx;
          const cy = g.y + Math.floor(i / g.cols) * g.dy;
          return (
            <span
              key={x.item}
              className={pp.cell}
              style={{ ...TEXT.small, left: cx, top: cy, width: g.w, height: g.h }}
              title={text.item(x.item)}
              data-testid={`assets-item-${x.item}`}
              data-count={x.count}
            >
              <span style={{ position: 'relative', width: 26, height: 22 }}>
                <Sprite sheet={ITEM_ICONS_SHEET} frame={x.item - 1} x={13} y={11} />
              </span>
              ×{x.count}
            </span>
          );
        })}
        {(cards ?? []).slice(0, 15).map((card, i) => {
          const g = ASSETS.cardGrid;
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: 卡槽顺序
              key={i}
              className={pp.cell}
              style={{
                ...TEXT.small,
                left: g.x + (i % g.cols) * g.dx,
                top: g.y + Math.floor(i / g.cols) * g.dy,
                width: g.w,
                height: g.h,
              }}
              data-testid={`assets-card-${i}`}
              data-card={card}
            >
              {text.card(card)}
            </span>
          );
        })}
      </>
    );
  } else if (page === 1) {
    const E = ASSETS.estate;
    const head = [
      t('pnl.property.name'),
      t('pnl.property.kind'),
      t('pnl.property.level'),
      t('pnl.property.landPrice'),
      t('pnl.property.mark'),
    ];
    const rows = estate
      .slice(offset, offset + perPage)
      .map((r) => [
        text.lot(r.id),
        r.kind === 'land'
          ? t('tiles:lot.land')
          : r.kind === 'company'
            ? t('tiles:lot.company')
            : r.facility
              ? text.facility(r.facility)
              : t('tiles:lot.facility'),
        String(r.level),
        r.landPrice === null ? '—' : formatMoney(r.landPrice),
        r.mark === 'raise' ? t('pnl.property.markRaise') : r.mark === 'seal' ? t('pnl.property.markSeal') : '',
      ]);
    body = table(
      E.cols,
      E.y0,
      E.dy,
      E.h,
      [head, ...rows],
      ['assets-estate-head', ...estate.slice(offset, offset + perPage).map((r) => `assets-estate-${r.id}`)],
    );
  } else {
    const S = ASSETS.stocks;
    const head = [t('pnl.stock.name'), t('pnl.stock.shares'), t('pnl.stock.totalValue')];
    const rows = stocks
      .slice(offset, offset + perPage)
      .map((r) => [
        `${text.stock(r.idx)} ${formatCents(r.priceCents)}`,
        t('classic:profile.unitShares', { n: formatMoney(r.shares) }),
        formatMoney(holdingValue(r).value),
      ]);
    body = table(
      S.cols,
      S.y0,
      S.dy,
      S.h,
      [head, ...rows],
      ['assets-stock-head', ...stocks.slice(offset, offset + perPage).map((r) => `assets-stock-${r.idx}`)],
    );
  }

  return (
    <Stage4x3
      testId="classic-assets"
      label={`${t('classic:tool.info')} ${text.player(seat)}`}
      backdrop="opaque"
      onClose={onClose}
      closeButton={false}
      attrs={{ 'data-seat': String(seat), 'data-page': String(page) }}
    >
      <Sprite sheet={ASSETS_SHEET} frame={page} x={0} y={0} origin="topLeft" />
      <p
        className={pp.text}
        style={{ ...classicText({ size: 16, color: '#ffe060', bold: true }), left: 18, top: 12, width: 420 }}
        data-testid="assets-title"
      >
        {t('classic:tool.info')} · {text.player(seat)}
      </p>
      <ClassicButton
        sheet={ASSETS_SHEET}
        frames={{ normal: ASSETS.exit.normal, hover: ASSETS.exit.hover }}
        x={ASSETS.exitAt.x}
        y={ASSETS.exitAt.y}
        origin="anchor"
        label={t('cmp.close')}
        onClick={onClose}
        testId="assets-exit"
      />
      {p && (
        <>
          <Sprite sheet={FACE_SHEET} frame={p.character} x={ASSETS.faceAt.x} y={ASSETS.faceAt.y} origin="topLeft" />
          <ClassicButton
            sheet={ASSETS_SHEET}
            frames={{ normal: ASSETS.arrows.up }}
            x={ASSETS.switchAt.x}
            y={ASSETS.switchAt.up}
            label={t('dlg.common.back')}
            onClick={() => cycle(-1)}
            disabled={seats.length < 2}
            testId="assets-prev"
          />
          <ClassicButton
            sheet={ASSETS_SHEET}
            frames={{ normal: ASSETS.arrows.down }}
            x={ASSETS.switchAt.x}
            y={ASSETS.switchAt.down}
            label={text.player(seats[(seats.indexOf(seat) + 1) % seats.length] ?? seat)}
            onClick={() => cycle(1)}
            disabled={seats.length < 2}
            testId="assets-next"
          />
        </>
      )}
      {gf !== null && god && (
        <>
          <Sprite
            sheet={ASSETS_SHEET}
            frame={gf}
            x={ASSETS.portrait.x + ASSETS.portrait.w / 2}
            y={ASSETS.portrait.y + ASSETS.portrait.h / 2 - 8}
          />
          <span
            className={pp.cell}
            style={{
              ...TEXT.small,
              left: ASSETS.portrait.x,
              top: ASSETS.portrait.y + ASSETS.portrait.h - 16,
              width: ASSETS.portrait.w,
              height: 16,
            }}
            data-testid="assets-god"
            data-god={god.kind}
          >
            {t('pnl.player.days', { n: god.days })}
          </span>
        </>
      )}
      {ASSETS.buttons.map((b, i) => (
        <BlueButton
          key={pageLabels[i]}
          x={b.x}
          y={b.y}
          label={pageLabels[i]!}
          pressed={page === i}
          onClick={() => {
            setPage(i);
            setOffset(0);
          }}
          testId={`assets-page-${i}`}
        />
      ))}
      {body}
      {page > 0 &&
        (['up', 'down'] as const).map((dir) => {
          const y = dir === 'up' ? ASSETS.pager.up : ASSETS.pager.down;
          const enabled = dir === 'up' ? canUp : canDown;
          const onClick = (): void => setOffset((o) => (dir === 'up' ? Math.max(0, o - perPage) : o + perPage));
          const testId = dir === 'up' ? 'assets-page-up' : 'assets-page-down';
          // 页 1 的箭头画在底图里：只放透明钮；页 2 没有，叠上箭头图
          return page === 1 ? (
            <button
              key={dir}
              type="button"
              className={pp.btn}
              style={{ left: ASSETS.pager.x, top: y, width: ASSETS.pager.size, height: ASSETS.pager.size }}
              aria-label={dir === 'up' ? '▲' : '▼'}
              disabled={!enabled}
              onClick={onClick}
              data-testid={testId}
            />
          ) : (
            <ClassicButton
              key={dir}
              sheet={ASSETS_SHEET}
              frames={{ normal: dir === 'up' ? ASSETS.arrows.up : ASSETS.arrows.down }}
              x={ASSETS.pager.x}
              y={y}
              label={dir === 'up' ? '▲' : '▼'}
              disabled={!enabled}
              onClick={onClick}
              testId={testId}
            />
          );
        })}
    </Stage4x3>
  );
}
