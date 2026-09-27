// 观战版拍卖厅的挂载判定（AuctionWatch.tsx）：本人不在竞拍、拍卖进行中、素材就绪才显示；缺素材不挂。
import { fixtureRegistry } from '@rich4/shared/data';
import { scenario } from '@rich4/shared/engine-testing';
import { projectState } from '@rich4/shared/view';
import { act, render, screen } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resetSkinStoreForTest } from '../../skin/skinStore';
import { useGameStore } from '../../store/gameStore';
import { installResizeObserver } from '../decisions/testing';
import { usePopupStore } from '../popups/popupStore';
import { AuctionWatchMount, auctionWatchActive } from './AuctionWatch';
import { resetClassicAssetsForTest } from './assets';
import { fakePackClient, installSceneAssets } from './common/testing';
import { fakeVenueBSheets, venueBKeys } from './venues/b/testing';

installResizeObserver();

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});
afterAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});
afterEach(() => {
  resetClassicAssetsForTest();
  resetSkinStoreForTest();
  usePopupStore.getState().clear();
  useGameStore.getState().clear();
});

const banner = (bidders: { seat: number; state: 'active' | 'passed' | 'quit' }[]) => ({ bidders });

describe('auctionWatchActive', () => {
  it('没有拍卖不显示；本人有决策（竞拍或回到回合菜单）或在横幅里仍在竞拍时不显示', () => {
    expect(auctionWatchActive({ me: 0, decisionKind: null, banner: null, asking: false })).toBe(false);
    expect(auctionWatchActive({ me: 0, decisionKind: null, banner: null, asking: true })).toBe(true);
    expect(auctionWatchActive({ me: 1, decisionKind: 'AUCTION_BID', banner: null, asking: true })).toBe(false);
    const b = banner([
      { seat: 1, state: 'active' },
      { seat: 2, state: 'quit' },
    ]);
    expect(auctionWatchActive({ me: 1, decisionKind: null, banner: b, asking: false })).toBe(false);
    expect(auctionWatchActive({ me: 2, decisionKind: null, banner: b, asking: false })).toBe(true);
    expect(auctionWatchActive({ me: 0, decisionKind: 'TURN_MENU', banner: b, asking: false })).toBe(false);
    expect(auctionWatchActive({ me: 0, decisionKind: null, banner: b, asking: false })).toBe(true);
    expect(auctionWatchActive({ me: null, decisionKind: null, banner: b, asking: false })).toBe(true);
  });
});

describe('AuctionWatchMount', () => {
  function setup(usable: string[]) {
    const sc = scenario({ players: ['human', 'human', 'human'] }).untilMenu(0);
    const view = projectState(sc.state, { kind: 'spectator' }, { handVisibility: 'public' });
    const map = fixtureRegistry.getMap(sc.state.dataRef.mapId);
    resetSkinStoreForTest({ client: fakePackClient(usable) });
    installSceneAssets({ sprites: fakeVenueBSheets() });
    render(<AuctionWatchMount view={view} map={map} me={null} />);
    return view;
  }

  function startAuction(view: ReturnType<typeof setup>): void {
    act(() =>
      usePopupStore.getState().setAuction({
        lot: 'L1',
        lotName: 'L1',
        sellerName: null,
        start: 1000,
        price: 1200,
        leader: null,
        bidders: [{ seat: 1, character: view.players[1]!.character, name: 'P2', state: 'active' }],
        result: null,
        tick: 0,
      }),
    );
  }

  it('观战者：拍卖开始后出现只读拍卖厅，结束后收起', async () => {
    const view = setup(venueBKeys());
    expect(screen.queryByTestId('classic-auction-watch')).toBeNull();
    startAuction(view);
    const w = await screen.findByTestId('classic-auction-watch');
    expect(w).toHaveAttribute('data-readonly', 'true');
    act(() => usePopupStore.getState().setAuction(null));
    expect(screen.queryByTestId('classic-auction-watch')).toBeNull();
  });

  it('缺 Q 版小人素材：不挂原版拍卖厅（只剩公开竞价横幅）', async () => {
    const view = setup(venueBKeys().filter((k) => !k.startsWith('venue.chibi.')));
    startAuction(view);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.queryByTestId('classic-auction-watch')).toBeNull();
  });
});
