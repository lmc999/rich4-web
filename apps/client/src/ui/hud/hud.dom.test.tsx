// HUD（design/client.md §5.1、§12.1 dom）：玩家条数值、行动区掷骰、等待条、决策层（动画播完才出现）、断线遮罩、终局。
// Pixi 不在 jsdom 挂载：BoardCanvas 用替身。
import type { YourDecision } from '@rich4/shared/net';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientProvider } from '../../app/services';
import { useConnectionStore } from '../../store/connectionStore';
import { useGameStore } from '../../store/gameStore';
import { useMapStore } from '../../store/mapStore';
import { useUiStore } from '../../store/uiStore';
import { makeTestClient } from '../../test/fakeTransport';
import { ai, human, roomView } from '../../test/roomFixtures';
import { selfPlay } from '../../test/selfPlay';
import GameScreen from '../screens/GameScreen';
import { ReconnectOverlay } from '../system/ReconnectOverlay';
import { Toasts } from './Overlays';

vi.mock('../screens/BoardCanvas', () => ({
  BoardCanvas: () => <div data-testid="board-host">board</div>,
}));

const room = roomView({
  phase: 'playing',
  epoch: 1,
  seats: [human(0, '我', { isYou: true, host: true }), ai(1), human(2, '小红'), ai(3)],
});

const sp = selfPlay({ seed: 21, steps: 60 });

function renderGame() {
  const t = makeTestClient();
  const utils = render(
    <ClientProvider client={t.client}>
      <GameScreen room={room} onLeave={() => {}} />
      <Toasts />
    </ClientProvider>,
  );
  return { ...utils, ...t };
}

beforeEach(() => {
  useMapStore.getState().clear();
});

afterEach(() => {
  useGameStore.getState().clear();
  useUiStore.getState().clear();
  useConnectionStore.getState().reset();
});

