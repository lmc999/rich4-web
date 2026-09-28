// 股市的原版场景（original-skin.md §4.2 场所屏：股市 Panel#75）：回合菜单（TURN_MENU）的股票子页在原版皮肤下打开它。
// 绿色行情表（图0）：顶栏 6 格写股市开闭、日期、存款、持股市值，第 6 格是烘焙的 EXIT；第 0 行栏名，1–12 行是 12 支股票
// （名称、现价、涨跌（红涨绿跌、涨停跌停）、持股、均价、盈亏）。点一行打开公司详情框（图2）：行业图（图3–11，按序号取模）、
// 行情与持股、30 日走势折线（画在彩色色带上）、买入 / 卖出切换、股数用计算器（Panel#21），圆台就是「成交」钮——提交
// STOCK_BUY / STOCK_SELL（非终结：服务器以新 decisionId 重发回合菜单），成交后回到行情表。EXIT / Esc 关闭（详情框开着时先关详情）。
// 金额 = trunc(价(分) × 股数 / 100)，从存款结算、没有手续费（与 StockPanel、引擎相同）；可买可卖量全部来自 options。
// data-testid 沿用程序化股市子页（turn-stock-sheet、stock-pick-<idx>、stock-side-buy/sell、stock-submit、stock-amount、
// stock-deposit、stock-total-value）；隐藏的 role=spinbutton「股数」给读屏与 E2E 直接填数。
import type { MapIndex } from '@rich4/shared/data';
import type { DecisionForYou, GameView } from '@rich4/shared/view';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  formatCents,
  formatDateShort,
  formatInt,
  formatPct10,
  formatSigned,
  stockAmount,
} from '../../../components/format';
import { type LooseT, useGameText } from '../../../components/names';
import type { DecisionController } from '../../../decisions/useDecision';
import { Calculator } from '../../common/Calculator';
import { type HotspotSpec, Hotspots } from '../../common/Hotspots';
import { NUMPAD_MASK, NUMPAD_SHEET } from '../../common/numpad';
import { SceneLayer, type SceneStatusTone, Stage4x3 } from '../../common/Stage4x3';
import { TEXT } from '../../common/textStyles';
import { Sprite } from '../../Sprite';
import { STOCK, stockCol, stockIndustryFrame, stockRowRect, trendPoints, VENUE_KEYS } from './layout';
import { Amount, PlateButton, SceneText, SrNumber, signColor } from './parts';
import v from './venues.module.css';

/** 走势折线的天数（与程序化 StockPanel 的 SPARK_DAYS 相同） */
const SPARK_DAYS = 30;

/** 股市场景依赖的素材 */
export const STOCK_KEYS: readonly string[] = [VENUE_KEYS.stock, NUMPAD_SHEET, NUMPAD_MASK];

export type StockSide = 'buy' | 'sell';

export interface StockMarketSceneProps {
  decision: DecisionForYou<'TURN_MENU'>;
  view: GameView;
  map: MapIndex;
  isMine: boolean;
  /** 回合菜单的决策控制器（提交锁、倒计时） */
  ctl: DecisionController;
  /** EXIT / Esc：关掉股市（回到回合菜单或收起） */
  onClose: () => void;
}

