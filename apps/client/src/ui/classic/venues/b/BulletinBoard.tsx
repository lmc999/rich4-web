// 公佈欄的原版场景（Panel#73）：TURN_MENU 的「公佈欄」子页在原版皮肤下打开它（回合菜单的原版场景在收到子页请求 board 时，
// 以同一套 DecisionProps 渲染本组件，并把关闭子页的回调传进来；见 venues/b/index.ts 的说明）。
// - 软木板上钉着挂牌（5×3 一页；别人的蓝底、自己的粉底，下方写价格）；点一张弹出明细卡：别人的「买下」（现金不足禁用）、
//   自己的「撤下」，另一颗「取消」；
// - 板上画好的 SALE 钮：类别选择（股票 / 道具 / 地产 / 卡片）→ 表格里选要卖的东西 → 明细卡 + 计算器输入数量与价格 → 挂牌；
//   地产价格不超过 lotCaps；不能挂牌（canList=false）或本回合操作次数用完时 SALE 与买卖都禁用；
// - 板上画好的 EXIT 钮与 Esc：关闭子页；
// - 买卖、撤下、挂牌都是非终结操作：服务器处理后以新 decisionId 重发 TURN_MENU，本场景回到板面、数据随 options 刷新；
// - data-testid 沿用程序化公布栏（board-panel、listing-<id>、listing-buy-<id>、listing-delist-<id>、board-list），
//   另有 board-sell、board-exit、board-kind-<类别>、board-pick-<类别>-<键>、board-calc-*（计算器）等。
import {
  CARD_IDS,
  type CardId,
  ITEM_IDS,
  type ItemId,
  type ListingAsset,
  type ListingView,
  type LotId,
  type SeatIndex,
} from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMoney } from '../../../../presentation/names';
import { type GameText, useGameText } from '../../../components/names';
import { lotStatus } from '../../../decisions/helpers';
import type { DecisionProps } from '../../../decisions/types';
import { type DecisionController, useDecision } from '../../../decisions/useDecision';
import { useClassicBox } from '../../ClassicStage';
import { Calculator } from '../../common/Calculator';
import s from '../../common/common.module.css';
import { DecisionStage } from '../../common/DecisionStage';
import { coarsePointer, wantsWideHit } from '../../common/stage';
import { classicText, TEXT } from '../../common/textStyles';
import { Sprite } from '../../Sprite';
import {
  BOARD_AT,
  BULLETIN_FRAME,
  BULLETIN_REQUIRED_KEYS,
  BULLETIN_SHEET,
  CALC_AT,
  DETAIL,
  DETAIL_AT,
  detailFrame,
  EXIT_BTN,
  FIELD_BTNS,
  itemsPerPage,
  KIND_ORDER,
  kindCell,
  kindsLayout,
  type ListKind,
  listingIconFrame,
  PAGE_BTNS,
  PRICE_MAX,
  pageCount,
  SALE_BTN,
  TABLE,
  TILE,
  TILES_PER_PAGE,
  tableRow,
  tileAt,
} from './bulletinLayout';
import { TextButton } from './shared';
import v from './venues.module.css';

export { BULLETIN_REQUIRED_KEYS };

export interface BulletinBoardProps extends DecisionProps<'TURN_MENU'> {
  /** 关闭公佈欄（回到回合菜单或收起回合菜单） */
  onClose: () => void;
  /** 父场景的决策控制器（共用提交锁与倒计时）；缺省自己建一个 */
  ctl?: DecisionController;
}

type Step = 'board' | 'detail' | 'kind' | 'asset' | 'form';

/** 选中要卖的东西 */
type Draft =
  | { t: 'lot'; lot: LotId; cap: number }
  | { t: 'stock'; stock: number; held: number }
  | { t: 'card'; card: CardId }
  | { t: 'item'; item: ItemId; held: number };

export function assetName(text: GameText, a: ListingAsset): string {
  switch (a.t) {
    case 'lot':
      return text.lot(a.lot);
    case 'stock':
      return text.stock(a.stock);
    case 'card':
      return text.card(a.card);
    case 'item':
      return text.item(a.item);
  }
}

interface SellRow {
  key: string;
  cells: string[];
  draft: Draft;
}

