// 观战版拍卖厅的挂载点（original-skin.md §4.2 场所屏：拍卖；venues/b 的 ClassicAuctionWatch）：拍卖进行中（公开竞价横幅，
// 或别人有 AUCTION_BID 待决策）而本人不在竞拍（观战者、卖方、已退出的人）时，在经典舞台上叠一个只读的原版拍卖厅。
// 本人正在竞拍时不显示：竞拍者看自己的 AUCTION_BID 场景；两次重问之间决策短暂为空，用横幅里本人的状态挡住闪烁。
// 本人有任何决策时也不显示（拍卖结束后横幅还挂着成交结果，卖方已回到自己的回合菜单）。
// 素材（拍卖厅图集 + 在场玩家的 Q 版小人）按 auctionWatchKeys 判定：不可用就不挂（只剩公开竞价横幅），不半原版半程序化。
import type { MapIndex } from '@rich4/shared/data';
import type { GameView } from '@rich4/shared/view';
import { type ReactNode, Suspense, useEffect, useMemo, useState } from 'react';
import { useGameStore } from '../../store/gameStore';
import { usePopupStore } from '../popups/popupStore';
import { useClassicAssets } from './assets';
import { prepareSceneKeys, sceneKeysStatus, scenePackClient } from './common/sceneAssets';
import { auctionWatchKeys, ClassicAuctionWatch } from './venues/b';

export interface AuctionWatchMountProps {
  view: GameView;
  map: MapIndex | null;
  /** 本人座位（观战者为 null） */
  me: number | null;
}

/** 此刻是否应该显示观战版拍卖厅（纯函数，便于测试） */
export function auctionWatchActive(i: {
  me: number | null;
  decisionKind: string | null;
  banner: { bidders: readonly { seat: number; state: string }[] } | null;
  asking: boolean;
}): boolean {
  if (i.banner === null && !i.asking) return false;
  // 本人有决策（竞拍者的 AUCTION_BID；拍卖结束后横幅还挂着成交结果时，卖方回到自己的回合菜单）→ 让位给决策场景
  if (i.decisionKind !== null) return false;
  if (i.me !== null && i.banner?.bidders.some((b) => b.seat === i.me && b.state === 'active')) return false;
  return true;
}

export function AuctionWatchMount({ view, map, me }: AuctionWatchMountProps): ReactNode {
  const decisionKind = useGameStore((s) => s.decision?.kind ?? null);
  const asking = useGameStore((s) => s.pending.some((p) => p.kind === 'AUCTION_BID'));
  const banner = usePopupStore((s) => s.auction);
  const packId = useClassicAssets((s) => s.packId);
  const active = auctionWatchActive({ me, decisionKind, banner, asking });
  const charKey = view.players
    .filter((p) => p.alive)
    .map((p) => p.character)
    .join(',');
  const keys = useMemo(() => auctionWatchKeys(charKey === '' ? [] : charKey.split(',').map(Number)), [charKey]);
  const [ready, setReady] = useState<string | null>(null);
  const want = `${packId ?? ''}|${keys.join(',')}`;

  useEffect(() => {
    if (!active || packId === null || ready === want) return;
    const client = scenePackClient();
    const st = sceneKeysStatus(keys, client);
    if (st === 'ready') {
      setReady(want);
      return;
    }
    if (st === 'missing') return;
    let live = true;
    prepareSceneKeys(keys, client).then(
      (ok) => {
        if (live && ok) setReady(want);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [active, packId, keys, want, ready]);

  if (!active || ready !== want) return null;
  return (
    <Suspense fallback={null}>
      <ClassicAuctionWatch view={view} map={map} />
    </Suspense>
  );
}