export function StockMarketScene({ decision: d, view, map, isMine, ctl, onClose }: StockMarketSceneProps): ReactNode {
  const { t } = useTranslation();
  const lt = t as unknown as LooseT;
  const text = useGameText(view, map);
  const market = d.options.stock;
  const rows = market.rows;
  const [sel, setSel] = useState<number | null>(null);
  const [side, setSide] = useState<StockSide>('buy');
  const [shares, setShares] = useState(100);
  const row = rows.find((r) => r.idx === sel) ?? null;
  const menuFull = d.options.menuActions.used >= d.options.menuActions.limit;
  const totalValue = rows.reduce((sum, r) => sum + stockAmount(r.priceCents, r.shares), 0);

  const max = row ? (side === 'buy' ? row.maxBuy : row.maxSell) : 0;
  let blocked: string | null = null;
  if (row) {
    if (!market.open) blocked = lt(`pnl.stock.closed.${market.reason ?? 'holiday'}`);
    else if (menuFull) blocked = text.reason('menuLimit');
    else if (row.suspended) blocked = text.reason('suspended');
    else if (side === 'buy' && row.limitUp) blocked = text.reason('limitUp');
    else if (side === 'sell' && row.limitDown) blocked = text.reason('limitDown');
    else if (max <= 0) blocked = side === 'buy' ? t('pnl.stock.cannotBuy') : t('pnl.stock.cannotSell');
  }
  const n = Math.min(Math.max(0, shares), Math.max(0, max));
  const amount = row ? stockAmount(row.priceCents, n) : 0;
  const depositAfter = market.deposit + (side === 'buy' ? -amount : amount);
  const canSubmit = ctl.interactive && row !== null && blocked === null && n >= 1;

  const submit = (): void => {
    if (!canSubmit || !row) return;
    if (ctl.send({ type: side === 'buy' ? 'STOCK_BUY' : 'STOCK_SELL', stock: row.idx, shares: n })) setSel(null);
  };
  const open = (idx: number): void => {
    setSel(idx);
    setSide('buy');
    setShares(100);
  };
  const close = (): void => {
    if (sel !== null) setSel(null);
    else onClose();
  };

  // 状态条（同 DecisionStage）
  let status: string | null = null;
  let tone: SceneStatusTone = 'info';
  if (!isMine) {
    status = t('dlg.common.waiting', { name: text.player(d.seat) });
    tone = 'wait';
  } else if (ctl.locked) {
    status = t('dlg.common.sent');
    tone = 'sent';
  } else if (ctl.expired) {
    status = t('dlg.common.expired');
    tone = 'expired';
  }

  const history = (idx: number): number[] => view.stocks.find((x) => x.idx === idx)?.history.slice(-SPARK_DAYS) ?? [];
  const head = STOCK.header;
  const titles = [
    t('pnl.stock.name'),
    t('pnl.stock.price'),
    t('pnl.stock.change'),
    t('pnl.stock.shares'),
    t('pnl.stock.avg'),
    t('pnl.stock.pnl'),
  ];

  const spots: HotspotSpec[] = [
    ...rows.slice(0, STOCK.rows.count - 1).map((r, i): HotspotSpec => {
      const rect = stockRowRect(i + 1);
      return {
        id: `row-${r.idx}`,
        rect,
        label: `${text.stock(r.idx)} ${formatCents(r.priceCents)}`,
        pressed: sel === r.idx,
        hit: 'none',
        testId: `stock-pick-${r.idx}`,
        onActivate: () => open(r.idx),
      };
    }),
    {
      id: 'exit',
      rect: head[5]!,
      label: t('cmp.close'),
      // 顶栏贴着场景上缘（手机横屏时即屏幕上缘），居中补的上半截落在屏幕外：只往下补（下面是不可点的栏名行）
      hit: 'down',
      testId: 'stock-exit',
      onActivate: () => onClose(),
    },
  ];

  const P = STOCK.panel;
  const cell = (k: number, r: number): { left: number; top: number; width: number; height: number } => {
    const c = stockCol(k);
    const rr = stockRowRect(r);
    return { left: c.x + 4, top: rr.y, width: c.w - 8, height: rr.h };
  };

  return (
    <Stage4x3
      testId="turn-stock-sheet"
      label={t('pnl.stock.title')}
      readOnly={!isMine}
      interactive={ctl.interactive}
      status={status}
      statusTone={tone}
      countdown={{ remainingMs: ctl.remainingMs, totalMs: ctl.totalMs }}
      countdownAt={STOCK.ring}
      countdownBadgeAt={STOCK.badge}
      onClose={close}
      closeButton={false}
      backdrop="opaque"
      attrs={{ 'data-selected': sel === null ? '' : String(sel), 'data-open': market.open ? 'true' : 'false' }}
    >
      <Sprite sheet={VENUE_KEYS.stock} frame={STOCK.table} x={0} y={0} origin="topLeft" />

      {/* 顶栏 */}
      <SceneText rect={head[0]!} style={{ ...TEXT.title, fontSize: 16, display: 'grid', placeItems: 'center' }}>
        {t('pnl.stock.title')}
      </SceneText>
      <SceneText
        rect={head[1]!}
        style={{ display: 'grid', placeItems: 'center', ...(market.open ? {} : TEXT.warn) }}
        testId="stock-market-state"
      >
        {market.open ? t('pnl.stock.open') : lt(`pnl.stock.closed.${market.reason ?? 'holiday'}`)}
      </SceneText>
      <SceneText rect={head[2]!} style={{ display: 'grid', placeItems: 'center' }}>
        {view.clock.date ? formatDateShort(view.clock.date) : ''}
      </SceneText>
      <SceneText rect={head[3]!} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
        <span>{t('pnl.stock.deposit')}</span>
        <Amount value={market.deposit} testId="stock-deposit" />
      </SceneText>
      <SceneText
        rect={{ x: head[4]!.x + 34, y: head[4]!.y, w: head[4]!.w - 38, h: head[4]!.h }}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}
      >
        <span>{t('pnl.stock.totalValue')}</span>
        <Amount value={totalValue} testId="stock-total-value" />
      </SceneText>

      {/* 表格：栏名 + 12 支股票 */}
      {titles.map((s, k) => (
        <span
          key={s}
          className={`${v.cellText} ${k > 0 ? v.num : ''}`}
          style={{ ...TEXT.title, fontSize: 15, ...cell(k, 0) }}
        >
          {s}
        </span>
      ))}
      {rows.slice(0, STOCK.rows.count - 1).map((r, i) => {
        const avg = r.shares > 0 ? Math.trunc(r.costCents / r.shares) : 0;
        const value = stockAmount(r.priceCents, r.shares);
        const pnl = value - Math.trunc(r.costCents / 100);
        const dir = { color: signColor(r.changePct10) };
        const rr = stockRowRect(i + 1);
        return (
          <div key={r.idx} data-testid={`stock-row-${r.idx}`} data-shares={r.shares}>
            {sel === r.idx && <span className={v.rowHi} style={{ left: rr.x, top: rr.y, width: rr.w, height: rr.h }} />}
            <span className={v.cellText} style={{ ...TEXT.body, ...cell(0, i + 1) }}>
              {text.stock(r.idx)}
              {r.chairman !== null ? ' ★' : ''}
              {r.suspended ? ` ${text.reason('suspended')}` : ''}
            </span>
            <span className={`${v.cellText} ${v.num}`} style={{ ...TEXT.body, ...cell(1, i + 1), ...dir }}>
              {formatCents(r.priceCents)}
            </span>
            <span className={`${v.cellText} ${v.num}`} style={{ ...TEXT.body, ...cell(2, i + 1), ...dir }}>
              {formatPct10(r.changePct10)}
              {r.limitUp ? '▲' : r.limitDown ? '▼' : ''}
            </span>
            <span className={`${v.cellText} ${v.num}`} style={{ ...TEXT.body, ...cell(3, i + 1) }}>
              {formatInt(r.shares)}
            </span>
            <span className={`${v.cellText} ${v.num}`} style={{ ...TEXT.body, ...cell(4, i + 1) }}>
              {r.shares > 0 ? formatCents(avg) : '—'}
            </span>
            <span
              className={`${v.cellText} ${v.num}`}
              style={{ ...TEXT.body, ...cell(5, i + 1), color: signColor(pnl) }}
              data-testid={`stock-pnl-${r.idx}`}
            >
              {r.shares > 0 ? formatSigned(pnl) : '—'}
            </span>
          </div>
        );
      })}
      <Hotspots
        x={0}
        y={0}
        w={640}
        h={480}
        spots={spots}
        disabled={!ctl.interactive}
        label={t('pnl.stock.title')}
        testId="stock-rows"
      />
      {/* 手机与读屏：原生下拉框选股 */}
      <select
        className={v.picker}
        style={{ left: 16, top: 418, width: 240 }}
        aria-label={t('pnl.stock.name')}
        value={sel === null ? '' : String(sel)}
        disabled={!isMine}
        onChange={(e) => (e.currentTarget.value === '' ? setSel(null) : open(Number(e.currentTarget.value)))}
        data-testid="stock-picker"
      >
        <option value="">—</option>
        {rows.map((r) => (
          <option key={r.idx} value={String(r.idx)}>
            {text.stock(r.idx)} {formatCents(r.priceCents)}
          </option>
        ))}
      </select>

      {/* 公司详情与交易 */}
      {row && (
        <SceneLayer x={P.x} y={P.y} w={P.w} h={P.h} testId="stock-trade" z={5}>
          <Sprite sheet={VENUE_KEYS.stock} frame={STOCK.detail} x={0} y={0} origin="topLeft" />
          <Sprite
            sheet={VENUE_KEYS.stock}
            frame={stockIndustryFrame(row.idx)}
            x={P.image.x}
            y={P.image.y}
            origin="topLeft"
            testId="stock-industry"
          />
          <SceneText rect={P.info} style={{ ...TEXT.body, lineHeight: '17px' }}>
            <p style={{ ...TEXT.title, fontSize: 20, lineHeight: '26px' }}>{text.stock(row.idx)}</p>
            <p>
              {t('pnl.stock.price')} {formatCents(row.priceCents)}
              <span style={{ color: signColor(row.changePct10), marginLeft: 8 }}>
                {formatPct10(row.changePct10)}
                {row.limitUp ? ' ▲' : row.limitDown ? ' ▼' : ''}
              </span>
            </p>
            <p>
              {t('pnl.stock.chairman')} {row.chairman === null ? '—' : text.player(row.chairman)}
            </p>
            <p>
              {t('pnl.stock.shares')} {formatInt(row.shares)}　{t('pnl.stock.avg')}{' '}
              {row.shares > 0 ? formatCents(Math.trunc(row.costCents / row.shares)) : '—'}
            </p>
            <p>{t('pnl.stock.maxBuy', { n: formatInt(Math.max(0, row.maxBuy)) })}</p>
            <p>{t('pnl.stock.maxSell', { n: formatInt(Math.max(0, row.maxSell)) })}</p>
            <p>{t('pnl.stock.noFee')}</p>
          </SceneText>
          <svg
            className={v.trend}
            style={{ left: P.chart.x, top: P.chart.y }}
            width={P.chart.w}
            height={P.chart.h}
            aria-label={t('pnl.stock.trendOf', { name: text.stock(row.idx) })}
            role="img"
            data-testid="stock-trend"
          >
            <polyline points={trendPoints(history(row.idx), P.chart.w, P.chart.h)} />
          </svg>
          <SceneText rect={{ x: P.chart.x + 4, y: P.chart.y + 2, w: P.chart.w - 8, h: 16 }}>
            {t('pnl.stock.trend', { n: SPARK_DAYS })}
          </SceneText>
          <div role="radiogroup" aria-label={t('pnl.stock.side')}>
            {(['buy', 'sell'] as const).map((s, i) => (
              <PlateButton
                key={s}
                x={P.side.xs[i]!}
                y={P.side.y}
                w={P.side.w}
                h={P.side.h}
                label={t(s === 'buy' ? 'pnl.stock.buy' : 'pnl.stock.sell')}
                pressed={side === s}
                onClick={() => {
                  setSide(s);
                  setShares(100);
                }}
                testId={`stock-side-${s}`}
                // 计算器盖在「卖出」钮正上方：只往下补（下面是说明文字，再往下才是提交钮）
                hitPad="down"
                textStyle={{ fontSize: 15, lineHeight: '18px', fontWeight: 700 }}
              />
            ))}
          </div>
          <Calculator
            value={n}
            onChange={setShares}
            min={0}
            max={Math.max(0, max)}
            onEnter={() => submit()}
            enterDisabled={!canSubmit}
            x={P.calc.x}
            y={P.calc.y}
            label={t('pnl.stock.qty')}
            disabled={!ctl.interactive || blocked !== null}
            testId="stock-calc"
          />
          <SrNumber
            label={t('pnl.stock.qty')}
            value={n}
            min={0}
            max={Math.max(0, max)}
            onChange={setShares}
            disabled={!ctl.interactive || blocked !== null}
            testId="stock-qty-input"
          />
          <SceneText rect={P.note} style={blocked ? TEXT.warn : TEXT.body} testId="stock-note">
            {blocked ?? (
              <>
                {t('pnl.stock.amount')} <Amount value={amount} testId="stock-amount" /> · {t('pnl.stock.depositAfter')}{' '}
                <Amount value={depositAfter} testId="stock-deposit-after" />
              </>
            )}
          </SceneText>
          <PlateButton
            x={P.submit.x}
            y={P.submit.y}
            w={P.submit.w}
            h={P.submit.h}
            bare
            label={t(side === 'buy' ? 'pnl.stock.doBuy' : 'pnl.stock.doSell', { n: formatInt(n) })}
            disabled={!canSubmit}
            onClick={submit}
            testId="stock-submit"
            textStyle={{ fontSize: 16, lineHeight: '20px', fontWeight: 700 }}
          />
          <PlateButton
            x={P.back.x}
            y={P.back.y}
            w={P.back.w}
            h={P.back.h}
            label={t('dlg.common.back')}
            onClick={() => setSel(null)}
            testId="stock-back"
          />
        </SceneLayer>
      )}
    </Stage4x3>
  );
}