/** 能卖的东西（按类别）：地产按 lotCaps，股票 / 卡片 / 道具按本人持有 */
export function sellRows(
  kind: ListKind,
  view: GameView,
  seat: SeatIndex,
  lotCaps: readonly { lot: LotId; cap: number }[],
  text: GameText,
  levelLabel: (n: number) => string,
): SellRow[] {
  const p = view.players.find((x) => x.seat === seat);
  if (!p) return [];
  switch (kind) {
    case 'lot':
      return lotCaps.map((c) => ({
        key: c.lot,
        cells: [text.lot(c.lot), levelLabel(lotStatus(view, c.lot)?.level ?? 0), formatMoney(c.cap)],
        draft: { t: 'lot', lot: c.lot, cap: c.cap },
      }));
    case 'stock':
      return view.stocks.flatMap((st, i) => {
        const held = p.holdings[i]?.shares ?? 0;
        if (held <= 0) return [];
        return [
          {
            key: String(st.idx),
            cells: [text.stock(st.idx), formatMoney(held), (st.priceCents / 100).toFixed(2)],
            draft: { t: 'stock', stock: st.idx, held } as Draft,
          },
        ];
      });
    case 'card': {
      const cards = p.cards ?? [];
      return CARD_IDS.filter((c) => cards.includes(c)).map((c) => ({
        key: String(c),
        cells: [text.card(c), `× ${cards.filter((x) => x === c).length}`, ''],
        draft: { t: 'card', card: c } as Draft,
      }));
    }
    case 'item': {
      const items = p.items ?? [];
      return ITEM_IDS.filter((i) => (items[i] ?? 0) > 0).map((i) => ({
        key: String(i),
        cells: [text.item(i), `× ${items[i] ?? 0}`, ''],
        draft: { t: 'item', item: i, held: items[i] ?? 0 } as Draft,
      }));
    }
  }
}

/** 草稿 → 挂牌的资产 */
export function draftAsset(d: Draft, qty: number): ListingAsset {
  switch (d.t) {
    case 'lot':
      return { t: 'lot', lot: d.lot };
    case 'stock':
      return { t: 'stock', stock: d.stock, shares: Math.max(1, Math.min(d.held, Math.trunc(qty))) };
    case 'card':
      return { t: 'card', card: d.card };
    case 'item':
      return { t: 'item', item: d.item, qty: Math.max(1, Math.min(d.held, Math.trunc(qty))) };
  }
}

function priceMax(d: Draft): number {
  return d.t === 'lot' ? d.cap : PRICE_MAX;
}

/** 场景内是否按手机的大热区排版（经典舞台缩小或粗指针） */
function useWide(): boolean {
  const box = useClassicBox();
  return wantsWideHit(box?.scale ?? 1, coarsePointer());
}

