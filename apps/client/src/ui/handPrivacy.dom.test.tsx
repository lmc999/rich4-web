// 联机时（私密手牌模式）别人的卡片与道具不公开：两种皮肤里查看别人的界面只显示张数与总数
// （原版资产表 AssetSheet、程序化 InventoryPanel / PlayerInfoPanel、资料栏「其他」页、等待条、日志文案）。
// 视图按服务器的真实投影（shared projectState）从公开视图改写：他人的 cards / items 为 null，pools 为 null。
import type { GameEvent, SeatIndex } from '@rich4/shared/engine';
import type { GameView, PendingView } from '@rich4/shared/view';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initI18n } from '../i18n';
import { tx } from '../i18n/tx';
import { formatEvent } from '../presentation/logFormat';
import { makeNames } from '../presentation/names';
import { resetSkinStoreForTest } from '../skin/skinStore';
import { useGameStore } from '../store/gameStore';
import { human, roomView } from '../test/roomFixtures';
import { resetClassicAssetsForTest } from './classic/assets';
import { installSceneAssets } from './classic/common/testing';
import { a11FakeSheets, a11PackClient } from './classic/dialogs/testing';
import { AssetSheet } from './classic/popups/AssetSheet';
import { profileNumbers, profileRows } from './classic/profileStats';
import { fixture, installResizeObserver } from './decisions/testing';
import { WaitingBanner, waitingActionKey } from './hud/WaitingBanner';
import { InventoryPanel } from './panels/InventoryPanel';
import { PlayerInfoPanel, summarizePlayer } from './panels/PlayerInfoPanel';

installResizeObserver();

beforeAll(() => {
  initI18n('original');
});

/** 与服务器 private 投影相同的改写：me 以外的座位只剩张数与总数 */
function hideHands(view: GameView, me: SeatIndex | null): GameView {
  return {
    ...view,
    pools: null,
    players: view.players.map((p) => (p.seat === me ? p : { ...p, cards: null, items: null })),
  };
}