describe('GameScreen HUD', () => {
  it('玩家条：四个座位的现金 / 存款 / 点券带 data-testid 与精确数值；轮次高亮', async () => {
    const b = sp.batches[10]!;
    act(() =>
      useGameStore.getState().resetTo({ epoch: 1, seq: b.seq, view: b.view, pending: b.pending, decision: null }),
    );
    renderGame();
    for (const p of b.view.players) {
      expect(screen.getByTestId(`p${p.seat}-cash`)).toHaveAttribute('data-value', String(p.cash));
      expect(screen.getByTestId(`p${p.seat}-deposit`)).toHaveAttribute('data-value', String(p.deposit));
      expect(screen.getByTestId(`p${p.seat}-points`)).toHaveAttribute('data-value', String(p.points));
    }
    const cur = b.view.clock.cursor;
    if (cur.t === 'seat') expect(screen.getByTestId(`chip-${cur.seat}`)).toHaveAttribute('data-current', 'true');
    expect(screen.getByTestId('hud-date')).toHaveAttribute('data-date', String(b.view.clock.date));
    expect(screen.getByTestId('hud-turn')).toHaveTextContent(`第 ${b.view.clock.turnNo} 回合`);
    // 地图加载后小地图与归属列表出现（fixture 回退）
    const lots = await screen.findByTestId('hud-lots');
    expect(within(lots).getAllByRole('listitem').length).toBe(b.view.lands.length + b.view.facilities.length);
  });

  it('行动区：我的 TURN_MENU 就绪时可掷骰（带骰子数）；提交后锁定', async () => {
    const i = sp.batches.findIndex((x) => x.yourDecision?.kind === 'TURN_MENU');
    const b = sp.batches[i]!;
    const decision = b.yourDecision as YourDecision;
    act(() => useGameStore.getState().resetTo({ epoch: 1, seq: b.seq, view: b.view, pending: b.pending, decision }));
    const { transport } = renderGame();
    const roll = screen.getByTestId('action-roll');
    expect(roll).toBeEnabled();
    await userEvent.click(roll);
    const sent = transport.payloads('game:act')[0]!;
    expect(sent.decisionId).toBe(decision.decisionId);
    expect(sent.intent.type).toBe('ROLL');
    await waitFor(() => expect(screen.getByTestId('action-roll')).toBeDisabled());
  });

  it('不是我的决策：掷骰按钮禁用，等待条显示「等待 X …」与倒计时', () => {
    const b = sp.batches.find((x) => x.pending[0] && x.pending[0].seat !== 0)!;
    const pending = [{ ...b.pending[0]!, deadlineAt: Date.now() + 12_000 }];
    act(() => useGameStore.getState().resetTo({ epoch: 1, seq: b.seq, view: b.view, pending, decision: null }));
    renderGame();
    expect(screen.getByTestId('action-roll')).toBeDisabled();
    const w = screen.getByTestId('waiting-banner');
    expect(w).toHaveAttribute('data-seat', String(pending[0]!.seat));
    expect(w.textContent).toMatch(/1[12] 秒/);
  });

  it('决策层：BUY_LAND 由对话框组件渲染，点「购买」发 CONFIRM', async () => {
    const b = sp.batches.find((x) => x.yourDecision?.kind === 'BUY_LAND');
    const base = b ?? sp.batches[0]!;
    const decision: YourDecision = b?.yourDecision ?? {
      decisionId: 'd999',
      seat: 0,
      kind: 'BUY_LAND',
      timing: 'confirm',
      options: {
        lot: 'L1',
        price: 2000,
        cash: 200000,
        level: 0,
        street: { lots: ['L1', 'L2', 'L3'], owners: [null, null, null] },
        tollAfter: 400,
        fortuneBonus: false,
      },
      defaultIntent: { type: 'DECLINE' },
      deadlineAt: null,
    };
    act(() =>
      useGameStore.getState().resetTo({ epoch: 1, seq: base.seq, view: base.view, pending: base.pending, decision }),
    );
    const { transport } = renderGame();
    const layer = await screen.findByTestId('decision-layer');
    expect(layer).toHaveAttribute('data-kind', 'BUY_LAND');
    await userEvent.click(await screen.findByTestId('buy-confirm'));
    expect(transport.payloads('game:act')[0]).toMatchObject({
      decisionId: decision.decisionId,
      intent: { type: 'CONFIRM' },
    });
  });

  it('TURN_MENU 的完整回合菜单只在点「卡片 / 道具 / 股票」后展开', async () => {
    const b = sp.batches.find((x) => x.yourDecision?.kind === 'TURN_MENU')!;
    act(() =>
      useGameStore
        .getState()
        .resetTo({ epoch: 1, seq: b.seq, view: b.view, pending: b.pending, decision: b.yourDecision as YourDecision }),
    );
    renderGame();
    expect(screen.queryByTestId('decision-layer')).toBeNull();
    await userEvent.click(screen.getByTestId('action-cards'));
    expect(await screen.findByTestId('decision-layer')).toHaveAttribute('data-kind', 'TURN_MENU');
    await userEvent.click(screen.getByTestId('decision-collapse'));
    expect(screen.queryByTestId('decision-layer')).toBeNull();
  });

  it('本人回合点「股票」：展开回合菜单并直接打开股市子页', async () => {
    const b = sp.batches.find((x) => x.yourDecision?.kind === 'TURN_MENU')!;
    act(() =>
      useGameStore
        .getState()
        .resetTo({ epoch: 1, seq: b.seq, view: b.view, pending: b.pending, decision: b.yourDecision as YourDecision }),
    );
    renderGame();
    await userEvent.click(screen.getByTestId('action-stock'));
    expect(await screen.findByTestId('decision-layer')).toHaveAttribute('data-kind', 'TURN_MENU');
    const sheet = await screen.findByTestId('turn-stock-sheet');
    expect(useUiStore.getState().menuSheet).toBeNull();
    // 经快捷入口打开的子页关掉后整个回合菜单收起，回到棋盘
    await userEvent.click(within(sheet).getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(screen.queryByTestId('decision-layer')).toBeNull());
  });

  it('非本人回合点「查看」打开玩家与地产面板', async () => {
    const b = sp.batches[5]!;
    act(() =>
      useGameStore.getState().resetTo({ epoch: 1, seq: b.seq, view: b.view, pending: b.pending, decision: null }),
    );
    renderGame();
    await screen.findByTestId('hud-lots');
    await userEvent.click(screen.getByTestId('action-info'));
    expect(await screen.findByTestId('panel-info')).toBeInTheDocument();
  });

  it('终局面板在动画播完后出现，房主可「再来一局」', async () => {
    const b = sp.batches[3]!;
    act(() => {
      useGameStore.getState().resetTo({ epoch: 1, seq: b.seq, view: b.view, pending: [], decision: null });
      useGameStore.getState().setOver({
        epoch: 1,
        result: { reason: 'timeLimit', code: 2, winner: 0, date: 20050601, elapsedDays: 30, ranking: [] },
        ranking: b.view.players.map((p) => ({ seat: p.seat, netWorth: p.cash })),
      });
    });
    const { transport } = renderGame();
    expect(screen.getByTestId('game-over')).toHaveTextContent('游戏结束');
    await userEvent.click(screen.getByTestId('over-rematch'));
    expect(transport.payloads('room:rematch')).toHaveLength(1);
  });
});

