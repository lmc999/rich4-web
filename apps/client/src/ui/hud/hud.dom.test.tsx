// HUD（design/client.md §5.1、§12.1 dom）：玩家条数值、行动区掷骰、等待条、决策层（动画播完才出现）、断线遮罩、终局。
// Pixi 不在 jsdom 挂载：BoardCanvas 用替身。
import type { YourDecision } from '@rich4/shared/net';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { useTrusteeDialog } from '../system/TrusteeSettings';
import { AUTOPILOT_LONG_PRESS_MS } from './ActionPad';
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
  useTrusteeDialog.getState().setOpen(false);
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

  it('行动区：选过的颗数在同一回合里跨决策保留（菜单操作后引擎换 decisionId 重发 TURN_MENU），换车后作废', async () => {
    const i = sp.batches.findIndex((x) => x.yourDecision?.kind === 'TURN_MENU');
    const b = sp.batches[i]!;
    const menu = (id: string, allowed: (1 | 2 | 3)[], current: 1 | 2 | 3): YourDecision => {
      const d = structuredClone(b.yourDecision!) as YourDecision & { options: { dice: unknown } };
      d.decisionId = id;
      d.options.dice = { allowed, current, locked: null };
      return d;
    };
    const load = (d: YourDecision) =>
      act(() => useGameStore.getState().resetTo({ epoch: 1, seq: b.seq, view: b.view, pending: [], decision: d }));
    load(menu('d4', [1, 2, 3], 3));
    const { transport } = renderGame();
    expect(screen.getByTestId('action-dice-3')).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByTestId('action-dice-1'));
    expect(screen.getByTestId('action-dice-1')).toHaveAttribute('aria-pressed', 'true');
    // 用道具 / 买股票之后的新 TURN_MENU（current 仍为 3）：仍是 1 颗
    load(menu('d5', [1, 2, 3], 3));
    expect(screen.getByTestId('action-dice-1')).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByTestId('action-roll'));
    const sent = transport.payloads('game:act')[0]!;
    expect([sent.decisionId, sent.intent]).toEqual(['d5', { type: 'ROLL', dice: 1 }]);
    // 换成机车（上限 2、current 2）：新上限取代旧的选择
    load(menu('d6', [1, 2], 2));
    expect(screen.getByTestId('action-dice-2')).toHaveAttribute('aria-pressed', 'true');
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

  it('本人回合点「更多」：展开完整回合菜单（公布栏、投降入口）；点「公布栏」直接打开公布栏子页', async () => {
    const b = sp.batches.find((x) => x.yourDecision?.kind === 'TURN_MENU')!;
    act(() =>
      useGameStore
        .getState()
        .resetTo({ epoch: 1, seq: b.seq, view: b.view, pending: b.pending, decision: b.yourDecision as YourDecision }),
    );
    renderGame();
    await userEvent.click(screen.getByTestId('action-menu'));
    expect(await screen.findByTestId('decision-layer')).toHaveAttribute('data-kind', 'TURN_MENU');
    expect(await screen.findByTestId('turn-board')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('decision-collapse'));
    await waitFor(() => expect(screen.queryByTestId('decision-layer')).toBeNull());
    await userEvent.click(screen.getByTestId('action-board'));
    expect(await screen.findByTestId('turn-board-sheet')).toBeInTheDocument();
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

  it('终局面板用 GameOverScreen：按排名列出每人的资产构成（现金 / 存款 / 股票 / 地产，贷款另列）', async () => {
    const b = sp.batches[3]!;
    const view = {
      ...b.view,
      players: b.view.players.map((p) => (p.seat === 1 ? { ...p, loan: 5000, alive: false } : p)),
    };
    const ranking = [...view.players]
      .map((p) => ({ seat: p.seat, netWorth: p.cash + p.deposit - p.loan + 1000 * (p.seat + 1), alive: p.alive }))
      .sort((x, y) => y.netWorth - x.netWorth);
    act(() => {
      useGameStore.getState().resetTo({ epoch: 1, seq: b.seq, view, pending: [], decision: null });
      useGameStore.getState().setOver({
        epoch: 1,
        result: { reason: 'wealthTarget', code: 2, winner: ranking[0]!.seat, date: 20050601, elapsedDays: 30, ranking },
        ranking: ranking.map(({ seat, netWorth }) => ({ seat, netWorth })),
      });
    });
    const { transport } = renderGame();
    const over = screen.getByTestId('game-over');
    const scr = within(over).getByTestId('game-over-screen');
    expect(scr).toHaveTextContent('游戏结束');
    expect(scr).toHaveTextContent('资产达到目标');
    // 排名与 result.ranking 一致，每行都有资产构成条（aria-label 列出各项金额）
    ranking.forEach((r, i) => {
      const row = within(scr).getByTestId(`over-rank-${i + 1}`);
      expect(row).toHaveAttribute('data-seat', String(r.seat));
      const parts = within(row).getByTestId(`over-parts-${r.seat}`);
      const p = view.players.find((x) => x.seat === r.seat)!;
      expect(parts.getAttribute('aria-label')).toContain(`现金 ${p.cash.toLocaleString('en-US')}`);
      expect(parts.getAttribute('aria-label')).toContain('地产');
    });
    // 贷款另列；出局者标出
    const loanRow = within(scr).getByTestId(`over-parts-1`);
    expect(loanRow.getAttribute('aria-label')).toContain('-5,000');
    // 结算后的操作仍在：离开与再来一局（房主）
    await userEvent.click(within(over).getByTestId('over-rematch'));
    expect(transport.payloads('room:rematch')).toHaveLength(1);
    expect(within(over).getByTestId('over-leave')).toBeInTheDocument();
  });

  it('game:over 的 result.ranking 为空时退回消息里的排名', () => {
    const b = sp.batches[3]!;
    act(() => {
      useGameStore.getState().resetTo({ epoch: 1, seq: b.seq, view: b.view, pending: [], decision: null });
      useGameStore.getState().setOver({
        epoch: 1,
        result: { reason: 'timeLimit', code: 2, winner: null, date: 20050601, elapsedDays: 30, ranking: [] },
        ranking: b.view.players.map((p) => ({ seat: p.seat, netWorth: p.cash })),
      });
    });
    renderGame();
    expect(screen.getByTestId('game-over-screen')).toHaveTextContent('没有赢家');
    expect(screen.getAllByTestId(/^over-rank-/)).toHaveLength(b.view.players.length);
  });
});

