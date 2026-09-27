// 宿主 DOM 叠层的原版外观（原版皮肤 A13；client-dom，jsdom，不建 Pixi）：
// - 原版外观下计时、得分、倒计时与结算分数由原版画面画出，同名 DOM 仍在（读屏与 E2E），只是视觉上隐藏；
// - 入场 FLC 期间本人遮罩上的「不玩了」：宿主调用会话提供的 decline，服务器接受后关闭；
// - 会话层把 decline 接到 GameClient.act（与决策对话框同一把全局提交锁），房间不允许跳过时不提供。
import type { MinigameTicket } from '@rich4/shared/minigames';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRoomStore } from '../../store/roomStore';
import { FakeTransport } from '../../test/fakeTransport';
import { roomView } from '../../test/roomFixtures';
import { MinigameSessions } from '../index';
import { HostShell, type HostSnapshot, type HostStore } from './HostShell';
import s from './host.module.css';
import { MiniGameHost } from './MiniGameHost';

const P = { ruleset: 'exe311' } as const;
const READY = { timeout: 10_000 } as const;

function ticket(o: Partial<MinigameTicket> = {}): MinigameTicket {
  return {
    sessionId: 'mg-1-d7',
    decisionId: 'd7',
    seat: 0,
    minigameId: 'balloon',
    seed: 99,
    params: { ...P },
    tickMs: 100,
    introTicks: 5,
    maxTicks: 300,
    startsAt: 10_000,
    deadlineAt: 50_000,
    role: 'player',
    ...o,
  };
}

function snap(o: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    phase: 'playing',
    mode: 'play',
    minigameId: 'balloon',
    sessionId: 'mg-1-d7',
    playerName: 'P1',
    state: null,
    tick: 3,
    countdownMs: 0,
    localScore: 12,
    finalScore: null,
    submitting: false,
    poseKey: null,
    notice: null,
    paused: false,
    skippable: false,
    look: 'original',
    declinable: false,
    readyFlc: true,
    ...o,
  };
}

function store(sn: HostSnapshot, extra: Partial<HostStore> = {}): HostStore {
  return { subscribe: () => () => {}, getSnapshot: () => sn, dismiss: vi.fn(), ...extra };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('HostShell 原版外观', () => {
  it('计时与得分、倒计时、结算分数只留给读屏（DOM 与 testid 仍在）；收起钮在右上角', () => {
    const Hud = () => <span data-testid="hud-inner">HUD</span>;
    const { rerender } = render(
      <HostShell
        store={store(snap({ mode: 'spectate', state: { tick: 3, phase: 'play', rng: 1, fx: [] } }))}
        Hud={Hud}
      />,
    );
    expect(screen.getByTestId('minigame-hud').className).toContain(s.srOnly);
    expect(screen.getByTestId('hud-inner')).toBeTruthy();
    expect(screen.getByTestId('minigame-watch-tag')).toBeTruthy();
    expect(screen.getByTestId('minigame-close').className).toContain(s.btnTop);
    rerender(<HostShell store={store(snap({ phase: 'countdown', countdownMs: 2000 }))} Hud={null} />);
    expect(screen.getByTestId('minigame-countdown').className).toContain(s.srOnly);
    // 入场 FLC 没载入：照常显示倒计时数字
    rerender(<HostShell store={store(snap({ phase: 'countdown', countdownMs: 2000, readyFlc: false }))} Hud={null} />);
    expect(screen.getByTestId('minigame-countdown').className).not.toContain(s.srOnly);
    rerender(<HostShell store={store(snap({ phase: 'result', finalScore: 42 }))} Hud={null} />);
    const final = screen.getByTestId('minigame-final-score');
    expect(final.dataset.value).toBe('42');
    expect(final.dataset.final).toBe('true');
    expect(final.parentElement!.className).toContain(s.srOnly);
  });

  it('程序化外观不受影响', () => {
    render(<HostShell store={store(snap({ look: 'procedural', phase: 'countdown', countdownMs: 2000 }))} Hud={null} />);
    expect(screen.getByTestId('minigame-countdown').className).not.toContain(s.srOnly);
    expect(screen.queryByTestId('minigame-preroll-decline')).toBeNull();
  });

  it('入场期间可以「不玩了」', () => {
    const decline = vi.fn();
    render(<HostShell store={store(snap({ phase: 'countdown', declinable: true }), { decline })} Hud={null} />);
    fireEvent.click(screen.getByTestId('minigame-preroll-decline'));
    expect(decline).toHaveBeenCalledTimes(1);
  });
});

describe('入场期间的「不玩了」', () => {
  it('宿主：开局前提供 decline 时可以跳过，服务器接受后关闭；开局后不再提供', async () => {
    let now = 5_000;
    let answer = true;
    const decline = vi.fn(async () => answer);
    const host = MiniGameHost.open({
      ticket: ticket(),
      mode: 'play',
      now: () => now,
      playerName: 'P1',
      characterId: 0,
      headless: true,
      pack: null,
      decline,
      clock: () => now,
    });
    await vi.waitFor(() => expect(host.isReady).toBe(true), READY);
    host.pump();
    expect(host.getSnapshot().declinable).toBe(true);
    // 服务器拒绝：遮罩保留
    answer = false;
    await act(async () => {
      host.decline();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(host.getSnapshot().declinable).toBe(true));
    expect(host.isClosed).toBe(false);
    // 开局后不再提供
    now = 10_050;
    host.pump();
    expect(host.getSnapshot().declinable).toBe(false);
    host.decline();
    expect(decline).toHaveBeenCalledTimes(1);
    host.close();

    // 服务器接受：关闭
    now = 5_000;
    answer = true;
    const h2 = MiniGameHost.open({
      ticket: ticket({ sessionId: 'mg-1-d8' }),
      mode: 'play',
      now: () => now,
      playerName: 'P1',
      characterId: 0,
      headless: true,
      pack: null,
      decline,
      clock: () => now,
    });
    await vi.waitFor(() => expect(h2.isReady).toBe(true), READY);
    h2.pump();
    h2.decline();
    await vi.waitFor(() => expect(h2.isClosed).toBe(true));
  });

  it('会话：decline 走 GameClient.act（MINIGAME_DECLINE，本决策），房间不允许跳过时不提供', async () => {
    const transport = new FakeTransport();
    const act = vi.fn(async () => ({ ok: true as const, data: { seq: 1 } }));
    const sessions = new MinigameSessions(
      { transport, clock: { serverNow: () => 5_000 }, act },
      { headless: true, clock: () => 5_000 },
    );
    sessions.install();
    const room = roomView();
    useRoomStore.setState({ room: { ...room, settings: { ...room.settings, allowMinigameDecline: true } } });
    const h = sessions.startPlayer(ticket())!;
    await vi.waitFor(() => expect(h.isReady).toBe(true), READY);
    h.pump();
    expect(h.getSnapshot().declinable).toBe(true);
    h.decline();
    await vi.waitFor(() => expect(h.isClosed).toBe(true));
    expect(act).toHaveBeenCalledWith({ type: 'MINIGAME_DECLINE' }, 'd7');
    expect(sessions.isDone('mg-1-d7')).toBe(true);

    useRoomStore.setState({ room: { ...room, settings: { ...room.settings, allowMinigameDecline: false } } });
    const h2 = sessions.startPlayer(ticket({ sessionId: 'mg-1-d9', decisionId: 'd9' }))!;
    await vi.waitFor(() => expect(h2.isReady).toBe(true), READY);
    h2.pump();
    expect(h2.getSnapshot().declinable).toBe(false);
    sessions.uninstall();
    useRoomStore.setState({ room: null });
  });
});