describe('程序化皮肤', () => {
  it('InventoryPanel 查看别人：卡片与道具都只显示总数，不出现任何卡片 / 道具格；看自己照常', () => {
    const fx = fixture();
    const p0 = fx.view.players.find((p) => p.seat === 0)!;
    expect(p0.cardCount).toBeGreaterThan(0);
    expect(p0.itemCount).toBeGreaterThan(0);
    const view = hideHands(fx.view, 1);
    const { unmount } = render(<InventoryPanel view={view} map={fx.map} seat={0} tab="cards" />);
    expect(screen.getByTestId('inv-cards-hidden')).toHaveTextContent(`手牌不公开（${p0.cardCount} 张）`);
    expect(screen.queryAllByTestId(/^inv-card-/)).toHaveLength(0);
    unmount();
    render(<InventoryPanel view={view} map={fx.map} seat={0} tab="items" />);
    expect(screen.getByTestId('inv-items-hidden')).toHaveTextContent(`道具不公开（${p0.itemCount} 个）`);
    expect(screen.queryAllByTestId(/^inv-item-/)).toHaveLength(0);
    cleanup();
    // 本人（座位 1 看座位 1）照常显示
    const p1 = view.players.find((p) => p.seat === 1)!;
    render(<InventoryPanel view={view} map={fx.map} seat={1} tab="items" />);
    expect(screen.queryByTestId('inv-items-hidden')).toBeNull();
    const held = (p1.items ?? []).filter((n) => n > 0).length;
    expect(screen.queryAllByTestId(/^inv-item-/)).toHaveLength(held);
  });

  it('PlayerInfoPanel：别人的道具数用公开的 itemCount', () => {
    const fx = fixture();
    const view = hideHands(fx.view, 1);
    const p0 = view.players.find((p) => p.seat === 0)!;
    expect(summarizePlayer(view, fx.map, 0)).toMatchObject({ cardCount: p0.cardCount, itemCount: p0.itemCount });
    render(<PlayerInfoPanel view={view} map={fx.map} seat={0} />);
    expect(screen.getByText(`道具 ${p0.itemCount} 个`)).toBeInTheDocument();
  });

  it('等待条：别人在考虑免费卡 / 嫁祸卡时，手牌不公开就只说「做决定」', () => {
    const fx = fixture();
    const room = roomView({
      phase: 'playing',
      seats: [human(0, '甲'), human(1, '我', { isYou: true }), human(2, '乙'), human(3, '丙')],
      you: { role: 'player', seat: 1, isHost: false },
    });
    const pending = (kind: PendingView['kind']): PendingView[] => [
      {
        decisionId: 'd9',
        seat: 0,
        kind,
        timing: 'confirm',
        deadlineAt: null,
        control: 'human',
        publicInfo: { kind, seat: 0, lot: null, amount: 3000, labelKey: null },
      } as PendingView,
    ];
    act(() =>
      useGameStore
        .getState()
        .resetTo({ epoch: 1, seq: 1, view: hideHands(fx.view, 1), pending: pending('USE_FREE_CARD'), decision: null }),
    );
    const { rerender } = render(<WaitingBanner view={hideHands(fx.view, 1)} room={room} map={fx.map} />);
    const w = screen.getByTestId('waiting-banner');
    expect(w).toHaveTextContent('做决定');
    expect(w.textContent).not.toMatch(/免费卡/);
    // 公开手牌（单机）照原样说出决策种类
    rerender(<WaitingBanner view={fx.view} room={room} map={fx.map} />);
    expect(screen.getByTestId('waiting-banner')).toHaveTextContent('考虑使用免费卡');
    expect(waitingActionKey('SCAPEGOAT', true)).toBe('hud:waiting.decide');
    expect(waitingActionKey('SCAPEGOAT', false)).toBe('hud:waiting.kind.SCAPEGOAT');
    expect(waitingActionKey('BUY_LAND', true)).toBe('hud:waiting.kind.BUY_LAND');
    act(() => useGameStore.getState().clear());
  });

  it('日志：别人的道具得失只写「道具」与数量', () => {
    const fx = fixture();
    const names = makeNames({ t: tx, view: () => fx.view, map: () => fx.map });
    const e: GameEvent = { type: 'ITEM_GAINED', seat: 0, item: null, qty: 2, source: 'shop' };
    const line = formatEvent(e, names)!;
    expect(line).toContain('道具 ×2');
    expect(line).not.toMatch(/道具#|null|undefined/);
    const lost: GameEvent = { type: 'ITEM_LOST', seat: 0, item: null, qty: 1, cause: 'robbed' };
    expect(formatEvent(lost, names)).toContain('道具 ×1');
  });
});

describe('原版皮肤', () => {
  beforeEach(() => {
    installSceneAssets({ sprites: a11FakeSheets() });
    resetSkinStoreForTest({ client: a11PackClient() });
  });
  afterEach(() => {
    cleanup();
    resetClassicAssetsForTest();
    resetSkinStoreForTest();
  });

  it('资产表查看别人：没有道具格与卡片格，「道具 / 卡片」栏是公开的总数；看自己照常', () => {
    const fx = fixture();
    const view = hideHands(fx.view, 1);
    const p0 = view.players.find((p) => p.seat === 0)!;
    const { unmount } = render(<AssetSheet view={view} map={fx.map} seat={0} onClose={() => {}} />);
    const sheet = screen.getByTestId('classic-assets');
    expect(sheet).toHaveAttribute('data-seat', '0');
    expect(within(sheet).queryAllByTestId(/^assets-item-\d+$/)).toHaveLength(0);
    expect(within(sheet).queryAllByTestId(/^assets-card-\d+$/)).toHaveLength(0);
    expect(within(sheet).getByTestId('assets-items')).toHaveAttribute('data-value', String(p0.itemCount));
    expect(within(sheet).getByTestId('assets-cards')).toHaveAttribute('data-value', String(p0.cardCount));
    unmount();
    const p1 = view.players.find((p) => p.seat === 1)!;
    render(<AssetSheet view={view} map={fx.map} seat={1} onClose={() => {}} />);
    const mine = screen.getByTestId('classic-assets');
    expect(within(mine).queryAllByTestId(/^assets-card-\d+$/)).toHaveLength(p1.cardCount);
    expect(within(mine).queryAllByTestId(/^assets-item-\d+$/)).toHaveLength(
      (p1.items ?? []).filter((n) => n > 0).length,
    );
  });

  it('资料栏「其他」页：卡片 / 道具数对别人照常显示（张数与总数公开）', () => {
    const fx = fixture();
    const view = hideHands(fx.view, 1);
    const p0 = view.players.find((p) => p.seat === 0)!;
    const n = profileNumbers(view, fx.map, 0)!;
    expect(n.items).toBe(p0.itemCount);
    expect(profileRows('other', n)[2]!.value).toBe(`${p0.cardCount}/${p0.itemCount}`);
  });
});
