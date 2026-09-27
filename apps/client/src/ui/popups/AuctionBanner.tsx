// 公开竞价横幅（与 AuctionDialog 协作）：出价者在对话框里出价，所有人（含观战者）在顶部看到拍卖标的、现价、
// 领先者与各竞拍者的状态；结束时显示成交 / 流拍一句话。演出被跳过（reset / 后台）时按对局状态自动收起。
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { useTx } from '../../i18n/tx';
import { formatMoney } from '../../presentation/names';
import { useGameStore } from '../../store/gameStore';
import { Avatar } from '../common/Avatar';
import { type AuctionBannerState, usePopupStore } from './popupStore';
import s from './popups.module.css';

export function AuctionBannerView({ a }: { a: AuctionBannerState }): ReactNode {
  const t = useTx();
  return (
    <div className={s.auction} role="status" aria-live="polite" data-testid="auction-banner" data-lot={a.lot}>
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
            {a.leader ? t('events:popup.auctionLeader', { who: a.leader.name }) : t('events:popup.auctionNoBid')}
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

export function AuctionBanner(): ReactNode {
  const a = usePopupStore((st) => st.auction);
  const live = useGameStore((st) => st.anim.playing || st.pending.some((p) => p.kind === 'AUCTION_BID'));
  // 结束事件被跳过（后台、reset）时横幅会残留：动画已停且没有拍卖决策就收起
  useEffect(() => {
    if (a && !live) usePopupStore.getState().setAuction(null);
  }, [a, live]);
  if (!a || !live) return null;
  return <AuctionBannerView a={a} />;
}