describe('ReconnectOverlay', () => {
  it('断线 1 秒后出现，恢复后消失；被顶替时提示接管', async () => {
    const t = makeTestClient();
    render(
      <ClientProvider client={t.client}>
        <ReconnectOverlay />
      </ClientProvider>,
    );
    act(() => useConnectionStore.getState().setStatus('reconnecting', 2));
    expect(screen.queryByTestId('reconnect-overlay')).toBeNull();
    expect(await screen.findByTestId('reconnect-overlay', {}, { timeout: 2000 })).toHaveTextContent('第 2 次');
    act(() => useConnectionStore.getState().setStatus('open', 0));
    await waitFor(() => expect(screen.queryByTestId('reconnect-overlay')).toBeNull());
    act(() => useConnectionStore.getState().setReplaced(true));
    await userEvent.click(screen.getByTestId('replaced-reclaim'));
    expect(useConnectionStore.getState().replaced).toBe(false);
  });

  it('首页 / 单机页挂 essentialOnly：被顶替时提示接管，普通断线不挡操作', async () => {
    const t = makeTestClient();
    render(
      <ClientProvider client={t.client}>
        <ReconnectOverlay essentialOnly />
      </ClientProvider>,
    );
    act(() => useConnectionStore.getState().setStatus('closed', 0));
    await new Promise((r) => setTimeout(r, 1200));
    expect(screen.queryByTestId('reconnect-overlay')).toBeNull();
    act(() => useConnectionStore.getState().setReplaced(true));
    expect(screen.getByTestId('replaced-overlay')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('replaced-reclaim'));
    expect(useConnectionStore.getState().replaced).toBe(false);
  });
});

describe('Toasts', () => {
  it('每条 toast 从出现起计时：新 toast 到来或别的 toast 被关掉都不会让它续期', () => {
    vi.useFakeTimers();
    try {
      render(<Toasts />);
      const ui = useUiStore.getState();
      act(() => {
        ui.toast('A', 'info', 3200);
      });
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      act(() => {
        ui.toast('B', 'info', 3200);
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(screen.getAllByTestId('toast').map((x) => x.textContent)).toEqual(['B×']);
      // t=3300 出现 C；t=5000 手动关掉 B；C 仍在 t=6500 到期
      act(() => {
        ui.toast('C', 'info', 3200);
      });
      act(() => {
        vi.advanceTimersByTime(1700);
      });
      act(() => {
        ui.dismissToast(useUiStore.getState().toasts[0]!.id);
      });
      expect(screen.getAllByTestId('toast').map((x) => x.textContent)).toEqual(['C×']);
      act(() => {
        vi.advanceTimersByTime(1450);
      });
      expect(screen.getAllByTestId('toast').map((x) => x.textContent)).toEqual(['C×']);
      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(screen.queryAllByTestId('toast')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
