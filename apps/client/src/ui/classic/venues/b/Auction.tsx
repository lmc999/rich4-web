// AUCTION_BID 的原版场景：拍卖厅（Panel#26）。多人并发：每个竞拍者各有一个决策；有人加价后服务器以新 decisionId 重问，
// 场景组件保持同一实例（宿主按「座位:种类」做 key），价格牌、领先者与竞拍者状态随 options / 公开竞价横幅的状态实时刷新；
// 价格变化时拍卖官举手喊价、价格数字闪一下。
// - 左上角星形闪框里是拍卖品（按地图与等级取建筑缩图）；中上方十字花纹框写地名、起拍价 / 目前出价、领先者、卖方与来源、
//   还能出价的人数、本人现金；
// - 竞拍者：Q 版小人（venue.chibi.<角色>.1）站在地毯上，领先者背后描黄边（图 78+角色），暂不加价 / 已退出的变灰；
// - 最下面一排 7 颗原版竞价钮：PASS、+100 … +10000、Give up（出价后超过现金的档位不在 options.increments 里 → 禁用）；
//   还没人出价时另有「按起拍价出价」文字钮（原版没有这一档的钮图）；data-testid 与程序化对话框同名（auction-bid-<档>、
//   auction-pass、auction-quit、auction-price、auction-leader、auction-cash），E2E 两种皮肤共用；
// - 退出不可撤销：没有关闭钮，Esc 不做任何事。
// 另导出只读的观战版（AuctionWatchScene）：没有 AUCTION_BID 决策的人（观战者、卖方、已退出的竞拍者）也能看到拍卖厅。
import type { MapIndex } from '@rich4/shared/data';
import type { BidIncrement, LotId, LotLevel, SeatIndex } from '@rich4/shared/engine';
import type { GameView } from '@rich4/shared/view';
import clsx from 'clsx';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useTx } from '../../../../i18n/tx';
import { formatMoney } from '../../../../presentation/names';
import { useGameStore } from '../../../../store/gameStore';
import { useGameText } from '../../../components/names';
import { lotStatus } from '../../../decisions/helpers';
import type { DecisionProps } from '../../../decisions/types';
import { useDecision } from '../../../decisions/useDecision';
import { type AuctionBannerState, usePopupStore } from '../../../popups/popupStore';
import { ClassicButton } from '../../common/ClassicButton';
import s from '../../common/common.module.css';
import { DecisionStage } from '../../common/DecisionStage';
import { NineSlice } from '../../common/NineSlice';
import { Stage4x3 } from '../../common/Stage4x3';
import { classicText } from '../../common/textStyles';
import type { RequiredKeys } from '../../decisions/scene';
import { Sprite } from '../../Sprite';
import {
  ASSISTANT_AT,
  ASSISTANT_EYES,
  AUCTION_BADGE,
  AUCTION_FRAME,
  AUCTION_SHEET,
  AUCTIONEER_AT,
  AUCTIONEER_CALL_AT,
  AUCTIONEER_CALL_MOUTH,
  BID_BUTTONS,
  BIDDER_GROUND,
  bidButtonFrames,
  bidButtonRect,
  bidderSlots,
  chibiSheet,
  ITEM_AT,
  ITEM_BUILDING_AT,
  lotArtFrame,
  mapStyleIndex,
  nextPrice,
  PRICE_BOARD,
  START_BID,
} from './auctionLayout';
import { characterOf, TextButton } from './shared';
import v from './venues.module.css';

export type BidderState = 'active' | 'passed' | 'quit';

export interface AuctionBidderView {
  seat: SeatIndex;
  character: number;
  name: string;
  state: BidderState;
}

/** 可能参加竞拍的人（在场、不是卖方）：素材与站位都按他们准备 */
export function auctionParticipants(view: Pick<GameView, 'players'>, seller: SeatIndex | null): SeatIndex[] {
  return view.players.filter((p) => p.alive && p.seat !== seller).map((p) => p.seat);
}