describe('ActionPad 托管按钮', () => {
  const turn = () => {
    const i = sp.batches.findIndex((x) => x.yourDecision?.kind === 'TURN_MENU');
    const b = sp.batches[i]!;
    act(() =>
      useGameStore.getState().resetTo({
        epoch: 1,
        seq: b.seq,
        view: b.view,
        pending: b.pending,
        decision: b.yourDecision as YourDecision,
      }),
    );
  };

  it('短按切换托管（game:autopilot），不打开托管设置', async () => {
    turn();
    const { transport } = renderGame();
    await userEvent.click(screen.getByTestId('action-autopilot'));
    expect(transport.payloads('game:autopilot')).toEqual([{ on: true }]);
    expect(screen.queryByTestId('trustee-dialog')).toBeNull();
  });

  it('⚙「托管设置…」打开托管设置对话框，不切换托管', async () => {
    turn();
    const { transport } = renderGame();
    const gear = screen.getByTestId('action-trustee-settings');
    expect(gear).toHaveAccessibleName('托管设置…');
    await userEvent.click(gear);
    expect(await screen.findByTestId('trustee-dialog')).toBeInTheDocument();
    expect(transport.payloads('game:autopilot')).toEqual([]);
  });

  it('长按或右键 🤖 打开托管设置；随后的 click 不切换托管', async () => {
    turn();
    const { transport } = renderGame();
    const btn = screen.getByTestId('action-autopilot');
    fireEvent.pointerDown(btn, { button: 0 });
    await act(async () => {
      await new Promise((r) => setTimeout(r, AUTOPILOT_LONG_PRESS_MS + 60));
    });
    fireEvent.pointerUp(btn, { button: 0 });
    fireEvent.click(btn, { detail: 1 });
    expect(await screen.findByTestId('trustee-dialog')).toBeInTheDocument();
    expect(transport.payloads('game:autopilot')).toEqual([]);
    act(() => useTrusteeDialog.getState().setOpen(false));
    await waitFor(() => expect(screen.queryByTestId('trustee-dialog')).toBeNull());
    fireEvent.contextMenu(btn);
    expect(await screen.findByTestId('trustee-dialog')).toBeInTheDocument();
    expect(transport.payloads('game:autopilot')).toEqual([]);
    // 按下不久就松开：照常切换
    act(() => useTrusteeDialog.getState().setOpen(false));
    fireEvent.pointerDown(btn, { button: 0 });
    fireEvent.pointerUp(btn, { button: 0 });
    fireEvent.click(btn, { detail: 1 });
    expect(transport.payloads('game:autopilot')).toEqual([{ on: true }]);
  });
});

describe('HUD 徽章', () => {
  it('玩家面板用 GodBadge / StatusBadges；玩家条显示紧凑徽章（神明头像 + 天数、状态图标 + 数字）', () => {
    const b = sp.batches[10]!;
    const view = {
      ...b.view,
      players: b.view.players.map((p) =>
        p.seat === 2
          ? {
              ...p,
              god: { kind: 2 as const, days: 4 },
              st: { ...p.st, jail: 3 },
              bomb: { fuse: 12 },
              alliance: { seat: 0 as const, days: 5 },
            }
          : p,
      ),
    };
    act(() => {
      useGameStore.getState().resetTo({ epoch: 1, seq: b.seq, view, pending: [], decision: null });
      useUiStore.getState().setInspectSeat(2);
    });
    renderGame();
    const panel = screen.getByTestId('player-panel');
    expect(panel).toHaveAttribute('data-seat', '2');
    const badges = within(panel).getByTestId('status-badges-2');
    expect(within(badges).getByTestId('god-badge')).toHaveTextContent('大财神');
    expect(within(badges).getByTestId('god-badge')).toHaveAttribute('data-days', '4');
    expect(badges.querySelector('[data-status="jail"]')).toHaveTextContent('坐牢 4 天');
    expect(badges.querySelector('[data-status="bomb"]')).toHaveTextContent('12 步');
    // 同盟对象按角色名显示
    const p0 = view.players.find((p) => p.seat === 0)!;
    expect(p0).toBeDefined();
    expect(badges.querySelector('[data-status="alliance"]')?.textContent).toMatch(/5 天 · \S+/);
    // 玩家条：紧凑徽章，完整文案在无障碍标签里
    const chip = screen.getByTestId('chip-2');
    const compact = within(chip).getByTestId('chip-status-2');
    const god = within(compact).getByTestId('god-badge');
    expect(god).toHaveAttribute('title', '大财神 · 4 天');
    expect(god).toHaveTextContent('4');
    expect(within(compact).getByRole('img', { name: '坐牢 4 天' })).toHaveTextContent('4');
    expect(within(compact).getByRole('img', { name: /💣 12 步/ })).toBeInTheDocument();
    // 没有状态的座位不渲染徽章行
    expect(within(screen.getByTestId('chip-1')).queryByTestId('chip-status-1')).toBeNull();
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