export function BulletinBoardScene(props: BulletinBoardProps): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine, decision: d, onClose } = props;
  const own = useDecision(props);
  const ctl = props.ctl ?? own;
  const text = useGameText(view, map);
  const o = d.options;
  const board = o.board;
  const menuFull = o.menuActions.used >= o.menuActions.limit;
  const can = ctl.interactive && !menuFull;
  const wide = useWide();
  const rowsPerItem = wide ? 2 : 1;

  const [step, setStep] = useState<Step>('board');
  const [page, setPage] = useState(0);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [kind, setKind] = useState<ListKind>('lot');
  const [tablePage, setTablePage] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState(1000);
  const [field, setField] = useState<'qty' | 'price'>('price');

  // 新的 TURN_MENU（买卖 / 挂牌 / 撤下之后重发）：回到板面
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只随决策变化
  useEffect(() => {
    setStep('board');
    setDetailId(null);
    setDraft(null);
  }, [d.decisionId]);

  const listings = board.listings;
  const pages = pageCount(listings.length, TILES_PER_PAGE);
  const pageNow = Math.min(page, pages - 1);
  const shown = listings.slice(pageNow * TILES_PER_PAGE, (pageNow + 1) * TILES_PER_PAGE);
  const detail = detailId === null ? null : (listings.find((l) => l.id === detailId) ?? null);
  const levelLabel = (n: number): string => t('dlg.common.levelN', { n });
  const rowsOf = (k: ListKind): SellRow[] => sellRows(k, view, d.seat, board.lotCaps, text, levelLabel);

  const close = (): void => {
    if (step === 'board') onClose();
    else if (step === 'asset') setStep('kind');
    else if (step === 'form') setStep('asset');
    else setStep('board');
  };

  const act = (intent: Parameters<DecisionController['send']>[0]): void => {
    if (ctl.send(intent)) {
      setStep('board');
      setDetailId(null);
    }
  };

  const openForm = (dr: Draft): void => {
    setDraft(dr);
    setQty(dr.t === 'stock' ? dr.held : 1);
    setPrice(Math.max(1, Math.min(priceMax(dr), 1000)));
    setField(dr.t === 'stock' || dr.t === 'item' ? 'qty' : 'price');
    setStep('form');
  };

  const valid = draft !== null && price >= 1 && price <= priceMax(draft);
  const doList = (p = price): void => {
    if (!draft || !can) return;
    if (p < 1 || p > priceMax(draft)) return;
    act({ type: 'BOARD_LIST', asset: draftAsset(draft, qty), price: p });
  };

  const light = classicText({ size: 12, lineHeight: 14 });
  const dark = classicText({ size: 12, color: '#10281a', outline: null, lineHeight: 24 });

  // ───── 明细卡（浏览挂牌 / 挂牌表单共用的外框） ─────
  const card = (
    k: ListKind,
    at: { x: number; y: number },
    name: string,
    rows: { label: string; value: ReactNode; testId?: string; active?: boolean }[],
    left: { label: string; onClick: () => void; disabled: boolean; testId: string },
    right: { label: string; onClick: () => void; testId: string },
    testId: string,
  ): ReactNode => {
    const f = detailFrame(k);
    const L = DETAIL.left(f.h);
    const R = DETAIL.right(f.h);
    return (
      <div data-testid={testId} data-kind={k}>
        <div className={v.deco}>
          <Sprite sheet={BULLETIN_SHEET} frame={f.frame} x={at.x} y={at.y} origin="topLeft" />
          {k === 'card' && (
            <Sprite
              sheet={BULLETIN_SHEET}
              frame={listingIconFrame('card', false)}
              x={at.x + DETAIL.icon.x}
              y={at.y + DETAIL.icon.y}
              origin="topLeft"
            />
          )}
          <p
            className={v.box}
            style={{
              ...light,
              left: at.x + DETAIL.name.x + 4,
              top: at.y + DETAIL.name.y + 6,
              width: DETAIL.name.w - 8,
              height: DETAIL.name.h - 8,
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
            }}
            title={name}
          >
            {name}
          </p>
        </div>
        {rows.slice(0, f.rows).map((r, i) => {
          const y = at.y + DETAIL.rowY0 + i * DETAIL.rowDy;
          const valueStyle: CSSProperties = {
            ...dark,
            left: at.x + DETAIL.value.x,
            top: y,
            width: DETAIL.value.w,
            height: DETAIL.value.h,
            paddingRight: 6,
            textAlign: 'right',
            color: '#fff',
            textShadow: '1px 1px 0 #000',
          };
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: 行位固定
            <div key={i}>
              <p
                className={v.box}
                style={{ ...light, left: at.x + DETAIL.label.x, top: y + 5, width: DETAIL.label.w, height: 16 }}
              >
                {r.label}
              </p>
              <p
                className={v.box}
                style={r.active ? { ...valueStyle, outline: '2px solid #ffe060', outlineOffset: -2 } : valueStyle}
                data-testid={r.testId}
                data-active={r.active ? 'true' : undefined}
              >
                {r.value}
              </p>
            </div>
          );
        })}
        <TextButton
          x={at.x + L.x}
          y={at.y + L.y}
          w={L.w}
          h={L.h}
          tone="red"
          label={left.label}
          onClick={left.onClick}
          disabled={left.disabled}
          testId={left.testId}
        />
        <TextButton
          x={at.x + R.x}
          y={at.y + R.y}
          w={R.w}
          h={R.h}
          tone="red"
          label={right.label}
          onClick={right.onClick}
          testId={right.testId}
        />
      </div>
    );
  };

  // ───── 板面 ─────
  const boardView = (
    <>
      {shown.map((l: ListingView, i) => {
        const p = tileAt(i);
        return (
          <div key={l.id}>
            <div className={v.deco}>
              <Sprite
                sheet={BULLETIN_SHEET}
                frame={listingIconFrame(l.asset.t, l.mine)}
                x={p.x}
                y={p.y}
                origin="topLeft"
              />
              <p
                className={v.box}
                style={{
                  ...classicText({ size: 10, color: '#1a1a3a', outline: null, lineHeight: 11, align: 'center' }),
                  left: p.x + 6,
                  top: p.y + 52,
                  width: TILE.w - 12,
                  height: 11,
                }}
              >
                {text.player(l.seller)}
              </p>
              <p
                className={v.box}
                style={{ ...light, left: p.x - 4, top: p.y + TILE.h + 1, width: TILE.w + 8, textAlign: 'center' }}
              >
                {formatMoney(l.price)}
              </p>
            </div>
            <button
              type="button"
              className={v.cell}
              style={{ left: p.x, top: p.y, width: TILE.w, height: TILE.h }}
              aria-label={`${text.player(l.seller)}：${assetName(text, l.asset)} ${formatMoney(l.price)}`}
              data-testid={`listing-${l.id}`}
              data-mine={l.mine ? 'true' : 'false'}
              onClick={() => {
                setDetailId(l.id);
                setStep('detail');
              }}
            />
          </div>
        );
      })}
      {listings.length === 0 && (
        <p
          className={v.box}
          style={{ ...TEXT.body, left: BOARD_AT.x + 40, top: BOARD_AT.y + 160, width: 360, textAlign: 'center' }}
          data-testid="board-empty"
        >
          {t('pnl.board.empty')}
        </p>
      )}
      {pages > 1 && (
        <>
          <TextButton
            x={BOARD_AT.x + PAGE_BTNS.x}
            y={BOARD_AT.y + PAGE_BTNS.y}
            w={PAGE_BTNS.w}
            h={PAGE_BTNS.h}
            label="◀"
            onClick={() => setPage((pageNow + pages - 1) % pages)}
            testId="board-page-prev"
          />
          <TextButton
            x={BOARD_AT.x + PAGE_BTNS.x + PAGE_BTNS.dx}
            y={BOARD_AT.y + PAGE_BTNS.y}
            w={PAGE_BTNS.w}
            h={PAGE_BTNS.h}
            label="▶"
            onClick={() => setPage((pageNow + 1) % pages)}
            testId="board-page-next"
          />
        </>
      )}
    </>
  );

  // ───── 类别选择 ─────
  const K = kindsLayout(wide);
  const kindView = (
    <div data-testid="board-kinds">
      <div className={v.deco}>
        <Sprite sheet={BULLETIN_SHEET} frame={BULLETIN_FRAME.kinds} x={K.x} y={K.y} origin="topLeft" scale={K.scale} />
      </div>
      {KIND_ORDER.map((k, i) => {
        const r = kindCell(i, K.scale);
        const n = rowsOf(k).length;
        return (
          <button
            key={k}
            type="button"
            className={v.cell}
            style={{ left: K.x + r.x, top: K.y + r.y, width: r.w, height: r.h }}
            aria-label={t(
              `pnl.board.kind${k === 'lot' ? 'Lot' : k === 'stock' ? 'Stock' : k === 'card' ? 'Card' : 'Item'}`,
            )}
            title={t(`pnl.board.kind${k === 'lot' ? 'Lot' : k === 'stock' ? 'Stock' : k === 'card' ? 'Card' : 'Item'}`)}
            disabled={n === 0 || !can}
            data-empty={n === 0 ? 'true' : undefined}
            data-testid={`board-kind-${k}`}
            onClick={() => {
              setKind(k);
              setTablePage(0);
              setStep('asset');
            }}
          />
        );
      })}
      <div className={v.deco}>
        <Sprite sheet={BULLETIN_SHEET} frame={BULLETIN_FRAME.close} x={K.close.x} y={K.close.y} origin="topLeft" />
      </div>
      <button
        type="button"
        className={v.cell}
        style={{ left: K.close.x, top: K.close.y, width: K.close.w, height: K.close.h }}
        aria-label={t('dlg.common.back')}
        data-testid="board-kind-close"
        onClick={() => setStep('board')}
      />
    </div>
  );

  // ───── 表格：选要卖的东西 ─────
  let assetView: ReactNode = null;
  if (step === 'asset') {
    const tb = kind === 'stock' ? TABLE.stock : TABLE.plain;
    const rows = rowsOf(kind);
    const per = itemsPerPage(rowsPerItem);
    const tp = pageCount(rows.length, per);
    const tpNow = Math.min(tablePage, tp - 1);
    const at = tb.at;
    const head = [
      t(`pnl.board.kind${kind === 'lot' ? 'Lot' : kind === 'stock' ? 'Stock' : kind === 'card' ? 'Card' : 'Item'}`),
      kind === 'lot' ? t('dlg.buyLot.level') : kind === 'stock' ? t('pnl.board.shares') : t('pnl.board.qty'),
      kind === 'lot' ? t('pnl.board.price') : kind === 'stock' ? t('pnl.board.price') : '',
    ];
    const colW = (c: number): number => (tb.cols[c + 1] ?? tb.w) - tb.cols[c]!;
    assetView = (
      <div data-testid="board-table" data-kind={kind}>
        <div className={v.deco}>
          <Sprite sheet={BULLETIN_SHEET} frame={tb.frame} x={at.x} y={at.y} origin="topLeft" />
          {head.map((h, c) => (
            <p
              // biome-ignore lint/suspicious/noArrayIndexKey: 列位固定
              key={c}
              className={v.box}
              style={{
                ...classicText({ size: 12, color: '#ffe060', lineHeight: TABLE.rowH }),
                left: at.x + tb.cols[c]! + 6,
                top: at.y,
                width: colW(c) - 12,
                height: TABLE.rowH,
              }}
            >
              {h}
            </p>
          ))}
        </div>
        {rows.slice(tpNow * per, (tpNow + 1) * per).map((r, i) => {
          const rr = tableRow(i, rowsPerItem, tb.w - 30);
          return (
            <button
              key={r.key}
              type="button"
              className={`${v.cell} ${v.row}`}
              style={{
                ...light,
                left: at.x + rr.x,
                top: at.y + rr.y,
                width: rr.w,
                height: rr.h,
                gridTemplateColumns: `${colW(0)}px ${colW(1)}px 1fr`,
              }}
              disabled={!can}
              data-testid={`board-pick-${kind}-${r.key}`}
              onClick={() => openForm(r.draft)}
            >
              {r.cells.map((c, k) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 列位固定
                <span key={k} style={{ paddingLeft: 6, overflow: 'hidden', whiteSpace: 'nowrap' }}>
                  {c}
                </span>
              ))}
            </button>
          );
        })}
        {/* 表格右上角画着的 ×（精确点击）+ 表格右侧的「返回」文字钮（手机上补足热区） */}
        <button
          type="button"
          tabIndex={-1}
          className={`${v.cell} ${v.flat}`}
          style={{
            left: at.x + tb.closeArt.x,
            top: at.y + tb.closeArt.y,
            width: tb.closeArt.w,
            height: tb.closeArt.h,
          }}
          aria-label={t('dlg.common.back')}
          data-testid="board-table-close"
          onClick={() => setStep('kind')}
        />
        <TextButton
          x={at.x + tb.w + TABLE.closeBtn.x}
          y={at.y + TABLE.closeBtn.y}
          w={TABLE.closeBtn.w}
          h={TABLE.closeBtn.h}
          label={t('dlg.common.back')}
          onClick={() => setStep('kind')}
          testId="board-table-back"
        />
        {tp > 1 && (
          <>
            <TextButton
              x={at.x + tb.w + TABLE.pageBtn.x}
              y={at.y + TABLE.pageBtn.y}
              w={TABLE.pageBtn.w}
              h={TABLE.pageBtn.h}
              label="▲"
              onClick={() => setTablePage((tpNow + tp - 1) % tp)}
              testId="board-table-prev"
            />
            <TextButton
              x={at.x + tb.w + TABLE.pageBtn.x}
              y={at.y + TABLE.pageBtn.y + TABLE.pageBtn.dy}
              w={TABLE.pageBtn.w}
              h={TABLE.pageBtn.h}
              label="▼"
              onClick={() => setTablePage((tpNow + 1) % tp)}
              testId="board-table-next"
            />
          </>
        )}
      </div>
    );
  }

  // ───── 挂牌表单 ─────
  let formView: ReactNode = null;
  if (step === 'form' && draft) {
    const asset = draftAsset(draft, qty);
    const qtyMax = draft.t === 'stock' || draft.t === 'item' ? draft.held : 1;
    const qtyRow =
      draft.t === 'stock' || draft.t === 'item'
        ? [
            {
              label: draft.t === 'stock' ? t('pnl.board.shares') : t('pnl.board.qty'),
              value: formatMoney(qty),
              testId: 'board-field-qty',
              active: field === 'qty',
            },
          ]
        : [];
    const priceRow = {
      label: t('pnl.board.price'),
      value: formatMoney(price),
      testId: 'board-field-price',
      active: field === 'price',
    };
    const rows =
      draft.t === 'lot'
        ? [
            { label: t('dlg.buyLot.level'), value: levelLabel(lotStatus(view, draft.lot)?.level ?? 0) },
            { label: '', value: t('pnl.board.cap', { cap: formatMoney(draft.cap) }), testId: 'board-cap' },
            priceRow,
          ]
        : draft.t === 'stock'
          ? [{ label: '', value: `${t('pnl.board.shares')} ≤ ${formatMoney(draft.held)}` }, ...qtyRow, priceRow]
          : [...qtyRow, priceRow];
    formView = (
      <>
        {card(
          draft.t,
          DETAIL_AT.form,
          assetName(text, asset),
          rows,
          {
            label: t('pnl.board.doList'),
            onClick: () => doList(),
            disabled: !valid || !can,
            testId: 'board-list',
          },
          { label: t('dlg.common.cancel'), onClick: () => setStep('asset'), testId: 'board-form-cancel' },
          'board-form',
        )}
        <Calculator
          key={field}
          x={CALC_AT.x}
          y={CALC_AT.y}
          value={field === 'qty' ? qty : price}
          onChange={(n) => (field === 'qty' ? setQty(n) : setPrice(n))}
          min={1}
          max={field === 'qty' ? Math.max(1, qtyMax) : priceMax(draft)}
          onEnter={(n) => {
            if (field === 'qty') {
              setQty(n);
              setField('price');
            } else doList(n);
          }}
          enterDisabled={field === 'price' ? !can : false}
          label={
            field === 'qty' ? (draft.t === 'stock' ? t('pnl.board.shares') : t('pnl.board.qty')) : t('pnl.board.price')
          }
          disabled={!can}
          testId="board-calc"
        />
        {/* 计算器右侧：切换正在输入的是数量还是价格 */}
        {qtyRow.length > 0 &&
          (['qty', 'price'] as const).map((f, i) => (
            <TextButton
              key={f}
              x={FIELD_BTNS.x}
              y={FIELD_BTNS.y + i * FIELD_BTNS.dy}
              w={FIELD_BTNS.w}
              h={FIELD_BTNS.h}
              tone="blue"
              pressed={field === f}
              label={f === 'qty' ? qtyRow[0]!.label : t('pnl.board.price')}
              onClick={() => setField(f)}
              testId={`board-edit-${f}`}
              style={field === f ? { outline: '2px solid #ffe060' } : undefined}
            />
          ))}
      </>
    );
  }

  // ───── 挂牌明细 ─────
  let detailView: ReactNode = null;
  if (step === 'detail' && detail) {
    const a = detail.asset;
    const rows: { label: string; value: ReactNode; testId?: string }[] = [
      { label: t('pnl.board.seller'), value: text.player(detail.seller), testId: 'listing-seller' },
    ];
    if (a.t === 'lot')
      rows.push({ label: t('dlg.buyLot.level'), value: levelLabel(lotStatus(view, a.lot)?.level ?? 0) });
    if (a.t === 'stock') rows.push({ label: t('pnl.board.shares'), value: formatMoney(a.shares) });
    if (a.t === 'item') rows.push({ label: t('pnl.board.qty'), value: formatMoney(a.qty) });
    rows.push({ label: t('pnl.board.price'), value: formatMoney(detail.price), testId: 'listing-price' });
    detailView = card(
      a.t,
      DETAIL_AT.view,
      assetName(text, a),
      rows,
      detail.mine
        ? {
            label: t('pnl.board.delist'),
            onClick: () => act({ type: 'BOARD_DELIST', listingId: detail.id }),
            disabled: !can,
            testId: `listing-delist-${detail.id}`,
          }
        : {
            label: t('pnl.board.buy'),
            onClick: () => act({ type: 'BOARD_BUY', listingId: detail.id }),
            disabled: !can || !detail.affordable,
            testId: `listing-buy-${detail.id}`,
          },
      { label: t('dlg.common.cancel'), onClick: () => setStep('board'), testId: 'listing-close' },
      'listing-detail',
    );
    if (!detail.mine && !detail.affordable) {
      const f = detailFrame(a.t);
      detailView = (
        <>
          {detailView}
          <p
            className={v.box}
            role="alert"
            style={{ ...TEXT.warn, left: DETAIL_AT.view.x, top: DETAIL_AT.view.y + f.h + 4, width: DETAIL.w }}
            data-testid="listing-short"
          >
            {text.reason('notEnoughCash')}
          </p>
        </>
      );
    }
  }

  const info = !board.canList
    ? t('pnl.board.cannotList')
    : menuFull
      ? text.reason('menuLimit')
      : t('pnl.board.list', { n: board.mine });

  return (
    <DecisionStage
      ctl={ctl}
      decision={d}
      view={view}
      map={map}
      isMine={isMine}
      label={t('pnl.board.title')}
      backdrop="dim"
      onClose={close}
      closeButton={false}
      attrs={{ 'data-venue': 'bulletin', 'data-sheet': 'board', 'data-step': step }}
    >
      <div data-testid="board-panel" data-listings={listings.length}>
        <div className={v.deco}>
          <Sprite sheet={BULLETIN_SHEET} frame={BULLETIN_FRAME.board} x={BOARD_AT.x} y={BOARD_AT.y} origin="topLeft" />
          <p
            className={v.box}
            style={{ ...light, left: BOARD_AT.x + 8, top: BOARD_AT.y + 350, width: 580 }}
            data-testid="board-info"
          >
            {info}
          </p>
        </div>
        {/* 板上画好的 SALE / EXIT */}
        <button
          type="button"
          className={v.cell}
          style={{ left: BOARD_AT.x + SALE_BTN.x, top: BOARD_AT.y + SALE_BTN.y, width: SALE_BTN.w, height: SALE_BTN.h }}
          aria-label={t('pnl.board.doList')}
          title={t('pnl.board.list', { n: board.mine })}
          disabled={!can || !board.canList}
          aria-pressed={step === 'kind' || step === 'asset' || step === 'form'}
          data-testid="board-sell"
          onClick={() => setStep(step === 'kind' ? 'board' : 'kind')}
        />
        <button
          type="button"
          className={v.cell}
          style={{ left: BOARD_AT.x + EXIT_BTN.x, top: BOARD_AT.y + EXIT_BTN.y, width: EXIT_BTN.w, height: EXIT_BTN.h }}
          aria-label={t('cmp.close')}
          title={t('cmp.close')}
          data-testid="board-exit"
          onClick={onClose}
        />
        {step !== 'asset' && step !== 'form' && boardView}
        {/* 弹层打开时挡住下面的板面（点空白处：明细卡与类别选择回到板面，表格与表单不动） */}
        {step !== 'board' && (
          <button
            type="button"
            tabIndex={-1}
            className={v.cell}
            style={{ left: 0, top: 0, width: 640, height: 480, cursor: 'default', outline: 'none' }}
            aria-label={t('dlg.common.back')}
            data-testid="board-backdrop"
            onClick={() => {
              if (step === 'detail' || step === 'kind') setStep('board');
            }}
          />
        )}
        {step === 'kind' && kindView}
        {assetView}
        {formView}
        {detailView}
      </div>
      <p className={s.srOnly}>{t('pnl.board.title')}</p>
    </DecisionStage>
  );
}

/** 懒加载入口：默认导出同一个组件 */
export default BulletinBoardScene;
