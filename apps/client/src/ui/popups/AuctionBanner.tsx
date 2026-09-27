// 公开竞价横幅（与 AuctionDialog 协作）：出价者在对话框里出价，所有人（含观战者）在顶部看到拍卖标的、现价、
// 领先者与各竞拍者的状态；结束时显示成交 / 流拍一句话。演出被跳过（reset / 后台）时按对局状态自动收起；
// 没有演出建立横幅时（后台标签页、instant、刷新）按待决策补一条（derivedAuction）。
import type { MapIndex } from '@rich4/shared/data';
import type { GameView, PendingView } from '@rich4/shared/view';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { uiLanguage } from '../../i18n';
import { useTx } from '../../i18n/tx';
import { formatMoney, makeNames, type NameKit } from '../../presentation/names';
import { useGameStore } from '../../store/gameStore';
import { Avatar } from '../common/Avatar';
import { type AuctionBannerState, usePopupStore } from './popupStore';
import s from './popups.module.css';

export function AuctionBannerView({ a }: { a: AuctionBannerState }): ReactNode {
  const t = useTx();
  return (
    <div
      className={s.auction}
      role="status"
      aria-live="polite"
      data-testid="auction-banner"
      data-lot={a.lot}
      data-derived={a.derived ? 'true' : undefined}
    >
      <strong>🔨 {t('events:popup.auction')}</strong>
      <span>{a.lotName}</span>
      {a.result ? (
        <span data-testid="auction-result">{a.result}</span>
      ) : (
        <>
          <span key={a.tick} className={s.auctionPrice} data-tick={a.tick} data-testid="auction-price">
            {formatMoney(a.price)}
          </span>
          <span>
            {a.leader
              ? t('events:popup.auctionLeader', { who: a.leader.name })
              : t(a.derived ? 'events:popup.auctionLive' : 'events:popup.auctionNoBid')}
          </span>
          <span className={s.bidders}>
            {a.bidders.map((b) => (
              <span
                key={b.seat}
                className={s.bidder}
                data-state={b.state}
                title={b.state === 'active' ? b.name : `${b.name} · ${t(`events:popup.bidder.${b.state}`)}`}
              >
                <Avatar character={b.character} size={22} seat={b.seat} />
              </span>
            ))}
          </span>
        </>
      )}
    </div>
  );
}

/**
 * 从待决策推出的竞价横幅（没有经过演出的情况：后台标签页、?anim=instant、积压跳过、中途进房或刷新）：
 * 标的与现价取 AUCTION_BID 的 publicInfo，竞拍者为当前被问的座位；领先者未知时不显示。
 */
export function derivedAuction(
  pending: readonly PendingView[],
  view: GameView | null,
  names: Pick<NameKit, 'lot' | 'seat'>,
): AuctionBannerState | null {
  const asks = pending.filter((p) => p.kind === 'AUCTION_BID' && p.publicInfo.lot !== null);
  const first = asks[0];
  if (!first || !view || first.publicInfo.lot === null) return null;
  const lot = first.publicInfo.lot;
  const price = first.publicInfo.amount ?? 0;
  const bidders: AuctionBannerState['bidders'] = [];
  for (const p of asks) {
    const pl = view.players.find((x) => x.seat === p.seat);
    if (pl) bidders.push({ seat: p.seat, character: pl.character, name: names.seat(p.seat), state: 'active' });
  }
  return {
    lot,
    lotName: names.lot(lot),
    sellerName: null,
    start: price,
    price,
    leader: null,
    bidders,
    result: null,
    tick: 0,
    derived: true,
  };
}

export function AuctionBanner({ map = null }: { map?: MapIndex | null }): ReactNode {
  const t = useTx();
  const a = usePopupStore((st) => st.auction);
  const pending = useGameStore((st) => st.pending);
  const view = useGameStore((st) => st.view);
  const playing = useGameStore((st) => st.anim.playing);
  const live = playing || pending.some((p) => p.kind === 'AUCTION_BID');
  // 结束事件被跳过（后台、reset）时横幅会残留：动画已停且没有拍卖决策就收起
  useEffect(() => {
    if (a && !live) usePopupStore.getState().setAuction(null);
  }, [a, live]);
  if (a && live) return <AuctionBannerView a={a} />;
  // 演出没有建立横幅（后台标签页、instant、跳过、刷新）：按待决策补一条
  if (!a && !playing) {
    const d = derivedAuction(pending, view, makeNames({ t, view: () => view, map: () => map, lang: uiLanguage }));
    if (d) return <AuctionBannerView a={d} />;
  }
  return null;
}