/** 依赖的素材：拍卖厅图集 + 每个可能的竞拍者的 Q 版小人 */
export const requiredKeys: RequiredKeys<'AUCTION_BID'> = (p) => [
  AUCTION_SHEET,
  ...auctionParticipants(p.view, p.decision.options.seller).map((seat) => chibiSheet(characterOf(p.view, seat))),
];

/**
 * 竞拍者与状态：优先取公开竞价横幅的状态（演出建立，含暂不加价 / 已退出）；没有横幅（instant、后台、刷新）时由待决策推出：
 * 见过的竞拍者（被问到的座位、本人、领先者）按座位排；此刻被问到的、本人与领先者算竞拍中，其余算暂不加价。
 */
export function auctionBidders(
  banner: Pick<AuctionBannerState, 'lot' | 'bidders'> | null,
  lot: LotId,
  view: Pick<GameView, 'players'>,
  seen: readonly SeatIndex[],
  asked: readonly SeatIndex[],
  nameOf: (seat: SeatIndex) => string,
): AuctionBidderView[] {
  if (banner && banner.lot === lot && banner.bidders.length > 0) {
    return banner.bidders.map((b) => ({ seat: b.seat, character: b.character, name: b.name, state: b.state }));
  }
  return [...new Set(seen)]
    .sort((a, b) => a - b)
    .map((seat) => ({
      seat,
      character: characterOf(view, seat),
      name: nameOf(seat),
      state: asked.includes(seat) ? ('active' as const) : ('passed' as const),
    }));
}

/** 没有横幅时记下这场拍卖里见过的竞拍者（换拍卖品时清空） */
function useSeenBidders(lot: LotId, now: readonly SeatIndex[]): SeatIndex[] {
  const ref = useRef<{ lot: LotId; seats: Set<SeatIndex> }>({ lot, seats: new Set() });
  if (ref.current.lot !== lot) ref.current = { lot, seats: new Set() };
  for (const s of now) ref.current.seats.add(s);
  return [...ref.current.seats];
}

export interface AuctionRoomProps {
  view: GameView;
  map: MapIndex | null;
  lot: LotId;
  level: LotLevel | number;
  seller: SeatIndex | null;
  /** 卖方的显示名（观战版取公开竞价横幅的 sellerName：拍卖卡拍无主地时地块没有主人，但卖方是出卡者）；给了就代替 seller */
  sellerName?: string | null | undefined;
  source?: 'card' | 'bankrupt' | 'surrender' | 'news' | 'magic' | undefined;
  start: number;
  /** 目前出价（无人领先时为起拍价） */
  price: number;
  leader: SeatIndex | null;
  bidders: readonly AuctionBidderView[];
  /** 还能出价的其他人数（决策里才有） */
  others?: number | undefined;
  /** 本人现金（决策里才有） */
  cash?: number | null;
}

