// MinigameIntro 的「不玩了」：房间不允许跳过时不显示；服务器确认后才放弃宿主，被拒时宿主保留（可照常开局）
import { defaultGameConfig } from '@rich4/shared/engine';
import type { MinigameTicket } from '@rich4/shared/minigames';
import { defaultRoomSettings } from '@rich4/shared/net';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRoomStore } from '../../store/roomStore';
import { roomView } from '../../test/roomFixtures';
import MinigameIntro from './MinigameIntro';
import { installResizeObserver, renderDialog } from './testing';

const mg = vi.hoisted(() => ({ start: vi.fn(), abandon: vi.fn() }));

vi.mock('../../minigames', () => ({
  startPlayerMinigame: mg.start,
  abandonPlayerMinigame: mg.abandon,
}));

installResizeObserver();

function ticket(): MinigameTicket {
  const startsAt = Date.now() + 5000;
  return {
    sessionId: 'mg-1-d7',
    decisionId: 'd7',
    seat: 0,
    minigameId: 'penguin',
    seed: 1,
    params: { ruleset: 'exe311' },
    tickMs: 100,
    introTicks: 10,
    maxTicks: 170,
    startsAt,
    deadlineAt: startsAt + 22_000,
    role: 'player',
  };
}

afterEach(() => {
  useRoomStore.getState().clear();
  mg.start.mockClear();
  mg.abandon.mockClear();
});

describe('MinigameIntro：跳过', () => {
  it('房间设置 allowMinigameDecline=false：不显示「不玩了」', () => {
    const settings = { ...defaultRoomSettings(defaultGameConfig('test')), allowMinigameDecline: false };
    useRoomStore.getState().setRoom(roomView({ phase: 'playing', settings }));
    renderDialog(MinigameIntro, 'MINIGAME', { minigame: ticket() });
    expect(screen.queryByTestId('minigame-decline')).toBeNull();
    expect(mg.start).toHaveBeenCalledTimes(1);
  });

  it('服务器拒绝跳过：不放弃宿主；接受后才放弃', async () => {
    const t = ticket();
    const rejected = renderDialog(MinigameIntro, 'MINIGAME', {
      minigame: t,
      submit: async () => ({ ok: false, error: { code: 'INVALID_ACTION' } }),
    });
    await rejected.user.click(screen.getByTestId('minigame-decline'));
    await vi.waitFor(() => expect(rejected.submit).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(mg.abandon).not.toHaveBeenCalled();
    rejected.unmount();

    const accepted = renderDialog(MinigameIntro, 'MINIGAME', {
      minigame: t,
      submit: async () => ({ ok: true, data: { seq: 3 } }),
    });
    await accepted.user.click(screen.getByTestId('minigame-decline'));
    await vi.waitFor(() => expect(mg.abandon).toHaveBeenCalledWith('mg-1-d7'));
  });
});