/** 拍卖厅的画面（底图、人物、拍卖品、价格牌、竞拍者）：决策场景与观战版共用 */
export function AuctionRoom({
  view,
  map,
  lot,
  level,
  seller,
  sellerName,
  source,
  start,
  price,
  leader,
  bidders,
  others,
  cash = null,
}: AuctionRoomProps): ReactNode {
  const { t } = useTranslation();
  const tx = useTx();
  const text = useGameText(view, map);
  const st = lotStatus(view, lot);
  const art = lotArtFrame(st, level, mapStyleIndex(map?.def.id));
  const noBid = leader === null;

  // 价格或领先者变化：拍卖官举手喊价 1.2 秒（首帧不算）
  const [calling, setCalling] = useState(false);
  const last = useRef(`${price}|${leader}`);
  useEffect(() => {
    const k = `${price}|${leader}`;
    if (k === last.current) return;
    last.current = k;
    setCalling(true);
    const id = setTimeout(() => setCalling(false), 1200);
    return () => clearTimeout(id);
  }, [price, leader]);

  const slots = bidderSlots(bidders.length);
  const dark = classicText({ size: 12, color: '#1a2450', outline: null, lineHeight: 16 });
  const B = PRICE_BOARD;

  return (
    <div className={v.deco}>
      <Sprite sheet={AUCTION_SHEET} frame={AUCTION_FRAME.bg} x={0} y={0} origin="topLeft" />
      {calling ? (
        <>
          <Sprite
            sheet={AUCTION_SHEET}
            frame={AUCTION_FRAME.auctioneerCall}
            x={AUCTIONEER_CALL_AT.x}
            y={AUCTIONEER_CALL_AT.y}
            origin="topLeft"
            testId="auction-auctioneer-call"
          />
          <Sprite
            sheet={AUCTION_SHEET}
            frame={AUCTION_FRAME.auctioneerCallMouth}
            x={AUCTIONEER_CALL_AT.x + AUCTIONEER_CALL_MOUTH.x}
            y={AUCTIONEER_CALL_AT.y + AUCTIONEER_CALL_MOUTH.y}
            origin="topLeft"
            className={v.talk}
          />
        </>
      ) : (
        <Sprite
          sheet={AUCTION_SHEET}
          frame={AUCTION_FRAME.auctioneer}
          x={AUCTIONEER_AT.x}
          y={AUCTIONEER_AT.y}
          origin="topLeft"
        />
      )}
      <Sprite
        sheet={AUCTION_SHEET}
        frame={AUCTION_FRAME.assistant}
        x={ASSISTANT_AT.x}
        y={ASSISTANT_AT.y}
        origin="topLeft"
      />
      <Sprite
        sheet={AUCTION_SHEET}
        frame={AUCTION_FRAME.assistantEyes}
        x={ASSISTANT_AT.x + ASSISTANT_EYES.x}
        y={ASSISTANT_AT.y + ASSISTANT_EYES.y}
        origin="topLeft"
        className={v.blink}
      />

      {/* 拍卖品 */}
      <Sprite sheet={AUCTION_SHEET} frame={AUCTION_FRAME.burst} x={ITEM_AT.x} y={ITEM_AT.y} />
      <Sprite sheet={AUCTION_SHEET} frame={art} x={ITEM_BUILDING_AT.x} y={ITEM_BUILDING_AT.y} testId="auction-item" />

      {/* 价格牌 */}
      <NineSlice spec="crossPanel" x={B.x} y={B.y} w={B.w} h={B.h} testId="auction-board" />
      <div className={v.box} style={{ ...dark, left: B.x + 16, top: B.y + 10, width: B.w - 32, height: B.h - 18 }}>
        <p style={classicText({ size: 16, color: '#ffe060', bold: true, lineHeight: 20 })} data-testid="auction-lot">
          {/* 地名多以数字结尾（台北市 2）：等级另起一段，免得读成「台北市 20 级」 */}
          {text.lot(lot)} ・ {t('dlg.common.levelN', { n: level })}
        </p>
        <p>
          {noBid ? t('dlg.auction.startPrice') : t('dlg.auction.current')}{' '}
          <strong
            key={price}
            className={v.price}
            style={classicText({ size: 20, color: '#c0201a', outline: '#fff', bold: true, lineHeight: 22 })}
            data-testid="auction-price"
            data-value={price}
            aria-live="polite"
          >
            {formatMoney(price)}
          </strong>
        </p>
        <p data-testid="auction-leader" data-leader={leader ?? ''}>
          {leader === null ? t('dlg.auction.noLeader') : tx('events:popup.auctionLeader', { who: text.player(leader) })}
        </p>
        <p style={{ fontSize: 12 }}>
          {t('dlg.auction.seller')}：
          {sellerName ? sellerName : seller === null ? t('dlg.auction.noSeller') : text.player(seller)}
          {source ? ` ・ ${tx(`dlg.auction.source.${source}`)}` : ''}
          {!noBid ? ` ・ ${t('dlg.auction.start')} ${formatMoney(start)}` : ''}
        </p>
        {(others !== undefined || cash !== null) && (
          <p style={{ fontSize: 12 }}>
            {others !== undefined ? t('dlg.auction.othersN', { n: others }) : ''}
            {cash !== null && (
              <>
                {others !== undefined ? ' ・ ' : ''}
                {t('dlg.common.cash')}{' '}
                <span data-testid="auction-cash" data-value={cash}>
                  {formatMoney(cash)}
                </span>
              </>
            )}
          </p>
        )}
      </div>

      {/* 竞拍者 */}
      <div data-testid="auction-bidders">
        {bidders.map((b, i) => {
          const x = slots[i]!;
          const lead = b.seat === leader;
          return (
            <div key={b.seat} data-testid={`auction-bidder-${b.seat}`} data-state={b.state} data-leader={lead}>
              {lead && (
                <Sprite sheet={AUCTION_SHEET} frame={AUCTION_FRAME.outline0 + b.character} x={x} y={BIDDER_GROUND} />
              )}
              <Sprite
                sheet={chibiSheet(b.character)}
                frame={0}
                x={x}
                y={BIDDER_GROUND}
                className={clsx(b.state !== 'active' && v.dimmed)}
              />
              <span
                className={v.tag}
                data-state={b.state}
                style={{ ...classicText({ size: 12, lineHeight: 14 }), left: x, top: BIDDER_GROUND - 108 }}
              >
                {b.name}
                {b.state !== 'active' ? `・${tx(`events:popup.bidder.${b.state}`)}` : lead ? ' ♛' : ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function AuctionScene(props: DecisionProps<'AUCTION_BID'>): ReactNode {
  const { t } = useTranslation();
  const { view, map, isMine, decision: d } = props;
  const ctl = useDecision(props);
  const text = useGameText(view, map);
  const o = d.options;
  const banner = usePopupStore((st) => st.auction);
  const pending = useGameStore((st) => st.pending);
  const asked = [
    ...pending.filter((p) => p.kind === 'AUCTION_BID').map((p) => p.seat),
    d.seat,
    ...(o.leader === null ? [] : [o.leader]),
  ];
  const seen = useSeenBidders(o.lot, asked);
  const bidders = auctionBidders(banner, o.lot, view, seen, asked, text.player).map((b) =>
    // 本人既然被问，就是竞拍中
    b.seat === d.seat ? { ...b, state: 'active' as const } : b,
  );
  const shown = o.leader === null ? o.start : o.price;
  const allowed = new Set<BidIncrement>(o.increments);

  return (
    <DecisionStage
      ctl={ctl}
      decision={d}
      view={view}
      map={map}
      isMine={isMine}
      label={`${t('dlg.auction.title')}：${text.lot(o.lot)}`}
      backdrop="opaque"
      countdownBadgeAt={AUCTION_BADGE}
      closeButton={false}
      attrs={{ 'data-venue': 'auction', 'data-lot': o.lot, 'data-price': String(shown) }}
    >
      <AuctionRoom
        view={view}
        map={map}
        lot={o.lot}
        level={o.level}
        seller={o.seller}
        source={o.source}
        start={o.start}
        price={shown}
        leader={o.leader}
        bidders={bidders}
        others={o.others}
        cash={o.cash}
      />
      {allowed.has(0) && (
        <TextButton
          x={START_BID.x}
          y={START_BID.y}
          w={START_BID.w}
          h={START_BID.h}
          tone="blue"
          label={t('dlg.auction.bidTo', { price: formatMoney(o.start) })}
          onClick={() => ctl.send({ type: 'BID', inc: 0 })}
          testId="auction-bid-0"
        >
          {t('dlg.auction.bidStart')}
        </TextButton>
      )}
      {BID_BUTTONS.map((b, i) => {
        const r = bidButtonRect(i);
        const frames = bidButtonFrames(i);
        if (b.k === 'pass') {
          return (
            <ClassicButton
              key="pass"
              sheet={AUCTION_SHEET}
              frames={frames}
              x={r.x}
              y={r.y}
              w={r.w}
              h={r.h}
              label={t('dlg.auction.pass')}
              onClick={() => ctl.send({ type: 'PASS' })}
              hitPad="up"
              testId="auction-pass"
            />
          );
        }
        if (b.k === 'quit') {
          return (
            <ClassicButton
              key="quit"
              sheet={AUCTION_SHEET}
              frames={frames}
              x={r.x}
              y={r.y}
              w={r.w}
              h={r.h}
              label={t('dlg.auction.quit')}
              onClick={() => ctl.send({ type: 'QUIT' })}
              hitPad="up"
              testId="auction-quit"
            />
          );
        }
        const next = nextPrice(o, b.inc);
        return (
          <ClassicButton
            key={b.inc}
            sheet={AUCTION_SHEET}
            frames={frames}
            x={r.x}
            y={r.y}
            w={r.w}
            h={r.h}
            label={`+${formatMoney(b.inc)}：${t('dlg.auction.bidTo', { price: formatMoney(next) })}`}
            onClick={() => ctl.send({ type: 'BID', inc: b.inc })}
            disabled={!allowed.has(b.inc)}
            hitPad="up"
            testId={`auction-bid-${b.inc}`}
          />
        );
      })}
      <p className={s.srOnly}>{t('dlg.auction.rule')}</p>
    </DecisionStage>
  );
}

/** 观战版的输入：公开竞价横幅（演出建立）或由待决策推出 */
export function watchState(
  banner: AuctionBannerState | null,
  pending: readonly { kind: string; seat: SeatIndex; publicInfo: { lot: LotId | null; amount: number | null } }[],
): { lot: LotId; price: number; start: number; leader: SeatIndex | null; bidderSeats: SeatIndex[] } | null {
  if (banner) {
    return {
      lot: banner.lot,
      price: banner.price,
      start: banner.start,
      leader: banner.leader?.seat ?? null,
      bidderSeats: banner.bidders.map((b) => b.seat),
    };
  }
  const asks = pending.filter((p) => p.kind === 'AUCTION_BID' && p.publicInfo.lot !== null);
  const first = asks[0];
  if (!first || first.publicInfo.lot === null) return null;
  const price = first.publicInfo.amount ?? 0;
  return { lot: first.publicInfo.lot, price, start: price, leader: null, bidderSeats: asks.map((p) => p.seat) };
}

export interface AuctionWatchSceneProps {
  view: GameView;
  map: MapIndex | null;
}

/**
 * 只读的拍卖厅（观战者、卖方、已退出或还没被问到的人）：拍卖进行中（有公开竞价横幅或 AUCTION_BID 待决策）时显示，
 * 不挡棋盘、不抢焦点；没有拍卖时不渲染。由经典布局在本人没有 AUCTION_BID 决策时挂载（见 venues/b/index.ts）。
 */
export function AuctionWatchScene({ view, map }: AuctionWatchSceneProps): ReactNode {
  const tx = useTx();
  const text = useGameText(view, map);
  const banner = usePopupStore((st) => st.auction);
  const pending = useGameStore((st) => st.pending);
  const w = watchState(banner, pending);
  if (!w) return null;
  const seller = view.lands.find((l) => l.id === w.lot)?.owner ?? null;
  const bidders: AuctionBidderView[] = banner
    ? banner.bidders.map((b) => ({ seat: b.seat, character: b.character, name: b.name, state: b.state }))
    : w.bidderSeats.map((seat) => ({
        seat,
        character: characterOf(view, seat),
        name: text.player(seat),
        state: 'active' as const,
      }));
  const st = lotStatus(view, w.lot);
  return (
    <Stage4x3
      testId="classic-auction-watch"
      label={`${tx('events:popup.auction')}：${text.lot(w.lot)}`}
      readOnly
      // 竞价中领先者与价格已写在价格牌上（状态条在舞台顶部正中，会压住价格牌标题）：只在成交 / 流拍时显示结果句
      status={banner?.result ?? undefined}
      statusTone="wait"
      backdrop="opaque"
      attrs={{ 'data-venue': 'auction', 'data-lot': w.lot }}
    >
      <AuctionRoom
        view={view}
        map={map}
        lot={w.lot}
        level={st?.level ?? 0}
        seller={seller}
        sellerName={banner?.sellerName}
        start={w.start}
        price={w.price}
        leader={w.leader}
        bidders={bidders}
      />
    </Stage4x3>
  );
}
